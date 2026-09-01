/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loopCommand } from './loopCommand.js';
import { CommandKind, type CommandContext } from './types.js';
import * as core from '@google/gemini-cli-core';

vi.mock('@google/gemini-cli-core', () => {
  class MockLoopAlreadyRunningError extends Error {
    constructor(pid: number) {
      super(
        `Loop daemon is already running (PID: ${pid}). Run "/loop stop" first if you want to reschedule.`,
      );
      this.name = 'LoopAlreadyRunningError';
    }
  }
  return {
    parseLoopArgs: vi.fn(),
    buildFixedPrompt: vi.fn(() => 'Mocked fixed prompt instructions'),
    buildDynamicPrompt: vi.fn(() => 'Mocked dynamic prompt instructions'),
    loadLoopState: vi.fn(),
    startLoopDaemon: vi.fn(),
    stopLoopDaemon: vi.fn(),
    isLoopDaemonRunning: vi.fn(),
    LoopAlreadyRunningError: MockLoopAlreadyRunningError,
    BACKGROUND_RUN_TIMEOUT_MS: 5 * 60 * 1000,
  };
});

describe('loopCommand', () => {
  let mockContext: CommandContext;
  const action = loopCommand.action;

  if (!action) {
    throw new Error('Loop command has no action');
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mockContext = {
      services: {
        agentContext: {
          config: {
            getSessionId: vi.fn().mockReturnValue('mock-session-id'),
          },
        },
      },
    } as unknown as CommandContext;
  });

  it('should have the correct command properties', () => {
    expect(loopCommand.name).toBe('loop');
    expect(loopCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(loopCommand.description).toContain(
      'Run a prompt on a fixed interval',
    );
  });

  it('should clear loop state on stop command', async () => {
    const result = await action(mockContext, 'stop');

    expect(core.stopLoopDaemon).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Background loop daemon stopped.',
    });
  });

  it('should report no loop is scheduled on status when state is empty', async () => {
    vi.mocked(core.loadLoopState).mockReturnValue(undefined);

    const result = await action(mockContext, 'status');

    expect(core.loadLoopState).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No loop is currently scheduled.',
    });
  });

  it('should report next run on status when loop is active', async () => {
    const nextRunTime = 1774900000000;
    vi.mocked(core.loadLoopState).mockReturnValue({
      nextRun: nextRunTime,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid: 1234,
    });
    vi.mocked(core.isLoopDaemonRunning).mockReturnValue(true);

    const result = await action(mockContext, 'status');

    expect(core.loadLoopState).toHaveBeenCalled();
    expect(core.isLoopDaemonRunning).toHaveBeenCalled();
    expect(result).toBeDefined();
    if (result && 'type' in result) {
      expect(result.type).toBe('message');
      if (result.type === 'message') {
        expect(result.messageType).toBe('info');
        expect(result.content).toContain('Loop is scheduled to run next at');
        expect(result.content).toContain('Running (PID: 1234)');
      }
    }
  });

  it('should show an objective countdown to the watchdog auto-recovery while a run is in flight', async () => {
    const heartbeatAgeMs = 68_000;
    vi.mocked(core.loadLoopState).mockReturnValue({
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Check for text.txt',
      intervalMs: 5000,
      pid: 1234,
      currentPhase: 'running',
      lastHeartbeatAt: Date.now() - heartbeatAgeMs,
    });
    vi.mocked(core.isLoopDaemonRunning).mockReturnValue(true);

    const result = await action(mockContext, 'status');

    expect(result).toBeDefined();
    if (result && 'type' in result && result.type === 'message') {
      // Reports elapsed time since the last observed activity...
      expect(result.content).toContain('last activity 68s ago');
      // ...and the objective remaining time until the watchdog
      // (BACKGROUND_RUN_TIMEOUT_MS, mocked to 5 minutes above) would abort
      // a still-silent run - not a made-up "stuck" verdict, since a
      // fixed elapsed-time threshold cannot generalize across prompts of
      // varying legitimate complexity (see task_16.md).
      expect(result.content).toContain('will auto-recover in 232s');
    }
  });

  it('should schedule background loop when background flag is present', async () => {
    vi.mocked(core.parseLoopArgs).mockReturnValue({
      mode: 'fixed-prompt',
      interval: '10s',
      intervalMs: 10000,
      prompt: 'Check server health',
      background: true,
      detach: false,
    });

    const result = await action(
      mockContext,
      '-i 10s --background Check server health',
    );

    expect(core.startLoopDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'fixed-prompt',
        prompt: 'Check server health',
        intervalMs: 10000,
        detached: false,
        ownerPid: process.pid,
        ownerSessionId: 'mock-session-id',
        ownerWorkspace: process.cwd(),
      }),
      expect.any(Object),
    );

    expect(result).toBeDefined();
    if (result && 'type' in result) {
      expect(result.type).toBe('message');
      if (result.type === 'message') {
        expect(result.messageType).toBe('info');
        expect(result.content).toContain(
          'Background loop has been scheduled successfully as a session-owned daemon.',
        );
      }
    }
  });

  it('should schedule detached background loop when background and detach flags are present', async () => {
    vi.mocked(core.parseLoopArgs).mockReturnValue({
      mode: 'fixed-prompt',
      interval: '10s',
      intervalMs: 10000,
      prompt: 'Check server health',
      background: true,
      detach: true,
    });

    const result = await action(
      mockContext,
      '-i 10s --background --detach Check server health',
    );

    expect(core.startLoopDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'fixed-prompt',
        prompt: 'Check server health',
        intervalMs: 10000,
        detached: true,
        ownerPid: process.pid,
        ownerSessionId: 'mock-session-id',
        ownerWorkspace: process.cwd(),
      }),
      expect.any(Object),
    );

    expect(result).toBeDefined();
    if (result && 'type' in result && result.type === 'message') {
      expect(result.content).toContain(
        'Background loop has been scheduled successfully as a detached daemon.',
      );
    }
  });

  it('should return prompt submission for normal loop', async () => {
    vi.mocked(core.parseLoopArgs).mockReturnValue({
      mode: 'fixed-prompt',
      interval: '5m',
      intervalMs: 300000,
      prompt: 'Analyze memory dump',
      background: false,
    });

    const result = await action(mockContext, '-i 5m Analyze memory dump');

    expect(core.buildFixedPrompt).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'Mocked fixed prompt instructions',
    });
  });

  it('should include the YOLO warning in the background scheduling message', async () => {
    vi.mocked(core.parseLoopArgs).mockReturnValue({
      mode: 'fixed-prompt',
      interval: '10s',
      intervalMs: 10000,
      prompt: 'Check server health',
      background: true,
    });

    const result = await action(
      mockContext,
      '-i 10s --background Check server health',
    );

    expect(result).toBeDefined();
    if (result && 'type' in result && result.type === 'message') {
      expect(result.content).toContain('auto-approved (YOLO mode)');
    }
  });

  it('should default to a 1 minute interval when none is specified', async () => {
    vi.mocked(core.parseLoopArgs).mockReturnValue({
      mode: 'fixed-prompt',
      interval: undefined,
      intervalMs: undefined,
      prompt: 'Check server health',
      background: true,
    });

    await action(mockContext, '--background Check server health');

    expect(core.startLoopDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 60000 }),
      expect.any(Object),
    );
  });

  it('should clamp an unsafely short requested interval up to the 10 second floor and warn', async () => {
    vi.mocked(core.parseLoopArgs).mockReturnValue({
      mode: 'fixed-prompt',
      interval: '1s',
      intervalMs: 1000,
      prompt: 'Check server health',
      background: true,
    });

    const result = await action(
      mockContext,
      '-i 1s --background Check server health',
    );

    expect(core.startLoopDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: 10000 }),
      expect.any(Object),
    );
    expect(result).toBeDefined();
    if (result && 'type' in result && result.type === 'message') {
      expect(result.content).toContain('raised to the minimum of 10000ms');
    }
  });

  it('should return an error message instead of throwing when a daemon is already running', async () => {
    vi.mocked(core.parseLoopArgs).mockReturnValue({
      mode: 'fixed-prompt',
      interval: '10s',
      intervalMs: 10000,
      prompt: 'Check server health',
      background: true,
    });
    vi.mocked(core.startLoopDaemon).mockImplementation(() => {
      throw new core.LoopAlreadyRunningError(1234);
    });

    const result = await action(
      mockContext,
      '-i 10s --background Check server health',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Loop daemon is already running'),
    });
  });

  it('should include failure diagnostics in status when the loop has retried', async () => {
    vi.mocked(core.loadLoopState).mockReturnValue({
      nextRun: 1774900000000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid: 1234,
      retryCount: 3,
      lastError: 'ECONNRESET',
    });
    vi.mocked(core.isLoopDaemonRunning).mockReturnValue(true);

    const result = await action(mockContext, 'status');

    expect(result).toBeDefined();
    if (result && 'type' in result && result.type === 'message') {
      expect(result.content).toContain('Consecutive Failures: 3');
      expect(result.content).toContain('Last Error: ECONNRESET');
    }
  });

  it('should report session-owned lifecycle and ownership metadata in status', async () => {
    vi.mocked(core.loadLoopState).mockReturnValue({
      nextRun: 1774900000000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid: 1234,
      detached: false,
      ownerPid: process.pid,
      ownerSessionId: 'mock-session-id',
      ownerWorkspace: process.cwd(),
    });
    vi.mocked(core.isLoopDaemonRunning).mockReturnValue(true);

    const result = await action(mockContext, 'status');

    expect(result).toBeDefined();
    if (result && 'type' in result && result.type === 'message') {
      expect(result.content).toContain('Lifecycle: session-owned');
      expect(result.content).toContain(`Owner PID: ${process.pid}`);
      expect(result.content).toContain('Owner Session ID: mock-session-id');
      expect(result.content).toContain(`Owner Workspace: ${process.cwd()}`);
    }
  });

  it('should report warnings in status when owner PID is dead or workspace/session mismatch', async () => {
    vi.mocked(core.loadLoopState).mockReturnValue({
      nextRun: 1774900000000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid: 1234,
      detached: false,
      ownerPid: 999999, // Dead/stale owner PID
      ownerSessionId: 'other-session-id',
      ownerWorkspace: '/some/other/workspace',
    });
    vi.mocked(core.isLoopDaemonRunning).mockReturnValue(true);

    const result = await action(mockContext, 'status');

    expect(result).toBeDefined();
    if (result && 'type' in result && result.type === 'message') {
      expect(result.content).toContain(
        'WARNING: The owning interactive process (PID: 999999) is no longer alive',
      );
      expect(result.content).toContain('WARNING: Current workspace');
      expect(result.content).toContain('WARNING: Current session ID');
    }
  });
});
