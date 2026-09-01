/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
import type {
  MessageBus,
  type Config,
  getSocketPath,
  MessageBusType,
} from '@google/gemini-cli-core';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('./cleanup.js', () => ({
  registerCleanup: vi.fn(),
}));

describe('notificationServer', () => {
  let config: Config;
  let client: net.Socket;
  let mockedPublish: MockInstance;
  let server: net.Server;
  let socketPath: string;

  beforeEach(() => {
    mockedPublish = vi.fn();
    const messageBus = {
      publish: mockedPublish,
    } as unknown as MessageBus;

    config = {
      storage: {
        getProjectTempDir: () => '/tmp/gemini-cli-test',
      },
      getMessageBus: () => messageBus,
    } as unknown as Config;

    socketPath = getSocketPath(config.storage);

    // Ensure the temp dir exists
    if (!fs.existsSync(path.dirname(socketPath))) {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    }

    server = startNotificationServer(config);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (client && !client.destroyed) {
        client.destroy();
      }
      server.close((err) => {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
        if (err) return reject(err);
        resolve();
      });
    });
  });

  async function connectClient(): Promise<net.Socket> {
    return new Promise((resolve) => {
      const newClient = net.createConnection({ path: socketPath }, () => {
        client = newClient;
        resolve(newClient);
      });
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
});
