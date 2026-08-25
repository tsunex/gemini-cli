/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { EventEmitter } from 'node:events';

/**
 * An application-wide event bus for decoupled communication between components.
 */
export const eventBus = new EventEmitter();
