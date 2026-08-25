/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { coreEvents, CoreEvent } from '../utils/events.js';

let watcher: fs.FSWatcher | null = null;

function getNotificationDir(): string {
  return path.join(Storage.getProjectLoopStateDir(), 'notifications');
}

interface LoopNotification {
  message: string;
}

function isLoopNotification(obj: unknown): obj is LoopNotification {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'message' in obj &&
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    typeof (obj as LoopNotification).message === 'string'
  );
}

function processNotificationFile(filePath: string) {
  fs.readFile(filePath, 'utf-8', (err, data) => {
    if (err) {
      // File might have been deleted before we could read it, which is fine.
      if (err.code !== 'ENOENT') {
        coreEvents.emit(CoreEvent.UserFeedback, {
          severity: 'error',
          message: `Error reading loop notification file: ${err.message}`,
        });
      }
      return;
    }

    try {
      const notification: unknown = JSON.parse(data);
      if (isLoopNotification(notification)) {
        if (notification.message) {
          coreEvents.emit(CoreEvent.UserFeedback, {
            severity: 'info',
            message: `[Loop Background Response]\n${notification.message}`,
          });
        }
      } else {
        coreEvents.emit(CoreEvent.UserFeedback, {
          severity: 'error',
          message: `Error parsing loop notification file: Invalid format`,
        });
      }
    } catch (parseErr) {
      coreEvents.emit(CoreEvent.UserFeedback, {
        severity: 'error',
        message: `Error parsing loop notification file: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      });
    } finally {
      // Clean up the file
      fs.unlink(filePath, (unlinkErr) => {
        if (unlinkErr && unlinkErr.code !== 'ENOENT') {
          coreEvents.emit(CoreEvent.UserFeedback, {
            severity: 'error',
            message: `Error deleting loop notification file: ${unlinkErr.message}`,
          });
        }
      });
    }
  });
}

export function startWatchingLoopNotifications() {
  if (watcher) {
    return;
  }

  const notificationDir = getNotificationDir();
  fs.mkdirSync(notificationDir, { recursive: true });

  // Process any existing files first
  fs.readdir(notificationDir, (err, files) => {
    if (err) {
      coreEvents.emit(CoreEvent.UserFeedback, {
        severity: 'error',
        message: `Error reading loop notification directory: ${err.message}`,
      });
      return;
    }
    for (const file of files) {
      if (file.endsWith('.json')) {
        processNotificationFile(path.join(notificationDir, file));
      }
    }
  });

  try {
    watcher = fs.watch(notificationDir, (eventType, filename) => {
      if (eventType === 'rename' && filename && filename.endsWith('.json')) {
        const filePath = path.join(notificationDir, filename);
        // 'rename' can mean created, moved, or deleted. Check for existence.
        fs.access(filePath, fs.constants.F_OK, (err) => {
          if (!err) {
            // File exists, so it was likely created or moved in.
            // Add a small delay to ensure the file is fully written.
            setTimeout(() => processNotificationFile(filePath), 100);
          }
        });
      }
    });

    watcher.on('error', (err) => {
      coreEvents.emit(CoreEvent.UserFeedback, {
        severity: 'error',
        message: `Loop notification watcher error: ${err.message}`,
      });
      stopWatchingLoopNotifications();
    });
  } catch (err) {
    coreEvents.emit(CoreEvent.UserFeedback, {
      severity: 'error',
      message: `Failed to start loop notification watcher: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export function stopWatchingLoopNotifications() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}
