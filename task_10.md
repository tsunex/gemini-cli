# Task 10: `/loop stop` の SIGKILL エスカレーション実装

## 背景

`report_11.md` §2・§9-2 の指摘:
`openclaude`（`terminateBackgroundProcessTree()`）と
`zero`（`TerminateProcessTree`）はいずれも「SIGTERM送信 → 猶予期間待機 → それでも生存していればSIGKILL
→ 終了検証」という定石パターンを実装している。

本セッション前半で `loopScheduler.ts` の `SIGTERM`/`SIGINT` ハンドラが
`process.exit()`
を呼ばないバグを修正したが、これは「デーモンプロセスがシグナルハンドラを正しく実行できる状態にある」ことが前提。ネイティブアドオンの同期ブロッキング呼び出し等でイベントループが完全に固まっている場合、
`SIGTERM` ハンドラ自体が実行されず、依然としてゾンビデーモンが残り得る。

## 目的

`stopDaemon()`
に、SIGTERM送信後一定の猶予期間（`TERMINATION_GRACE_MS`）を待ってもプロセスが生存している場合、`SIGKILL`
へエスカレーションする仕組みを追加する。

## 設計

- `stopDaemon()` 自体は同期関数のまま維持する（スラッシュコマンド・ `loop-stop`
  ツール・自動再起動処理など、既存の呼び出し元のシグネチャを変更しない）。
- `SIGTERM` 送信後、`setTimeout(..., TERMINATION_GRACE_MS).unref()`
  でファイア・アンド・フォーゲット方式の猶予チェックをスケジュールする。
  `unref()`
  により、呼び出し元プロセス（対話CLI等）がこのタイマーだけで待たされることはない。
- 猶予期間経過後、`process.kill(pid, 0)` で生存確認し、まだ生きていれば
  `process.kill(pid, 'SIGKILL')` を送る。既に終了していれば何もしない。
- `TERMINATION_GRACE_MS = 3000`（3秒）をエクスポートし、テストから参照可能にする。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - `TERMINATION_GRACE_MS` 定数のエクスポート。
  - `stopDaemon()` に猶予期間後のSIGKILLエスカレーションロジックを追加。
- `packages/core/src/services/loopScheduler.test.ts`
  - `process.kill`
    をモックし、(a) 猶予期間経過後もプロセスが生存している場合にSIGKILLが送られること、(b) 猶予期間中にプロセスが自然終了した場合はSIGKILLが送られないこと、の両方を検証。実際のプロセスに対してシグナルを送らないよう、テストプロセス自身の PID は使わず、モックのみで検証する。

## 実行結果

2026年8月31日、設計通り実装完了。

- `loopScheduler.ts` に `TERMINATION_GRACE_MS = 3000`（3秒）をエクスポート。
- `stopDaemon()` を、SIGTERM送信後に `setTimeout(...).unref()`
  でファイア・アンド・フォーゲット方式の猶予チェックをスケジュールするよう変更。
  `stopDaemon()`
  自体のシグネチャ（同期・戻り値なし）は変更していないため、スラッシュコマンド・`loop-stop`
  ツール・自動再起動処理など既存の呼び出し元は無修正で動作する。
- 猶予期間経過後もプロセスが生存していれば `SIGKILL`
  を送信、期間中に自然終了していれば何もしない。
- テスト: `loopScheduler.test.ts` に `process.kill`
  をモックした2ケースを追加（猶予後も生存→SIGKILL送信 / 猶予中に自然終了→SIGKILL送信されない）。実プロセスへのシグナル送信は行わず、テストランナー自身への影響なし。
  **11/11 テスト合格**。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `eslint`: クリーン（`prefer-const` の指摘1件を修正済み）。
