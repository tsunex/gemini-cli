/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
  type CommandContext,
} from './types.js';
import {
  parseLoopArgs,
  buildFixedPrompt,
  buildDynamicPrompt,
  loadLoopState,
  startLoopDaemon,
  stopLoopDaemon,
  isLoopDaemonRunning,
  LoopAlreadyRunningError,
  BACKGROUND_RUN_TIMEOUT_MS,
  type LoopState,
} from '@google/gemini-cli-core';

const LOCAL_MAINTENANCE_PROMPT = 'This is a maintenance prompt.';

// Default background interval when the user does not specify one. 1 minute
// is a practical lower bound for "monitoring/maintenance" use cases while
// keeping API/rate-limit costs manageable (see design_loop_autonomous_v2.md
// §4.4 discussion / task_08.md defect ④).
const DEFAULT_INTERVAL_MS = 60000;

// Hard floor for the background interval. Even if the user explicitly
// requests something shorter (e.g. "-i 1s"), values below this are clamped
// up to avoid runaway API usage / rate-limit exhaustion from an unattended
// detached daemon.
const MIN_INTERVAL_MS = 10000;

export const loopCommand: SlashCommand = {
  name: 'loop',
  description:
    'Run a prompt on a fixed interval or dynamically reschedule it in the background. Usage: /loop [interval] [prompt] [--background] | /loop stop | /loop status',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const trimmedArgs = args.trim();
    const lowerArgs = trimmedArgs.toLowerCase();

    // Check for control commands
    if (lowerArgs === 'stop') {
      stopLoopDaemon();
      return {
        type: 'message',
        messageType: 'info',
        content: 'Background loop daemon stopped.',
      };
    }

    if (lowerArgs === 'status') {
      const state = loadLoopState();
      let status: string;
      if (state) {
        const isRunning = isLoopDaemonRunning();
        status = `Loop is scheduled to run next at ${new Date(
          state.nextRun,
        ).toLocaleString()}.\n  - Daemon Status: ${isRunning ? `Running (PID: ${state.pid})` : 'Stopped/Dead'}`;
        // Surface the heartbeat so a stuck-but-alive run is visible instead
        // of only a stale "next run" timestamp (see report_11.md §6/§9-3).
        // Rather than guessing "stuck" from an arbitrary elapsed-time
        // threshold (which cannot generalize across prompts - a complex
        // investigation may legitimately take much longer than a simple
        // file check), report the objective countdown to the same
        // BACKGROUND_RUN_TIMEOUT_MS the watchdog itself uses (task_15.md),
        // so the user can judge for themselves whether a run is merely
        // slow or is approaching automatic recovery.
        if (state.currentPhase === 'running') {
          const secondsSinceHeartbeat = state.lastHeartbeatAt
            ? Math.round((Date.now() - state.lastHeartbeatAt) / 1000)
            : undefined;
          if (secondsSinceHeartbeat !== undefined) {
            const secondsUntilWatchdog = Math.max(
              0,
              Math.round(
                (BACKGROUND_RUN_TIMEOUT_MS -
                  (Date.now() - state.lastHeartbeatAt!)) /
                  1000,
              ),
            );
            status += `\n  - Currently executing a background run (last activity ${secondsSinceHeartbeat}s ago; will auto-recover in ${secondsUntilWatchdog}s if it stays silent).`;
          } else {
            status += '\n  - Currently executing a background run.';
          }
          // Surface subagent delegation explicitly, since it blocks the
          // run with no further stream events for as long as the
          // subagent takes (see task_18.md) - without this, a delegated
          // run looks identical to an unexplained silence.
          if (state.currentAction) {
            status += `\n  - ${state.currentAction}`;
          }
        }
        if (state.retryCount) {
          status += `\n  - Consecutive Failures: ${state.retryCount}`;
        }
        if (state.lastError) {
          status += `\n  - Last Error: ${state.lastError}`;
        }
      } else {
        status = 'No loop is currently scheduled.';
      }
      return {
        type: 'message',
        messageType: 'info',
        content: status,
      };
    }

    const parsed = parseLoopArgs(args);

    if (parsed.background) {
      if (!context.services.agentContext) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Agent context is not available for background scheduling.',
        };
      }

      const requestedIntervalMs = parsed.intervalMs ?? DEFAULT_INTERVAL_MS;
      const intervalMs = Math.max(requestedIntervalMs, MIN_INTERVAL_MS);
      const wasClamped = intervalMs !== requestedIntervalMs;
      const config = context.services.agentContext.config;
      const effectivePrompt = parsed.prompt ?? LOCAL_MAINTENANCE_PROMPT;

      const state: LoopState = {
        nextRun: Date.now() + intervalMs,
        mode: parsed.mode,
        prompt: effectivePrompt,
        intervalMs,
      };

      try {
        startLoopDaemon(state, config);
      } catch (e) {
        if (e instanceof LoopAlreadyRunningError) {
          return {
            type: 'message',
            messageType: 'error',
            content: `${e.message}`,
          };
        }
        throw e;
      }

      const nextRunDate = new Date(state.nextRun);
      const clampWarning = wasClamped
        ? `\n  - WARNING: Requested interval (${requestedIntervalMs}ms) was too short and has been raised to the minimum of ${MIN_INTERVAL_MS}ms to avoid excessive API usage / rate-limit exhaustion.`
        : '';
      return {
        type: 'message',
        messageType: 'info',
        content: `Background loop has been scheduled successfully as detached daemon.\n  - Mode: ${state.mode}\n  - Interval: ${intervalMs}ms (${intervalMs / 1000} seconds)\n  - Next run: ${nextRunDate.toLocaleString()}\n  - Prompt: "${effectivePrompt}"\n  - WARNING: Background loop runs with all tool calls auto-approved (YOLO mode). Use "/loop stop" to cancel it at any time.${clampWarning}`,
      };
    }

    // Normal interactive loop (generates prompt instructions)
    const promptText =
      parsed.mode === 'fixed-prompt' || parsed.mode === 'fixed-maintenance'
        ? buildFixedPrompt(parsed)
        : buildDynamicPrompt(parsed);

    return {
      type: 'submit_prompt',
      content: promptText,
    };
  },
};
