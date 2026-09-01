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

---

## PR #3 Review Fixes (Round 2)

Addressed four more issues identified in the PR review after commit a88a1cedf.

### Issues Fixed

1.  **`notificationServer.ts` dropped message:** The server no longer drops the
    final buffered message if a client disconnects without a trailing newline.
    The buffer is now flushed on socket `end`.
2.  **`loopScheduler.ts` interval clamping:** `getSafeIntervalMs()` now clamps
    legacy/manual `intervalMs` values to a minimum safety floor of 10 seconds.
3.  **`notificationServer.test.ts` temp directory:** The test now uses a unique
    temp directory for each run (`fs.mkdtempSync`) to prevent cross-test
    interference.
4.  **`loopScheduler.test.ts` completion marker tests:** Replaced isolated unit
    tests of `hasCompletionSignal`/`stripCompletionMarker` with integrated tests
    that exercise the production `schedule()` behavior, verifying that the
    marker is only respected on the final standalone line.

### Implementation & Validation

#### 1. `notificationServer.ts` Buffer Flushing (Issue #1) & Temp Directory (Issue #3)

- **Status:** Implemented.
- **Implementation:**
  - Modified `packages/cli/src/utils/notificationServer.ts` to add a
    `socket.on('end', ...)` handler that processes any remaining data in the
    buffer. Refactored the processing logic into a shared `processMessage`
    function.
  - Modified `packages/cli/src/utils/notificationServer.test.ts` to create a
    unique temporary directory for each test using `os.tmpdir()` and
    `fs.mkdtempSync`, with cleanup in `afterEach`.
- **Validation:**
  - Added a new test
    `'handles a message without a trailing newline before client disconnects'`
    to `notificationServer.test.ts`.
  - Ran
    `npm test --workspace ./packages/cli -- src/utils/notificationServer.test.ts`.
    All 5 tests passed.

```
> @google/gemini-cli@0.56.0-nightly.20260806.g761f604c1 test
> vitest run src/utils/notificationServer.test.ts

RUN  v3.2.4 /home/tsuneokam/workfolder/gemini-cli/packages/cli
     Coverage enabled with v8

 ✓ src/utils/notificationServer.test.ts (5 tests) 22ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  12:41:59
   Duration  7.13s (transform 1.64s, setup 3.34s, collect 21ms, tests 22ms, environment 0ms, prepare 161ms)
```

#### 2. `loopScheduler.ts` Interval Clamping (Issue #2) & Improved Tests (Issue #4)

- **Status:** Implemented.
- **Implementation:**
  - Modified `getSafeIntervalMs` in
    `packages/core/src/services/loopScheduler.ts` to clamp the interval to a
    minimum of 10,000ms.
  - Removed the isolated
    `describe('hasCompletionSignal / stripCompletionMarker', ...)` block from
    `packages/core/src/services/loopScheduler.test.ts`.
  - Added new integration tests to `loopScheduler.test.ts` to verify the
    interval clamping and the correct production behavior of completion marker
    handling within `schedule()`.
- **Validation:**
  - Added tests:
    - `'should clamp a too-short interval to the minimum safety floor when calculating backoff'`
    - `'should treat a run as incomplete if the marker is not the final standalone line'`
    - `'should strip only the final marker line, preserving earlier mentions'`
  - Ran
    `npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts`.
    All 32 tests passed.

```
> @google/gemini-cli-core@0.56.0-nightly.20260806.g761f604c1 test
> vitest run src/services/loopScheduler.test.ts

RUN  v3.2.4 /home/tsuneokam/workfolder/gemini-cli/packages/core
     Coverage enabled with v8

 ✓ src/services/loopScheduler.test.ts (32 tests) 49ms

 Test Files  1 passed (1)
      Tests  32 passed (32)
   Start at  12:41:59
   Duration  6.66s (transform 1.92s, setup 53ms, collect 3.52s, tests 49ms, environment 0ms, prepare 121ms)
```

#### Overall Validation

- **Builds:** Ran the two specified build commands.
  - `npm run build -w @google/gemini-cli`: Succeeded.
  - `npm run build -w @google/gemini-cli-core`: Succeeded.
- **All checks passed successfully.**

---

## PR #3 Review Fixes (Round 3)

This round addresses two issues from the latest review on commit 578ba0c11.

### Issues to Fix

