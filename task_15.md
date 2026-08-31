# Task 15: バックグラウンド実行のウォッチドッグタイムアウト

## 背景

Task 09〜14で `report_11.md` §9 の6項目を実装し終えた後、実地の
`/loop --background` 実行で新たな障害が観測された:

1. モデルが `invoke_agent` でサブエージェント（`generalist`）へ委譲。
2. 委譲後、ストリームイベントが完全に途絶（デッドロック）。
3. `state.json` は `currentPhase: "running"` のまま固まり、 `lastHeartbeatAt`
   も進まなくなった。
4. `nextRun` は永久に更新されず、`/loop status` は「last activity
   N秒前」が延々増え続けるだけで、ユーザーが手動でデーモンを `kill`
   するまで一切復旧しなかった。

Task
11（ハートビート）はこの状態を**観測可能**にしたが、**自動復旧**の手段は無かった。`for await (const event of stream)`
ループにはイベントが来る限り待ち続ける以外の制御が存在せず、時間経過だけを理由に実行を打ち切る仕組み（ウォッチドッグ）が欠けていたことが根本原因である。

## 目的

1回のバックグラウンド実行についてストリームイベントが一定時間（`BACKGROUND_RUN_TIMEOUT_MS`、既定5分）来ない場合、実行中の
`AgentSession` を `abort()`
で強制終了し、既存の「完了シグナル無し」パス（`rescheduleAfterSetback`）に合流させることで、ハングしたループが自動的にリトライ/バックオフへ復帰できるようにする。

## 設計

- `packages/core/src/services/loopScheduler.ts` の `schedule()` 内、
  `for await (const event of stream)` ループの前後に以下を追加:
  - `armWatchdog()`: `setTimeout(..., BACKGROUND_RUN_TIMEOUT_MS)`
    を (再)セットする。タイマー発火時は `timedOut = true`
    をセットし、ログに記録した上で `session.abort()`
    を呼ぶ（`LegacyAgentSession` が既に持つ `abort()` を利用。内部で
    `AbortController.abort()`
    が呼ばれ、進行中のツール呼び出し/モデル呼び出しへ中断シグナルが伝播し、ストリームが
    `agent_end(reason: 'aborted')` で終了する）。
  - ループ開始前とイベント受信ごとに `armWatchdog()`
    を呼び直すことで、「本当に進行中」の実行は打ち切られず、イベントが完全に止まった場合のみ発火する。
  - `finally` で必ず `clearWatchdog()`
    し、正常終了時にタイマーが残留しないようにする。
  - タイマーには `.unref()`
    を付与し、ウォッチドッグ自体がデーモンプロセスの生存を人為的に延命しないようにする（既存の
    `TERMINATION_GRACE_MS` の設計と同じ考え方）。
- ストリーム終了後、`hasCompletionSignal()` が false だった場合の
  `rescheduleAfterSetback()` 呼び出しで、`timedOut` に応じて `lastError`
  メッセージを分岐（"aborted after Nms..." / "ended without a completion
  signal..."）し、`/loop status` やログから原因を区別できるようにする。
- `BACKGROUND_RUN_TIMEOUT_MS` は `loopScheduler.ts`
  からエクスポートし、テストから参照できるようにする（他の定数と同じ方式）。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - `BACKGROUND_RUN_TIMEOUT_MS` 定数の追加（5分）。
  - `schedule()` 内のストリーム消費ループにウォッチドッグを追加。
  - `timedOut` に応じた `lastError` メッセージの分岐。
- `packages/core/src/services/loopScheduler.test.ts`
  - 1件のイベント後に完全に停止するモックストリームを用意し、
    `BACKGROUND_RUN_TIMEOUT_MS` 経過後に `session.abort()`
    が呼ばれること、その後 `retryCount` が加算され `lastError`
    に "aborted" が含まれること、通知は送信されないことを検証。

## 実行結果

2026年8月31日、設計通り実装完了。

- `loopScheduler.ts`: ウォッチドッグ実装（`armWatchdog`/`clearWatchdog`、
  `timedOut`フラグ、`abort()`呼び出し、`lastError`分岐）。
- テスト: 新規1件（ウォッチドッグ発火→abort→incomplete扱い）を追加し、既存17件と合わせて
  **18/18 テスト合格**。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `eslint`: クリーン。
- 実CLI確認（`node packages/cli/dist/index.js loop daemon`
  を直接ヘッドレス起動、`text.txt`を実際に配置した上で実施）:
  - 意図的なハング再現はモデルの非決定性のため困難であり、今回は再現しなかった。代わりに、モデルが本来のタスクから逸れて
    `state.json`を直接読もうとし、許可ディレクトリ外エラー →
    8ターン上限到達、という**別種の「注意逸れ」**が発生した。
  - この場合でも Task 09 の完了ゲートが正しく機能し、
    `retryCount: 1`・通知なし・40秒後へのバックオフ再スケジュールが実環境で確認できた。ウォッチドッグ追加によって既存の正常系・distraction系の挙動が壊れていないことの回帰確認になった。
  - ウォッチドッグ自体（実際のタイムアウト発火→`abort()`）の実環境再現は非決定的なため、上記の単体テストでの担保に留めることを明記する（follow-up: 実際に長時間ハングする状況が再発した場合、`state.json`の`lastError`に"aborted
    after"が含まれるかで本機能が発火したことを事後確認できる）。

これで、実運用で新たに発見された「バックグラウンド実行が無期限にハングし得る」という report_11.md 策定時には想定されていなかったギャップに対応した。
