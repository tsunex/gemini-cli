# Task 08: loopコマンドの「起動時自動再開（オートスタート）」と「プロセス分離バックグラウンド実行」の実装

## 目的

`gemini-cli`
を終了（ターミナルをクローズ）しても動き続ける、真のバックグラウンド自律実行（プロセス分離デーモン化）を実現する。また、OS再起動や不測の終了によりデーモンプロセスが停止していた場合でも、次回
`gemini`
コマンドが叩かれた際に、自動的にスケジューラを復元・起動する「自動再開（オートスタート）」機能を実装する。

---

## 期待されるゴール

1. **プロセス分離（デーモン化）**:
   - `/loop [interval] [prompt] --background`
     を実行すると、親プロセスから完全に切り離された（`detached: true`）軽量な子プロセスが
     `gemini-cli` のデーモンとして立ち上がり、指定間隔で自律動作する。
   - CLIセッションやターミナルを閉じても、タイマーが終了することなく動き続ける。
2. **多重起動の安全な防止と上書き**:
   - すでにデーモンプロセスが動作している場合、新しい `/loop --background`
     を入力すると、古いデーモンプロセスをプロセスID（PID）ベースで安全に終了（`kill`）させた上で、新しい設定でデーモンを再起動する。
   - `/loop stop`
     を入力すると、稼働中のデーモンプロセスが安全に終了し、`state.json`
     が削除される。
3. **起動時自動再開（オートスタート）**:
   - ディスク上に有効なスケジュール（`state.json`）が存在するにもかかわらず、そのPIDのデーモンプロセスが生存していない場合（PC再起動後など）、次回
     `gemini`
     コマンド起動時に、自動的にデーモンプロセスをフォークして再起動する。
4. **不揮発な永続化**:
   - プロセス終了時（SIGINT/SIGTERM）に `state.json`
     を削除してしまう不具合を解消し、明示的な `stop`
     時のみ削除するよう修正する。

---

## 実装手順（ロードマップ）

### ステップ 1: `LoopState` スキーマの拡張と永続化処理の修正

1. `packages/core/src/config/agent-loop-context.ts` または `loopScheduler.ts`
   に定義されている `LoopState`
   インターフェースに、デーモンのプロセスIDを管理する `pid?: number` を追加。
2. `packages/core/src/services/loopScheduler.ts`
   内のプロセス終了フック（`SIGINT`/`SIGTERM`）から、**`state.json`
   を削除する処理（`clearState`）を撤去**。プロセス終了時はタイマーをクリアするのみにする（`state.json`
   を残すことで後から復元可能にする）。

### ステップ 2: 軽量デーモン実行モードの追加（CLIエントリーポイント）

1. `gemini`
   CLIが内部的に自らをデーモンとして起動するための内部引数・サブコマンド（例:
   `gemini loop daemon`）を追加。
2. このコマンドが呼ばれた際は、React / Ink などの対話型UIやLegacy
   Sessionマネージャ等の重いUI層を一切初期化せず、直接 `packages/core` の
   `loopScheduler.ts`（`schedule`）を動かしてイベントループを維持する、超軽量な常駐エントリーポイントとして機能させる。
3. デーモン実行時のログはプロジェクトルートを汚さないよう、`Storage.getProjectLoopStateDir()`（`.gemini/loop-state/`）配下の
   `loop.log` に蓄積するように出力先を変更。

### ステップ 3: プロセス分離（デーモン起動・停止ロジック）の実装

1. `packages/core/src/services/loopScheduler.ts` に、プロセスをフォークする
   `startDaemon(state: LoopState, config: Config)` を実装。
   - `child_process.spawn` を用いて、自分自身のプログラムを `loop daemon`
     サブコマンドかつ `{ detached: true, stdio: 'ignore' }` で非同期起動。
   - `child.unref()` を実行して親プロセスからの参照を切り離す。
   - 起動したデーモンプロセスの `child.pid` を `state.json` に保存する。