1.  **`notificationServer.test.ts`: Test stability**: The `connectClient()` test
    can hang or flap. The test does not wait for the server to start listening,
    and the `connectClient` promise never rejects on socket errors.
    - **Plan:** Fix the test setup to `await` the server listening before
      connecting. Modify `connectClient` to reject its promise on a socket
      error.
2.  **`loopScheduler.ts`: Inaccurate logging**: The log message in `stopDaemon`
    incorrectly states that a `SIGTERM` was sent to the daemon process group,
    even when `killDaemonTree()` falls back to killing a single PID.
    - **Plan:** Adjust `killDaemonTree()` to report what it actually did (killed
      a group or a single process) and make the log message in `stopDaemon`
      reflect this accurately.

### Validation Plan

- `npm test --workspace ./packages/cli -- src/utils/notificationServer.test.ts`
- `npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts`
- `npm run build -w @google/gemini-cli`
- `npm run build -w @google/gemini-cli-core`

### Implementation & Validation

#### 1. `notificationServer.test.ts` Stability (Issue #1)

- **Status:** Implemented.
- **Implementation:**
  - Modified `startNotificationServer()` in
    `packages/cli/src/utils/notificationServer.ts` to be an `async` function. It
    now returns a `Promise` that resolves only when the server's `'listening'`
    event is fired and rejects on `'error'`.
  - Updated `beforeEach` in `packages/cli/src/utils/notificationServer.test.ts`
    to `await` the server startup.
  - Added an `.on('error', reject)` handler to the `connectClient` promise to
    prevent test hangs on connection failure.
- **Validation:**
  - Ran
    `npm test --workspace ./packages/cli -- src/utils/notificationServer.test.ts`.
    All 5 tests passed, confirming the fix for the race condition.

#### 2. `loopScheduler.ts` Logging Accuracy (Issue #2)

- **Status:** Implemented.
- **Implementation:**
  - Modified `killDaemonTree()` in `packages/core/src/services/loopScheduler.ts`
    to return either `'group'` or `'pid'`, indicating the actual target of the
    kill signal.
  - Updated `stopDaemon()` to use this return value to construct an accurate log
    message (e.g., "Sent SIGTERM to daemon process group" vs. "Sent SIGTERM to
    daemon process").
- **Validation:**
  - Verified no existing tests asserted on the old log message.
  - Ran
    `npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts`.
    All 32 tests passed, confirming no regressions.

#### Overall Validation

- **Builds:** Ran the two specified build commands.
  - `npm run build -w @google/gemini-cli`: Succeeded.
  - `npm run build -w @google/gemini-cli-core`: Succeeded.
- **All checks passed successfully.**
- **Note:** Was unable to verify other inline comments on PR #3 as the provided
  URL resulted in a 404 error. Addressed all issues specified in the prompt.

---

## PR #3 Review Fixes (Round 4 - Cleanup)

This round addresses a runtime risk introduced by the previous fix. The
`startNotificationServer()` was made `async`, but the production call site was
not updated to `await` it, creating a risk of unhandled promise rejections. This
fix reverts the function to be synchronous while keeping the test stability
improvements.

### Issues Fixed

1.  **`startNotificationServer` API mismatch:** Reverted
    `startNotificationServer()` to be a synchronous function that returns a
    `net.Server` instance directly. This matches the existing production call
    site in `gemini.tsx` and eliminates the risk of an unhandled promise
    rejection.
2.  **`notificationServer.test.ts` adaptation:** The test suite was updated to
    work with the synchronous API. A new `waitForServer()` test helper was
    introduced in `beforeEach` to explicitly wait for the server's `listening`
    event, ensuring the server is fully ready before clients attempt to connect.
    This preserves the test stability from the previous fix.

### Validation Plan

- `npm test --workspace ./packages/cli -- src/utils/notificationServer.test.ts`
- `npm run typecheck --workspace ./packages/cli`
- `npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts`
- `npm run build -w @google/gemini-cli`
- `npm run build -w @google/gemini-cli-core`

### Validation Result

- **Status:** Passed.
- **Commands:**
  - `npm test --workspace ./packages/cli -- src/utils/notificationServer.test.ts`
    - 5 tests passed.
  - `npm run typecheck --workspace ./packages/cli`
    - Passed.
  - `npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts`
    - 32 tests passed.
  - `npm run build -w @google/gemini-cli`
    - Passed.
  - `npm run build -w @google/gemini-cli-core`
    - Passed.
