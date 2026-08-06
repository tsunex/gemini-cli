/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Storage } from '../config/storage.js';
import { Config } from '../config/config.js';
import {
  schedule,
  loadState,
  saveState,
  clearState,
  type LoopState,
} from './loopScheduler.js';
import { LegacyAgentSession } from '../agent/legacy-agent-session.js';

vi.mock('../agent/legacy-agent-session.js', () => ({
  LegacyAgentSession: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
}));

describe('loopScheduler', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `loop-scheduler-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    vi.spyOn(Storage, 'getProjectLoopStateDir').mockReturnValue(tempDir);
    vi.spyOn(Config.prototype, 'initialize').mockResolvedValue(undefined);
    vi.spyOn(Config.prototype, 'getGeminiClient').mockReturnValue(
      {} as unknown as ReturnType<Config['getGeminiClient']>,
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should save and load loop state', () => {
    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
    };

    saveState(state);
    const loaded = loadState();
    expect(loaded).toEqual(state);
  });

  it('should return undefined if no state exists', () => {
    const loaded = loadState();
    expect(loaded).toBeUndefined();
  });

  it('should clear loop state', () => {
    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
    };

    saveState(state);
    expect(loadState()).toEqual(state);

    clearState();
    expect(loadState()).toBeUndefined();
  });

  it('should schedule loop and run session', async () => {
    const mockConfig = {
      _params: {
        targetDir: tempDir,
        sessionId: 'test-session',
      },
      initialize: vi.fn().mockResolvedValue(undefined),
    } as unknown as Config;

    const events = [
      {
        type: 'message',
        streamId: 'mock-stream',
        timestamp: new Date().toISOString(),
        role: 'agent',
        content: [{ type: 'text', text: 'System status is normal.' }],
      },
    ];

    async function* mockSendStream() {
      for (const event of events) {
        yield event;
      }
    }

    const sendStreamMock = vi.fn().mockReturnValue(mockSendStream());
    vi.mocked(LegacyAgentSession).mockImplementation(
      () =>
        ({
          sendStream: sendStreamMock,
        }) as unknown as LegacyAgentSession,
    );

    const { coreEvents } = await import('../utils/events.js');
    const emitSpy = vi.spyOn(coreEvents, 'emit');

    const interval = 5000;
    const state: LoopState = {
      nextRun: Date.now() + interval,
      mode: 'fixed-prompt',
      prompt: 'Verify system',
      intervalMs: interval,
    };

    schedule(state, mockConfig);

    // Fast-forward time
    vi.advanceTimersByTime(interval);

    // Flush all pending promises and microtasks of the async generator loop
    for (let i = 0; i < 20; i++) {
      vi.runAllTicks();
      await Promise.resolve();
    }

    expect(sendStreamMock).toHaveBeenCalledWith({
      message: {
        content: [{ type: 'text', text: 'Verify system' }],
      },
    });

    expect(emitSpy).toHaveBeenCalledWith(
      'user-feedback',
      expect.objectContaining({
        severity: 'info',
        message: expect.stringContaining('System status is normal.'),
      }),
    );

    // Check that loop state is updated for next run
    const loaded = loadState();
    expect(loaded).toBeDefined();
    expect(loaded!.nextRun).toBeGreaterThanOrEqual(Date.now() + interval);
  });

  it('should clear state on process exit signals', () => {
    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Test SIGINT',
      intervalMs: 5000,
    };

    saveState(state);
    expect(loadState()).toEqual(state);

    // Trigger SIGINT event on process
    process.emit('SIGINT');

    expect(loadState()).toBeUndefined();
  });
});
