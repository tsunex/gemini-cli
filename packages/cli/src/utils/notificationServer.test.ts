/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import {
  vi,
  describe,
  beforeEach,
  afterEach,
  it,
  expect,
  type MockInstance,
} from 'vitest';
import { startNotificationServer } from './notificationServer.js';
import { getSocketPath, MessageBusType } from '@google/gemini-cli-core';
import type { MessageBus, Config } from '@google/gemini-cli-core';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('./cleanup.js', () => ({
  registerCleanup: vi.fn(),
}));

// Test helper to wait for the server to be ready
function waitForServer(server: net.Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

describe('notificationServer', () => {
  let config: Config;
  let client: net.Socket;
  let mockedPublish: MockInstance;
  let server: net.Server;
  let socketPath: string;
  let tempDir: string;

  beforeEach(async () => {
    mockedPublish = vi.fn();
    const messageBus = {
      publish: mockedPublish,
    } as unknown as MessageBus;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-test-'));

    config = {
      storage: {
        getProjectTempDir: () => tempDir,
      },
      getMessageBus: () => messageBus,
    } as unknown as Config;

    socketPath = getSocketPath(config.storage);

    server = startNotificationServer(config);
    await waitForServer(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (client && !client.destroyed) {
        client.destroy();
      }
      server.close((err) => {
        if (err) {
          // Still try to cleanup
          fs.rmSync(tempDir, { recursive: true, force: true });
          return reject(err);
        }
        resolve();
      });
    });
    // Clean up the temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function connectClient(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const newClient = net.createConnection({ path: socketPath });

      const onConnect = () => {
        newClient.removeListener('error', onError);
        client = newClient;
        resolve(newClient);
      };

      const onError = (err: Error) => {
        newClient.removeListener('connect', onConnect);
        reject(err);
      };

      newClient.once('connect', onConnect);
      newClient.once('error', onError);
    });
  }

  function waitForEvent<T>(): Promise<T> {
    return new Promise((resolve) => {
      mockedPublish.mockImplementationOnce((event: T) => {
        resolve(event);
      });
    });
  }

  it('handles a single complete JSON message', async () => {
    const eventPromise = waitForEvent();
    const client = await connectClient();

    const payload = { type: 'loop_result', content: 'test' };
    client.write(JSON.stringify(payload) + '\n');
    client.end();

    const event = await eventPromise;
    expect(event).toEqual({
      type: MessageBusType.LOOP_RESULT,
      content: 'test',
      prompt: undefined,
    });
  });

  it('handles a split JSON message', async () => {
    const eventPromise = waitForEvent();
    const client = await connectClient();

    const payload = { type: 'loop_result', content: 'split message' };
    const message = JSON.stringify(payload) + '\n';
    const half = Math.floor(message.length / 2);

    client.write(message.substring(0, half));
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.write(message.substring(half));
    client.end();

    const event = await eventPromise;
    expect(event).toEqual({
      type: MessageBusType.LOOP_RESULT,
      content: 'split message',
      prompt: undefined,
    });
  });

  it('handles coalesced JSON messages', async () => {
    const event1Promise = waitForEvent();
    const event2Promise = waitForEvent();
    const client = await connectClient();

    const payload1 = { type: 'loop_result', content: 'first' };
    const payload2 = { type: 'loop_result', content: 'second' };
    const message =
      JSON.stringify(payload1) + '\n' + JSON.stringify(payload2) + '\n';
    client.write(message);
    client.end();

    const event1 = await event1Promise;
    const event2 = await event2Promise;

    expect(mockedPublish).toHaveBeenCalledTimes(2);
    expect(event1).toEqual({
      type: MessageBusType.LOOP_RESULT,
      content: 'first',
      prompt: undefined,
    });
    expect(event2).toEqual({
      type: MessageBusType.LOOP_RESULT,
      content: 'second',
      prompt: undefined,
    });
  });

  it('handles a plain text message as one message per connection', async () => {
    const eventPromise = waitForEvent();
    const client = await connectClient();

    client.write('just plain text');
    client.end();

    const event = await eventPromise;
    expect(event).toEqual({
      type: MessageBusType.BACKGROUND_NOTIFICATION,
      message: 'just plain text',
    });
  });

  it('handles a message without a trailing newline before client disconnects', async () => {
    const eventPromise = waitForEvent();
    const client = await connectClient();

    const payload = { type: 'loop_result', content: 'final message' };
    // Note: No trailing newline
    client.write(JSON.stringify(payload));
    client.end();

    const event = await eventPromise;
    expect(event).toEqual({
      type: MessageBusType.LOOP_RESULT,
      content: 'final message',
      prompt: undefined,
    });
  });

  it('handles a plain text message with embedded newlines as a single message', async () => {
    const eventPromise = waitForEvent();
    const client = await connectClient();

    const multiLineMessage = 'Hello\nWorld\nThis is a test.';
    client.write(multiLineMessage);
    client.end();

    const event = await eventPromise;
    expect(mockedPublish).toHaveBeenCalledTimes(1);
    expect(event).toEqual({
      type: MessageBusType.BACKGROUND_NOTIFICATION,
      message: multiLineMessage,
    });
  });

  it('handles a split multi-byte UTF-8 character', async () => {
    const eventPromise = waitForEvent();
    const client = await connectClient();

    const payload = { type: 'loop_result', content: '✅' };
    const message = JSON.stringify(payload) + '\n';

    // This will split the '✅' character
    const buffer = Buffer.from(message, 'utf8');
    const part1 = buffer.slice(0, 20);
    const part2 = buffer.slice(20);

    client.write(part1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.write(part2);
    client.end();

    const event = await eventPromise;
    expect(event).toEqual({
      type: MessageBusType.LOOP_RESULT,
      content: '✅',
      prompt: undefined,
    });
  });

  it('handles a socket error without crashing', async () => {
    const errorEventPromise = waitForEvent();

    let serverSocket: net.Socket;
    server.once('connection', (socket) => {
      serverSocket = socket;
    });

    const client = await connectClient();

    // Wait for server to get the connection
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Manually emit an error on the server-side socket to test the handler
    serverSocket!.emit('error', new Error('fake socket error'));

    const event = await errorEventPromise;
    expect(event).toEqual({
      type: MessageBusType.BACKGROUND_NOTIFICATION,
      message: '[ERROR] Notification socket error: fake socket error',
    });

    expect(server.listening).toBe(true);
    client.end();
  });
});
