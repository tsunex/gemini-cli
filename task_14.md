# Task 14: `state.json` のアトミック書き込み化

## 背景

`report_11.md` §4・§9-6 の指摘: `zero` の `persistTaskLocked()`
は、タスクメタデータをJSONとして一時ファイルに書き込んでから `rename()`
でその場所へ配置する、アトミック書き込みパターンを採用している。一方
`gemini-cli` の `loopScheduler.ts::saveState()` はこれまで
`fs.writeFileSync(statePath, ...)` で `state.json` へ直接書き込んでいた。

バックグラウンドデーモンは無人で稼働し、Task 10・12で実装した `SIGKILL`
エスカレーションや、予期しないクラッシュ・電源断など、プロセスが書き込みの途中で強制終了され得る状況が現実に存在する。直接書き込みが中断されると
`state.json` が不完全な（壊れた）JSONとして残り、次回 `loadState()`
がパース失敗してスケジュール情報を丸ごと失うリスクがある。

## 目的

`state.json` の書き込みを、一時ファイルへ書き込んでから `rename()`
で本配置するアトミックなパターンに変更し、書き込み中断による破損を防止する。

## 設計

- `saveState()` を次のように変更する:
  1. `${statePath}.tmp-${process.pid}-${Date.now()}`
     という一意な一時ファイルパスに、これまで通り `fs.writeFileSync()`
     でJSONを書き込む。
  2. `fs.renameSync(tmpPath, statePath)`
     で本来のパスへ配置する。同一ファイルシステム内の `rename()`
     はアトミックであるため、`state.json`
     は「直前の完全な状態」か「新しい完全な状態」のいずれかにしかならず、中間状態（部分書き込み）を外部から観測することはない。
- 一時ファイル名にPIDとタイムスタンプを含めることで、対話CLIとデーモンプロセスが同時に書き込みを行うケース（多重起動防止の排他制御をすり抜けた場合の保険）でも一時ファイル名の衝突を避ける。

## 実装対象

- `packages/core/src/services/loopScheduler.ts`: `saveState()` の変更。
- `packages/core/src/services/loopScheduler.test.ts`:
  - 書き込み後に一時ファイルが残っていないことを確認するテスト。
  - 書き込み後の `state.json`
    の内容が正しいこと（既存のsave/loadの往復テストがそのまま回帰確認になる）。

## 実行結果

2026年8月31日、設計通り実装完了。

- `saveState()` を、`${statePath}.tmp-${process.pid}-${Date.now()}`
  への書き込み → `fs.renameSync()` による本配置、の2段階に変更。
- テスト: `loopScheduler.test.ts` に、保存後の状態ディレクトリに `state.json`
  のみが残り一時ファイルが残留しないことを確認するテストを追加。**17/17 テスト合格**。
- `npm run build -w @google/gemini-cli-core`: 成功。
- `eslint`: クリーン。

これで `report_11.md`
§9 で洗い出した6項目（完了ゲート／SIGKILLエスカレーション／可観測性／プロセスグループKill／stale状態正規化／アトミック書き込み）すべての実装が完了した。
