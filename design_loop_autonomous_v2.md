# `/loop` 自律動作（バックグラウンド常駐）実現のための設計書 v2

**作成日**: 2026-08-31 **関連ドキュメント**:
`design_loop_background.md`（初版設計）,
`task_01.md`〜`task_11.md`（調査・修正の経緯）
**対象ブランチ**: 作業ツリー（`feature/useQuotaAndFallback`
上に未コミットで置かれた loop 関連変更）, 比較対象
`feature/loop-command`（および関連フォーク `myfork/loop-command`,
`myfork/gcli_loop`）

---

## 1. 背景と結論の要約

ユーザー報告「gemini-cli が自律動作できない（`/loop`
のバックグラウンド実行が継続しない）」について、 `task_01.md`〜`task_11.md`
の一連の調査・修正記録と、実際のソースコード・Git 履歴を突き合わせて検証した。

**結論（先出し）**:

`/loop --background` が自律動作できない根本原因は、単一のバグではなく、次の
**5つの独立した欠落** が積み重なった結果である。

1. **アーキテクチャ上の欠落**: 現在作業ツリーにある実装は `setTimeout`
   による**インプロセス・スケジューラ**のみであり、OS レベルで独立した「デーモンプロセス」が存在しない。対話型 CLI（親プロセス）が終了すればタイマーは消滅する。
2. **プロセス管理上の欠落（本件で新たに判明）**: 上記の問題を解決する**デーモン化の実装（`startDaemon`/`stopDaemon`/detached
   spawn）が、実は既に別ブランチ `feature/loop-command`
   に存在する**にもかかわらず、直近の task_01〜task_08 の調査・修正はすべてそれとは異なる作業ツリー（`feature/useQuotaAndFallback`
   上の未コミット変更、かつ `feature/loop-command` の古い WIP コミット
   `a3407deff`
   がベース）に対して行われており、両者が**統合されないまま並行して分岐**している。
3. **排他制御の欠落**: どちらの実装にも、二重起動を防ぐプロセスロック（PID ファイル等）が無い。
4. **耐障害性の欠落**: エラー時のリトライ上限・バックオフが無く、"無限即時リトライ"（現行ブランチ）または "エラー時は無言で恒久停止"（`feature/loop-command`）のいずれかに倒れている。
5. **非対話（headless）復元の欠落**: `state.json`
   からのスケジュール復元は対話モード起動時のみ行われ、ヘッドレス実行や真の意味でのデーモン起動導線（`loop daemon`
   サブコマンド）が現行作業ツリーには存在しない。

つまり
**「task_xx.md に何が不足しているか」への回答は、個々のバグ修正が不足しているのではなく、「すでに存在する、より完成度の高い実装（`feature/loop-command`）を発見・参照・統合するプロセスが調査タスクの中に組み込まれていなかったこと」が最大の欠落である**。task_08 は原因究明としては的確だが、「他ブランチの既存資産の棚卸し」を行っていないため、車輪の再発明と部分修正の繰り返しに陥っている。

---

## 2. 現状調査の詳細（証跡）

### 2.1 task_xx.md のタイムライン整理

| Task                         | 内容                                                               | 成果                                                                                                 | 未達事項                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task_01                      | `npm install` ハング調査                                           | ハングなしと結論。`design_loop_background.md` との関連性は「不明」で終了                             | 本来ここで loop 機能の設計調査に踏み込むべきだった                                                                                                                           |
| task_02                      | loop 機能のユニットテスト実行確認                                  | 18/18 テスト成功、lint/typecheck もクリーン                                                          | テストが通ることと「実運用で自律動作するか」は別問題であることの検証が無い                                                                                                   |
| task_03                      | `loopScheduler.ts` を `spawn`+`stdio:'inherit'` 方式へリファクタ   | 子プロセス生成方式に変更                                                                             | `stdio:'inherit'` は親ターミナルに接続されたままであり、**親が終了すれば道連れで終了する**（真のデタッチではない）                                                           |
| task_04                      | YOLO モードでの自己停止シナリオの手動検証                          | `state.json` 復活によるフォークボム的無限ループ機構を発見・修正（存在チェックガード追加）            | 手動検証が「人間の張り付き」を要求する時点で自律動作の検証になっていない                                                                                                     |
| task_04_manual_test_scenario | 手動テスト手順書                                                   | -                                                                                                    | 人手を要する時点でそもそも「自律」の検証ではない                                                                                                                             |
| task_05                      | `text.txt` に `hello` を追記                                       | 完了                                                                                                 | loop 機能と無関係                                                                                                                                                            |
| task_06                      | ビルド失敗修正（`Config` 引数必須化による513件のコンパイルエラー） | `config` を optional 化して復旧                                                                      | loop 機能側の設計不足とは無関係だが、**マージ元 `issue-22092` との統合作業が発生している = 複数ブランチの同時進行が常態化している証拠**                                      |
| task_07                      | `SIGINT`/`SIGTERM` が `state.json` を削除するバグ修正              | `clearTimer()` と `clearState()` を分離                                                              | 対症療法。「なぜプロセス終了時にタイマーが消えること自体が問題なのか」という**デーモン化の必要性**には踏み込んでいない                                                       |
| task_08                      | 「なぜ loop が実行されないか」の根本原因の総括                     | 4つの欠陥（自動復元漏れ、catch内リスケジュール漏れ、排他制御なし、危険なデフォルト間隔）を的確に指摘 | **調査のみでコード修正タスクに接続されていない。また `feature/loop-command` という、デーモン化を含むより進んだ実装がリポジトリに存在する事実に一切言及がない**（棚卸し不足） |
| task_09                      | OSS-3524 Tomcat 脆弱性調査                                         | 完了                                                                                                 | loop 機能と無関係（無関係タスクが同一ディレクトリに混在し、`task_xx` の連番が loop 機能の追跡に使えなくなっている）                                                          |
| task_11                      | `Daily-VulnFeed.sh` 修正                                           | -                                                                                                    | loop 機能と無関係                                                                                                                                                            |

