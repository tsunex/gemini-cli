/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { Storage } from '../config/storage.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ApprovalMode } from '../policy/types.js';

export interface LoopState {
  nextRun: number;
  mode: string;
  prompt: string;
  intervalMs?: number;
  pid?: number;
  /** Number of consecutive execution failures since the last success. */
  retryCount?: number;
  /** Message of the most recent execution failure, if any. */
  lastError?: string;
  /**
   * Coarse-grained lifecycle phase of the loop, updated independently of
   * `nextRun`. Lets `/loop status` distinguish "waiting for the next
   * scheduled run" from "a run is currently in flight", which `nextRun`
   * alone cannot express once a run has started (see
   * report_11.md §6/§9-3).
   */
  currentPhase?: 'idle' | 'running';
  /**
   * Timestamp of the most recent observed activity: either a background
   * run starting, a stream event being received during a run, or a run
   * finishing. Lets a monitoring user/tool notice a daemon that is alive
   * (per PID) but has gone silent/stuck mid-run, instead of only seeing a
   * stale `nextRun` with no further signal.
   */
  lastHeartbeatAt?: number;
}

const STATE_FILE = 'state.json';

// Consecutive-failure handling: back off exponentially, but never wait longer
// than MAX_BACKOFF_MS, and give up (stop rescheduling) after MAX_RETRY_COUNT
// consecutive failures so a persistently broken loop does not retry forever
// and does not fail silently either (see design_loop_autonomous_v2.md §4.4).
const MAX_RETRY_COUNT = 10;
const MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

// A background loop run is meant to be a short, single-purpose check (e.g.
// "does text.txt exist?"), not an open-ended interactive session. Without an
// explicit cap, invoke_agent/subagent delegation and unbounded exploration
// can turn a single run into a multi-minute (or longer) chain of tool calls
// that never lets schedule() reschedule the next run. Subagent delegation
// itself stays fully enabled (it is required for autonomous operation) -
// only the number of turns a single background run may take is bounded.
const BACKGROUND_MAX_SESSION_TURNS = 8;

// A background run is only "done" if the agent explicitly confirms it
// actually completed the requested check - not merely because it stopped
// talking (e.g. it hit BACKGROUND_MAX_SESSION_TURNS mid-tangent, or gave up
// silently). This mirrors zero's RequireCompletionSignal headless safeguard
// (see report_11.md §3/§9-1): the model must positively assert completion,
// rather than the scheduler assuming success by default. Subagent
// delegation itself is not restricted by this - only whether a given run's
// *result* counts as a verified success for scheduling/notification
// purposes.
const COMPLETION_MARKER = '<<<LOOP_TASK_COMPLETE>>>';

function buildCompletionGateInstruction(): string {
  return (
    `\n\nIMPORTANT: This is an unattended background check. If, and only ` +
    `if, you have actually completed the task above and are confident in ` +
    `the result, end your final response with a line containing exactly: ` +
    `${COMPLETION_MARKER}\n` +
    `If you could not complete the task, got stuck, ran out of turns, or ` +
    `are uncertain, do NOT include that marker.`
  );
}

function hasCompletionSignal(text: string): boolean {
  return text.includes(COMPLETION_MARKER);
}

function stripCompletionMarker(text: string): string {
  return text.split(COMPLETION_MARKER).join('').trim();
}

function getStatePath(): string {
  return path.join(Storage.getProjectLoopStateDir(), STATE_FILE);
}

function getLogPath(): string {
  return path.join(Storage.getProjectLoopStateDir(), 'loop.log');
}

import { LegacyAgentSession } from '../agent/legacy-agent-session.js';
import type { Config } from '../config/config.js';
import { coreEvents, CoreEvent } from '../utils/events.js';
import { sendNotification } from '../utils/notificationClient.js';

let timeoutId: NodeJS.Timeout | undefined;

