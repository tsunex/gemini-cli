# OpenClaude 自律的バックグラウンド実行（内部Cron ＆ メッセージ自動実行キュー）詳細分析調査レポート

本レポートは、`~/workfolder/openclaude/src`
以下の全関係ファイルを1行ずつ精読・解読し、OpenClaudeが人間との並行会話やキー入力を1ミリも邪魔することなく、5分ごとの裏での「ファイル自動監視・自律停止・お知らせ発話」を安全に可能にしているアーキテクチャの全容を、推論を一切排除した「厳密な事実コード定義」としてまとめたものである。

---

## 1. 自動監視タスク（内部Cron）のデータ構造と管理仕様

OSのcronデーモンではなく、アプリケーション（Node.jsプロセス）が起動している間だけ、裏で静かに秒単位で監視を回すインプロセス型のタイマースケジュールとして設計されている。

### A. タスクオブジェクトのデータ型定義

- **ファイル:** `src/utils/cronTasks.ts`（ライン29〜70付近）
- **物理型定義 (`CronTask`):**
  ```typescript
  export type CronTask = {
    id: string; // 一意なタスクID (UUID)
    cron: string; // 5フィールド構成のcron表現 (M H DoM Mon DoW)
    prompt: string; // 発火時にキューに注入するプロンプト本体
    createdAt: number; // タスク作成時のEpochミリ秒
    lastFiredAt?: number; // 直近で発火したEpochミリ秒（永続化のアンカー）
    recurring?: boolean; // true = 繰り返しタスク、false = 1回限りの使い捨て
    permanent?: boolean; // true = 自動消去（寿命）の対象外
    durable?: boolean; // true = ディスクに永続化、false = セッション限定のインメモリ保持
    agentId?: string; // 作成元のインプロセス・チームメンバー（エージェント）ID
  };
  ```

### B. タスクの永続化・ロード仕様

- **ファイル:** `src/utils/cronTasks.ts`
- **永続化先:** デフォルトではプロジェクトのルート配下の
  `.openclaude/scheduled_tasks.json` に保存される（ライン72付近
  `getCronFilePath`）。
- **セッション限定（`durable: false`）タスクの隔離:** `durable` が
  `false`（または未定義）のタスクは、ディスクファイル（`.openclaude/...`）には一切書き込まれず、`src/bootstrap/state.js`
  の `addSessionCronTask`
  を介して、親のプロセス（メインセッション）のインメモリ・ステート上にのみ安全に隔離保持され、セッション終了とともに自動消去される。

---

## 2. 1秒に1回の「チェック・ティックループ」設計仕様

OSの別プロセスを起動することなく、親プロセスの背後で1秒ごとにスケジュールを評価する軽量なインメモリスケジューラ。

### A. スケジューラの状態管理

- **ファイル:** `src/utils/cronScheduler.ts`（ライン47〜58付近）
- **内部ステート:**
  - `tasks: CronTask[]`: 読み込まれたタスクの一覧。
  - `nextFireAt = new Map<string, number>()`: タスクIDごとの「次回発火予定時刻（Epochミリ秒）」。
  - `inFlight = new Set<string>()`: 現在発火中でクリーンアップ処理（ディスク削除等）を待っているタスクID（二重発火を物理的に防ぐ安全装置）。
  - `checkTimer`: 1000ms（1秒）間隔で `check()` を回すための `setInterval`
    インスタンス（ライン37 `CHECK_INTERVAL_MS`）。

### B. 発火時のコールバックとタイマーストップ仕様

- **ファイル:** `src/utils/cronScheduler.ts`（ライン183〜268付近 `check()`
  および `process()` 関数）
- **発火のチェックロジック:**
  - 1秒ごとに `check()` が回り、現在の時刻 `now = Date.now()` が、タスクの
    `nextFireAt` 予定時刻を超えているかを評価。
  - 時刻を超えた場合、`onFire(t.prompt)`（または
    `onFireTask(t)`）コールバックを非同期で実行する。
- **使い捨て（one-shot）タスクの自動消去:**
  - 発火したタスクが
    `recurring: false`（1回限り）の場合、発火と同時に、インメモリ（セッションタスクの場合）またはディスク（ファイルタスクの場合）から即座にタスクIDが削除される：
    ```typescript
    // セッション限定タスクの場合 (ライン324付近)
    removeSessionCronTasks([t.id]);
    nextFireAt.delete(t.id);
    ```
    これにより、1回発火したら二度と自動スケジュールされない自律消去（Self-Stop）が確実に完了する。

---

## 3. キー入力妨害を防ぐ「優先度 `later`」自動キューイング仕様

タイマー発火時に直接LLMを起動すると、ユーザーがメッセージをタイピングしている目の前のUI（キーフォーカス、`rawMode`）を完全に破壊・リセットしてしまいます。OpenClaudeは、**メッセージキュー（`commandQueue`）**
を使って、完全に非干渉で自動送信させる設計を採用している。

### A. キューへの非表示・後回し（`later`）登録

- **対話型（REPL/TUI）モードにおける発火ハンドラ:**
  `src/hooks/useScheduledTasks.ts`（ライン50〜100付近）
- **非対話（SDK/-p）モードにおける発火ハンドラ:**
  `src/cli/print.ts`（ライン2895〜2920付近）
- **仕様:**
  5分が経過しタイマーが発火した際、直ちに送信処理を走らせるのを完全にやめ、メッセージキューへプロンプトを
  **`isMeta: true` かつ 優先度 `'later'`** として Enqueue（注入）する：
  ```typescript
  // useScheduledTasks.ts (ライン53付近)
  const enqueueForLead = (prompt: string) =>
    enqueuePendingNotification({
      value: prompt,
      mode: 'prompt',
      priority: 'later', // 優先度：後回し
      isMeta: true, // 画面非表示フラグ
      workload: WORKLOAD_CRON,
    });
  ```

