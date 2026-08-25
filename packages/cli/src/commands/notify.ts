/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { sendNotification } from '../utils/notificationServer.js';

interface NotifyArgs {
  message: string;
}

export const notifyCommand: CommandModule<object, NotifyArgs> = {
  command: 'notify <message>',
  describe: 'Sends a notification to the active Gemini CLI session.',
  builder: (yargs) => yargs.positional('message', {
      describe: 'The message to send as a notification',
      type: 'string',
      demandOption: true,
    }),
  handler: async (args) => {
    await sendNotification(args.message);

    // Allow a moment for the message to be sent before exiting.
    await new Promise((resolve) => setTimeout(resolve, 100));
  },
};
