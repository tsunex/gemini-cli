# Task 20: バックグラウンドループで親セッションの一時的なツール制限を引き継がない

## 背景

Task 17〜19 の修正後、`text.txt` が存在したら削除して `loop-stop`
する実機シナリオを試したところ、`/loop status` は以下の状態になった。

```text
Consecutive Failures: 1
Last Error: Run ended without a completion signal (possible distraction or turn-cap cutoff).
```

`loop.log` を確認すると、`invoke_agent`/`Delegating to subagent`
は出ておらず、サブエージェント委譲ではなかった。代わりに、モデルは
`loop-stop`、`run_shell_command`、`write_file` などが宣言されていないと認識し、
`list_directory` / `read_file` / `glob`
など読み取り系ツールだけで解決策を探し続け、最終的に `MAX_TURNS_EXCEEDED`
で終了していた。

つまり、Task
17 で不要な委譲は抑止できている一方、バックグラウンドループ側のツール宣言が親の対話セッションの一時的な
`mainAgentTools`
制限を引き継いでしまい、自律的な削除・自己停止に必要なツールが見えないことが新たな根本原因だった。

## 目的

`/loop --background`
はユーザーが明示的に登録する YOLO モードの保守エージェントであり、登録時にも「Background
loop runs with all tool calls
auto-approved」と警告している。そのため、対話中の親セッションが一時的に
`mainAgentTools`
で読み取り系などに絞られていても、バックグラウンドループにはその一時制限を引き継がせず、登録済みツール（ユーザー設定の
`coreTools` / `excludeTools`
など恒久的な設定は引き続き尊重）を宣言できるようにする。

## 設計

- `packages/core/src/services/loopScheduler.ts` の `config.fork(...)` 呼び出しで
  `mainAgentTools: undefined` を明示的に指定する。
- `Config.fork()` は `...this._params, ...overrides` の順で子 `Config`
  を生成するため、`undefined` を指定すれば親の `mainAgentTools`
  を子へ引き継がない。
- `coreTools` / `excludeTools` /
  policy 由来の制限は変更しない。あくまで「この対話ターンのメインエージェント向け一時ツールサブセット」を背景ループに漏らさない修正とする。
- 回帰テストでは、親 `Config` に `mainAgentTools: ['glob']`
  がある状態でも、`LegacyAgentSession` に渡される背景 `Config` では
  `mainAgentTools: undefined` になっていることを検証する。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - `config.fork()` の overrides に `mainAgentTools: undefined` を追加。
- `packages/core/src/services/loopScheduler.test.ts`
  - 既存の `should schedule loop and run session` テストで、親側に
    `mainAgentTools: ['glob']` を設定し、背景側では `undefined`
    にクリアされることを検証。

## 実行結果

2026年8月31日、設計通り実装完了。

- `loopScheduler.ts`: バックグラウンド用 `Config.fork()` で
  `mainAgentTools: undefined` を明示。
- `loopScheduler.test.ts`: 親セッションの `mainAgentTools`
  が背景ループに継承されないことを検証するアサーションを追加。
- 検証結果:
  - `npx vitest run packages/core/src/services/loopScheduler.test.ts packages/cli/src/ui/commands/loopCommand.test.ts`:
    **31/31 合格**。
  - `npx tsc --noEmit -p packages/core/tsconfig.json`: クリーン。
  - `npm run build -w @google/gemini-cli-core`: 成功。
  - `npx tsc --noEmit -p packages/cli/tsconfig.json`: クリーン。
  - `npx eslint packages/core/src/services/loopScheduler.ts packages/core/src/services/loopScheduler.test.ts packages/cli/src/ui/commands/loopCommand.ts packages/cli/src/ui/commands/loopCommand.test.ts`: クリーン。
  - `npm run build -w @google/gemini-cli`: 成功。

この修正により、`text.txt` 削除 + `loop-stop`
のシナリオで、モデルが「削除/loop-stopツールが見えない」と迷走してターン上限に達する問題を解消する。

## 追記: 実機再テストでの追加判明事項

この Task 20 の修正だけでは不十分だった。`Config.fork()` で子Configの
`mainAgentTools` を `undefined` にしても、fork後に
`child._toolRegistry = this._toolRegistry` として親の `ToolRegistry`
インスタンスを共有していたため、ツール宣言生成時には `ToolRegistry`
内部の親Config参照が使われ続けていた。

このため、実機再テストでは依然として `loop-stop` / `run_shell_command` /
`write_file` がモデルに見えず、`MAX_TURNS_EXCEEDED` になった。追加修正は Task
21 で実施した。
