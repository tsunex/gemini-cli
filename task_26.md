# Task 26: Session-owned `/loop --background` lifecycle

## Context

This repository is the internal `tsunex/gemini-cli` fork. The previous internal
work added an experimental `/loop` background daemon and headless quota
fallback.

Current branch:

- `feature/loop-session-owned-default`
- Base: `myfork/main`

The current `/loop --background` implementation starts a detached daemon by
default. During manual testing, multiple old loop daemons could remain after
interactive sessions ended, which caused confusing status output and sometimes
froze interactive testing.

The desired design is closer to OpenClaude:

- `/loop --background` should be session-owned by default.
- The session-owned loop should stop when the interactive Gemini CLI session
  exits.
- Persistent loop daemons should require an explicit detach option:
  `/loop --background --detach`.

This is internal-use functionality, but it should still be safe enough for daily
development use.

## Goals

1. Make `/loop --background` session-owned by default.
2. Add explicit detach mode:
   - `/loop --background --detach`
   - detached mode keeps the current persistent behavior.
3. Stop session-owned loops when the owning interactive session exits.
4. Preserve existing detached behavior and model/headless tool behavior where
   appropriate.
5. Warn users when persisted state appears to belong to a different/stale owner
   or multiple loop daemons may exist.
6. Add focused tests.
7. Update this file with implementation notes and validation results.

## Non-goals

- Do not redesign `/loop` into a full workflow engine in this task.
- Do not implement long-running task chaining yet.
- Do not change unrelated quota/fallback logic.
- Do not stage or commit local user artifacts:
  - `text.txt` deletion
  - `MyChangeLog.md`
  - `handoff-2026-09-01.md`
  - `divergence-report-2026-09-01.md`
  - `loop-usage-confluence.md`

## Existing relevant files

- `packages/cli/src/ui/commands/loopCommand.ts`
  - user-facing `/loop` command parsing and status/stop output.
- `packages/core/src/services/loopScheduler.ts`
  - daemon lifecycle, scheduling, persisted state, PID handling, stop logic.
- `packages/core/src/services/loopScheduler.test.ts`
  - scheduler and daemon lifecycle tests.
- `packages/core/src/tools/loop.ts`
  - model/headless-facing `loop` tool.
- `packages/core/src/tools/loop-parser.ts`
  - loop argument parsing.
- `packages/core/src/tools/loop-parser.test.ts`
  - parser tests.
- `packages/core/src/tools/loop.test.ts`
  - model/headless tool tests.
- `packages/core/src/tools/loopControl.ts`
  - `loop-stop` / `loop-status` tools.

## Proposed state model

Extend `LoopState` with ownership metadata:

```ts
ownerSessionId?: string;
ownerPid?: number;
ownerWorkspace?: string;
detached?: boolean;
```

Suggested semantics:

- `detached: true`
  - persistent daemon, current behavior.
  - not automatically stopped on interactive session exit.
- `detached: false` or missing
  - session-owned daemon.
  - should be stopped when the owning interactive process exits.
- `ownerPid`
  - PID of the interactive process that scheduled the loop.
  - must be a positive safe integer before any liveness check.
- `ownerSessionId`
  - config session id if available.
- `ownerWorkspace`
  - project root or cwd to help status/warnings.

If backwards compatibility is easier, treat legacy state with missing `detached`
as detached only if there is no owner metadata. Avoid breaking existing
persisted loops unexpectedly.

## CLI behavior

### Start

```text
/loop -i 15s --background "prompt"
```

Expected behavior:

- Starts a background loop owned by the current interactive session.
- Status/success output should say it is session-owned and will stop on session
  exit.
- It should not imply that it will keep running after the session exits.

```text
/loop -i 15s --background --detach "prompt"
```

Expected behavior:

- Starts a persistent detached loop.
- Status/success output should say it is detached and will continue after the
  session exits.
- Keep the existing warning about YOLO/auto-approved tool calls.

### Status

`/loop status` should show:

- daemon running status and PID;
- whether loop is session-owned or detached;
- owner PID/session/workspace when available;
- warning if session-owned owner PID is no longer alive;
- warning if current workspace/session does not match owner metadata.

### Stop

`/loop stop` should stop either session-owned or detached loops using the
existing hardened daemon stop path.

## Session exit behavior

When an interactive Gemini CLI process exits, it should stop only the loop it
owns:

- If persisted state has `detached: true`, do nothing.
- If persisted state has `ownerPid === process.pid`, call the existing stop
  path.
- If persisted state has another owner, do not stop it.
- Do not clear or kill unrelated state.
- Do not introduce broad silent catches. Log/report failures consistently with
  existing patterns.

Implementation hint:

- Look for the top-level interactive CLI lifecycle in
  `packages/cli/src/gemini.tsx` or nearby cleanup code.
- Register cleanup for normal exit/SIGINT/SIGTERM where the interactive app
  already handles shutdown.
- Avoid duplicating process-signal handling if an existing cleanup mechanism is
  present.

## Model/headless tool behavior

For the model-facing `loop` tool:

- Preserve existing behavior by default unless there is a clear owner context.
- If adding a `detach` parameter, document it in the tool schema and tests.
- Headless commands usually do not have a long-lived interactive session, so
  defaulting tool-created background loops to detached may be safer.

If behavior differs between slash command and tool, make that explicit in code
comments and tests.

## Tests to add/update

Prefer focused tests over broad suites.

Suggested coverage:

1. Parser accepts `--detach` with `--background`.
2. Parser rejects or ignores `--detach` without `--background` in a documented
   way.
