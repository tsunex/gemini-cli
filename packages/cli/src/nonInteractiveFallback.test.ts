/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  TerminalQuotaError,
  type Config,
  type FallbackModelHandler,
} from '@google/gemini-cli-core';
import { configureNonInteractiveFallback } from './nonInteractiveFallback.js';

describe('configureNonInteractiveFallback', () => {
  function createConfig(existingHandler?: FallbackModelHandler) {
    let registeredHandler: FallbackModelHandler | undefined;
    const config = {
      getFallbackModelHandler: vi.fn().mockReturnValue(existingHandler),
      setFallbackModelHandler: vi.fn((handler: FallbackModelHandler) => {
        registeredHandler = handler;
      }),
    } as unknown as Config;

    return {
      config,
      getRegisteredHandler: () => registeredHandler,
    };
  }

  it('registers a headless fallback handler when none exists', () => {
    const { config, getRegisteredHandler } = createConfig();

    configureNonInteractiveFallback(config);

    expect(config.setFallbackModelHandler).toHaveBeenCalledOnce();
    expect(getRegisteredHandler()).toBeDefined();
  });

  it('does not replace an existing fallback handler', () => {
    const existingHandler: FallbackModelHandler = vi.fn();
    const { config } = createConfig(existingHandler);

    configureNonInteractiveFallback(config);

    expect(config.setFallbackModelHandler).not.toHaveBeenCalled();
  });

  it('retries quota failures once with a distinct fallback model', async () => {
    const { config, getRegisteredHandler } = createConfig();
    const warnings: string[] = [];
    configureNonInteractiveFallback(config, (message) =>
      warnings.push(message),
    );

    const intent = await getRegisteredHandler()?.(
      'gemini-3.5-flash',
      'gemini-3-pro-preview',
      new TerminalQuotaError('quota exhausted', {
        code: 429,
        message: 'quota exhausted',
        details: [],
      }),
    );

    expect(intent).toBe('retry_once');
    expect(warnings.join('')).toContain(
      'Retrying this headless request once with',
    );
  });

  it('stops instead of retrying when no distinct fallback is available', async () => {
    const { config, getRegisteredHandler } = createConfig();
    const warnings: string[] = [];
    configureNonInteractiveFallback(config, (message) =>
      warnings.push(message),
    );

    const intent = await getRegisteredHandler()?.(
      'gemini-3.5-flash',
      'gemini-3.5-flash',
      new TerminalQuotaError('quota exhausted', {
        code: 429,
        message: 'quota exhausted',
        details: [],
      }),
    );

    expect(intent).toBe('stop');
    expect(warnings).toEqual([]);
  });

  it('does not silently fallback for non-quota errors', async () => {
    const { config, getRegisteredHandler } = createConfig();
    const warnings: string[] = [];
    configureNonInteractiveFallback(config, (message) =>
      warnings.push(message),
    );

    const intent = await getRegisteredHandler()?.(
      'gemini-3.5-flash',
      'gemini-3-pro-preview',
      new Error('unexpected failure'),
    );

    expect(intent).toBe('stop');
    expect(warnings).toEqual([]);
  });
});
