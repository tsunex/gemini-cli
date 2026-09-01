# report_11: 自律動作CLIとの比較調査（gemini-cli 不足機能の洗い出し）

## 0. 目的・調査範囲

`gemini-cli` の `/loop --background`
機能が自律動作しない問題を調査・修正してきた過程で、「自律動作が可能」とされる3つの兄弟CLIと実装を比較し、`gemini-cli`
に不足している機能を洗い出す。

調査対象: | リポジトリ | パス | ソース有無 | |---|---|---| | antigravity-cli |
`/home/tsuneokam/workfolder/antigravity-cli` |
❌ ソースコードなし（README/CHANGELOG/exampleのみ。実体はcurlインストールされるクローズドソースバイナリ） |
| openclaude | `/home/tsuneokam/workfolder/openclaude` | ✅
TypeScript実装。Claude Code類似のフルソース | | zero |
`/home/tsuneokam/workfolder/zero` | ✅
Go実装。デーモン/CLI/エージェントループのフルソース |

**注記**: `antigravity-cli` はREADMEに機能説明があるのみで、実装（Shared Core
Agent
Engine）はこのリポジトリに含まれていない（Google管理のクローズドソース/リモート実行）。そのためアーキテクチャの直接比較はできず、本レポートでは openclaude と zero の実装比較を主とする。

---

## 1. 背景/デタッチ実行モデル

| 項目               | openclaude                                                                         | zero                                                                                                                     | gemini-cli（現状）                                                                |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 起動方式           | `spawn(..., {detached:true})` + `child.unref()`（`src/cli/bg.ts::handleBgFlag()`） | `exec.Command` + `ConfigureChildProcessGroup`（独立プロセスグループ化）+ `Release()`（`internal/cli/daemon.go:138-170`） | `spawn` で detached daemon（`loopScheduler.ts`）— 同等                            |
| 親終了後の生存     | detached + unref + ログ/メタデータファイル                                         | 独立プロセスグループ化により親終了後も生存、ログはファイルへ                                                             | 同等（detached daemon）                                                           |
| 専用デーモン管理層 | **スタブのみ**（`src/daemon/main.ts` は no-op）                                    | **正式デーモン**（`zero daemon start/status/attach`、Unixソケットで通信）                                                | 簡易daemon（`loop daemon`サブコマンド）。ソケット通信やstatusコマンドの体系化なし |

**gap**: zero は
`daemon status`（PID/バージョン/ソケット/キュー深度/セッション要約）という
**デーモン専用の状態確認コマンド**を持つ。gemini-cli の `/loop status`
は単一loopの状態のみで、デーモンプロセス自体の健全性（ソケット生存、キュー滞留等）を可視化する手段がない。

---

## 2. プロセス監視・ライフサイクル管理

| 項目                        | openclaude                                                                                   | zero                                                                                                                  | gemini-cli（修正前）                                                                                                           | gemini-cli（本セッションの修正後）                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 多重起動防止                | 名前予約ファイル＋stale reclaim（`bgRegistry.ts::reserveBackgroundSessionName()`）           | `Register()` が `taskID` 重複を拒否、`O_EXCL` で出力ファイル作成（`manager.go:124-177`）                              | **なし**                                                                                                                       | `LoopAlreadyRunningError` による排他チェックを追加済み（`startDaemon()`）                                                            |
| SIGTERM/SIGINT              | `terminateBackgroundProcessTree()`: SIGTERM→grace 2000ms待機→SIGKILL→検証（`bgRegistry.ts`） | `TerminateProcessTree`: SIGTERM→grace→SIGKILL→exit確認（`process_unix.go:41-83`）                                     | **`process.on('SIGTERM',...)` がリスナー登録のみで `process.exit()` を呼ばず、プロセスが終了しない致命的バグ**（本調査で発見） | `isLoopDaemonProcess` 判定＋`handleTerminationSignal()` で `process.exit(0)` を追加（デーモンプロセスのみ対象、対話CLIには影響なし） |
| プロセスグループKill        | プロセスグループ全体を対象に終了処理                                                         | `Setpgid=true`＋`-pid`ターゲットでプロセスグループ全体をkill（`process_unix.go:13-23,85-99`）                         | なし（単一PIDのみ）                                                                                                            | 未対応（**残課題**）                                                                                                                 |
| クラッシュ時のstale状態処理 | —                                                                                            | `loadTasks()` が起動時に `StatusRunning` を `StatusError` に正規化し、stale PIDでのkillを防止（`manager.go:326-372`） | なし                                                                                                                           | 未対応（**残課題**）                                                                                                                 |

