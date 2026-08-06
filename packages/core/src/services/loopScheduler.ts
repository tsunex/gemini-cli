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

export interface LoopState {
  nextRun: number;
  mode: string;
  prompt: string;
  intervalMs?: number;
}

const STATE_FILE = 'state.json';

function getStatePath(): string {
  return path.join(Storage.getProjectLoopStateDir(), STATE_FILE);
}

import { LegacyAgentSession } from '../agent/legacy-agent-session.js';
import { Config } from '../config/config.js';
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
    // Clone config for background session to avoid state pollution and locking
    const params = config._params;
    const backgroundConfig = new Config({
      ...params,
      sessionId: `background-loop-${Date.now()}`,
    });

    let accumulatedText = '';
    try {
      await backgroundConfig.initialize();
      const session = new LegacyAgentSession({ config: backgroundConfig });
      const stream = session.sendStream({
        message: {
          content: [{ type: 'text', text: state.prompt }],
        },
      });

      for await (const event of stream) {
        if (event.type === 'message' && event.role === 'agent') {
          for (const part of event.content) {
            if (part.type === 'text') {
              accumulatedText += part.text;
            }
          }
        }
      }

      if (accumulatedText.trim()) {
        coreEvents.emit(CoreEvent.UserFeedback, {
          severity: 'info',
          message: `[Loop Background Response]\n${accumulatedText.trim()}`,
        });
      }

      const newState: LoopState = {
        ...state,
        nextRun: Date.now() + (state.intervalMs ?? 0),
      };
      schedule(newState, config);
    } catch (e) {
      coreEvents.emit(CoreEvent.UserFeedback, {
        severity: 'error',
        message: `Error in loop execution: ${e instanceof Error ? e.message : String(e)}`,
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
  const statePath = getStatePath();
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }
}

// Ensure state is cleared on process termination
process.on('SIGINT', () => {
  clearState();
});
process.on('SIGTERM', () => {
  clearState();
});
