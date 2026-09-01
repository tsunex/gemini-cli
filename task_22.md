# Task 22: 自律停止時も最終報告を通知する

## 背景

Task 21 後の実機テストで、`text.txt`
が作成された後にファイル削除とループ停止は成功したが、親の対話画面には何の報告も表示されなかった。

`loopScheduler.ts` を確認すると、ストリーム完了後にまず `state.json`
の存在確認を行い、存在しなければ即 `return` していた。 `loop-stop` ツールは
`clearState()`
を呼ぶため、自己停止が成功した実行ほどこの早期returnに入り、完了シグナル付きの最終応答があっても
`sendNotification()` へ到達できなかった。

## 目的

`text.txt` 削除 + `loop-stop`
のように、実行中に自律停止した場合でも、完了シグナル付きの最終応答があれば親UIへ通知する。ただし、停止済みのループを再スケジュールしてはいけない。

## 設計

- `hasCompletionSignal(accumulatedText)` の判定と `sendNotification()` は、
  `state.json` の存在確認より前に行う。
- 通知送信後に `state.json`
  の存在を確認し、自己停止で消えていれば再スケジュールせず `return` する。
- 完了シグナルが無い場合の挙動（不完全扱い、retry/backoff）は変更しない。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - self-stop後も通知されるように、state存在確認を完了通知の後へ移動。
- `packages/core/src/services/loopScheduler.test.ts`
  - ストリーム中に `clearState()`
    された後、完了シグナル付き最終応答が返るケースで通知が送られ、かつ state が復活しないことを検証。

## 実行結果

2026年8月31日、設計通り実装完了。

- `loopScheduler.ts`: 完了シグナル検出と `sendNotification()` を、自己停止による
  `state.json`
  存在確認より前へ移動した。通知送信後に state が無い場合は再スケジュールせず return する。
- `loopScheduler.test.ts`: ストリーム中に `clearState()`
  が呼ばれた後、完了シグナル付き最終応答が返るケースを追加。通知が送られ、state が復活しないことを検証。

検証結果:

- `npx vitest run packages/core/src/services/loopScheduler.test.ts packages/core/src/tools/tool-registry.test.ts packages/core/src/config/config.test.ts -t "self-stopped|rebind cloned registries|Config fork"`:
  **3/3 合格**。
- `npx vitest run packages/core/src/services/loopScheduler.test.ts packages/cli/src/ui/commands/loopCommand.test.ts`:
  **32/32 合格**。
- `npx tsc --noEmit -p packages/core/tsconfig.json`: クリーン。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `npx tsc --noEmit -p packages/cli/tsconfig.json`: クリーン。
- `npx eslint packages/core/src/services/loopScheduler.ts packages/core/src/services/loopScheduler.test.ts packages/core/src/tools/tool-registry.ts packages/core/src/tools/tool-registry.test.ts packages/core/src/config/config.ts packages/core/src/config/config.test.ts packages/cli/src/ui/commands/loopCommand.ts packages/cli/src/ui/commands/loopCommand.test.ts`: クリーン。
- `npm run build -w @google/gemini-cli`: 成功。

これにより、`text.txt` 削除と `loop-stop`
による自律停止が成功した場合でも、親UIへ最終報告が通知される。