**gap（最重要）**:
gemini-cli で今回発見した「SIGTERM登録するが`exit()`しない」バグは、openclaude/zero双方が
**grace period + SIGKILLエスカレーション**
という定石パターンを実装していたのに対し、gemini-cliには元々このパターン自体が存在しなかったことが根本原因。今回の修正はSIGTERMハンドラの修正のみで、**SIGKILLへのエスカレーション（grace
timeout後の強制終了）は未実装**。プロセスがフリーズしてSIGTERMを無視する状況（例: ネイティブアドオンのブロッキング呼び出し）には依然弱い。

---

## 3. 自律タスクのスコープ制御（暴走防止）

| 項目                           | openclaude                                                 | zero                                                                                                                                                                         | gemini-cli                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ターン数上限                   | `DEFAULT_GOAL_MAX_TURNS = 50`（goal専用、`goal/state.ts`） | `MaxTurns` デフォルト12（`internal/agent/loop.go:167-170`）                                                                                                                  | 対話セッションは `-1`（無制限）がデフォルト。**本セッションで背景実行専用に `BACKGROUND_MAX_SESSION_TURNS=8` を追加**したことでようやく同等機能を獲得 |
| 予算（トークン/コスト）        | `maxBudgetUsd`, `maxThinkingTokens` オプションあり         | 明示的な「最大ツール呼数」「壁時計時間」予算は **見つからず**（ターン予算＋completion gateが主）                                                                             | なし（ターン数のみ）                                                                                                                                  |
| **ヘッドレス専用の完了ゲート** | 見つからず                                                 | **`RequireCompletionSignal`**: `zero exec`（ヘッドレス）はデフォルトON。エージェントが明示的な完了シグナルを出すまでタスク未完了とみなす暴走防止機構（`agent/types.go:405`） | **なし** — これが `text.txt` 監視シナリオでLLMが無関係な脱線（メモリファイル閲覧、JIRA grep、サブエージェント呼び出し）をした根本原因の一つ           |
| 実行プロファイル               | なし                                                       | `balanced/fast/thorough` の3段階で `MaxTurns`/`ReasoningEffort`/自己修正を切替（`execprofile/profile.go`）                                                                   | なし                                                                                                                                                  |

**gap（最重要）**: zero の
`RequireCompletionSignal`（ヘッドレス実行時は「明示的完了シグナルが出るまでタスク未完了」とみなす）は、まさに今回の
`text.txt` 監視シナリオの失敗（LLMが無関係な作業に脱線し `nextRun`
が更新されないまま止まった）に対する直接的な解決策になり得る。gemini-cli の
`BACKGROUND_MAX_SESSION_TURNS=8`
は「上限で強制終了する」対症療法だが、zero 方式は「そもそも脱線したら完了と認めない」という**予防的**アプローチであり、より本質的。

---

## 4. 状態永続化・リカバリ

| 項目                               | openclaude                                                                       | zero                                                                                                                                         | gemini-cli                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| バックグラウンドタスクのメタデータ | `~/.claude/bg-sessions/sessions/*.json`（JSON）                                  | `${XDG_DATA_HOME}/zero/background/<task_id>.json`＋出力は`.ndjson`。**一時ファイル→rename によるアトミック書き込み**（`manager.go:475-501`） | `~/.gemini/loop-state/state.json`（JSON）＋ `loop.log` — アトミック書き込みは未確認（**要確認事項**） |
| ゴール/タスク進行状態              | セッションJSONLトランスクリプトに `type:'goal-state'` として追記、resume時に復元 | task JSON + NDJSON出力                                                                                                                       | 単一の `state.json` に `retryCount`/`lastError`/`nextRun` 等をフラットに保持                          |

**gap**:
zero の「一時ファイルに書いてrename」というアトミック書き込みパターンは、daemon強制終了時（SIGKILLや電源断）に
`state.json` が壊れる（部分書き込み）リスクを防ぐ。gemini-cli の
`loopScheduler.ts` の状態保存処理がアトミックかどうかは未検証であり、
**破損防止の観点で確認・改修の余地がある**。

