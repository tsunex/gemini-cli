# Task 09: バックグラウンド実行専用の「完了ゲート」導入

## 背景

`report_11.md` §3・§9-1 で指摘した通り、`zero` の `RequireCompletionSignal`
はヘッドレス実行（`zero exec`）において、エージェントが明示的な完了シグナルを出すまでタスクを未完了とみなす暴走防止機構である。

対して `gemini-cli` の `/loop --background` は、`BACKGROUND_MAX_SESSION_TURNS=8`
というターン数の上限で強制的に打ち切るだけで、「そもそも本来のタスク（例:
`text.txt`
の存在確認）を放棄して無関係な作業に脱線した」ことを検出する手段がない。ターン上限に達すれば、脱線した内容がそのまま
`accumulatedText` としてユーザーに通知されてしまう可能性もある。

## 目的

バックグラウンドループの1回の実行が、指示されたタスクを実際に完了したかどうかを、エージェント自身に明示的な完了シグナルとして申告させ、その有無によって「成功」と「未完了（脱線・ハング）」を区別できるようにする。サブエージェント機能自体には一切制限を課さない。

## 設計

1. バックグラウンド実行時にLLMへ送るメッセージに、`state.prompt`
   へ完了ゲートの指示文（`buildCompletionGateInstruction()`）を追記する。指示内容: 「指示されたタスクを実際に完了・確認できた場合のみ、最終応答の末尾に厳密に
   `<<<LOOP_TASK_COMPLETE>>>`
   という行を出力すること。タスクを完了できなかった場合や、判断がつかない場合はこのマーカーを出力してはならない。」
2. ストリーム終了後、`accumulatedText` に完了マーカーが含まれるかを
   `hasCompletionSignal()` で判定する。
   - マーカーが**ある**場合: 従来通り成功として扱い、`retryCount`
     をリセットし、次回実行をスケジュールする。ユーザーへの通知本文からはマーカー自体を
     `stripCompletionMarker()` で除去する。
   - マーカーが**ない**場合: 「未完了」とみなし、`retryCount`
     をインクリメントして次回実行を指数バックオフでスケジュールする（既存の失敗時バックオフと同じロジックを再利用）。この場合はユーザーへの通知を送らない（脱線した中途半端な内容を見せない）。ログには「完了シグナルなし」の旨を記録する。
   - 未完了が `MAX_RETRY_COUNT`
     を超えて連続した場合は、既存の「自動停止」ロジックに合流させる（無限に脱線を繰り返さない）。
3. `maxSessionTurns`
   によるハード打ち切り（ターン上限到達）と、「モデルが自発的に応答を終えたが完了マーカーを付けなかった」場合の両方を、同じ「未完了」パスで扱う（`LegacyAgentSession`
   側からは打ち切り理由の判別ができないため、`schedule()` 側では区別しない）。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - `COMPLETION_MARKER` 定数、`buildCompletionGateInstruction()`,
    `hasCompletionSignal()`, `stripCompletionMarker()` を追加。
  - `schedule()` 内でメッセージ送信前にプロンプトへ指示を追記。
  - ストリーム終了後の成功/未完了判定ロジックを追加。
- `packages/core/src/services/loopScheduler.test.ts`
  - 完了マーカーがある場合に成功パス（通知送信・retryCountリセット）を通ることを検証するテスト。
  - 完了マーカーがない場合に、通知が送信されず、`retryCount`
    がインクリメントされ、バックオフされることを検証するテスト。
  - 既存のプロンプト送信内容アサーションを、追記後の内容に合わせて更新。

## 実行結果

2026年8月31日、設計通り実装完了。

- `loopScheduler.ts` に `COMPLETION_MARKER`
  (`<<<LOOP_TASK_COMPLETE>>>`)、`buildCompletionGateInstruction()`,
  `hasCompletionSignal()`, `stripCompletionMarker()` を追加。
- バックグラウンド実行の送信メッセージに完了ゲート指示を追記。
- ストリーム終了後、完了マーカーの有無で成功/未完了を分岐。
  - 成功時: マーカーを除去した本文のみ通知、`retryCount` リセット。
  - 未完了時: 通知を送らず、失敗時と同じ `rescheduleAfterSetback()`
    （指数バックオフ／`MAX_RETRY_COUNT` 超過で自動停止）に合流。
- 例外時のリトライ/バックオフ処理と未完了時の処理を共通化し (`rescheduleAfterSetback()`)、ロジックの重複・乖離を防止。
- テスト: `loopScheduler.test.ts`
  に完了マーカーあり/なしの両ケースを追加し、既存の送信内容アサーションも新しいプロンプト構造に更新。
  **9/9 テスト合格**。
- `npm run build -w @google/gemini-cli-core`: 成功（型エラーなし）。
- `eslint`: クリーン。
