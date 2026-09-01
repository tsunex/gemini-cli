# Task 24: loop-stop が実行中daemon自身をkillしないようにする

## 背景

Task 21/22 後の実機テストで、`text.txt` が残ったまま `/loop status` が
`No loop is currently scheduled.` になった。これはデグレードである。

`loop.log` では、モデルが `run_shell_command` で `rm .../text.txt`
を要求し、ほぼ同時に `loop-stop` も要求していた。しかし `loop-stop` の実装は
`stopDaemon()` を呼び、`state.pid` のプロセスグループに SIGTERM を送る。この
`loop-stop` は背景daemon自身の中で実行されるため、同じrun内の sibling tool
call（`rm text.txt`）や最終通知処理が完了する前に、自分自身のプロセスグループを終了させてしまう可能性がある。

つまり、「自己停止」は「現在のdaemonを即kill」ではなく、「次回以降のスケジュールを消し、現在のrunは自然終了させる」でなければならない。

## 目的

`loop-stop`
が背景daemon自身から呼ばれた場合は、daemonプロセスへSIGTERM/SIGKILLを送らず、`state.json`
を削除するだけにする。これにより、同じturn内で並列発行された削除コマンドが完了し、Task
22 の最終通知も送れるようにする。

外部からの `/loop stop` は従来どおりdaemonプロセスグループを停止する。

## 設計

- `loopScheduler.ts` に `stopLoopFromCurrentProcess()` を追加。
- `state.pid === process.pid` の場合:
  - 現在の背景daemon自身からの self-stop と判断。
  - ログに記録。
  - `clearState()` のみ実行し、プロセスにはsignalしない。
- それ以外の場合:
  - 従来の `stopDaemon()` を呼び、外部停止としてプロセスグループを終了する。
- `LoopStopTool` は `stopDaemon()` ではなく `stopLoopFromCurrentProcess()`
  を呼ぶ。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - `stopLoopFromCurrentProcess()` 追加。
- `packages/core/src/tools/loopControl.ts`
  - `LoopStopTool` から新関数を呼ぶよう変更。
- `packages/core/src/services/loopScheduler.test.ts`
  - `state.pid === process.pid` の自己停止では `process.kill`
    が呼ばれず、stateだけ消えることを検証。
- `packages/core/src/tools/loop.test.ts`
  - `LoopStopTool` が `stopLoopFromCurrentProcess()` を呼ぶことを検証。

## 実行結果

2026年9月1日、実装完了。

設計どおりに以下のファイルを修正。

- `packages/core/src/services/loopScheduler.ts`
- `packages/core/src/tools/loopControl.ts`
- `packages/core/src/services/loopScheduler.test.ts`
- `packages/core/src/tools/loop.test.ts`

関連するテストを実行し、すべて成功することを確認した。

```sh
$ npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts src/tools/loop.test.ts
> @google/gemini-cli-core@0.56.0-nightly.20260806.g761f604c1 test
> vitest run src/services/loopScheduler.test.ts src/tools/loop.test.ts

RUN  v3.2.4 /home/tsuneokam/workfolder/gemini-cli/packages/core
     Coverage enabled with v8
 ✓ src/tools/loop.test.ts (5 tests) 9ms
 ✓ src/services/loopScheduler.test.ts (21 tests) 33ms
 Test Files  2 passed (2)
      Tests  26 passed (26)
   Start at  10:20:00
   Duration  5.96s

```

追加で core パッケージのビルドと型チェックも実行し、問題ないことを確認した。

- `npm run build -w @google/gemini-cli-core`
- `npm run typecheck -w @google/gemini-cli-core`

これにより、`loop-stop`
が daemon 自身から呼ばれた場合に、プロセスグループを kill せずにスケジュールのみを停止する対応が完了した。