// Shared retry/backoff/give-up logic for anything that keeps a background
// run from counting as a verified success: thrown errors *and* runs that
// ended without a completion signal (see COMPLETION_MARKER above). Kept as
// one function so both code paths stay consistent with
// design_loop_autonomous_v2.md §4.4's backoff/give-up policy.
function rescheduleAfterSetback(
  state: LoopState,
  config: Config,
  errorMessage: string,
  options: { emitImmediateFeedback?: boolean } = {},
): void {
  if (options.emitImmediateFeedback) {
    coreEvents.emit(CoreEvent.UserFeedback, {
      severity: 'error',
      message: `Error in loop execution: ${errorMessage}`,
    });
  }

  // Do not reschedule if the loop was stopped/cleared while this run was in
  // flight.
  if (!fs.existsSync(getStatePath())) {
    return;
  }

  const retryCount = (state.retryCount ?? 0) + 1;

  if (retryCount > MAX_RETRY_COUNT) {
    fs.appendFileSync(
      getLogPath(),
      `[${Date.now()}] BG Loop: Giving up after ${retryCount - 1} consecutive failures/incomplete runs. Stopping loop. Run "/loop <interval> <prompt> --background" to restart once the issue is resolved.\n`,
    );
    coreEvents.emit(CoreEvent.UserFeedback, {
      severity: 'error',
      message: `Loop stopped automatically after ${
        retryCount - 1
      } consecutive failures/incomplete runs. Last issue: ${errorMessage}`,
    });
    clearState();
    return;
  }

  // Exponential backoff with a ceiling so a flaky/distracted loop retries
  // with increasing patience instead of hammering the API or spinning
  // forever with no delay at all.
  const backoffMs = Math.min(
    (state.intervalMs ?? 0) * 2 ** retryCount,
    MAX_BACKOFF_MS,
  );
  const newState: LoopState = {
    ...state,
    nextRun: Date.now() + backoffMs,
    retryCount,
    lastError: errorMessage,
  };
  fs.appendFileSync(
    getLogPath(),
    `[${Date.now()}] BG Loop: Rescheduling after setback #${retryCount} in ${backoffMs}ms.\n`,
  );
  schedule(newState, config);
}

