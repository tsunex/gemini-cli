# Task 13: デーモンクラッシュ時のstale状態正規化

## 背景

`report_11.md` §2・§9-5 の指摘: `zero` の `loadTasks()`
は起動時、永続化されたタスクが `StatusRunning` のままだった場合、それを
`StatusError` に正規化し、PIDをクリアしてstale PIDでの誤killを防止する。

`gemini-cli` の `gemini.tsx` のオートスタート処理は、`isLoopDaemonRunning()`
が偽（＝以前のデーモンプロセスが死んでいる）と判断した場合、ディスクから読み込んだ
`loopState` をそのまま `startLoopDaemon()`
に渡して新デーモンを起動していた。もし前回のデーモンが
**バックグラウンド実行の最中（`currentPhase: 'running'`）にクラッシュ**
していた場合、その古い `pid`・`currentPhase`・`retryCount`
がそのまま新デーモンの初期状態として引き継がれてしまう。これにより:

- `/loop status`
  が実際には動いていない古い実行を「実行中」と表示し続ける可能性がある。
- クラッシュが連続してもリトライカウントが正しく増加せず、無限にクラッシュ→再起動を繰り返すリスクがある（Task
  09で実装した「完了ゲート未達時のリトライ上限」の枠組みの外で発生するクラッシュには対応できていなかった）。

## 目的

デーモンプロセスが死んでいることを検知してから再起動するまでの間に、ディスク上のstale（前回クラッシュ由来の）状態を正規化する。

## 設計

- `normalizeStaleState(state: LoopState): LoopState | undefined` を追加。
  - `currentPhase !== 'running'`
    の場合（前回は正常にidle状態で終わっていた/元々daemonが起動していなかった等）:
    `pid` のみクリアして返す。
  - `currentPhase === 'running'` の場合（実行中にクラッシュした）: `retryCount`
    をインクリメントし、`currentPhase` を `idle` に戻し、 `pid`
    をクリアし、`lastError`
    にクラッシュ検出の旨を記録する。これにより、クラッシュが連続した場合も既存の
    `MAX_RETRY_COUNT` の枠組みで検知できる。
  - `retryCount` が `MAX_RETRY_COUNT` を超えた場合は、再起動をあきらめて
    `clearState()` し、`undefined` を返す（呼び出し元は再起動を行わない）。
- `gemini.tsx` のオートスタート処理で、`startLoopDaemon()` を呼ぶ前に
  `normalizeStaleLoopState()` を通し、`undefined` が返った場合は再起動しない。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`: `normalizeStaleState()`
  を追加。
- `packages/core/src/index.ts`: `normalizeStaleLoopState` としてエクスポート。
- `packages/cli/src/gemini.tsx`: オートスタート処理に組み込み。
- `packages/core/src/services/loopScheduler.test.ts`: 3ケースのテストを追加。

## スコープ外

`openclaude` の `verifyBackgroundSessionProcessIdentity()`
のような「生存確認したPIDが本当に自分のデーモンか」を検証する仕組み（PID再利用対策）は、プラットフォーム依存のプロセスメタデータ読み取り（`/proc/<pid>/cmdline`
等）が必要でコストが高いため、本タスクの範囲外とする。

## 実行結果

2026年8月31日、設計通り実装完了。

- `loopScheduler.ts` に `normalizeStaleState()`
  を追加し、上記設計通りの分岐（idle時の単純pidクリア／実行中クラッシュ時のretryCount増加＋フェーズリセット／リトライ上限超過時の自動停止）を実装。
- `core/src/index.ts` から `normalizeStaleLoopState` としてエクスポート。
- `gemini.tsx` のオートスタート処理に組み込み、`startLoopDaemon()`
  呼び出し前に正規化を通すよう変更。
- テスト: `loopScheduler.test.ts` に `normalizeStaleState` 専用の `describe`
  ブロックを追加し、3ケースすべてを検証。 **16/16 テスト合格**。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `npx tsc --noEmit -p packages/cli/tsconfig.json`: 成功（`gemini.tsx`
  の変更を含め型エラーなし）。
- `eslint`: クリーン。
- `packages/cli/src/gemini.test.tsx`
  を実行したところ2件失敗したが、変更前のベースブランチ（`git stash`）でも同一の2件が同一理由（無関係なソケットEACCESエラー、無関係な
  `startInteractiveUI`
  のクリーンアップ回数の事前不整合）で失敗することを確認済み。本タスクの変更による回帰ではない（既知の環境起因の事前不具合）。
