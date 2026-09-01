/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type LoopMode =
  | 'dynamic-prompt'
  | 'dynamic-maintenance'
  | 'fixed-prompt'
  | 'fixed-maintenance';

export interface ParsedLoopArgs {
  mode: LoopMode;
  interval?: string;
  intervalMs?: number;
  prompt?: string;
  background?: boolean;
  detach?: boolean;
}

export function parseLoopArgs(args: string): ParsedLoopArgs {
  const parts = args.trim().split(/\s+/);
  let interval: string | undefined;
  let background = false;
  let detach = false;
  const promptParts: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (part === '-i' || part === '--interval') {
      interval = parts[++i];
    } else if (part === '-b' || part === '--background') {
      background = true;
    } else if (part === '-d' || part === '--detach') {
      detach = true;
    } else {
      promptParts.push(part);
    }
  }

  if (detach && !background) {
    throw new Error('--detach can only be used with --background');
  }

  const promptText = promptParts.join(' ').trim() || undefined;

  let mode: LoopMode;
  if (interval) {
    mode = promptText ? 'fixed-prompt' : 'fixed-maintenance';
  } else {
    mode = promptText ? 'dynamic-prompt' : 'dynamic-maintenance';
  }

  let intervalMs: number | undefined;
  if (interval) {
    const match = interval.match(/^(\d+)(s|m|h)$/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      switch (unit) {
        case 's':
          intervalMs = value * 1000;
          break;
        case 'm':
          intervalMs = value * 60 * 1000;
          break;
        case 'h':
          intervalMs = value * 60 * 60 * 1000;
          break;
        default:
          break;
      }
    }
  }

  return {
    mode,
    interval,
    intervalMs,
    prompt: promptText,
    background,
    ...(detach ? { detach } : {}),
  };
}