### 2.2 実装コードの直接検証結果

- **現行作業ツリー**（`git status` で `M` = 未コミット）:

  - `packages/core/src/services/loopScheduler.ts`:
    task_04 の自己停止ガード、task_08 指摘②に対応する catch 内リスケジュールは実装済み。ただし
    **デーモン化なし**（`spawn` を使わず `setTimeout` のみ）。
  - `packages/cli/src/gemini.tsx`: `config.isInteractive()` の場合のみ起動時に
    `loadLoopState()` → `scheduleLoop()`
    で復元するロジックが**追加済み**（task_08 指摘①への対応と思われるが、対応する task ファイルが存在せず、誰がいつ何のために直したか記録されていない =
    **野良修正**）。
  - `packages/cli/src/ui/commands/loopCommand.ts`: デフォルト間隔は
    `300000`（5分）に安全化済み（task_08 指摘④への対応、これも対応する task ファイルなし）。
  - **プロセスロック（排他制御）は存在しない**（task_08 指摘③は未対応のまま）。
  - **`loop daemon` サブコマンドや detached spawn の導線は存在しない**
    → 対話型 CLI プロセスが生きている間しかバックグラウンド実行は継続しない。

- **`feature/loop-command` ブランチ**（`git log HEAD..feature/loop-command`
  で確認できる直近4コミット）:
  - `c7325220e feat(loop): implement auto-start, detached daemon, and real-time IPC notification`
  - `880e4d7dd fix(loop): daemon auth and notification`
  - `8a3f40135 feat(loop): inject loop notifications into conversation context`
  - `0eccd25b1 fix(loop): prevent background daemon from corrupting notification socket`
  - このブランチでは `startDaemon()` / `stopDaemon()` / `isDaemonRunning()`
    が実装され、
    `spawn(nodeBin, [scriptPath, 'loop', 'daemon'], { detached: true, stdio: 'ignore' })` +
    `child.unref()`
    による**真の意味でOSプロセスとして独立したデーモン**が実現されている。
  - `gemini.tsx` に
    `process.argv.includes('loop') && process.argv.includes('daemon')`
    の分岐があり、 `gemini loop daemon` として単体起動できる導線が存在する。
  - ループ結果は Unix ドメインソケット（`notification.sock`）経由で親の対話 CLI（起動していれば）に IPC 通知される（`notificationClient.ts`
    → `notificationServer.ts` → `MessageBus` → `useLoopNotificationListener.ts`
    →会話コンテキストへの注入）。
  - **ただし** このブランチには以下の欠落がある:
    - デフォルト間隔が
      `5000`（5秒）のままで、task_08 指摘④（危険なデフォルト）が**未修正**。
    - `catch`
      ブロックでのリスケジュールが**行われない**（エラー発生で恒久停止する。task_08 指摘②が未修正）。
    - `startLoopDaemon()` 呼び出し前に `isLoopDaemonRunning()`
      を確認していない（多重起動ガードの実装はあるのに呼び出し側で使われていない。task_08 指摘③が実質未修正）。

### 2.3 結論の裏付け

