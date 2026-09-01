/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as net from 'node:net';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';

export function getSocketPath(storage: Storage): string {
  return path.join(storage.getProjectTempDir(), 'notification.sock');
}

export async function sendNotification(message: string) {
  const storage = new Storage(process.cwd());
  await storage.initialize();
  const socketPath = getSocketPath(storage);
  const client = net.createConnection({ path: socketPath }, () => {
    client.write(message + '\n');
    client.end();
  });

  client.on('error', (err) => {
    // Ignore ECONNREFUSED, it just means the server isn't running
    if ('code' in err && err.code !== 'ECONNREFUSED') {
      // In this client command, we don't want to spam the user's console
      // with errors if the server isn't running. We can log to a debug file
      // or just ignore. For now, we'll ignore.
    }
  });
}
