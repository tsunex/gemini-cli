# Task 16: `/loop status` にウォッチドッグ復旧までの客観的カウントダウンを表示

## 背景

Task 15 でウォッチドッグ（`BACKGROUND_RUN_TIMEOUT_MS`、既定5分）を実装した後、
`/loop status` は「last activity
N秒前」しか表示しておらず、ユーザーが「これはハングしているのか、単に時間のかかるタスクを実行中なのか」を判断する材料が乏しかった。

当初、「N秒以上活動が無ければ "stuck" とみなす」という固定閾値の表示案を検討したが、ユーザーから「それは汎用的にできなくないか？」との指摘があった。単純なファイル確認と複雑な調査ではタスクの所要時間が大きく異なるため、経過時間だけで「詰まっている」と決めつける閾値は本質的に恣意的であり、誤ったユーザー判断を誘発しかねない。

## 目的

「詰まっているかどうか」の主観的な判定をツール側で行うのではなく、既存の客観的な定数（`BACKGROUND_RUN_TIMEOUT_MS`、= ウォッチドッグが実際に
`abort()`
して自動リトライに入るまでの時間）を使い、「あと何秒で自動復旧するか」という客観的なカウントダウンとして提示する。「詰まっている」の判断自体はユーザーに委ねる。

## 設計

- `packages/core/src/services/loopScheduler.ts` から `BACKGROUND_RUN_TIMEOUT_MS`
  を `packages/core/src/index.ts` 経由で `packages/cli`
  から参照できるよう re-export する。
- `packages/cli/src/ui/commands/loopCommand.ts` の `/loop status` の「Currently
  executing」分岐で、`lastHeartbeatAt` から経過時間だけでなく
  `BACKGROUND_RUN_TIMEOUT_MS - 経過時間` を計算し、
  `will auto-recover in Ns if it stays silent` の形で表示する。

## 実装対象

- `packages/core/src/index.ts`: `BACKGROUND_RUN_TIMEOUT_MS` の re-export 追加。
- `packages/cli/src/ui/commands/loopCommand.ts`: カウントダウン表示ロジック追加。
- `packages/cli/src/ui/commands/loopCommand.test.ts`: カウントダウン表示を検証するテストを追加、既存モックの
  `vi.mock('@google/gemini-cli-core', ...)` ファクトリに
  `BACKGROUND_RUN_TIMEOUT_MS` を追加（追加しないと import が `undefined`
  に解決され、当該コードパスを通すテストが無い限り無言で壊れる）。

## 実行結果

2026年8月31日、設計通り実装完了。

- `packages/core/src/index.ts`: `BACKGROUND_RUN_TIMEOUT_MS` を re-export。
- `packages/cli/src/ui/commands/loopCommand.ts`: 「last activity Ns ago; will
  auto-recover in Ns if it stays silent」の客観的カウントダウン表示を追加。
- テスト: 新規1件（カウントダウン表示の検証）を含め **12/12 テスト合格**。
- `npm run build -w @google/gemini-cli-core` を先に実行しないと `packages/cli`
  の `tsc --noEmit`
  が新規エクスポートを認識できない（既知のビルド順序の落とし穴。Task
  13 で一度経験済み）ことを再確認し、正しい順序（core build → cli
  typecheck）で実施。
- `npx tsc --noEmit -p packages/cli/tsconfig.json`: クリーン。
- `eslint`: クリーン。
- `npm run build -w @google/gemini-cli`: 成功。

これにより、ユーザーが `/loop status`
を見た際に「あと何秒で自動復旧するか」という客観的な情報を得られるようになり、恣意的な閾値によるツール側の誤判定を避けつつ、最終判断をユーザーに委ねる設計とした。
