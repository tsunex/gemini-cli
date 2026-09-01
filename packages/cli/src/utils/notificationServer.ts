/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  MessageBusType,
  getSocketPath,
} from '@google/gemini-cli-core';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { registerCleanup } from './cleanup.js';

interface LoopResultNotification {
  type: 'loop_result';
  content: string;
  prompt?: string;
}

function isLoopResultNotification(obj: unknown): obj is LoopResultNotification {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    obj.type === 'loop_result' &&
    'content' in obj &&
    typeof obj.content === 'string' &&
    (!('prompt' in obj) ||
      typeof obj.prompt === 'string' ||
      typeof obj.prompt === 'undefined')
  );
}

export function startNotificationServer(config: Config): net.Server {
  const socketPath = getSocketPath(config.storage);
  const messageBus = config.getMessageBus();

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', (data: string) => {
      buffer += data;
    });

    socket.on('end', () => {
      const fullMessage = buffer;
      if (!fullMessage.trim()) {
        return;
      }

      // Attempt 1: Parse as a single, complete JSON object
      try {
        const parsed: unknown = JSON.parse(fullMessage);
        if (isLoopResultNotification(parsed)) {
          void messageBus.publish({
            type: MessageBusType.LOOP_RESULT,
            content: parsed.content,
            prompt: parsed.prompt,
          });
          return;
        }
      } catch {
        // Not a single valid JSON object, continue.
      }

      // Attempt 2: Parse as newline-delimited JSON objects to support
      // older test cases and raw socket testing.
      const lines = fullMessage.split('\n');
      const notifications: LoopResultNotification[] = [];
      const nonEmptyLines = lines.filter((line) => line.trim() !== '');

      if (nonEmptyLines.length > 0) {
        let allLinesAreJson = true;
        for (const line of nonEmptyLines) {
          try {
            const parsed: unknown = JSON.parse(line);
            if (isLoopResultNotification(parsed)) {
              notifications.push(parsed);
            } else {
              allLinesAreJson = false;
              break;
            }
          } catch {
            allLinesAreJson = false;
            break;
          }
        }

        if (allLinesAreJson) {
          for (const notification of notifications) {
            void messageBus.publish({
              type: MessageBusType.LOOP_RESULT,
              content: notification.content,
              prompt: notification.prompt,
            });
          }
          return;
        }
      }

      // Fallback: Treat the entire buffer as a single plain text message.
      void messageBus.publish({
        type: MessageBusType.BACKGROUND_NOTIFICATION,
        message: fullMessage,
      });
    });

    socket.on('error', (err) => {
      // Don't crash the server on a single socket error.
      void messageBus.publish({
        type: MessageBusType.BACKGROUND_NOTIFICATION,
        message: `[ERROR] Notification socket error: ${err.message}`,
      });
    });
  });

  server.on('error', (err) => {
    // This is a background server, so we shouldn't crash the main app.
    // Instead, we'll just log the error via the message bus.
    void messageBus.publish({
      type: MessageBusType.BACKGROUND_NOTIFICATION,
      message: `[ERROR] Notification server error: ${err.message}`,
    });
  });

  server.on('listening', () => {
    const cleanup = () => {
      server.close();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    };

    registerCleanup(cleanup);
  });

  // Clean up old socket file if it exists
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  server.listen(socketPath);

  return server;
}
