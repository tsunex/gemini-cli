# Task 12: デーモンのプロセスグループ単位でのKill

## 背景

`report_11.md` §2・§9-4 の指摘: `zero` は `ConfigureProcessGroup`
（`Setpgid=true`）でデーモンの子プロセスを独立したプロセスグループのリーダーとして起動し、終了時は
`processSignalTarget` により `-pid`
（プロセスグループ全体）へシグナルを送る。これにより、デーモンが起動した孫プロセス（シェルコマンド等）も確実に終了する。

`gemini-cli` の `loopScheduler.ts` は `startDaemon()` で
`spawn(..., { detached: true })`
によりデーモンを起動しており、これはPOSIX環境では新しいプロセスグループのリーダーとなる（`detached: true`
は内部的に `setsid()` 相当の挙動）。しかし `stopDaemon()`
はこれまで単一PIDに対してのみ `SIGTERM`/`SIGKILL`
を送っており、バックグラウンド実行中にサブエージェント経由でシェルコマンド等の子プロセスが起動されていた場合、それらが取り残される（孤児化する）リスクがあった。

## 目的

`stopDaemon()` が送信する `SIGTERM`/`SIGKILL`
を、可能な限りデーモンのプロセスグループ全体（`-pid`）に対して送るようにし、サブプロセスの取りこぼしを防ぐ。

## 設計

- `killDaemonTree(pid, signal)` ヘルパーを追加。
  - POSIX環境（`process.platform !== 'win32'`）では、まず
    `process.kill(-pid, signal)`（プロセスグループ全体）を試みる。
  - 失敗した場合（グループリーダーでない等）は単一PIDへフォールバックする。
  - Windows環境ではそもそも負のPIDによるグループシグナリングが機能しないため、単一PIDへのシグナル送信のみを行う。
- 生存確認（`process.kill(pid, 0)`）は従来通りデーモン本体のPIDに対して行う（グループ全体の生存確認ではなく、デーモンリーダー自身の生存を見る）。
- Task 10 で実装した `SIGTERM` 送信・猶予後の `SIGKILL` エスカレーションの両方に
  `killDaemonTree()` を適用する。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - `killDaemonTree()` を追加し、`stopDaemon()` 内の `SIGTERM`/`SIGKILL`
    送信をこれ経由に変更。
- `packages/core/src/services/loopScheduler.test.ts`
  - `SIGTERM`/`SIGKILL` が `-pid`（プロセスグループ）に送られることを検証。
  - プロセスグループへのシグナリングが失敗した場合に単一PIDへフォールバックすることを検証。

## 実行結果

2026年8月31日、設計通り実装完了。

- `killDaemonTree()` を追加し、POSIX環境ではまず `-pid`
  （プロセスグループ全体）へシグナルを送り、失敗時のみ単一PIDへフォールバックするよう実装。Windowsでは単一PID送信のみ。
- `stopDaemon()` の `SIGTERM` 送信・猶予後の `SIGKILL`
  エスカレーションの両方に適用。
- テスト: `loopScheduler.test.ts` に (a) `-pid`
  へ`SIGTERM`/`SIGKILL`が送られることの確認、(b) グループへのシグナリングが例外を投げた場合に単一PIDへフォールバックすることの確認、を追加。既存のTask
  10のテストも `-pid` を期待するよう更新。**13/13 テスト合格**。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `eslint`: クリーン。
