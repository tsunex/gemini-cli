/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getDisplayString,
  RetryableQuotaError,
  TerminalQuotaError,
  type Config,
  type FallbackIntent,
} from '@google/gemini-cli-core';

function isQuotaOrCapacityError(error: unknown): boolean {
  return (
    error instanceof TerminalQuotaError || error instanceof RetryableQuotaError
  );
}

export function configureNonInteractiveFallback(
  config: Config,
  writeWarning: (message: string) => void = (message) =>
    process.stderr.write(message),
): void {
  if (typeof config.setFallbackModelHandler !== 'function') {
    return;
  }

  const existingHandler =
    typeof config.getFallbackModelHandler === 'function'
      ? config.getFallbackModelHandler()
      : undefined;
  if (existingHandler) {
    return;
  }

  config.setFallbackModelHandler(
    async (failedModel, fallbackModel, error): Promise<FallbackIntent> => {
      if (!isQuotaOrCapacityError(error) || failedModel === fallbackModel) {
        return 'stop';
      }

      writeWarning(
        `[INFO] Usage limit reached for ${getDisplayString(
          failedModel,
        )}. Retrying this headless request once with ${getDisplayString(
          fallbackModel,
        )}.\n`,
      );
      return 'retry_once';
    },
  );
}
