# Task 18: サブエージェント委譲中であることを `/loop status` に可視化

## 背景

Task 17 でモデルへの指示を強化しても、正当な理由で（あるいは指示に従わず）
`generalist` サブエージェントへ委譲するケースは残り得る。`invoke_agent`
はアウターストリームから見ると完全に不透明な同期的ツール呼び出しであり、サブエージェント内部の各ターンのイベントはアウター側の
`for await (const event of stream)`
には一切流れてこない。そのため、正当な（実際には壊れていない）委譲であっても、数分間ハートビートが更新されず、Task
15のウォッチドッグが捉える「本当のハング」と外形上区別が付かない。

## 目的

`invoke_agent` への `tool_request` イベントを検知した時点で、その旨を
`state.json`（`/loop status` が参照する）と `loop.log`
の両方に記録し、「委譲中で、数分間無反応でも正常」であることをユーザーが判別できるようにする。

## 設計

- `LoopState` インターフェースに `currentAction?: string`
  フィールドを追加する（`isLoopState()` の型ガードにも対応するチェックを追加）。
- `schedule()`
  内のストリーム消費ループで、`event.type === 'tool_request' && event.name === 'invoke_agent'`
  を検知したら、
  `Delegating to subagent '${agentName}' (may take several minutes with no further activity)`
  という文字列を `loop.log` に記録し、
  `recordHeartbeat('running', currentAction)` 経由で `state.json`
  にも永続化する。
- `recordHeartbeat()` は第2引数 `currentAction?: string`
  を受け取るように拡張し、呼び出し側が渡さない場合は
  `undefined`（= クリア）として保存する。これにより、委譲イベントの次の通常イベントで自動的に
  `currentAction` がクリアされ、古い「委譲中」表示が居座らないようにする。
- `packages/cli/src/ui/commands/loopCommand.ts` の `/loop status` で、
  `state.currentAction` が存在すればそれを追加の行として表示する。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`:
  - `LoopState.currentAction?: string` フィールド追加。
  - `isLoopState()` に `currentAction` の型チェックを追加。
  - `recordHeartbeat()` のシグネチャ拡張。
  - ストリーム消費ループ内での `invoke_agent` 検知・ログ記録・ `recordHeartbeat`
    呼び出しへの反映。
- `packages/core/src/services/loopScheduler.test.ts`: `invoke_agent` の
  `tool_request`
  イベントを1件返してブロックするモックストリームを用意し、`state.json` の
  `currentAction` に `generalist` と `Delegating`
  の両方が含まれることを検証する新規テストを追加。
- `packages/cli/src/ui/commands/loopCommand.ts`: `state.currentAction` を
  `/loop status` の出力に追加する分岐を実装。

## 実行結果

2026年8月31日、設計通り実装完了。

- `loopScheduler.ts`: `currentAction` フィールド・型ガード・ `recordHeartbeat`
  拡張・`invoke_agent` 検知ロジックをすべて実装。
- テスト: 新規1件（委譲検知→`currentAction`永続化の検証）を追加し、
  `loopScheduler.test.ts` は Task 17 分のアサーション追加とあわせて
  **19/19 テスト合格**。
- `loopCommand.ts`: `/loop status` に「Delegating to subagent 'X' (may take
  several minutes with no further activity)」を追加表示する分岐を実装。既存の
  `loopCommand.test.ts`
  **12/12 テスト合格**（維持、新規の委譲表示専用テストは追加しなかった。カウントダウン表示のテスト（Task
  16）と重複するインフラを使うため、まずは `loopScheduler.test.ts`
  側の検証で担保した）。
- `npx tsc --noEmit -p packages/core/tsconfig.json` /
  `npx tsc --noEmit -p packages/cli/tsconfig.json`（core ビルド後）: いずれもクリーン。
- `eslint` （変更ファイル一式）: クリーン。
- `npm run build -w @google/gemini-cli-core` /
  `npm run build -w @google/gemini-cli`: いずれも成功。

これにより、`generalist`
への委譲が発生した場合に「数分間無反応 = ハング」という誤解をユーザーに与えず、「委譲中で正常」であることを
`/loop status` から即座に判別できるようになった。
