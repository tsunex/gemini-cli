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
import { schedule, type LoopState } from '../services/loopScheduler.js';
import { parseLoopArgs, type ParsedLoopArgs } from './loop-parser.js';
import { type MessageBus } from '../confirmation-bus/message-bus.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

const MAINTENANCE_PROMPT = 'This is a maintenance prompt.';
const DYNAMIC_MIN_DELAY = '1m';
const DYNAMIC_MAX_DELAY = '5m';

export class LoopTool extends BaseDeclarativeTool<object, ToolResult> {
  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
  ) {
    super('loop', 'Loop', 'A tool for looping.', Kind.Other, {}, messageBus);
  }

  createInvocation(
    params: object,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<object, ToolResult> {
    const parsed = parseLoopArgs(params.toString());
    const config = this.context.config;

    if (parsed.background) {
      if (!parsed.intervalMs) {
        // This should be a validation error.
        throw new Error('Interval is required for background loops.');
      }
      const state: LoopState = {
        nextRun: Date.now() + parsed.intervalMs,
        mode: parsed.mode,
        prompt: parsed.prompt ?? MAINTENANCE_PROMPT,
        intervalMs: parsed.intervalMs,
      };
      schedule(state, config);
      const result: ToolResult = {
        llmContent: `Loop scheduled to run every ${parsed.interval}.`,
        returnDisplay: `Loop scheduled to run every ${parsed.interval}.`,
      };
      return new LoopToolInvocation(result, messageBus);
    }

    let prompt: string;
    if (parsed.mode.startsWith('fixed')) {
      prompt = buildFixedPrompt(parsed);
    } else {
      prompt = buildDynamicPrompt(parsed);
    }
    const result: ToolResult = {
      llmContent: prompt,
      returnDisplay: prompt,
    };
    return new LoopToolInvocation(result, messageBus);
  }
}

class LoopToolInvocation
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
    return 'Loop tool invocation';
  }

  async execute(): Promise<ToolResult> {
    return this.result;
  }
}

export function buildFixedPrompt(parsed: ParsedLoopArgs): string {
  const targetInstructions = parsed.prompt
    ? `Use this prompt verbatim for both the immediate run and the recurring scheduled task:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

For the recurring scheduled task, use this exact maintenance prompt body:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`;

  return `# /loop — fixed recurring interval

The user invoked /loop with a fixed interval.

Requested interval: ${parsed.interval}

${targetInstructions}
## Instructions

1. Briefly confirm what was scheduled and the human cadence.
2. Immediately execute the effective prompt now — do not wait for the first timer fire.
   - If the effective prompt starts with a slash command, invoke it.
   - Otherwise, act on it directly.
`;
}

export function buildDynamicPrompt(parsed: ParsedLoopArgs): string {
  const effectivePromptInstructions = parsed.prompt
    ? `Use this prompt verbatim as the effective prompt for this iteration:

--- BEGIN PROMPT ---
${parsed.prompt}
--- END PROMPT ---
`
    : `This is a maintenance loop with no explicit prompt.

Determine the effective prompt in this order:
1. If .gemini/loop.md exists, read it and use it.
2. Otherwise, if ~/.gemini/loop.md exists, read it and use it.
3. Otherwise, use this built-in maintenance prompt:

--- BEGIN MAINTENANCE PROMPT ---
${MAINTENANCE_PROMPT}
--- END MAINTENANCE PROMPT ---
`;

  const reschedulePrompt = parsed.prompt ? `/loop ${parsed.prompt}` : '/loop';

  return `# /loop — dynamic rescheduling

The user invoked /loop without a fixed interval.

${effectivePromptInstructions}
## Instructions

1. Execute the effective prompt now.
   - If it starts with a slash command, invoke it.
   - Otherwise, act on it directly.
2. After the work finishes, choose the next delay dynamically between ${DYNAMIC_MIN_DELAY} and ${DYNAMIC_MAX_DELAY}.
   - Use shorter delays while active work is progressing or likely to change soon.
   - Use longer delays when the situation is quiet or stable.
3. Briefly tell the user the chosen delay and the reason.
4. Schedule exactly one session-only follow-up run by writing a scheduled task or notifying the loop scheduler.
   - Set the scheduled prompt to this exact text so the next iteration stays in dynamic mode:

--- BEGIN SCHEDULED PROMPT ---
${reschedulePrompt}
--- END SCHEDULED PROMPT ---

5. Confirm the next run time.
`;
}
