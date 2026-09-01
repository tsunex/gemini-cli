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
    let buffer = '';

    const processMessage = (rawMessage: string) => {
      if (!rawMessage) {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(rawMessage);
        if (isLoopResultNotification(parsed)) {
          void messageBus.publish({
            type: MessageBusType.LOOP_RESULT,
            content: parsed.content,
            prompt: parsed.prompt,
          });
          return;
        }
      } catch {
        // Fallback to plain text for non-JSON or malformed JSON
      }
      void messageBus.publish({
        type: MessageBusType.BACKGROUND_NOTIFICATION,
        message: rawMessage,
      });
    };

    socket.on('data', (data) => {
      buffer += data.toString();
      let boundary = buffer.indexOf('\n');
      while (boundary !== -1) {
        const rawMessage = buffer.substring(0, boundary);
        buffer = buffer.substring(boundary + 1);
        processMessage(rawMessage);
        boundary = buffer.indexOf('\n');
      }
    });

    socket.on('end', () => {
      // Flush any remaining buffer content when the client disconnects.
      if (buffer.length > 0) {
        processMessage(buffer);
      }
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
