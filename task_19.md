# Task 19: 回帰テストの整備（Task 17/18 および既存機能の非破壊確認）

## 背景

Task 17（委譲抑止プロンプト）・Task 18（委譲の可視化）は、いずれも
`loopScheduler.ts`
の中核ロジック（完了ゲート・ハートビート・ウォッチドッグ・バックオフ）に手を加えるため、既存の Task
09〜16 で担保した挙動を壊していないことを回帰テストで確認する必要がある。

## 目的

1. 完了ゲート指示文に Task
   17 の委譲抑止ガイダンスが含まれることをテストで固定する。
2. `invoke_agent` の `tool_request` イベントが `currentAction`
   を正しく設定・ログ記録することをテストで固定する。
3. 既存の完了ゲート・ウォッチドッグ・バックオフ・アトミック書き込み等の挙動が Task
   17/18 の変更後も壊れていないことを、全テストスイートの再実行で確認する。

## 設計

新規のテストファイルは作成せず、Task
17/18の実装と同じコミット内で対象テストファイルに直接テストを追加する方針とした（`task-19-regression-tests`
todo として独立に管理していたが、実務上は Task
17/18 それぞれの実装と一体で検証するのが自然なため）。

- `packages/core/src/services/loopScheduler.test.ts`:
  - 既存の「should schedule loop and run session」テストに、送信プロンプトが
    `invoke_agent` および「do not
    delegate」を含むことを検証するアサーションを追加（Task 17 の回帰テスト）。
  - 新規テスト「should surface subagent delegation via currentAction when an
    invoke_agent tool_request event is seen」を追加し、`currentAction` に
    `generalist` と `Delegating` が含まれることを検証（Task 18の回帰テスト）。
  - 既存18件 + 新規1件 = 19件、全て合格することを確認。
- `packages/cli/src/ui/commands/loopCommand.test.ts`: Task
  16 で追加したカウントダウン表示テストを含め、既存12件がTask
  17/18 の変更後も全て合格することを確認（`loopCommand.ts` 自体には Task 18 で
  `currentAction` 表示分岐を追加したが、既存テストのモック `state`
  オブジェクトには `currentAction`
  を含めていないため、既存のアサーションには影響しない）。

## 実装対象

- `packages/core/src/services/loopScheduler.test.ts`
  （アサーション追加1件・新規テスト1件）。
- 追加のテストファイルなし。

## 実行結果

2026年8月31日、設計通り実施完了。

- `npx vitest run packages/core/src/services/loopScheduler.test.ts`:
  **19/19 合格**（Task 09〜16 由来の既存18件 + Task
  18 由来の新規1件、いずれも Task 17 のアサーション追加を含め非破壊）。
- `npx vitest run packages/cli/src/ui/commands/loopCommand.test.ts`:
  **12/12 合格**（Task 16 由来、Task 18 の表示分岐追加後も非破壊）。
- `npx tsc --noEmit -p packages/core/tsconfig.json`: クリーン。
- `npm run build -w @google/gemini-cli-core` 実行後、
  `npx tsc --noEmit -p packages/cli/tsconfig.json`: クリーン（ビルド順序の落とし穴を毎回回避することを再確認）。
- `eslint`（Task 16/17/18 で変更した4ファイル全て）: クリーン。
- `npm run build -w @google/gemini-cli-core` /
  `npm run build -w @google/gemini-cli`: いずれも成功。

Task
09〜18 で積み上げてきた挙動（完了ゲート・アトミック書き込み・ハートビート・ウォッチドッグ・プロセスグループ終了・委譲抑止・委譲可視化）が、単体テストレベルで一貫して壊れていないことを確認できた。

## 今後のフォローアップ（未実施）

Task 17 のプロンプト修正のみで、実地での不要な `generalist`
委譲パターン（text.txt 削除→自己停止シナリオ）が実際に収まるかどうかは、単体テストでは検証できない。次回、実 CLI での再テストを行い、以下を確認することを推奨する:

- `/loop status` の `currentAction` に「Delegating to
  subagent」が一切表示されず、モデルが直接
  `run_shell_command`/ファイル削除ツールを自分で呼んでいること。
- 万一それでも委譲が発生した場合、`/loop status` に「Delegating to subagent
  'generalist'
  ...」が正しく表示され、ユーザーが「ハングではなく委譲中」と判別できること。