---

## 5. スケジューリング機構

| 項目         | openclaude                                                                                                | zero                                                                               | gemini-cli                            |
| ------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| 実装方式     | インプロセス `setTimeout`（loop）／cronはファイルバック＋インプロセスポーリング（`useScheduledTasks.ts`） | インプロセス `time.NewTicker(30s)`（`cron_run.go`）。`--once` で外部cron連携も想定 | インプロセス `setTimeout`（同等方式） |
| OSレベル連携 | なし                                                                                                      | なし（`--once`で外部スケジューラ利用を許容する設計のみ）                           | なし                                  |

**gap**:
3者ともOSレベルのcron/systemdタイマー統合はなし。この点はgemini-cliに致命的な不足はない（業界的に「インプロセスタイマー」で揃っている）。

---

## 6. 監視・可観測性

| 項目                     | openclaude                                                                                                               | zero                                                                                                                                      | gemini-cli                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ステータス確認CLI        | `ps`/`logs -f`/`attach`（未実装）                                                                                        | `daemon status`（PID/socket/queue/session要約）、`daemon attach`                                                                          | `/loop status`（単一loopの次回実行時刻・リトライ状況のみ）                                   |
| ヘッドレス向け構造化出力 | `headlessHeartbeat.ts`: 周期的にJSON/stderrでハートビート（state, phase, pending_permission_requests, background_tasks） | `--output-format stream-json`: `run_start/reasoning/text/tool_call/permission_request/tool_result/usage/final/run_end` の構造化イベント列 | 通知はIPC経由で対話セッションに1回届くのみ。**構造化イベントストリームやハートビートは無し** |

**gap**:
openclaude/zero双方に「実行中の内部状態を外部から周期的/構造的に覗ける」機構（ハートビート、stream-json）があるのに対し、gemini-cliは「完了時に1回通知が飛ぶ」だけで、
**実行中の進捗を外部監視する手段がない**。今回のバグ（daemonが `18:56`
から進んでいないのに `status`
は "Running" としか出せず、内部で何が起きているか分からなかった）はまさにこの欠如が問題を長引かせた一因。

---

## 7. エラー処理・リトライ

| 項目                         | openclaude                                | zero                                                                                             | gemini-cli                                                                                                                         |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 終了失敗時のエスカレーション | SIGTERM→grace→SIGKILL→例外                | 同様のgrace→SIGKILLパターン。Kill失敗時は`running`状態に復元（false-killedを防止）               | **今回修正するまでSIGKILLへのエスカレーションが皆無**（現状もgraceからのSIGKILL自動エスカレーションは未実装、手動SIGKILLのみ有効） |
| リトライ/バックオフ          | goal永続化失敗はログのみ（fatalにしない） | ストール検知＋1回までのリトライ（`maxStreamStallRetries=1`）、コンテキスト超過時の圧縮＆リトライ | 本セッション以前に実装済み: 指数バックオフ＋`MAX_RETRY_COUNT=10`（gemini-cli側がむしろ手厚い）                                     |
| サーキットブレーカー         | なし                                      | なし                                                                                             | なし（3者とも同様）                                                                                                                |

**gap**: リトライ/バックオフ自体はgemini-cliの方が手厚い（他2つより体系的）。一方で「grace
timeout超過時の自動SIGKILLエスカレーション」はopenclaude/zero双方にあるが、gemini-cliには依然存在しない（今回の修正はSIGTERMで`exit()`を呼ぶだけで、それでも終了しない場合の保険がない）。

---

## 8. エージェンティックループ設計思想

- **openclaude**: 「goal」という概念で継続判定 (`evaluateGoalAfterTurn()`) を行い、未完了なら
  `buildGoalContinuationInstruction()`
  で合成ユーザー指示を追記して継続。単一の「自律バックグラウンドモード」があるわけではなく、goal/cron/autoDream/coordinatorという複数の自律サブシステムの集合体。
- **zero**: 単一のエージェントループ（`internal/agent/loop.go`）にツール呼び出し・圧縮・
  `RequireCompletionSignal`による完了ゲートを組み込み。TUI/exec/ACPで共通ループを使い回す設計。
