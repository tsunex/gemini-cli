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
}

const STATE_FILE = 'state.json';

function getStatePath(): string {
  return path.join(Storage.getProjectLoopStateDir(), STATE_FILE);
}

function getLogPath(): string {
  return path.join(Storage.getProjectLoopStateDir(), 'loop.log');
}

import { LegacyAgentSession } from '../agent/legacy-agent-session.js';
import type { Config } from '../config/config.js';
import { coreEvents, CoreEvent } from '../utils/events.js';

let timeoutId: NodeJS.Timeout | undefined;

export function schedule(state: LoopState, config: Config): void {
  saveState(state);
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

    const backgroundConfig = config.fork({
      approvalMode: ApprovalMode.YOLO, // Force auto-approval for silent background check
      sessionId: `background-loop-${Date.now()}`,
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
          content: [{ type: 'text', text: state.prompt }],
        },
      });

      for await (const event of stream) {
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

      if (accumulatedText.trim()) {
        try {
          const notificationDir = path.join(
            Storage.getProjectLoopStateDir(),
            'notifications',
          );
          fs.mkdirSync(notificationDir, { recursive: true });
          const notificationFile = path.join(
            notificationDir,
            `notify-${Date.now()}-${Math.random().toString(36).substring(2, 9)}.json`,
          );
          fs.writeFileSync(
            notificationFile,
            JSON.stringify(
              {
                timestamp: Date.now(),
                prompt: state.prompt,
                message: accumulatedText.trim(),
              },
              null,
              2,
            ),
          );
        } catch (err) {
          fs.appendFileSync(
            getLogPath(),
            `[${Date.now()}] BG Loop: Failed to write notification file: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
        }

        coreEvents.emit(CoreEvent.UserFeedback, {
          severity: 'info',
          message: `[Loop Background Response]\n${accumulatedText.trim()}`,
        });
      }

      // Check if the state file still exists before rescheduling (e.g. self-stopping called clearState)
      if (fs.existsSync(getStatePath())) {
        const newState: LoopState = {
          ...state,
          nextRun: Date.now() + (state.intervalMs ?? 0),
        };
        fs.appendFileSync(
          getLogPath(),
          `[${Date.now()}] BG Loop: Rescheduling next run.\n`,
        );
        schedule(newState, config);
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      fs.appendFileSync(
        getLogPath(),
        `[${Date.now()}] BG Loop: CATCH BLOCK ERROR: ${errorMessage}\n`,
      );
      coreEvents.emit(CoreEvent.UserFeedback, {
        severity: 'error',
        message: `Error in loop execution: ${errorMessage}`,
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

export function startDaemon(state: LoopState, _config: Config): void {
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

export function stopDaemon(): void {
  const state = loadState();
  if (state && state.pid) {
    try {
      process.kill(state.pid, 0);
      process.kill(state.pid, 'SIGTERM');
      fs.appendFileSync(
        getLogPath(),
        `[${Date.now()}] Sent SIGTERM to daemon PID: ${state.pid}\n`,
      );
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

// Ensure active timers (not disk state) are cleared on process termination
process.on('SIGINT', () => {
  clearTimer();
});
process.on('SIGTERM', () => {
  clearTimer();
});
