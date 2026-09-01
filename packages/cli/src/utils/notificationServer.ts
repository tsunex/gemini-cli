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
    socket.on('data', (data) => {
      buffer += data.toString();
      let boundary = buffer.indexOf('\n');
      while (boundary !== -1) {
        const rawMessage = buffer.substring(0, boundary);
        buffer = buffer.substring(boundary + 1);
        boundary = buffer.indexOf('\n');

        if (rawMessage) {
          try {
            const parsed: unknown = JSON.parse(rawMessage);
            if (isLoopResultNotification(parsed)) {
              void messageBus.publish({
                type: MessageBusType.LOOP_RESULT,
                content: parsed.content,
                prompt: parsed.prompt,
              });
              continue;
            }
          } catch {
            // Ignore parse errors, fallback to legacy plain text
          }

          void messageBus.publish({
            type: MessageBusType.BACKGROUND_NOTIFICATION,
            message: rawMessage,
          });
        }
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

  return server;
}