2. 稼働中のデーモンを停止する `stopDaemon()` を実装。
   - `state.json` から `pid` を読み込む。
   - 該当PIDのプロセスが生存しているかを `process.kill(pid, 0)` で確認。
   - 生存していれば `process.kill(pid, 'SIGTERM')` などで停止。
   - タイマーをクリアし、`state.json` を削除する。
3. `/loop stop` コマンド、および `loop-stop` ツールで `stopDaemon()`
   を呼ぶように修正。

### ステップ 4: 起動時の「自動再開（オートスタート）」フックの追加

1. `packages/cli` のメインエントリーポイント（例:
   `packages/cli/src/nonInteractiveCli.ts` および `AppContainer`
   の起動時処理）において、以下の初期化ロジックを追加。
   - `loadLoopState()` が存在するか確認。
   - 存在する場合、その `pid`
     のデーモンプロセスが生存しているか（`process.kill(pid, 0)`）を検証。
   - デーモンプロセスが死んでいる（＝PC再起動後、または不慮のクラッシュ）と判断された場合、自動的に
     `startDaemon()`
     を呼び出して、裏でデーモンプロセスを静かに再起動（スケジュール復元）する。

### ステップ 5: テストの追加と堅牢性の確認

1. プロセス起動・停止、PIDが正しく記録されること、多重起動時に古いプロセスがキルされることをモックタイマーおよび実プロセスを用いて検証する単体テストを追加。
2. 手動・統合テストを実行し、意図通りにターミナルを閉じても動作し続けること、再起動時に自動復元されることを確認する。

---

## 実行結果

2026年8月25日に、設計通りにすべてのコア機能およびCLIの統合、自動テストの修正が完了しました。

### 1. 実装された機能

- **ステップ 1 (状態永続化の修正)**:
  - `LoopState` インターフェースに `pid?: number` を追加。
  - プロセス終了フック（`SIGINT`/`SIGTERM`）を `clearTimer()`
    に変更し、タイマーのみを解除してディスク上の `state.json`
    は消去せずに保存し続けるように修正。
- **ステップ 2 (超軽量デーモン常駐処理の割り込み)**:
  - CLIメインエントリ `gemini.tsx` 内で、起動引数に `loop daemon`
    が含まれる場合に、Ink/React等の重いUI構築や認証画面等の初期化を完全にスキップして、直接コアスケジューラタイマーイベントループへと乗り入れる軽量常駐エントリーポイントを実装。
  - ログ出力をプロジェクトルートの `trace.log` から、状態ディレクトリ
    `.gemini/loop-state/loop.log` に変更。
- **ステップ 3 (プロセス分離デーモン化ロジック)**:
  - `startDaemon`, `stopDaemon`, `isDaemonRunning` を `loopScheduler.ts`
    に実装し、`@google/gemini-cli-core` パッケージからエクスポート。
  - ユーザーが新しくループを登録する、または `loop stop`
    コマンドや停止ツールを叩いた際、PIDベースで古いデーモンプロセスを完全に
    `kill` し、重複起動を防ぐように実装。
- **ステップ 4 (自動再開/オートスタートのフック)**:
  - 通常の `gemini`
    コマンド起動時、有効なスケジュール（`state.json`）が存在するがデーモンプロセスが死んでいる場合（OS再起動後やクラッシュ等）、裏で静かにデーモンプロセスをフォークして再起動する処理を
    `gemini.tsx` に追加。

### 2. テストの実行と合格

- CLIコマンド、およびコアスケジューラの仕様変更に伴い、それぞれのユニットテスト（`loopCommand.test.ts`,
  `loopScheduler.test.ts`）を更新・拡充。
- **検証結果**:
  - `loopCommand.test.ts`: **6/6 テストすべて合格 (PASS)**
  - `loopScheduler.test.ts`: **5/5 テストすべて合格 (PASS)**
  - プロジェクト全体のビルド（`npm run build`）も警告なしで **100%成功**。
