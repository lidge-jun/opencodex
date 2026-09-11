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
