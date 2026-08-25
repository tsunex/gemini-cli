/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { Storage } from '@google/gemini-cli-core';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LoopNotification {
  timestamp: number;
  prompt: string;
  message: string;
}

export function useLoopNotificationListener(
  onNotification: (notification: LoopNotification) => void,
) {
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;

  useEffect(() => {
    const notificationDir = path.join(
      Storage.getProjectLoopStateDir(),
      'notifications',
    );

    const checkNotifications = () => {
      if (!fs.existsSync(notificationDir)) return;

      try {
        const files = fs.readdirSync(notificationDir);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          const filePath = path.join(notificationDir, file);
          try {
            const rawContent = fs.readFileSync(filePath, 'utf-8');
            const data: unknown = JSON.parse(rawContent);

            if (
              typeof data === 'object' &&
              data !== null &&
              'timestamp' in data &&
              'prompt' in data &&
              'message' in data &&
              typeof data.timestamp === 'number' &&
              typeof data.prompt === 'string' &&
              typeof data.message === 'string'
            ) {
              onNotificationRef.current({
                timestamp: data.timestamp,
                prompt: data.prompt,
                message: data.message,
              });
            }

            // Clean up to prevent duplicate notifications
            fs.unlinkSync(filePath);
          } catch {
            // Ignore temporary access errors (e.g. while writing)
          }
        }
      } catch {
        // Ignore read errors
      }
    };

    // Poll every 2 seconds for portability and robustness
    const interval = setInterval(checkNotifications, 2000);
    return () => clearInterval(interval);
  }, []);
}
