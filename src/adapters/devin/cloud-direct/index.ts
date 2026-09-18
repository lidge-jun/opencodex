/*
 * Derived from rsvedant/opencode-windsurf-auth (src/cloud-direct/), MIT licensed.
 *
 * MIT License
 * Copyright (c) 2026 Vedant
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * Public surface of the cloud-direct module.
 *
 * Usage:
 *   import { streamChat } from './cloud-direct/index.js';
 *
 *   for await (const delta of streamChat({
 *     apiKey: creds.apiKey,
 *     apiServerUrl: creds.apiServerUrl,
 *     modelUid: 'swe-1-6',
 *     messages: [{ role: 'user', content: 'hi' }],
 *   })) {
 *     process.stdout.write(delta);
 *   }
 */

export {
  streamChat,
  streamChatEvents,
  allocateCascadeId,
  CloudChatError,
  type CloudChatRequest,
  type ChatHistoryItem,
  type CloudChatEvent,
  type ToolDef,
} from './chat.js';

export {
  mintUserJwt,
  getCachedUserJwt,
  clearCachedUserJwt,
  CloudAuthError,
} from './auth.js';

export {
  getCachedCatalog,
  clearCachedCatalog,
  ModelNotAvailableError,
  type ModelCatalogEntry,
  type CacheEntry,
} from './catalog.js';