### B. ターンの合間（Between Turns）の自動実行（Drains）

- **ファイル:** `src/utils/messageQueueManager.ts` および
  `src/cli/print.ts`（ライン2121付近 `drainCommandQueue`）
- **キューの優先度設計:** `commandQueue`
  は、優先度によってデキュー順序を決定している。
  - `'now' > 'next' > 'later'`
- **挙動:** 監視タスクは `'later'`
  に設定されているため、ユーザーが別メッセージを入力中、またはAIが回答ストリーミング中の間は、絶対にキューから取り出されません。親プロセスが応答を完了し、**TUIが完全に「Idle（入力待ち）」状態になった最初の安全な瞬間**にのみ、キューから自動送信（`submitQuery`）がトリガーされ、会話の合間で静かに実行される。これにより、ユーザーのタイピングが妨害されることは物理的に100%発生しない。

---

## 4. 会話汚染・トークン爆発を防ぐ「非表示メッセージ (`isMeta: true`)」システム

5分ごとの空振りの進捗ログ（「ファイルはありませんでした」など）が画面に現れると画面が埋め尽くされ、LLMのトークン制限（Context
Window）が数時間でパンクします。これを防ぐため、**「非表示（Meta）メッセージ」**というデータ構造がクエリエンジンに極めて精緻に組み込まれている。

### A. メッセージオブジェクトの定義

- **ファイル:** `src/types/message.ts`（ライン99, 175, 207付近）
- **仕様:** `UserMessage`、`AssistantMessage`、`SystemMessage`
  のすべてのメッセージ型に `isMeta?: boolean` が定義されている。
  ```typescript
  export interface Message {
    type: string;
    isMeta?: boolean;
  }
  ```

### B. TUI レンダラーによる画面描画の完全スキップ

- **ファイル:** `src/components/Messages.tsx`（ライン146付近）および
  `src/components/VirtualMessageList.tsx`（ライン148付近）
- **仕様:** 画面に会話履歴をレンダリングする際、メッセージの `isMeta` が `true`
  の場合、**画面（UI）への出力を完全にバイパス**する：
  ```typescript
  if (msg.isMeta || msg.isVisibleInTranscriptOnly) {
    return null; // チャットの画面上には1文字も出力しない（完全サイレント）
  }
  ```
  これにより、裏で何十回監視が回ろうとも、ユーザーのチャット画面は完全にクリーンなまま維持される。

### C. クエリ実行中の一貫した `isMeta` の伝播（芋づる式非表示）

ユーザーから送られたプロンプトが `isMeta: true`
だった場合、そこから派生して発生したLLMの回答（`AssistantMessage`）や、ツール実行結果（`tool_result`）のメッセージオブジェクトに対しても、一貫して
`isMeta: true`
が引き継がれ、裏でのチェックが完全にサイレントに完結するよう、クエリエンジン内で伝播ロジックが完璧に組まれている。

- **ファイル:** `src/QueryEngine.ts`（ライン430付近
  `isMeta: options?.isMeta`, ライン596付近 `isSynthetic: msg.isMeta`）および
  `src/query.ts`
- **仕様:**
  - `processUserInput` において、`isMeta: options?.isMeta` が伝播して
    `UserMessage` が生成される。
  - クエリエンジンの実行中、`msg.isMeta`
    を判定してメッセージを処理し、モデルに渡す一時的な文脈メッセージ
    `requestOnlyMessages` を構築（`query.ts`）。
  - 生成されるアシスタントメッセージ（`AssistantMessage`）にも、直前のコンテキストを引き継ぎ
    `isMeta: true`
    がセットされる。これにより、LLMの「ファイルはありませんでした」という空振り応答も、画面に一切表示されず、履歴の残骸にならずにシングルターンで安全にパージされ、トークン消費量を常に1ターン分に抑え込む。

---

## 5. 目標達成時の「自律停止（Self-Stop）」と「お知らせ発話」の連動設計

人間が `touch text.txt`
などでファイルを作成し、5分後の次のタイマーで裏の非表示チェック（`isMeta: true`）が実行された際、自律停止とお知らせが極めてエレガントに発火する。

### A. 自動消去（Self-Stop）の実行

- **仕様:** 監視プロンプト（`isMeta: true`）を実行し、カレントに `text.txt`
  が存在することを発見したLLMは、指示に従って **`CronDeleteTool`
  (`cron-delete`) をツールコールし、自らこのタイマースケジュールをファイルおよびメモリから自動消去・完全停止**する。

### B. 通常メッセージによる自発的お知らせ（Proactive Trigger）

- **仕様:** スケジュールを自律消去（停止）させた瞬間、LLMは **`isMeta: false`
  (通常のメッセージとしてお喋りする)**
  として応答（Response）を作成して yield（出力）する：
  ```text
  [Geminiの自動作成レスポンス]
  「カレントに text.txt が作成されたのを確認いたしました！監視タスクを自動停止し、Loopを終了します。」
  ```
  この「最終結果のお知らせ」は、`isMeta` が
  `false`（または未定義）であるため、TUIの描画スキップフィルターを回避し、**チャット画面上に綺麗に表示され、ユーザーに自発的なお知らせ（Proactive
  Trigger）が安全に、最高の体験として届けられる。**

---

_作成日: 2026-08-07_  
_詳細分析著者: tsuneokam / Gemini CLI Agent_  
_技術分析リファレンス: OpenClaude / Claude Code Message & Queue Query Engine_
