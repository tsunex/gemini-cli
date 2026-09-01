# Task 21: fork後のToolRegistryを子Configへ再バインドする

## 背景

Task 20では、`/loop --background` の `Config.fork()` 呼び出し時に
`mainAgentTools: undefined`
を指定し、親の一時的なメインエージェント向けツール制限を引き継がないようにした。

しかし実機テストではまだ失敗した。`loop.log` には `invoke_agent`
は出ておらず、代わりにモデルが `loop-stop` / `run_shell_command` / `write_file`
を見つけられず、読み取り系ツールで実装調査を続けて `MAX_TURNS_EXCEEDED`
に到達していた。

再調査の結果、`Config.fork()` は `child._toolRegistry = this._toolRegistry`
として親の `ToolRegistry` インスタンスをそのまま共有していた。`ToolRegistry`
は内部に `config` 参照を持ち、`getFunctionDeclarations()` で
`this.config.getMainAgentTools()` を参照するため、子 `Config` の
`mainAgentTools` を `undefined` にしても、共有された `ToolRegistry`
は依然として親Configの `mainAgentTools` を見続けていた。

## 目的

forkされた子Configでは、ToolRegistryの既存ツール登録状態は引き継ぎつつ、
`getFunctionDeclarations()` などの設定参照は子Configを見るようにする。

## 設計

- `ToolRegistry.clone(config?: Config)`
  を追加/拡張し、clone先のConfigを指定できるようにする。
- `clone()` は `allKnownTools` を浅くコピーし、`isMainRegistry` を維持する。
- `Config.fork()` では `child._toolRegistry = this._toolRegistry.clone(child)`
  とし、ToolRegistryを子Configへ再バインドする。
- 回帰テストとして、親Configが `mainAgentTools: ['glob']` で `write_file`
  を隠している状態でも、`clone(unrestrictedChildConfig)` 後は `glob` と
  `write_file` の両方が宣言されることを検証する。

## 実行結果

2026年8月31日、設計通り実装完了。

- `packages/core/src/tools/tool-registry.ts`:
  `clone(config: Config = this.config)`
  に拡張し、clone先のConfigを指定できるようにした。 `isMainRegistry`
  は維持するため、通常のメインレジストリ挙動は変えない。
- `packages/core/src/config/config.ts`: `Config.fork()` で
  `child._toolRegistry = this._toolRegistry.clone(child)`
  とし、親の登録済みツール一覧は引き継ぎつつ、ツール宣言生成時の設定参照は子Configを見るようにした。
- `packages/core/src/tools/tool-registry.test.ts`: 親Configが
  `mainAgentTools: ['glob']` で `write_file`
  を隠している状態でも、子Configへcloneしたレジストリでは `glob` と `write_file`
  の両方が宣言されることを検証するテストを追加。
- `packages/core/src/config/config.test.ts`: 既存の fork テスト用モックに
  `clone()`
  を追加し、実運用と同じく ToolRegistry 初期化済みのConfigを fork する形に更新。

検証結果:

- `npx vitest run packages/core/src/tools/tool-registry.test.ts packages/core/src/config/config.test.ts -t "rebind cloned registries|Config fork"`:
  **2/2 合格**。
- `npx vitest run packages/core/src/services/loopScheduler.test.ts packages/cli/src/ui/commands/loopCommand.test.ts`:
  **31/31 合格**。
- `npx tsc --noEmit -p packages/core/tsconfig.json`: クリーン。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `npx tsc --noEmit -p packages/cli/tsconfig.json`: クリーン。
- `npx eslint packages/core/src/tools/tool-registry.ts packages/core/src/tools/tool-registry.test.ts packages/core/src/config/config.ts packages/core/src/config/config.test.ts packages/core/src/services/loopScheduler.ts packages/core/src/services/loopScheduler.test.ts packages/cli/src/ui/commands/loopCommand.ts packages/cli/src/ui/commands/loopCommand.test.ts`: クリーン。
- `npm run build -w @google/gemini-cli`: 成功。

これで Task 20 で意図した「親の一時的な `mainAgentTools`
制限をバックグラウンドループへ漏らさない」が、実際のツール宣言生成パスでも成立するようになった。
