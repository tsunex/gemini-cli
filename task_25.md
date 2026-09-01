# Task 25: Address PR Review Feedback

This task is to address four correctness/operational issues identified in a PR
review.

## Issues to Fix

1.  **Completion marker validation**: `hasCompletionSignal()` currently accepts
    any occurrence of `<<<LOOP_TASK_COMPLETE>>>`. It should only count success
    when the marker appears as the final standalone line.
    `stripCompletionMarker` must also be updated to only remove the final marker
    line.
2.  **Startup lock corrupt/empty PID**: `startDaemon()` reads `.startup.lock`,
    but `Number(...)` may become `0`/`NaN`. `process.kill(0,0)` can succeed and
    permanently block startup. The PID must be validated strictly.
3.  **`startDaemon()` catch block**: The `catch` block currently clears state on
    any error. It should not clear state if the failure comes from
    `stopDaemon()` as an existing daemon may still be running.
4.  **`isDaemonRunning()` EPERM handling**: The function currently returns
    `false` for any `process.kill(pid,0)` error. On `EPERM`, the process exists,
    so it should be treated as running (`true`).

## Plan

1.  Address the completion marker validation issue in `loopScheduler.ts`.
2.  Address the startup lock PID validation issue in `loopScheduler.ts`.
3.  Address the `startDaemon` catch block issue in `loopScheduler.ts`.
4.  Address the `isDaemonRunning` EPERM handling in `loopScheduler.ts`.
5.  Add new tests to `loopScheduler.test.ts` to cover all four fixed cases.
6.  Run all relevant tests and validation.
7.  Document the results in this file.

## Implementation & Validation

### 1. Completion Marker Validation (Issue #1)

- **Status:** Implemented.
- **Implementation:**
  - Modified `hasCompletionSignal()` in
    `packages/core/src/services/loopScheduler.ts` to check if the last non-empty
    line of the text is exactly the completion marker.
  - Modified `stripCompletionMarker()` to use the new `hasCompletionSignal`
    logic and only remove the final line if it is the completion marker, leaving
    other mentions of the marker untouched.
- **Validation:**
  - Added a new `describe` block with two tests to
    `packages/core/src/services/loopScheduler.test.ts`.
    - `'should detect completion signal only on the final line'`: Confirms
      `hasCompletionSignal` only returns true for valid final-line markers.
    - `'should strip completion signal only from the final line'`: Confirms
      `stripCompletionMarker` only removes the valid final-line marker.
  - Both tests passed.

### 2. Startup Lock Corrupt/Empty PID (Issue #2)

- **Status:** Implemented.
- **Implementation:**
  - Modified `startDaemon()` in `packages/core/src/services/loopScheduler.ts`.
  - Added a check to validate the `pid` read from the `.startup.lock` file.
  - It now uses `Number.isSafeInteger(pid) && pid > 0` to ensure the PID is a
    valid positive integer before calling `process.kill`.
  - If the PID is invalid, it's treated as a stale lock by throwing an `ESRCH`
    error, allowing startup to proceed.
- **Validation:**
  - Added a new test
    `'should treat a lock file with invalid PID as stale and proceed with startup'`
    to `packages/core/src/services/loopScheduler.test.ts`.
  - The test confirms that if `.startup.lock` contains an invalid PID, it is
    correctly identified as stale and the daemon starts successfully.
  - The test passed.

### 3. `startDaemon()` Catch Block (Issue #3)

- **Status:** Implemented.
- **Implementation:**
  - Modified the `try...catch` block within `startDaemon()` in
    `packages/core/src/services/loopScheduler.ts`.
  - A new boolean flag, `stateWrittenByThisAttempt`, is introduced.
  - This flag is set to `true` only after `saveState()` is called by the current
    startup attempt.
  - The `catch` block now only calls `clearState()` if
    `stateWrittenByThisAttempt` is true, preventing `clearState()` from being
    called if the initial `stopDaemon()` fails.
- **Validation:**
  - Added a new test `'should not clear state if initial stopDaemon call fails'`
    to `packages/core/src/services/loopScheduler.test.ts`.
  - The test simulates `stopDaemon` throwing an error and asserts that the
    original state is not cleared.
  - The test passed.

### 4. `isDaemonRunning()` EPERM Handling (Issue #4)

- **Status:** Implemented.
- **Implementation:**
  - Modified `isDaemonRunning()` in
    `packages/core/src/services/loopScheduler.ts`.
  - The `catch` block now inspects the error.
  - If the error code is `EPERM`, the function returns `true`, correctly
    identifying that a process exists even if it can't be signaled.
- **Validation:**
  - Added a new test `'should return true from isDaemonRunning on EPERM'` to
    `packages/core/src/services/loopScheduler.test.ts`.
  - This test confirms that `isDaemonRunning()` returns `true` when
    `process.kill` throws an `EPERM` error.
  - The test passed.

### Overall Validation

- **Tests:** Ran the two specified test commands.
  - `npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts`:
    All 30 tests passed.
  - `npm test --workspace ./packages/cli -- src/utils/notificationServer.test.ts`:
    All 4 tests passed.
- **Build:** No build was needed as only test files and logic were changed.
- **All checks passed successfully.**
