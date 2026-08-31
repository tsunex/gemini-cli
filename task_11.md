# Task 11: バックグラウンド実行のハートビート可観測性

## 背景

`report_11.md` §6・§9-3 の指摘: `openclaude` の `headlessHeartbeat.ts`
（周期的にstate/phase/pending_permission_requests等をJSON出力）や `zero` の
`--output-format stream-json`（`run_start/reasoning/tool_call/...`
の構造化イベント列）は、実行中のバックグラウンドタスクの内部状態を外部から周期的に覗ける仕組みを提供する。

`gemini-cli` の `/loop status` は `state.json` の `nextRun`
を見せるだけで、実際に今デーモンが「実行中」なのか「次回実行待ち」なのかを判別できない。今回の障害調査でも、`/loop status`
が "Running (PID: ...)" としか言えず、デーモンが `18:56`
の実行に固まったまま無応答なのか、単に次回実行時刻を過ぎているだけなのかを外部から即座に判断できなかった。

## 目的

バックグラウンド実行の生存確認に使える最小限のハートビート機構を追加する。新しいプロセス/デーモン/IPCチャネルを増やさず、既存の
`state.json` にフィールドを追加するだけの軽量な実装とする。

## 設計

- `LoopState` に `currentPhase?: 'idle' | 'running'` と
  `lastHeartbeatAt?: number` を追加。
- `schedule()` が状態を保存するたび（次回実行を待つ「idle」状態になるたび）
  `currentPhase: 'idle'` を書き込む。
- `setTimeout` のコールバックが実際に発火し実行を開始した瞬間、および
  `for await` でストリームイベントを受信するたびに、
  `recordHeartbeat('running')` を呼び、`state.json` 上の
  `currentPhase`/`lastHeartbeatAt`
  のみをディスク上の最新状態にマージして上書きする（`nextRun`
  等の他フィールドはそのまま）。停止済み（`state.json`
  が削除済み）の場合は何もしない（停止後に古い実行がstateファイルを復活させないため）。
- `/loop status` は `currentPhase === 'running'`
  の場合、「現在バックグラウンド実行中（最終活動:
  Xs前）」を表示する。ハートビートが極端に古い場合、ユーザーはハングを疑うことができる（自動検知・自動対処は本タスクの範囲外。可視化のみ）。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`
  - `LoopState` に `currentPhase`/`lastHeartbeatAt` を追加、 `isLoopState()`
    のバリデーションを拡張。
  - `recordHeartbeat()` 関数を追加。
  - `schedule()` 冒頭の `saveState` を `currentPhase: 'idle'` 付きに変更。
  - タイマー発火直後、および `for await` ループの各イベント受信時に
    `recordHeartbeat('running')` を呼び出す。
- `packages/cli/src/ui/commands/loopCommand.ts`
  - `/loop status` の出力に実行中フェーズ・最終活動時刻を追加。
- `packages/core/src/services/loopScheduler.test.ts`
  - 実行開始時・イベント受信時に `state.json` の `currentPhase`/
    `lastHeartbeatAt` が更新されることを検証するテスト。

## 実行結果

2026年8月31日、設計通り実装完了。

- `LoopState` に `currentPhase?: 'idle'|'running'` / `lastHeartbeatAt?: number`
  を追加し、`isLoopState()` のバリデーションを拡張。
- `recordHeartbeat()` を追加し、`schedule()`
  の初回保存（idle）、タイマー発火直後（running）、`for await`
  の各イベント受信時（running, タイムスタンプ更新）で呼び出すよう配線。
- `/loop status`
  に、実行中フェーズと最終活動からの経過秒数を表示する分岐を追加。
- テスト: `loopScheduler.test.ts` に (a) 成功実行後に `currentPhase` が `idle`
  に戻ることの確認、(b) ストリームを意図的にブロックさせ、実行中の `state.json`
  が `currentPhase: 'running'` かつ新しい `lastHeartbeatAt`
  を持つことを確認するテスト、を追加。**12/12 テスト合格**。
- `loopCommand.test.ts`: 既存11件、影響なしで合格。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `eslint`: クリーン。