現行作業ツリーと `feature/loop-command`
は、**互いに相手側でのみ修正済みの欠陥を抱えたまま**、別々の道筋で
`a3407deff`（共通の祖先コミット）から分岐して進化している。どちらか一方だけを直しても自律動作は実現しない。両方の良いとこ取りをする统合作業が必要。

---

## 3. 自律動作に必要な要件の棚卸し（要件充足マトリクス）

| #   | 要件                                           |               現行作業ツリー               |                   `feature/loop-command`                    | 統合後の対応方針                                                                                                |
| --- | ---------------------------------------------- | :----------------------------------------: | :---------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------- |
| R1  | 親（対話）プロセス終了後も実行が継続する       |                     ❌                     |                   ✅ (`detached`+`unref`)                   | `feature/loop-command` の `startDaemon` を採用                                                                  |
| R2  | CLI 再起動時に前回のスケジュールを自動復元する |            △（対話モードのみ）             |           ❌（未検証・デーモン監視前提で別実装）            | デーモンの生存確認 (`isDaemonRunning`) を起点に、死んでいれば再 `startDaemon`、生きていれば何もしない設計に統一 |
| R3  | ヘッドレス/非対話実行でも動作する              |                     ❌                     |             ✅ (`gemini loop daemon` 単体起動)              | 採用                                                                                                            |
| R4  | 二重起動を防ぐ排他制御                         |                     ❌                     |              △（関数はあるが呼び出し側未使用）              | `startLoopDaemon()` の先頭で `isLoopDaemonRunning()` を必須チェックに変更                                       |
| R5  | エラー時に恒久停止しない（再試行/バックオフ）  |       ✅（ただし無制限即時リトライ）       |              ❌（catch 内リスケジュール無し）               | 両者を統合し、**上限付き指数バックオフ**を新設計として導入（詳細は4.4節）                                       |
| R6  | 危険なほど短いデフォルト間隔を回避する         |               ✅ (300000ms)                |                         ❌ (5000ms)                         | 現行作業ツリーの値を採用                                                                                        |
| R7  | 実行結果をユーザーに通知/会話へ反映する        | △（`coreEvents` 経由、プロセス生存中のみ） |        ✅ (IPC ソケット経由、プロセスをまたいで到達)        | 採用                                                                                                            |
| R8  | `loop status` がデーモンの実生存確認を伴う     |       ❌（`state.json` の有無のみ）        |        ✅ (`isLoopDaemonRunning()` で PID 生存確認)         | 採用                                                                                                            |
| R9  | 変更が正しいブランチ/PRフローに乗っている      |     ❌（未コミット、無関係ブランチ上）     | ✅（`feature/loop-command` 上、ただし本体 `main` 未マージ） | 4.1節の統合戦略で解消                                                                                           |

---

## 4. 設計方針

### 4.1 ブランチ統合戦略（最優先・非コード作業）

自律動作を実現する前提として、まず「どこで直すか」を確定させる。

1. 現行作業ツリーの未コミット変更（`loopScheduler.ts`
   の catch 内リスケジュール、`gemini.tsx` の対話時復元、 `loopCommand.ts`
   のデフォルト間隔 300000ms 化）を、**`git stash`
   または一時ブランチに退避**して保護する（このまま放置すると
   `git checkout`/`git clean` で消失するリスクがある）。
2. `feature/loop-command`
   を最新の統合先ベースブランチとして採用し、そこに 1. の変更を
   **cherry-pick 相当で手動マージ**する。
3. 以後の `/loop` 関連タスクはすべて
   `feature/loop-command`（または、そこから切った新しい
   `feature/loop-command-v2`）上で行い、**現行作業ブランチ（`feature/useQuotaAndFallback`）へは loop 関連の変更を一切コミットしない**ことをチームルールとして明文化する。
4. task ファイルの命名を `task_loop_NN.md`
   のように機能名を含める形に改め、無関係タスク（OSS-3524調査、Daily-VulnFeed 修正等）と混在させない。

### 4.2 デーモンアーキテクチャ（`feature/loop-command` をベースに採用）

```
+-------------------+   /loop --background   +----------------------+
| 対話型 CLI (親)     | ----------------------> | startLoopDaemon()    |
| gemini             |                         | (排他確認→spawn)     |
+-------------------+                         +----------+-----------+
        ^                                                  |
        | IPC通知 (notification.sock)                       | detached, unref
        |                                                  v
+-------------------+                         +----------------------+
| notificationServer |  <--------------------- | gemini loop daemon   |
| (親プロセス内)      |   sendNotification()    | (完全に独立したOS    |
+-------------------+                         |  プロセス, state.json |
                                               |  を見て自走)         |
                                               +----------------------+
```

