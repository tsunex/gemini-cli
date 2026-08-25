# Gemini‑CLI `/loop` 背景実行設計書

## 目的

- 現行の **`/loop`** コマンドは対話セッション内でのみ繰り返し実行できる。
- ユーザーが `/loop` を入力したまま **バックグラウンドで定期的に再実行**
  できる機能を追加し、長時間の自動化タスク（例: 定期リポジトリ走査、定期レポート生成）をサポートする。

## 既存実装概要 (`src/skills/bundled/loop.ts`)

1. **コマンド解析** `parseLoopArgs`
   が入力文字列を分解し、以下の 4 種類のモードを判別
   - `fixed‑prompt` / `fixed‑maintenance` → ユーザーが `N minutes`
     等具体的な間隔を指定する **固定間隔**
   - `dynamic‑prompt` / `dynamic‑maintenance` → 間隔未指定、または `/loop`
     のみで **動的再スケジュール**（直前の実行完了後すぐ再実行）
2. **プロンプト生成**: 選択されたモードに応じて `prompt`
   文字列を組み立て、`runAgent` へ渡す。
3. **エージェントループ** は `runAgent`
   内でターミナルの対話的入力を待つ形で実行され、`/loop`
   が入力されるまで終了しない。

### 課題

- 現行は **対話的 UI**
  に依存し、CLI が終了するかユーザーが手動でキャンセルしなければループは継続できない。
- バックグラウンド実行に必要な「**スケジューラ**」と「**永続状態**」が無い。

## 設計方針

| 要件                       | 実装方針                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| バックグラウンドで定期実行 | `node` の `setTimeout`/`setInterval` を利用した **内部スケジューラ**。CLI プロセスが起動したまま（`--daemon` オプション）または **`npm run loop-bg`** のような長期プロセスとして実行。 |
| 複数モードの共存           | 既存 `parseLoopArgs` を拡張し、`--background` フラグと `--interval <duration>` を受け取る。指定が無い場合は **動的モード**（前回完了後直ちに再実行）。                                 |
| 状態永続化                 | `Storage.getProjectLoopStateDir()` を新規作成し、JSON で `{ nextRun: timestamp, mode: string, prompt: string }` を保存。CLI 再起動時に読み込み、遅延が発生した場合は即時実行。         |
| 途中停止 / 再開            | `loop stop` コマンドで状態ファイルを削除／`loop status` で次回実行予定を表示。                                                                                                         |
| テスト容易性               | スケジューラロジックを **純粋関数** (`scheduleNextRun`, `loadState`, `saveState`) に切り出し、`jest`/`vitest` でタイマーをモック。                                                     |

## アーキテクチャ概要

```
+-------------------+      +------------------+      +--------------------+
| CLI Entry (gemini) | --> | LoopSkill (bundle) | --> | AgentRunner (core) |
+-------------------+      +------------------+      +--------------------+
        |                               |
        |  (if --background)            | (unchanged interactive flow)
        v                               v
+-------------------+      +------------------+      +--------------------+
| Scheduler Service | <-- | LoopState Store   | --> | Timer (setTimeout) |
+-------------------+      +------------------+      +--------------------+
```

- **Scheduler Service** (`src/services/loopScheduler.ts`) が **状態ファイル**
  を監視し、次回実行まで `setTimeout` をスケジュール。
- `LoopSkill` は **モード判定** 後、`Scheduler.schedule(state)`
  を呼び出すだけでバックグラウンド実行に委譲。
- **インタラクティブモード** は従来通り `runAgent` を同期的に呼び出す。

## 実装タスク（単体テスト込み）

1. **LoopScheduler 実装** (`src/services/loopScheduler.ts`)
   - `schedule(state: LoopState): void`
   - `loadState(): LoopState | undefined`
   - `saveState(state: LoopState): void`
   - `clearState(): void`
   - タイマーのモック可能な内部 `private setTimer(fn, ms)` を提供。
2. **ストレージ拡張** (`src/config/storage.ts`)
   - `getProjectLoopStateDir(): string` を追加し、`.gemini/loop-state`
     ディレクトリを返す。
3. **LoopSkill 拡張** (`src/skills/bundled/loop.ts`)
   - `--background` オプションのパーシング。
   - `--interval <duration>`（例: `5m`, `1h`）を `ms` に変換し
     `LoopState.intervalMs` に設定。
   - `if (background) Scheduler.schedule(state)` の分岐追加。
4. **新コマンド `loop stop` / `loop status`**
   (`src/skills/bundled/loopControl.ts`)
   - `stop` は `Scheduler.clearState()` を呼び出す。
   - `status` は `Scheduler.loadState()` を表示。
5. **ユニットテスト** (`packages/core/src/skills/loop.test.ts`)
   - `parseLoopArgs` が `background` と `interval` を正しく解析すること。
   - `LoopScheduler.schedule` が `setTimeout` を呼び出す（タイマーを
     `jest.useFakeTimers()` でモック）。
   - `Scheduler.saveState/loadState` が JSON ファイルの入出力を正しく行うこと。
   - `loop stop` が状態ファイルを削除し、タイマーをクリアすること。
6. **統合テスト** (`integration-tests/loopBackground.test.ts`)
   - `gemini loop "test" --background --interval 1s`
     を実行し、2 回目の実行が 1 秒後に自動的に走ることを確認。
   - `loop stop` 後に再実行が起きないことを検証。

## テスト方針の詳細

- **モック対象**: `fs.promises`（`readFile`, `writeFile`, `unlink`）と
  `setTimeout`。
- **Vitest 設定**: `testEnvironment: node`, `globalSetup` で `tmp`
  ディレクトリを作成し、テスト後にクリーンアップ。
- **カバレッジ**: `parseLoopArgs`, `LoopScheduler` の全メソッド、`loop`
  コマンドのエントリポイント。

## 影響範囲とリスク

- `Config.getActiveTeam`
  等既存ロジックに副作用は無いため、バックグラウンド機能は
  **オプショナル**。デフォルトで有効にならず、`--background`
  が指定された場合のみ新ロジックが走る。
- 永続化ディレクトリが `.gemini/loop-state`
  と分離されているので、既存プロジェクトの `.gitignore` に自動追加は不要。
- タイマーが長時間走るプロセスになるため、**プロセス終了時のクリーンアップ**（`process.on('SIGINT')`）で
  `Scheduler.clearState()` を呼び出す実装を追加。

---

_作成日: 2026‑08‑06_ _Author: Zero (Auto‑pair programmer)_