- **gemini-cli**: 対話ループとバックグラウンドloopで基本的に同じ実行パス（`config.fork()`）を使う。今回
  `BACKGROUND_MAX_SESSION_TURNS`
  を追加したことで、ようやく「バックグラウンド実行の方が制約が強い」という区別がついた。しかし
  **「完了ゲート」「実行プロファイル」に相当する概念はまだ無い**。

---

## 9. 総括: gemini-cli に不足している機能（優先度順）

1. **【最重要・未実装】ヘッドレス専用の完了ゲート（zero の
   `RequireCompletionSignal` 相当）**
   「明示的な完了シグナルが無い限りタスク未完了」とし、無関係な脱線を続ける挙動そのものを抑止する。現状の
   `BACKGROUND_MAX_SESSION_TURNS=8`
   は対症療法（打ち切り）であり、根治にはならない。

2. **【重要・未実装】SIGTERM grace timeout からの自動SIGKILLエスカレーション**
   openclaude/zero共に「SIGTERM→grace待機→SIGKILL→検証」を標準実装している。gemini-cliは今回SIGTERMで`exit()`するようにしたのみで、ハングして終了しない場合の自動エスカレーションが無い。

3. **【重要・未実装】デーモン/バックグラウンドタスクの構造化・周期的可観測性**
   （openclaudeの`headlessHeartbeat`、zeroの`stream-json`相当）現状は完了時の一回通知のみで、「今何をしているか」を外部から確認する手段がない。今回の障害発生時、`/loop status`
   が "Running" としか言えず原因究明に手間取った直接要因。

4. **【中】プロセスグループ単位でのKill**
   サブエージェント/子プロセスが生成された場合、単一PIDのSIGTERMでは孫プロセスが残留するリスク。
   `Setpgid`+プロセスグループ全体へのシグナル送出パターンの導入を検討。

5. **【中】stale/クラッシュ状態の起動時正規化**
   （zeroの`loadTasks()`が`StatusRunning`→`StatusError`に正規化する仕組み）デーモン自体がクラッシュして再起動した場合、`state.json`に古い"running"情報が残ると誤判定・誤kill（PID再利用）のリスクがある。

6. **【低〜中】状態ファイルのアトミック書き込み** （zeroの`persistTaskLocked`:
   tmpファイル→rename）
   `state.json`書き込み中のクラッシュ/SIGKILLによるファイル破損防止のため確認・改修を推奨。

7. **【参考・優先度低】多重起動の名前空間管理／stale reclaim**
   （openclaudeの名前予約ファイル方式）gemini-cliは既に`LoopAlreadyRunningError`による単一loopの排他制御を実装済みだが、複数loopインスタンスを想定した名前空間的な管理は無い（現行の1デーモン=1タスク設計では優先度低）。

---

## 10. 除外事項・限界

- `antigravity-cli`
  は実装非公開のため直接比較不能。README記載の「マルチステップ推論」「永続履歴」「GUIと共有のエンジン」がgemini-cliに相当する機能を持つかは不明（伏せられている）。
- 本レポートはCI/CD関連の差異は対象外（ユーザー指示によりCIは調査対象外）。
- バージョン番号や依存パッケージの脆弱性は対象外（別件のOSS脆弱性調査と区別）。

---

## 付録: 本セッションで実施済みの修正（feature/loop-autonomous-daemonブランチ）

- リトライ/指数バックオフ、`MAX_RETRY_COUNT`/`MAX_BACKOFF_MS`
- `LoopAlreadyRunningError` によるデーモン多重起動防止
- デフォルト実行間隔を5分→1分に、最小許容値10秒のフロア/警告
- **SIGTERM/SIGINTでデーモンプロセスが実際に終了しない致命的バグの修正**（`isLoopDaemonProcess`判定+`process.exit()`）
- **`BACKGROUND_MAX_SESSION_TURNS=8`**によるバックグラウンド実行専用のターン上限（サブエージェント機能自体は無制限のまま維持）

上記のうち後半2件は本レポート作成時点で未コミット（テスト未追加）。セクション9の指摘事項（特に1〜3）は、現行のfeatureブランチのスコープを超える可能性があり、着手前にユーザーの判断を仰ぐ。