export function schedule(state: LoopState, config: Config): void {
  // Persist as "idle" (waiting for the next scheduled run) - recordHeartbeat
  // flips this to 'running' once the timer actually fires and a run starts.
  saveState({ ...state, currentPhase: 'idle' });
  const now = Date.now();
  const delay = state.nextRun - now;

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  timeoutId = setTimeout(async () => {
    // Check if the loop has been stopped before executing
    if (!fs.existsSync(getStatePath())) {
      return;
    }

    recordHeartbeat('running');

    const backgroundConfig = config.fork({
      approvalMode: ApprovalMode.YOLO, // Force auto-approval for silent background check
      sessionId: `background-loop-${Date.now()}`,
      maxSessionTurns: BACKGROUND_MAX_SESSION_TURNS,
    });

    let accumulatedText = '';
    try {
      fs.appendFileSync(getLogPath(), `[${Date.now()}] BG Loop: Start\n`);

      // Proactively initialize the client to prevent "Chat not initialized" errors in background loops
      const client = backgroundConfig.getGeminiClient();
      await client.initialize();

      const session = new LegacyAgentSession({
        config: backgroundConfig,
        client,
      });
      const stream = session.sendStream({
        message: {
          content: [
            {
              type: 'text',
              text: state.prompt + buildCompletionGateInstruction(),
            },
          ],
        },
      });

      for await (const event of stream) {
        // Update the on-disk heartbeat on every event so a monitoring user
        // (via `/loop status`) can distinguish "actively working" from
        // "hung/stuck" during a long-running background turn, instead of
        // only seeing a stale nextRun with no further signal (see
        // report_11.md §6/§9-3).
        recordHeartbeat('running');
        fs.appendFileSync(
          getLogPath(),
          `[${Date.now()}] BG Loop: Event received: ${JSON.stringify(event)}\n`,
        );
        if (event.type === 'message' && event.role === 'agent') {
          fs.appendFileSync(
            getLogPath(),
            `[${Date.now()}] BG Loop: Agent turn: ${JSON.stringify(event.content)}\n`,
          );
          for (const part of event.content) {
            if (part.type === 'text') {
              accumulatedText += part.text;
            }
          }
        }
      }

      fs.appendFileSync(
        getLogPath(),
        `[${Date.now()}] BG Loop: Stream finished. Result: ${accumulatedText}\n`,
      );

      // Check if the state file still exists before rescheduling (e.g. self-stopping called clearState)
      if (!fs.existsSync(getStatePath())) {
        return;
      }

      if (hasCompletionSignal(accumulatedText)) {
        const finalText = stripCompletionMarker(accumulatedText);
        if (finalText) {
          try {
            const notification = {
              type: 'loop_result',
              content: finalText,
            };
            await sendNotification(JSON.stringify(notification));
          } catch (err) {
            fs.appendFileSync(
              getLogPath(),
              `[${Date.now()}] BG Loop: Failed to send notification: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }

        const newState: LoopState = {
          ...state,
          nextRun: Date.now() + (state.intervalMs ?? 0),
          // Reset failure tracking after a verified-complete run.
          retryCount: 0,
          lastError: undefined,
        };
        fs.appendFileSync(
          getLogPath(),
          `[${Date.now()}] BG Loop: Completion signal detected. Rescheduling next run.\n`,
        );
        schedule(newState, config);
        return;
      }

      // The run ended (turn cap reached, or the model simply stopped)
      // without ever confirming it completed the requested task - e.g. it
      // went on a tangent instead of checking what it was asked to check
      // (see report_11.md §3/§9-1). Do not surface this partial/uncertain
      // output to the user, and do not treat it as a normal success: back
      // off like a failure so a persistently distracted loop does not spam
      // notifications or spin at full speed forever.
      fs.appendFileSync(
        getLogPath(),
        `[${Date.now()}] BG Loop: No completion signal detected - treating run as incomplete.\n`,
      );
      rescheduleAfterSetback(
        state,
        config,
        'Run ended without a completion signal (possible distraction or turn-cap cutoff).',
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      fs.appendFileSync(
        getLogPath(),
        `[${Date.now()}] BG Loop: CATCH BLOCK ERROR: ${errorMessage}\n`,
      );
      rescheduleAfterSetback(state, config, errorMessage, {
        emitImmediateFeedback: true,
      });
    }
  }, delay);
}

function isLoopState(obj: unknown): obj is LoopState {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  if (!('nextRun' in obj) || typeof obj.nextRun !== 'number') {
    return false;
  }

  if (!('mode' in obj) || typeof obj.mode !== 'string') {
    return false;
  }

  if (!('prompt' in obj) || typeof obj.prompt !== 'string') {
    return false;
  }

  if (
    'intervalMs' in obj &&
    typeof obj.intervalMs !== 'number' &&
    typeof obj.intervalMs !== 'undefined'
  ) {
    return false;
  }

  if (
    'pid' in obj &&
    typeof obj.pid !== 'number' &&
    typeof obj.pid !== 'undefined'
  ) {
    return false;
  }

  if (
    'retryCount' in obj &&
    typeof obj.retryCount !== 'number' &&
    typeof obj.retryCount !== 'undefined'
  ) {
    return false;
  }

  if (
    'lastError' in obj &&
    typeof obj.lastError !== 'string' &&
    typeof obj.lastError !== 'undefined'
  ) {
    return false;
  }

  if (
    'currentPhase' in obj &&
    obj.currentPhase !== 'idle' &&
    obj.currentPhase !== 'running' &&
    typeof obj.currentPhase !== 'undefined'
  ) {
    return false;
  }

  if (
    'lastHeartbeatAt' in obj &&
    typeof obj.lastHeartbeatAt !== 'number' &&
    typeof obj.lastHeartbeatAt !== 'undefined'
  ) {
    return false;
  }

  return true;
}

export function loadState(): LoopState | undefined {
  try {
    const statePath = getStatePath();
    if (!fs.existsSync(statePath)) {
      return undefined;
    }
    const content = fs.readFileSync(statePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (isLoopState(parsed)) {
      return parsed;
    }
    return undefined;
  } catch (e) {
    coreEvents.emit(CoreEvent.UserFeedback, {
      severity: 'error',
      message: `Failed to load or parse loop state file. Starting fresh. Error: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
    return undefined;
  }
}

export function saveState(state: LoopState): void {
  const statePath = getStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Records a heartbeat (current phase + timestamp) into the on-disk state
 * without disturbing `nextRun`/the in-memory scheduling timer. Used during
 * an in-flight background run so `/loop status` can tell "waiting for next
 * scheduled run" apart from "a run is currently in progress", and detect a
 * stuck run by how long ago the heartbeat was last updated (see
 * report_11.md §6/§9-3). No-ops if the loop has been stopped (state.json
 * removed) since this run started, so a stopped loop's state file is never
 * accidentally resurrected by a stale in-flight run.
 */
function recordHeartbeat(phase: 'idle' | 'running'): void {
  const statePath = getStatePath();
  if (!fs.existsSync(statePath)) {
    return;
  }
  const current = loadState();
  if (!current) {
    return;
  }
  saveState({
    ...current,
    currentPhase: phase,
    lastHeartbeatAt: Date.now(),
  });
}

export function clearState(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = undefined;
  }
  const statePath = getStatePath();
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

export function clearTimer(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = undefined;
  }
}

/**
 * Thrown when a caller tries to start a new background loop daemon while one
 * is already running. Prevents multiple daemons from racing to write the
 * same state.json / execute the same prompt concurrently (see
 * design_loop_autonomous_v2.md §4.3).
 */
export class LoopAlreadyRunningError extends Error {
  constructor(pid: number) {
    super(
      `Loop daemon is already running (PID: ${pid}). Run "/loop stop" first if you want to reschedule.`,
    );
    this.name = 'LoopAlreadyRunningError';
  }
}

export function startDaemon(
  state: LoopState,
  _config: Config,
  options: { force?: boolean } = {},
): void {
  const existing = loadState();
  if (!options.force && existing?.pid && isDaemonRunning()) {
    throw new LoopAlreadyRunningError(existing.pid);
  }

  stopDaemon();

  const statePath = getStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  saveState(state);

  const nodeBin = process.argv[0];
  const scriptPath = process.argv[1];

  // Filter out Gemini-specific environment variables to prevent session conflicts
  const env: NodeJS.ProcessEnv = {};
  for (const key in process.env) {
    if (!key.startsWith('GEMINI_CLI_')) {
      env[key] = process.env[key];
    }
  }

  const child = spawn(nodeBin, [scriptPath, 'loop', 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env,
  });

  child.unref();

  if (child.pid) {
    const newState = { ...state, pid: child.pid };
    saveState(newState);
    fs.appendFileSync(
      getLogPath(),
      `[${Date.now()}] Daemon spawned with PID: ${child.pid}\n`,
    );
  } else {
    throw new Error('Failed to retrieve process ID of the spawned daemon.');
  }
}

// Grace period between SIGTERM and a forceful SIGKILL escalation when
// stopping the daemon. Registering a SIGTERM handler (see
// handleTerminationSignal below) is usually enough, but a daemon stuck in a
// blocking/native call could still ignore it indefinitely; without this
// escalation `/loop stop` could silently leave a zombie daemon running
// forever. Mirrors openclaude's terminateBackgroundProcessTree() and zero's
// TerminateProcessTree grace->SIGKILL pattern (see report_11.md §2/§9-2).
export const TERMINATION_GRACE_MS = 3000;

/**
 * Signals the daemon's whole process group (negative PID) rather than just
 * its own PID, so subprocesses it spawned (e.g. shell commands run via
 * subagent/tool calls during a background run) are also terminated instead
 * of being orphaned. `startDaemon()` spawns the daemon with
 * `detached: true`, which on POSIX makes it the leader of a new process
 * group, so `-pid` targets that whole group. Falls back to signaling just
 * the PID on Windows (no POSIX process-group signaling) or if group
 * signaling is otherwise unavailable. Mirrors zero's
 * ConfigureProcessGroup/processSignalTarget pattern (see
 * report_11.md §2/§9-4).
 */
function killDaemonTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall through to single-PID signaling below (e.g. the process is not
      // a group leader).
    }
  }
  process.kill(pid, signal);
}

export function stopDaemon(): void {
  const state = loadState();
  if (state && state.pid) {
    const pid = state.pid;
    try {
      process.kill(pid, 0);
      killDaemonTree(pid, 'SIGTERM');
      fs.appendFileSync(
        getLogPath(),
        `[${Date.now()}] Sent SIGTERM to daemon process group (PID: ${pid}).\n`,
      );

      // Fire-and-forget escalation check: if the daemon is still alive
      // after the grace period, force-kill it. Runs independently of the
      // caller (stopDaemon() itself stays synchronous so existing callers -
      // slash command, tool invocation, auto-restart - do not need to
      // change) and is unref()'d so it never keeps the calling process
      // alive on its own.
      setTimeout(() => {
        try {
          process.kill(pid, 0);
          fs.appendFileSync(
            getLogPath(),
            `[${Date.now()}] Daemon PID ${pid} still alive ${TERMINATION_GRACE_MS}ms after SIGTERM; escalating to SIGKILL.\n`,
          );
          killDaemonTree(pid, 'SIGKILL');
        } catch {
          // Already exited on its own during the grace period - nothing to
          // escalate.
        }
      }, TERMINATION_GRACE_MS).unref();
    } catch {
      // Ignore if process is already dead or permission denied
    }
  }
  clearState();
}

export function isDaemonRunning(): boolean {
  const state = loadState();
  if (!state || !state.pid) {
    return false;
  }
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes on-disk loop state that was left behind by a daemon process
 * which is no longer running (crash, OS reboot, unexpected kill) before it
 * is used to decide whether/how to restart. Without this:
 *  - a stale `currentPhase: 'running'` would make `/loop status` claim a
 *    run is still in progress forever, even though the process that would
 *    ever update it again is gone;
 *  - a stale `pid` could later coincidentally match an unrelated reused
 *    PID once the OS recycles it, causing `isDaemonRunning()` to report a
 *    false positive.
 *
 * A daemon found dead while `currentPhase` was `'running'` is also treated
 * as a setback (retryCount is incremented) so a loop whose daemon keeps
 * crashing immediately after every auto-restart still eventually gives up,
 * instead of respawning forever in a tight crash loop.
 *
 * Mirrors zero's `loadTasks()` normalizing `StatusRunning` -> `StatusError`
 * on load (see report_11.md §2/§9-5). Note: unlike openclaude's
 * `verifyBackgroundSessionProcessIdentity()`, this does not attempt to
 * verify that a live PID is actually *our* daemon and not an unrelated
 * reused PID (that would require reading platform-specific process
 * metadata such as `/proc/<pid>/cmdline`); this is called out as follow-up
 * work in task_13.md rather than implemented here.
 *
 * Returns the normalized state to restart with, or `undefined` if the loop
 * should be given up on instead (max retries exceeded) - in which case the
 * on-disk state has already been cleared.
 */
export function normalizeStaleState(state: LoopState): LoopState | undefined {
  const wasMidRun = state.currentPhase === 'running';
  if (!wasMidRun) {
    return { ...state, pid: undefined };
  }

  const retryCount = (state.retryCount ?? 0) + 1;
  if (retryCount > MAX_RETRY_COUNT) {
    fs.appendFileSync(
      getLogPath(),
      `[${Date.now()}] BG Loop: Daemon was found dead mid-run ${
        retryCount - 1
      } times in a row. Giving up and clearing schedule.\n`,
    );
    clearState();
    return undefined;
  }

  fs.appendFileSync(
    getLogPath(),
    `[${Date.now()}] BG Loop: Detected stale in-flight state from a dead daemon (pid: ${state.pid}); normalizing before restart (setback #${retryCount}).\n`,
  );

  return {
    ...state,
    pid: undefined,
    currentPhase: 'idle',
    retryCount,
    lastError:
      'Daemon process was found dead while a run was in flight (crash or unexpected termination).',
  };
}

// This process is the actual detached daemon spawned by startDaemon() (see
// gemini.tsx's matching `process.argv.includes('loop') && ...('daemon')`
// check that drives auto-start there). Only the daemon process should force
// its own exit below; the interactive CLI process also loads this module and
// must keep handling SIGINT/SIGTERM through its own shutdown path.
const isLoopDaemonProcess =
  process.argv.includes('loop') && process.argv.includes('daemon');

function handleTerminationSignal(): void {
  clearTimer();
  // Registering a SIGINT/SIGTERM listener suppresses Node's default
  // "terminate immediately" behavior for that signal. If a background run is
  // in-flight (e.g. awaiting a long subagent call), the event loop stays
  // alive and the daemon process would otherwise ignore `/loop stop`
  // indefinitely. Force the daemon to exit so stopDaemon()'s SIGTERM is
  // actually honored.
  if (isLoopDaemonProcess) {
    process.exit(0);
  }
}

// Ensure active timers (not disk state) are cleared on process termination
process.on('SIGINT', handleTerminationSignal);
process.on('SIGTERM', handleTerminationSignal);
