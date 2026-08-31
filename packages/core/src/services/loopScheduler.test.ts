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
  startDaemon,
  stopDaemon,
  isDaemonRunning,
  TERMINATION_GRACE_MS,
  LoopAlreadyRunningError,
  type LoopState,
} from './loopScheduler.js';
import { LegacyAgentSession } from '../agent/legacy-agent-session.js';

vi.mock('../agent/legacy-agent-session.js', () => ({
  LegacyAgentSession: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../utils/notificationClient.js', () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
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
    const rawMockConfig = {
      _params: {
        targetDir: tempDir,
        sessionId: 'test-session',
      },
      initialize: vi.fn().mockResolvedValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      fork: vi.fn().mockImplementation((params) => ({
        ...rawMockConfig,
        _params: {
          ...rawMockConfig._params,
          ...params,
        },
      })),
      getGeminiClient: vi.fn().mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const mockConfig = rawMockConfig as unknown as Config;

    const events = [
      {
        type: 'message',
        streamId: 'mock-stream',
        timestamp: new Date().toISOString(),
        role: 'agent',
        content: [
          {
            type: 'text',
            text: 'System status is normal.\n<<<LOOP_TASK_COMPLETE>>>',
          },
        ],
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

    const { sendNotification } = await import('../utils/notificationClient.js');
    const sendNotificationMock = vi.mocked(sendNotification);

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

    // The prompt sent to the model is the original prompt plus the
    // completion-gate instruction appended by schedule() (see task_09.md).
    const sentMessage = sendStreamMock.mock.calls.at(-1)?.[0];
    expect(sentMessage.message.content[0].text).toContain('Verify system');
    expect(sentMessage.message.content[0].text).toContain(
      '<<<LOOP_TASK_COMPLETE>>>',
    );

    // Check that the background config was instantiated with approvalMode: 'yolo' to isolate UI
    const sessionCall = vi.mocked(LegacyAgentSession).mock.calls.at(-1);
    expect(sessionCall).toBeDefined();
    const passedConfig = sessionCall![0].config;
    expect(passedConfig._params).toEqual(
      expect.objectContaining({ approvalMode: 'yolo' }),
    );

    // The daemon process cannot rely on in-process events reaching the UI
    // (it may be a fully detached process), so results are surfaced via the
    // cross-process IPC notification channel instead.
    expect(sendNotificationMock).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'loop_result',
        content: 'System status is normal.',
      }),
    );

    // Check that loop state is updated for next run
    let loaded = loadState();
    expect(loaded).toBeDefined();
    expect(loaded!.nextRun).toBeGreaterThanOrEqual(Date.now() + interval);
    // After a successful run finishes, the loop goes back to "idle" (waiting
    // for the next scheduled run) rather than staying marked as running.
    expect(loaded!.currentPhase).toBe('idle');

    // Ensure clearState clears memory timers and prevents rescheduling
    clearState();
    loaded = loadState();
    expect(loaded).toBeUndefined();
  });

  it('should record a running heartbeat while a background run is in flight', async () => {
    const rawMockConfig = {
      _params: { targetDir: tempDir, sessionId: 'test-session' },
      initialize: vi.fn().mockResolvedValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      fork: vi.fn().mockImplementation((params) => ({
        ...rawMockConfig,
        _params: { ...rawMockConfig._params, ...params },
      })),
      getGeminiClient: vi.fn().mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const mockConfig = rawMockConfig as unknown as Config;

    // A stream that yields one event and then blocks (never resolves the
    // second `next()`), simulating a run that is genuinely still in
    // progress - so we can inspect the on-disk heartbeat mid-flight.
    let releaseStream: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    async function* mockSendStream() {
      yield {
        type: 'message',
        streamId: 'mock-stream',
        timestamp: new Date().toISOString(),
        role: 'agent',
        content: [{ type: 'text', text: 'Working...' }],
      };
      await blocker;
    }

    const sendStreamMock = vi.fn().mockReturnValue(mockSendStream());
    vi.mocked(LegacyAgentSession).mockImplementation(
      () =>
        ({
          sendStream: sendStreamMock,
        }) as unknown as LegacyAgentSession,
    );

    const interval = 5000;
    const state: LoopState = {
      nextRun: Date.now() + interval,
      mode: 'fixed-prompt',
      prompt: 'Check for text.txt',
      intervalMs: interval,
    };

    schedule(state, mockConfig);
    // Before the timer fires, the loop is persisted as idle.
    expect(loadState()!.currentPhase).toBe('idle');

    vi.advanceTimersByTime(interval);
    for (let i = 0; i < 20; i++) {
      vi.runAllTicks();
      await Promise.resolve();
    }

    // The run has started and yielded its first event, but is still
    // in-flight (blocked on `blocker`): the on-disk heartbeat should reflect
    // "running", with a fresh timestamp.
    const midFlight = loadState();
    expect(midFlight).toBeDefined();
    expect(midFlight!.currentPhase).toBe('running');
    expect(midFlight!.lastHeartbeatAt).toBeDefined();
    expect(midFlight!.lastHeartbeatAt!).toBeLessThanOrEqual(Date.now());

    // Let the run finish so the fake timer / pending promises do not leak
    // into the next test.
    releaseStream();
    for (let i = 0; i < 20; i++) {
      vi.runAllTicks();
      await Promise.resolve();
    }
  });

  it('should treat a run without a completion signal as incomplete: no notification, retry backoff applied', async () => {
    const rawMockConfig = {
      _params: { targetDir: tempDir, sessionId: 'test-session' },
      initialize: vi.fn().mockResolvedValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      fork: vi.fn().mockImplementation((params) => ({
        ...rawMockConfig,
        _params: { ...rawMockConfig._params, ...params },
      })),
      getGeminiClient: vi.fn().mockReturnValue({
        initialize: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const mockConfig = rawMockConfig as unknown as Config;

    // Simulates the agent going on a tangent instead of confirming
    // completion of the requested check (see task_09.md / report_11.md §3).
    const events = [
      {
        type: 'message',
        streamId: 'mock-stream',
        timestamp: new Date().toISOString(),
        role: 'agent',
        content: [
          { type: 'text', text: 'Let me look into something unrelated...' },
        ],
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

    const { sendNotification } = await import('../utils/notificationClient.js');
    const sendNotificationMock = vi.mocked(sendNotification);

    const interval = 5000;
    const state: LoopState = {
      nextRun: Date.now() + interval,
      mode: 'fixed-prompt',
      prompt: 'Check for text.txt',
      intervalMs: interval,
    };

    schedule(state, mockConfig);
    vi.advanceTimersByTime(interval);
    for (let i = 0; i < 20; i++) {
      vi.runAllTicks();
      await Promise.resolve();
    }

    // No completion marker was present, so the partial/distracted output
    // must not be surfaced to the user.
    expect(sendNotificationMock).not.toHaveBeenCalled();

    // The run counts as a setback: retryCount increments and the next run
    // is backed off further than the plain interval, exactly like a thrown
    // error would be handled.
    const loaded = loadState();
    expect(loaded).toBeDefined();
    expect(loaded!.retryCount).toBe(1);
    expect(loaded!.lastError).toContain('completion signal');
    expect(loaded!.nextRun).toBeGreaterThan(Date.now() + interval);
  });

  it('should clear timer on process exit signals but preserve state.json', () => {
    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Test SIGINT',
      intervalMs: 5000,
    };

    saveState(state);
    expect(loadState()).toEqual(state);

    process.emit('SIGINT');

    // State file is preserved for auto-restart
    expect(loadState()).toEqual(state);
  });

  it('should reschedule with exponential backoff and increment retryCount on failure', async () => {
    const rawMockConfig = {
      _params: { targetDir: tempDir, sessionId: 'test-session' },
      initialize: vi.fn().mockResolvedValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      fork: vi.fn().mockImplementation((params) => ({
        ...rawMockConfig,
        _params: { ...rawMockConfig._params, ...params },
      })),
      getGeminiClient: vi.fn().mockReturnValue({
        initialize: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    };
    const mockConfig = rawMockConfig as unknown as Config;

    const interval = 1000;
    const state: LoopState = {
      nextRun: Date.now() + interval,
      mode: 'fixed-prompt',
      prompt: 'Verify system',
      intervalMs: interval,
      retryCount: 2,
    };

    schedule(state, mockConfig);
    vi.advanceTimersByTime(interval);
    for (let i = 0; i < 20; i++) {
      vi.runAllTicks();
      await Promise.resolve();
    }

    const loaded = loadState();
    expect(loaded).toBeDefined();
    expect(loaded!.retryCount).toBe(3);
    expect(loaded!.lastError).toContain('boom');
    // backoff should push nextRun out further than the plain interval
    expect(loaded!.nextRun).toBeGreaterThan(Date.now() + interval);
  });

  it('should stop rescheduling and clear state after exceeding the max retry count', async () => {
    const rawMockConfig = {
      _params: { targetDir: tempDir, sessionId: 'test-session' },
      initialize: vi.fn().mockResolvedValue(undefined),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      fork: vi.fn().mockImplementation((params) => ({
        ...rawMockConfig,
        _params: { ...rawMockConfig._params, ...params },
      })),
      getGeminiClient: vi.fn().mockReturnValue({
        initialize: vi.fn().mockRejectedValue(new Error('still broken')),
      }),
    };
    const mockConfig = rawMockConfig as unknown as Config;

    const interval = 1000;
    const state: LoopState = {
      nextRun: Date.now() + interval,
      mode: 'fixed-prompt',
      prompt: 'Verify system',
      intervalMs: interval,
      retryCount: 10, // already at the max; this failure should tip it over
    };

    schedule(state, mockConfig);
    vi.advanceTimersByTime(interval);
    for (let i = 0; i < 20; i++) {
      vi.runAllTicks();
      await Promise.resolve();
    }

    expect(loadState()).toBeUndefined();
  });

  it('should prevent starting a second daemon while one is already running', () => {
    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid: process.pid, // use our own pid so process.kill(pid, 0) succeeds
    };
    saveState(state);

    expect(isDaemonRunning()).toBe(true);
    expect(() => startDaemon(state, {} as Config)).toThrow(
      LoopAlreadyRunningError,
    );
  });

  it('should escalate to SIGKILL if the daemon is still alive after the grace period', () => {
    const pid = 424242; // arbitrary fake PID; process.kill is fully mocked below
    const stillAlive = true;
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid, signal) => {
        if (signal === 0 && !stillAlive) {
          throw new Error('ESRCH: no such process');
        }
        return true;
      });

    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid,
    };
    saveState(state);

    stopDaemon();

    expect(killSpy).toHaveBeenCalledWith(pid, 0);
    // Signals the whole process group (-pid) rather than just the PID, so
    // any subprocesses spawned during a background run are also terminated
    // (see task_12.md / report_11.md §2/§9-4).
    expect(killSpy).toHaveBeenCalledWith(-pid, 'SIGTERM');

    // The daemon ignores SIGTERM (simulated stuck process) and is still
    // alive when the grace period elapses.
    killSpy.mockClear();
    vi.advanceTimersByTime(TERMINATION_GRACE_MS);

    expect(killSpy).toHaveBeenCalledWith(pid, 0);
    expect(killSpy).toHaveBeenCalledWith(-pid, 'SIGKILL');
  });

  it('should not send SIGKILL if the daemon exits on its own during the grace period', () => {
    const pid = 424243;
    let stillAlive = true;
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((_pid, signal) => {
        if (signal === 0 && !stillAlive) {
          throw new Error('ESRCH: no such process');
        }
        return true;
      });

    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid,
    };
    saveState(state);

    stopDaemon();

    // Simulate the daemon actually honoring SIGTERM and exiting before the
    // grace period elapses.
    stillAlive = false;
    killSpy.mockClear();
    vi.advanceTimersByTime(TERMINATION_GRACE_MS);

    expect(killSpy).toHaveBeenCalledWith(pid, 0);
    expect(killSpy).not.toHaveBeenCalledWith(-pid, 'SIGKILL');
    expect(killSpy).not.toHaveBeenCalledWith(pid, 'SIGKILL');
  });

  it('should fall back to signaling just the PID if process-group signaling is unavailable', () => {
    const pid = 424244;
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((targetPid, signal) => {
        if (signal === 0) {
          return true; // liveness checks always succeed
        }
        if (typeof targetPid === 'number' && targetPid < 0) {
          // Simulate an environment where group signaling is unavailable
          // (e.g. the process is not a group leader).
          throw new Error('ESRCH: no such process group');
        }
        return true;
      });

    const state: LoopState = {
      nextRun: Date.now() + 5000,
      mode: 'fixed-prompt',
      prompt: 'Check logs',
      intervalMs: 5000,
      pid,
    };
    saveState(state);

    stopDaemon();

    expect(killSpy).toHaveBeenCalledWith(-pid, 'SIGTERM');
    // Falls back to the plain PID once the group-signal attempt throws.
    expect(killSpy).toHaveBeenCalledWith(pid, 'SIGTERM');
  });
});