- `gemini loop daemon` は
  **親 CLI を必要としない完全に独立したプロセス**として動作し、 `state.json`
  を読み、`nextRun` まで待機 → 実行 → 結果を `notification.sock`
  へ送信（親が起動していれば届く。いなければ黙って `ECONNREFUSED` を握りつぶし
  `loop.log`
  にのみ記録）→ 自身のプロセス内で次回スケジュールをタイマーし直す、を繰り返す。
- 親 CLI（対話 UI）は、いてもいなくても良い「ビューア」の位置づけに変える。これにより
  **R1・R3 を満たす**。

### 4.3 排他制御（プロセスロック）

- `state.json` に `pid` フィールドを保持する現行 `feature/loop-command`
  の設計を維持しつつ、 `startLoopDaemon()`
  の**入口**で必ず以下を行う（現状は関数があるだけで呼ばれていないため、これが本質的な修正）:

  ```ts
  export function startLoopDaemon(state: LoopState, config: Config): void {
    if (isLoopDaemonRunning()) {
      throw new LoopAlreadyRunningError(
        `Loop daemon is already running (PID: ${loadState()?.pid}). ` +
          `Run "/loop stop" first if you want to reschedule.`,
      );
    }
    // ...既存の spawn 処理
  }
  ```

- `loopCommand.ts` 側は `LoopAlreadyRunningError`
  を捕捉し、ユーザーにエラーメッセージとして提示する（黙って上書きしない）。これにより
  **R4 を満たす**。
- 単純な `process.kill(pid, 0)` による生存確認は **PID 再利用（PID recycling）**
  による誤検知の可能性がゼロではない。将来的な堅牢化案として、`state.json` に
  `startedAt`
  タイムスタンプとプロセスの起動コマンドライン（`/proc/<pid>/cmdline`
  が読める環境限定）を併記し、両方が一致する場合のみ「生存」とみなすオプションを追加する（v3 検討事項とし、本設計では必須要件としない）。

### 4.4 耐障害性（リトライ・バックオフ）

現行2実装の「無制限即時リトライ」と「エラーで恒久停止」はどちらも極端であるため、新規に以下を導入する。

- `LoopState` に `retryCount: number`（デフォルト `0`）と `lastError?: string`
  を追加。
- 正常終了時: `retryCount` を `0` にリセットして次回を `intervalMs`
  後にスケジュール（現行仕様どおり）。
- 異常終了時（`catch` ブロック）:
  - `retryCount` をインクリメントして `state.json` に保存。
  - 次回実行までの遅延を
    `Math.min(intervalMs * 2 ** retryCount, MAX_BACKOFF_MS)` （`MAX_BACKOFF_MS`
    は例えば 30 分）で計算し再スケジュール（指数バックオフ）。
  - `retryCount` が
    `MAX_RETRY_COUNT`（例えば 10 回）を超えた場合は自動停止し、`loop.log`
    に「連続エラーのため自動停止しました。`/loop status`
    で詳細を確認し、問題を解決後に再度 `/loop --background`
    を実行してください」という趣旨のメッセージを残す。**恒久的な無言停止ではなく、ユーザーが気づける形の停止**にする。
- これにより **R5 を満たす**。

### 4.5 スケジュール復元とデーモン生存監視（R2）

- 対話型 CLI 起動時（`config.isInteractive()` の分岐）に、単純に
  `scheduleLoop()` （インプロセス
  `setTimeout`）を呼ぶ現行実装を廃止し、次のロジックに置き換える:

  ```ts
  const loopState = loadLoopState();
  if (loopState) {
    if (isLoopDaemonRunning()) {
      // 既にデーモンが生きている。何もしない（インプロセスで二重管理しない）。
    } else {
      // state.json はあるがデーモンが死んでいる（例: OS再起動、kill -9等）。
      // ユーザーに確認の上、再起動するかどうかは既定でデーモンを再起動する。
      startLoopDaemon(loopState, config);
      debugLogger.info('Restored orphaned loop daemon on startup.');
    }
  }
  ```

- これにより「インプロセスタイマー」と「デーモン」の二重の実行系統が同時に存在する状態を排除し、
  **常にデーモンプロセスのみが実行主体である**という単純な状態機械にする。

### 4.6 通知 IPC（R7・R8）の継続採用と拡張

- `feature/loop-command` の `notification.sock` 経由の IPC はそのまま踏襲する。
- `/loop status` コマンドは `isLoopDaemonRunning()`
  による実プロセス生存確認結果を必ず表示に含める（`state.json`
  の有無だけで「スケジュール中」と表示する現行の欠陥を修正、**R8**）。

### 4.7 セキュリティ・安全性についての注記

