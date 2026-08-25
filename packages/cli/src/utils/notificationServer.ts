/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Config, MessageBusType, Storage } from '@google/gemini-cli-core';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerCleanup } from './cleanup.js';

function getSocketPath(storage: Storage): string {
  return path.join(storage.getProjectTempDir(), 'notification.sock');
}

export function startNotificationServer(config: Config) {
  const socketPath = getSocketPath(config.storage);
  const messageBus = config.getMessageBus();

  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      const message = data.toString();
      if (message) {
        void messageBus.publish({
          type: MessageBusType.BACKGROUND_NOTIFICATION,
          message,
        });
      }
    });
  });

  // Clean up old socket file if it exists
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  server.listen(socketPath);

  const cleanup = () => {
    server.close();
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  };

  registerCleanup(cleanup);
}

export async function sendNotification(message: string) {
  const storage = new Storage(process.cwd());
  await storage.initialize();
  const socketPath = getSocketPath(storage);
  const client = net.createConnection({ path: socketPath }, () => {
    client.write(message);
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