3. Starting `/loop --background` stores `detached: false`, `ownerPid`,
   `ownerSessionId`, and `ownerWorkspace`.
4. Starting `/loop --background --detach` stores `detached: true`.
5. Interactive session cleanup stops only loops where `ownerPid === process.pid`
   and `detached !== true`.
6. Cleanup does not stop detached loops.
7. Cleanup does not stop loops owned by another PID.
8. Status output includes session-owned/detached lifecycle information.

Likely commands:

```bash
npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts src/tools/loop-parser.test.ts src/tools/loop.test.ts
npm test --workspace ./packages/cli -- src/ui/commands/loopCommand.test.ts
npm run typecheck --workspace ./packages/cli
npm run typecheck --workspace ./packages/core
npm run build -w @google/gemini-cli
npm run build -w @google/gemini-cli-core
```

Run the smallest targeted set while iterating. Run the broader listed commands
before committing if time/quota permits.

## Manual smoke test

After implementation, run an interactive smoke test if practical:

1. Start Gemini CLI.
2. Run:
   `/loop -i 15s --background "カレントワークスペースに ./text.txt が存在するか確認してください。存在する場合は ./text.txt を削除し、その後 loop-stop ツールを呼び出してこのループを停止してください。存在しない場合は何もせず、次回の定期実行を待ってください。最後の行に <<<LOOP_TASK_COMPLETE>>> と出力してください。"`
3. Confirm `/loop status` says session-owned.
4. Exit the interactive session.
5. Confirm no owned loop daemon remains.
6. Repeat with `--detach` and confirm it survives session exit until
   `/loop stop`.

## Completion criteria

- Implementation committed to `feature/loop-session-owned-default`.
- Branch pushed to `myfork`.
- This `task_26.md` updated with:
  - summary of changed files;
  - design decisions;
  - validation commands and results;
  - any known limitations.
- Do not commit unrelated local files/artifacts listed in Non-goals.

## Implementation Notes & Validation Results

### Changed Files

- `packages/core/src/tools/loop-parser.ts` &
  `packages/core/src/tools/loop-parser.test.ts`
  - Added `-d` / `--detach` argument parsing.
  - Enforced that `--detach` can only be used with `--background`.
  - Added unit tests for parsing detach flag and validating constraints.
- `packages/core/src/services/loopScheduler.ts` &
  `packages/core/src/services/loopScheduler.test.ts`
  - Extended `LoopState` with optional metadata: `ownerPid`, `ownerSessionId`,
    `ownerWorkspace`, and `detached`.
  - Updated `isLoopState` type-guard validator.
  - Implemented `stopSessionOwnedLoop()` which checks if a background loop is
    owned by the current process PID and not detached, stopping the daemon if
    matches.
  - Added comprehensive unit tests for `stopSessionOwnedLoop` covering normal
    cleanup, detached loops, and loops owned by other processes.
- `packages/core/src/tools/loop.ts` & `packages/core/src/tools/loop.test.ts`
  - Updated Loop Tool to default tool-created background loops to
    `detached: true` unless otherwise requested.
  - Added test case verifying correct default `detached: true` for LoopTool
    runs.
- `packages/cli/src/ui/commands/loopCommand.ts` &
  `packages/cli/src/ui/commands/loopCommand.test.ts`
  - Updated `/loop` slash command to use session-owned (`detached: false`)
    background loop by default.
  - Set ownership metadata: `ownerPid` (`process.pid`), `ownerSessionId`
    (`config.getSessionId()`), and `ownerWorkspace` (`process.cwd()`).
  - Enhanced `/loop status` output with lifecycle, ownership details, and
    mismatch warnings.
  - Added unit tests verifying status reporting, correct state storage, and
    mismatch warnings.
- `packages/cli/src/gemini.tsx`
  - Registered `stopSessionOwnedLoop` as a cleanup listener on interactive exit
    via `registerCleanup`.
- `packages/core/src/index.ts`
  - Exported `stopSessionOwnedLoop`.

### Design Decisions

1. **Session-Owned Default:** By making `/loop --background` session-owned by
   default, daily development becomes safer because background loops terminate
   with the interactive session, preventing lingering background processes.
2. **Explicit Detach Mode:** Users can still run persistent background loops
   across sessions by specifying `/loop --background --detach`.
3. **Headless Default to Detached:** For tool-driven (AI-driven) background
   scheduling, background loops default to `detached: true` because headless
   runs typically do not have long-lived interactive process owners.
4. **Mismatch Warnings:** Enhanced `/loop status` command with mismatch warnings
   (for Owner PID, Workspace mismatch, or Session ID mismatch) to alert the user
   if they have an active background daemon from a different directory or shell
   session.

### Validation Results

All unit and integration tests passed cleanly:

```bash
# Core Loop Parser, Scheduler, and Tool Tests
npm test -w @google/gemini-cli-core -- src/tools/loop-parser.test.ts src/services/loopScheduler.test.ts src/tools/loop.test.ts
# ✓ All 53 tests passed!

# CLI Loop Command Tests
npm test --workspace ./packages/cli -- src/ui/commands/loopCommand.test.ts
# ✓ All 15 tests passed!

# Compilation & Typechecks
npm run typecheck --workspace ./packages/core && npm run typecheck --workspace ./packages/cli
# ✓ Success (No errors or warnings)

# Build
npm run build
# ✓ Success (Successfully built all packages and companions)
```

### Known Limitations

- Checking if an owner PID is alive uses Node's standard `process.kill(pid, 0)`
  mechanism, which has platform-specific OS behaviors on Windows/Linux but is
  highly accurate on POSIX.
