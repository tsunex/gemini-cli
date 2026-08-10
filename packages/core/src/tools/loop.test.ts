/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LoopTool } from './loop.js';
import { LoopStopTool, LoopStatusTool } from './loopControl.js';
import { type MessageBus } from '../confirmation-bus/message-bus.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import * as loopScheduler from '../services/loopScheduler.js';

vi.mock('../services/loopScheduler.js', () => ({
  schedule: vi.fn(),
  loadState: vi.fn(),
  clearState: vi.fn(),
}));

describe('LoopTools', () => {
  let mockContext: AgentLoopContext;
  let mockMessageBus: MessageBus;

  beforeEach(() => {
    mockContext = {
      config: {
        getGlobalGeminiDir: () => '/mock/dir',
      },
    } as unknown as AgentLoopContext;
    mockMessageBus = {} as unknown as MessageBus;
    vi.restoreAllMocks();
  });

  describe('LoopTool', () => {
    it('should generate buildPrompt instructions for standard run', async () => {
      const tool = new LoopTool(mockContext, mockMessageBus);
      const invocation = tool.createInvocation(
        { args: 'Verify database index structure' },
        mockMessageBus,
      );

      expect(invocation.getDescription()).toBe('Loop tool invocation');
      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });
      expect(result.llmContent).toContain('/loop — dynamic rescheduling');
      expect(result.llmContent).toContain('Verify database index structure');
    });

    it('should schedule background loop if background flag is present', async () => {
      const tool = new LoopTool(mockContext, mockMessageBus);
      const invocation = tool.createInvocation(
        { args: '-i 10m --background Analyze resource consumption' },
        mockMessageBus,
      );

      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });
      expect(result.returnDisplay).toBe('Loop scheduled to run every 10m.');
      expect(loopScheduler.schedule).toHaveBeenCalled();
    });
  });

  describe('LoopStopTool', () => {
    it('should stop and clear loop state', async () => {
      const tool = new LoopStopTool(mockMessageBus);
      const invocation = tool.createInvocation({}, mockMessageBus);

      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });
      expect(result.returnDisplay).toBe('Loop stopped.');
      expect(loopScheduler.clearState).toHaveBeenCalled();
    });
  });

  describe('LoopStatusTool', () => {
    it('should report correct status when loop is scheduled', async () => {
      vi.mocked(loopScheduler.loadState).mockReturnValue({
        nextRun: 1774900000000, // Fixed mock timestamp
        mode: 'fixed-prompt',
        prompt: 'Check logs',
        intervalMs: 60000,
      });

      const tool = new LoopStatusTool(mockMessageBus);
      const invocation = tool.createInvocation({}, mockMessageBus);

      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });
      expect(result.returnDisplay).toContain(
        'Loop is scheduled to run next at',
      );
    });

    it('should report no loop is scheduled when empty', async () => {
      vi.mocked(loopScheduler.loadState).mockReturnValue(undefined);

      const tool = new LoopStatusTool(mockMessageBus);
      const invocation = tool.createInvocation({}, mockMessageBus);

      const result = await invocation.execute({
        abortSignal: new AbortController().signal,
      });
      expect(result.returnDisplay).toBe('No loop is currently scheduled.');
    });
  });
});
