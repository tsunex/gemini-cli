/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  type ToolInvocation,
  type ToolResult,
  BaseToolInvocation,
  Kind,
} from './tools.js';
import {
  loadState,
  stopLoopFromCurrentProcess,
} from '../services/loopScheduler.js';
import { type MessageBus } from '../confirmation-bus/message-bus.js';
import { type Config } from '../config/config.js';

export class LoopStopTool extends BaseDeclarativeTool<object, ToolResult> {
  constructor(messageBus: MessageBus) {
    super(
      'loop-stop',
      'Stop Loop',
      'A tool for stopping loops.',
      Kind.Other,
      {},
      messageBus,
    );
  }

  createInvocation(
    params: object,
    messageBus: MessageBus,
    _config: Config,
  ): ToolInvocation<object, ToolResult> {
    stopLoopFromCurrentProcess();
    const result: ToolResult = {
      llmContent: 'Loop stopped.',
      returnDisplay: 'Loop stopped.',
    };
    return new LoopControlToolInvocation(result, messageBus);
  }
}

export class LoopStatusTool extends BaseDeclarativeTool<object, ToolResult> {
  constructor(messageBus: MessageBus) {
    super(
      'loop-status',
      'Loop Status',
      'A tool for getting loop status.',
      Kind.Other,
      {},
      messageBus,
    );
  }

  createInvocation(
    params: object,
    messageBus: MessageBus,
    _config: Config,
  ): ToolInvocation<object, ToolResult> {
    const state = loadState();
    let status: string;
    if (state) {
      status = `Loop is scheduled to run next at ${new Date(
        state.nextRun,
      ).toLocaleString()}.`;
    } else {
      status = 'No loop is currently scheduled.';
    }
    const result: ToolResult = {
      llmContent: status,
      returnDisplay: status,
    };
    return new LoopControlToolInvocation(result, messageBus);
  }
}

class LoopControlToolInvocation
  extends BaseToolInvocation<object, ToolResult>
  implements ToolInvocation<object, ToolResult>
{
  constructor(
    private readonly result: ToolResult,
    messageBus: MessageBus,
  ) {
    super({}, messageBus);
  }

  getDescription(): string {
    return 'Loop control tool invocation';
  }

  async execute(): Promise<ToolResult> {
    return this.result;
  }
}
