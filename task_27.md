# Task 27: Auto-inject loop completion marker instruction

## Context

The experimental `/loop` background daemon currently treats a background run as
successful only when the final assistant text contains this marker as the final
standalone line:

```text
<<<LOOP_TASK_COMPLETE>>>
```

That marker is an internal loop protocol detail. Users should not have to add
"print this marker at the end" to every `/loop` prompt.

Observed issue during manual smoke testing:

- User started
  `/loop -i 15s --background "check ./text.txt; delete and loop-stop if it exists; otherwise wait for the next run"`.
- When `text.txt` did not exist, the model answered normally but did not include
  the completion marker.
- The loop treated the run as incomplete/failure and backed off for 30 seconds.
- After `text.txt` was created, the response appeared delayed because the loop
  was waiting for the backoff schedule rather than the normal 15 second
  interval.

This is not acceptable UX. The correct fix is to auto-inject the completion
marker instruction internally.

## Goal

Make `/loop` automatically instruct the model to finish every successful
background run by outputting `<<<LOOP_TASK_COMPLETE>>>` as the final standalone
line, without requiring users to put that instruction in their prompt.

## Requirements

1. Add the completion-marker instruction automatically in loop execution code.
2. Preserve the original user prompt for:
   - `/loop status` output;
   - `[Loop Background Response] Prompt:` display;
   - persisted `LoopState.prompt`;
   - any user-visible messages.
3. Only the actual model execution prompt should receive the internal
   instruction.
4. Do not double-inject if the execution prompt already contains the marker
   instruction or marker.
5. Preserve existing behavior that strips the final marker from notification
   content before displaying it to users.
6. Existing safety behavior should remain:
   - timeout/max-turn/error should still be failure/backoff;
   - final standalone marker should still be required for success unless the
     implementation intentionally changes completion semantics and tests cover
     it.
7. Add focused tests.
8. Update this file with implementation notes and validation results.
9. Commit and push to `myfork/feature/loop-session-owned-default`.

## Suggested implementation

Prefer a central helper in `packages/core/src/services/loopScheduler.ts`, for
example:

```ts
function buildLoopExecutionPrompt(userPrompt: string): string {
  ...
}
```

Use it at the point where `LegacyAgentSession.sendStream()` receives the prompt
for background loop execution. Keep `LoopState.prompt` untouched.

The injected text should be explicit and concise, for example:

```text

Internal loop protocol requirement:
When this background loop run has completed successfully, output exactly
<<<LOOP_TASK_COMPLETE>>>
as the final standalone line. Do not mention this marker elsewhere.
```

Make sure this helper does not modify user-facing prompt strings.

## Tests to add/update

Likely file:

- `packages/core/src/services/loopScheduler.test.ts`

Suggested test cases:

1. A loop run whose user prompt does not mention the marker should call
   `LegacyAgentSession.sendStream()` with a prompt that contains the internal
   marker instruction.
2. Persisted state and notification prompt should still contain the original
   user prompt only.
3. If the user prompt already includes the marker, the instruction is not
   duplicated.
4. Existing completion marker strip tests should still pass.

Optional but useful:

- Add tests in `packages/core/src/tools/loop.test.ts` if tool-created background
  loops bypass the same scheduler path.

## Validation commands

Run focused commands first:

```bash
npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts src/tools/loop.test.ts
npm run typecheck --workspace ./packages/core
npm run build -w @google/gemini-cli-core
```

If CLI-facing files are touched, also run:

```bash
npm test --workspace ./packages/cli -- src/ui/commands/loopCommand.test.ts
npm run typecheck --workspace ./packages/cli
npm run build -w @google/gemini-cli
```

## Completion criteria

- Users no longer need to manually include the completion marker instruction in
  `/loop` prompts.
- Prompt display/status still shows the original user prompt.
- Tests prove internal prompt injection and user-visible prompt preservation.
- Changes are committed and pushed.
- Do not stage unrelated local artifacts:
  - `text.txt` deletion
  - `MyChangeLog.md`
  - `handoff-2026-09-01.md`
  - `divergence-report-2026-09-01.md`
  - `loop-usage-confluence.md`

## Implementation Notes & Validation Results

### Implementation Notes

1. **New Helper Function**: Added
   `buildLoopExecutionPrompt(userPrompt: string): string` to
   `packages/core/src/services/loopScheduler.ts`.
   - Checks if the user prompt already contains `<<<LOOP_TASK_COMPLETE>>>` or
     the instruction title to prevent duplicate injection.
   - Automatically appends the concise, explicit loop protocol instruction if
     not present.
2. **Stream Integration**: Updated background loop execution inside `schedule()`
   in `loopScheduler.ts` to call `buildLoopExecutionPrompt(state.prompt)` before
   appending the completion gate instructions when sending the stream.
3. **Preservation**: Left `state.prompt` and `LoopState.prompt` completely
   unmodified, ensuring all status listings, UI elements, and notifications show
   the original user-supplied prompt.

### Validation Results

- Focused unit and integration tests successfully verified all requirements.
- **Test execution commands and outputs**:
  - `npm test -w @google/gemini-cli-core -- src/services/loopScheduler.test.ts`
    (All 43 tests passed, including new auto-injection, duplicate avoidance, and
    prompt preservation tests).
  - `npm test -w @google/gemini-cli-core -- src/tools/loop.test.ts` (All 6 tests
    passed).
  - `npm test --workspace ./packages/cli -- src/ui/commands/loopCommand.test.ts`
    (All 15 tests passed).
- **TypeScript Compilation and Builds**:
  - `npm run typecheck --workspace ./packages/core` (Passed successfully, no
    compilation errors).
  - `npm run typecheck --workspace ./packages/cli` (Passed successfully, no
    compilation errors).
  - `npm run build -w @google/gemini-cli-core` (Succeeded, output built
    perfectly).