- デーモン実行は `ApprovalMode.YOLO`
  を強制する設計が既存にある。これはバックグラウンドで人間の確認を挟めない以上妥当だが、**ユーザーには
  `/loop --background`
  実行時に「以後の全ツール呼び出しは自動承認されます」という明示的な警告を表示する**ことを新規要件として追加する（現行 UI メッセージには明記がない）。
- デーモンプロセスは `env` から `GEMINI_CLI_`
  プレフィックスの環境変数を除去する実装が既に `feature/loop-command`
  にあるが、その意図（セッション競合防止）をコードコメントに残し、レビュー時に消されないようにする。

---

## 5. 実装タスク分解（`task_loop_NN.md` として起票することを推奨）

| Task         | 内容                                                             | 完了の定義 (DoD)                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| task_loop_01 | ブランチ統合: 現行未コミット変更を `feature/loop-command` へ移植 | `git diff` で両ブランチの loop 関連差分がゼロになり、`npm run preflight` がグリーン                                                                                                  |
| task_loop_02 | `startLoopDaemon()` に排他チェックを追加（4.3節）                | 二重起動時にエラーが返り、既存デーモンが生存し続けることをユニットテストで確認                                                                                                       |
| task_loop_03 | `retryCount` / 指数バックオフ / 上限停止の実装（4.4節）          | 連続エラーを注入するテストで、指定回数後に自動停止しログが残ることを確認                                                                                                             |
| task_loop_04 | 起動時復元ロジックをデーモン生存確認ベースに刷新（4.5節）        | デーモン強制終了(`kill -9`)後にCLI再起動 → 自動的にデーモンが復活することを結合テストで確認                                                                                          |
| task_loop_05 | `/loop status` にデーモン生存確認を統合（4.6節）                 | `state.json` は存在するがプロセスが死んでいる場合に「Stopped/Dead」を表示することを確認                                                                                              |
| task_loop_06 | YOLO 警告メッセージの追加（4.7節）                               | `/loop --background` 実行直後の応答メッセージに承認モードの警告文が含まれることをスナップショットテストで確認                                                                        |
| task_loop_07 | 統合テスト: 端末を閉じてもループが継続することの自動検証         | `integration-tests/loopDaemon.test.ts` で、子プロセスとして CLI を起動→`/loop --background`実行→**親プロセスをkillしてから**一定時間待ち、`loop.log`に新規実行が記録されることを確認 |
| task_loop_08 | ドキュメント更新                                                 | `docs/` 配下に `/loop` のユーザー向け説明を追加・更新（`docs-writer` skill を使用）                                                                                                  |

---

## 6. リスクと軽減策

| リスク                                                                         | 軽減策                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ブランチ統合時のコンフリクト（`loopScheduler.ts` はほぼ全面書き換えになる）    | 4.1節の手順に従い、まず現行差分を隔離してから、`feature/loop-command` 側をベースに手動で再適用する（自動マージに頼らない）                                                            |
| デーモンプロセスが `kill -9` された場合に `state.json` の `pid` が古いまま残る | `isLoopDaemonRunning()` は毎回 `process.kill(pid, 0)` で生存確認するため、次回参照時に自動的に「Dead」と判定される。追加対応不要                                                      |
| バックグラウンドYOLO実行によりユーザーの意図しない破壊的操作が自動承認される   | 4.7節の警告表示に加え、将来的に「破壊的コマンド（`rm`, `git push --force`等）はバックグラウンドループでは拒否する」ポリシーの追加を別タスクとして検討（本設計のスコープ外として明記） |
| task ファイルの散逸が今後も続く                                                | 5節のとおり `task_loop_NN.md` 命名規則を導入し、無関係タスクと分離する                                                                                                                |

---

## 7. 未確認・要確認事項（ユーザーへの確認推奨）

1. `feature/loop-command` ブランチは
   `myfork`（個人フォーク）側にも存在し、`origin`（本家
   `google-gemini/gemini-cli`）には存在しない。本機能を upstream にコントリビュートする想定か、社内/個人利用のみのフォーク機能として維持する想定か方針確認が必要（CONTRIBUTING.md の CLA 要件にも影響）。
2. 現行作業ツリーの未コミット変更（`loopScheduler.ts`, `gemini.tsx`,
   `loopCommand.ts` ほか)は、`git stash` 等で保護しない限り `checkout`
   等の操作で失われる状態にある。至急のバックアップを推奨。
3. `MAX_RETRY_COUNT` や `MAX_BACKOFF_MS`
   の具体値は暫定値。実運用のAPIレートリミット仕様に応じて調整が必要。
