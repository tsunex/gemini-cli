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
      const newClient = net.createConnection({ path: socketPath }, () => {
        client = newClient;
        resolve(newClient);
      });
      newClient.on('error', reject);
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

  it('handles a plain text message', async () => {
    const eventPromise = waitForEvent();
    const client = await connectClient();

    client.write('just plain text\n');
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
});
