/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { eventBus } from '../services/eventBus.js';
import { runAndMonitor } from '../services/backgroundTaskRunner.js';
import { taskManager } from '../services/taskManager.js';

interface LoopTriggerPayload {
  originalArgs: string;
  commandToRun: string;
}

/**
 * Initializes the listener for loop-related events.
 */
export function initializeLoopCycleListener(): void {
  eventBus.on('loop-trigger', (payload: LoopTriggerPayload) => {
    // A simple rule: always continue the loop for now.
    // A future implementation (Phase 2: AutonomousAgent) would have more
    // sophisticated logic here, potentially involving an LLM call.

    const task = taskManager.createTask(payload.commandToRun);
    runAndMonitor(task, payload.commandToRun);
  });

  eventBus.on('task-completed', (_task) => {
    // For now, we just log the completion.
    // The AutonomousAgent (Phase 2) will use this event to decide
    // the next action.
  });
}
