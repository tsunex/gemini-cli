# Task 17: 完了ゲート指示に「不要なサブエージェント委譲の抑止」を追加

## 背景

Task 09〜16 で report_11.md
§9 の6項目・ウォッチドッグ・状態表示改善まで実装した後、ユーザーから「これを自律的に起こさせたいわけよ。zero や openclaude みたいに。」との要望があり、実地の
`/loop --background` 実行を継続的に監視した。

観測されたパターンは一貫していた:

1. モデルが `text.txt` の存在を検知する。
2. モデルが「直接の削除ツールが無い」と判断し、`invoke_agent` で `generalist`
   サブエージェントへ処理を委譲する。
3. `generalist` は `runConfig: { maxTimeMinutes: 10, maxTurns: 20 }`
   で動作するが、委譲元の1バックグラウンド実行自体は8ターンの上限を持ち、サブエージェント呼び出し自体で丸ごと使い切ってしまう（`MAX_TURNS_EXCEEDED`）。
4. 完了シグナル無しのため `rescheduleAfterSetback` へフォールバックし、
   `retryCount`
   が加算されて再試行されるが、次回も全く同じ委譲パターンを繰り返す。

`packages/core/src/config/config.ts` を確認したところ、`WriteFileTool` /
`ShellTool` は既定で登録されており、バックグラウンド用にフォークされた `Config`
にも継承される（`coreTools`/`excludeTools` によるツール制限は
`.gemini/settings.json` にも `~/.gemini/settings.json`
にも見当たらない）。つまり、モデルが「直接のツールが無い」と述べているのは実際のツール未登録ではなく、プロンプト/振る舞い上の問題である。

なお `generalist` サブエージェント自身の `description`
（`generalist-agent.ts`）は「ターン数の多いタスクに強く推奨」という誘引的な文言であり、単純なタスクでも過剰に委譲される一因と考えられるが、今回は通常利用（バックグラウンドループ以外）への影響を避けるため、サブエージェントの説明文自体は変更せず、バックグラウンドループ専用の完了ゲート指示文だけを修正する方針とした。

## 目的

バックグラウンドループの完了ゲート指示に、「YOLO モードで既に直接ツールへアクセスできる」「単純・単一ステップの操作（存在確認、単一ファイル削除、単一シェルコマンド実行など）は自分で直接実行し、`invoke_agent`
へ委譲しない」ことを明示的に指示することで、不要な委譲によるハング様の停止とターン上限超過を抑止する。

## 設計

- `packages/core/src/services/loopScheduler.ts` の
  `buildCompletionGateInstruction()` を書き換え、以下を明示する:
  - 既に YOLO（フル自動承認）モードでファイル読み書き・シェル実行等の全ツールに直接アクセスできること。
  - 単純・単一ステップ・低ターン数の操作は
    `invoke_agent`/サブエージェントに委譲せず、自分で直接ツールを呼ぶこと。
  - サブエージェント委譲は、委譲している間ストリームに進捗が一切現れず（数分単位で）実行がブロックされ、かつこの実行の限られたターン予算を1回の呼び出しで消費してしまうため、本当に大規模・複数ファイル・高ターン数の作業のためだけに温存すること。
- 完了シグナルの仕組み自体（`<<<LOOP_TASK_COMPLETE>>>`）は変更しない。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`:
  `buildCompletionGateInstruction()` の書き換え。
- `packages/core/src/services/loopScheduler.test.ts`: 既存の「should schedule
  loop and run session」テストに、送信されるプロンプトが `invoke_agent`
  という語と「do not
  delegate」という趣旨の文言を含むことを検証するアサーションを追加。

## 実行結果

2026年8月31日、設計通り実装完了。

- `buildCompletionGateInstruction()` を書き換え、上記の委譲抑止指示を追加。
- テスト: 既存テストへのアサーション追加を含め、`loopScheduler.test.ts`
  全19件（Task 18分含む）が合格。
- `npx tsc --noEmit -p packages/core/tsconfig.json`: クリーン。
- `eslint`: クリーン。
- `npm run build -w @google/gemini-cli-core` /
  `npm run build -w @google/gemini-cli`: 成功。
- 本修正のみでの実地再検証（実際に `generalist` への不要委譲が止まるか）は Task
  19 完了後にまとめて実施する（次のステップとして明記）。
