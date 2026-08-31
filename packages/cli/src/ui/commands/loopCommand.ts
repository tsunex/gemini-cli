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
  type LoopState,
} from '@google/gemini-cli-core';

const LOCAL_MAINTENANCE_PROMPT = 'This is a maintenance prompt.';

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

      const intervalMs = parsed.intervalMs ?? 300000; // Default to 5 minutes if not specified; a 5s default is unsafe for unattended background execution.
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
      return {
        type: 'message',
        messageType: 'info',
        content: `Background loop has been scheduled successfully as detached daemon.\n  - Mode: ${state.mode}\n  - Interval: ${intervalMs}ms (${intervalMs / 1000} seconds)\n  - Next run: ${nextRunDate.toLocaleString()}\n  - Prompt: "${effectivePrompt}"\n  - WARNING: Background loop runs with all tool calls auto-approved (YOLO mode). Use "/loop stop" to cancel it at any time.`,
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
