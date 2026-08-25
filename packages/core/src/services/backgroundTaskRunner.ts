/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { spawn } from 'node:child_process';
import { eventBus } from './eventBus.js';
import { taskManager, type Task } from './taskManager.js';

/**
 * Executes a command in a separate process and monitors its execution.
 * When the command completes, it updates the task status and emits a
 * 'task-completed' event.
 *
 * @param task The task object from the TaskManager.
 * @param command The full command string to execute.
 */
export function runAndMonitor(task: Task, command: string): void {
  // Immediately update task status to 'running'
  taskManager.updateTask(task.id, { status: 'running' });

  // A more robust implementation would parse the command string,
  // but for now, we use the shell to handle it.
  const child = spawn(command, {
    stdio: 'pipe',
    shell: true,
  });

  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  child.stderr.on('data', (data) => {
    output += data.toString();
  });

  child.on('close', (code) => {
    const status = code === 0 ? 'success' : 'error';
    const finalTask = taskManager.updateTask(task.id, {
      status,
      output,
      endTime: Date.now(),
    });

    if (finalTask) {
      eventBus.emit('task-completed', finalTask);
    }
  });

  child.on('error', (err) => {
    // This catches errors in spawning the process itself.
    const finalTask = taskManager.updateTask(task.id, {
      status: 'error',
      output: `Failed to start task: ${err.message}`,
      endTime: Date.now(),
    });

    if (finalTask) {
      eventBus.emit('task-completed', finalTask);
    }
  });
}
