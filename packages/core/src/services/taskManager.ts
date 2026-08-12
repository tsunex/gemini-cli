/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

export type TaskStatus = 'running' | 'success' | 'error' | 'pending';

export interface Task {
  id: string;
  command: string;
  status: TaskStatus;
  startTime: number;
  endTime?: number;
  output: string;
}

/**
 * Manages the state of background tasks within the current session.
 */
class TaskManager {
  private tasks = new Map<string, Task>();
  private nextTaskId = 1;

  createTask(command: string): Task {
    const id = `task-${this.nextTaskId++}`;
    const newTask: Task = {
      id,
      command,
      status: 'pending',
      startTime: Date.now(),
      output: '',
    };
    this.tasks.set(id, newTask);
    return newTask;
  }

  updateTask(id: string, updates: Partial<Omit<Task, 'id'>>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }
    const updatedTask = { ...task, ...updates };
    this.tasks.set(id, updatedTask);
    return updatedTask;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }
}

// Export a singleton instance
export const taskManager = new TaskManager();
