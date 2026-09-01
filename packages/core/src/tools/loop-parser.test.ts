/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseLoopArgs } from './loop-parser.js';

describe('loop-parser', () => {
  it('should parse simple prompt without options', () => {
    const parsed = parseLoopArgs('Run system diagnostic check');
    expect(parsed).toEqual({
      mode: 'dynamic-prompt',
      interval: undefined,
      intervalMs: undefined,
      prompt: 'Run system diagnostic check',
      background: false,
    });
  });

  it('should parse fixed interval prompt', () => {
    const parsed = parseLoopArgs('-i 5m Run system diagnostic check');
    expect(parsed).toEqual({
      mode: 'fixed-prompt',
      interval: '5m',
      intervalMs: 5 * 60 * 1000,
      prompt: 'Run system diagnostic check',
      background: false,
    });
  });

  it('should parse interval and background flags', () => {
    const parsed = parseLoopArgs('--interval 10s --background Monitor logs');
    expect(parsed).toEqual({
      mode: 'fixed-prompt',
      interval: '10s',
      intervalMs: 10 * 1000,
      prompt: 'Monitor logs',
      background: true,
    });
  });

  it('should parse maintenance loop (no prompt)', () => {
    const parsed = parseLoopArgs('-i 1h');
    expect(parsed).toEqual({
      mode: 'fixed-maintenance',
      interval: '1h',
      intervalMs: 60 * 60 * 1000,
      prompt: undefined,
      background: false,
    });
  });

  it('should handle different time units', () => {
    expect(parseLoopArgs('-i 30s').intervalMs).toBe(30 * 1000);
    expect(parseLoopArgs('-i 15m').intervalMs).toBe(15 * 60 * 1000);
    expect(parseLoopArgs('-i 2h').intervalMs).toBe(2 * 60 * 60 * 1000);
  });

  it('should parse detach flag when background is present', () => {
    const parsed = parseLoopArgs(
      '--interval 10s --background --detach Monitor logs',
    );
    expect(parsed).toEqual({
      mode: 'fixed-prompt',
      interval: '10s',
      intervalMs: 10 * 1000,
      prompt: 'Monitor logs',
      background: true,
      detach: true,
    });
  });

  it('should parse detach flag with -b and -d shorthand', () => {
    const parsed = parseLoopArgs('-i 10s -b -d Monitor');
    expect(parsed).toEqual({
      mode: 'fixed-prompt',
      interval: '10s',
      intervalMs: 10 * 1000,
      prompt: 'Monitor',
      background: true,
      detach: true,
    });
  });

  it('should reject detach flag when background is absent', () => {
    expect(() => parseLoopArgs('--detach Monitor logs')).toThrow(
      '--detach can only be used with --background',
    );
    expect(() => parseLoopArgs('-d -i 5m')).toThrow(
      '--detach can only be used with --background',
    );
  });
});
