/*
 * Derived from rsvedant/opencode-windsurf-auth (src/cloud-direct/), MIT licensed,
 * Copyright (c) 2026 Vedant. The full notice is in ./index.ts.
 */
/**
 * Per-account model catalog from Cognition's `GetCascadeModelConfigs`.
 *
 * Why this exists — issue #14:
 *   The cloud's `GetChatMessage` returns a single Connect-streaming EOS frame
 *   containing `{"error":{"code":"permission_denied","message":"an internal
 *   error occurred (trace ID: <hex>)"}}` whenever the caller's account tier
 *   does not include the requested `model_uid`. Reproduced byte-identical on a
 *   `TEAMS_TIER_DEVIN_FREE` account for every Anthropic/Gemini/Premium UID
 *   (only `swe-1-6-slow` streamed a real reply). The user-facing message is
 *   indistinguishable from a transient server fault — issue #14's reporter
 *   spent multiple sessions guessing.
 *
 *   The pre-flight here checks the per-account catalog (`disabled` flag on
 *   `ClientModelConfig` field #4) BEFORE we spend a roundtrip on a request
 *   the cloud will refuse. When the lookup fails (network, auth, schema
 *   drift) we silently fall back to the chat path so a transient catalog
 *   outage can't take chat down with it.
 *
 * Schema (verified against the bundled `extension.js`,
 * `exa.codeium_common_pb.ClientModelConfig`):
 *
 *   GetCascadeModelConfigsResponse {
 *     #1 client_model_configs: repeated ClientModelConfig
 *   }
 *   ClientModelConfig {
 *     #1  label                string
 *     #4  disabled             bool   ← the gate this module reads
 *     #22 model_uid            string ← what `GetChatMessage` accepts
 *   }
 *
 *   Disabled semantics: TRUE means "this UID exists in the catalog but the
 *   caller's account/tier cannot run inference against it." BYOK models
 *   surface as `disabled: false` so users with their own provider keys still
 *   pass through — the only way they fail at chat time is a missing key,
 *   which surfaces with a different message.
 *
 * Cache: per (apiServerUrl, apiKey) for {@link CATALOG_TTL_MS}. Cognition
 * doesn't bump catalog entries mid-session in normal operation, so a 10-min
 * TTL trades one extra roundtrip per ~10 min for clear errors on every chat.
 */

import * as crypto from 'crypto';
import { buildMetadata } from './metadata.js';
import { getCachedUserJwt } from './auth.js';
import { encodeMessage, iterFields } from './wire.js';
import { resolveDevinApiBaseUrl } from '../../../oauth/devin/api-base.js';

/** 10 minutes — see header. */
const CATALOG_TTL_MS = 10 * 60 * 1000;

/** Catalog endpoint inactivity timeout. Cognition responds in <500ms steady-state. */
const CATALOG_FETCH_TIMEOUT_MS = 10_000;

export interface ModelCatalogEntry {
  /** Cloud-side `model_uid` (e.g. `claude-opus-4-7-medium`). */
  modelUid: string;
  /** Human label (e.g. `Claude Opus 4.7 Medium`) — used in error messages. */
  label: string;
  /** True when the caller's account tier cannot use this UID for chat. */
  disabled: boolean;
  /**
   * Maximum input tokens the account may send this model, from
   * `ClientModelConfig` field #18.
   *
   * Cognition publishes no context-window numbers anywhere: not in the Devin
   * CLI or Desktop model pages, not in the SWE-2 or SWE-1.7 announcements, and
   * not in the Windsurf model reference, which has no such table. The only
   * numbers on those pages are long-context PRICING thresholds, which are a
   * different quantity. That makes this field the single first-party source,
   * and it is per account rather than per model id.
   *
   * Absent when the entry omits the field, which is how a future schema change
   * degrades: the caller keeps its static fallback instead of reporting zero.
   */
  contextWindow?: number;
}

export interface CacheEntry {
  /** Lookup keyed by `model_uid`. */
  byUid: Map<string, ModelCatalogEntry>;
  fetchedAt: number;
  /** Cache key components, captured for invalidation/log purposes. */
  apiKey: string;
  host: string;
}

let cached: CacheEntry | null = null;
let inFlight: Promise<CacheEntry> | null = null;
let inFlightKey: string | null = null;
// Bumped on clearCachedCatalog so an in-flight fetch racing with a clear
// can't repopulate the cache with a just-invalidated catalog.
let cacheEpoch = 0;

function flightKey(apiKey: string, host: string): string {
  return `${host}\x1f${apiKey}`;
}

/**
 * Parse a GetCascadeModelConfigsResponse buffer into a UID-keyed map.
 * A malformed catalog returns an empty map.
 */
export function parseCatalogBuffer(buf: Buffer, apiKey: string, host: string): CacheEntry {
  // GetCascadeModelConfigsResponse #1 (repeated ClientModelConfig)
  const byUid = new Map<string, ModelCatalogEntry>();
  for (const f of iterFields(buf)) {
    if (f.num !== 1 || f.wire !== 2 || !Buffer.isBuffer(f.value)) continue;
    let label = '';
    let modelUid = '';
    let disabled = false;
    let contextWindow = 0;
    for (const sf of iterFields(f.value as Buffer)) {
      if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        label = (sf.value as Buffer).toString('utf8');
      } else if (sf.num === 4 && sf.wire === 0) {
        // #4 = disabled (bool, varint 0/1)
        disabled = sf.value === 1n;
      } else if (sf.num === 18 && sf.wire === 0) {
        // #18 = max input tokens. Identified by dumping a live catalog and
        // reading the varints back against models whose windows are known from
        // their upstream vendors: 1000000 on the Claude and GPT rows, 1048576
        // on Gemini/Kimi/GLM, 500000 on Grok, 262000 on swe-2.
        contextWindow = Number(sf.value);
      } else if (sf.num === 22 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
        modelUid = (sf.value as Buffer).toString('utf8');
      }
    }
    if (modelUid.length > 0) {
      byUid.set(modelUid, {
        modelUid,
        label: label || modelUid,
        disabled,
        ...(contextWindow > 0 ? { contextWindow } : {}),
      });
    }
  }
  return { byUid, fetchedAt: Date.now(), apiKey, host };
}

/**
 * Fetch the cascade model catalog for `(apiKey, host)` and parse the
 * subset of `ClientModelConfig` we care about into a UID-keyed map.
 *
 * Throws on transport/auth failure so the caller can decide whether to fall
 * back to "skip pre-flight". Does NOT throw on an unexpected response body —
 * a malformed catalog returns an empty map, treated the same as "model not
 * listed" by the chat pre-flight.
 *
 * Uses only an internal timeout — caller cancellation is handled by
 * getCachedCatalog racing each caller's signal against the shared promise.
 */
async function fetchCatalog(apiKey: string, host: string): Promise<CacheEntry> {
  const userJwt = await getCachedUserJwt(apiKey, host);

  const metadata = buildMetadata({
    apiKey,
    userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
  });
  // GetCascadeModelConfigsRequest { metadata: Metadata }  — Metadata is #1.
  const reqBody = encodeMessage(1, metadata);

  // Internal 10s timeout so a stalled catalog endpoint can't deadlock chat.
  // The shared fetch uses only this internal timeout — caller cancellation is
  // handled by racing each caller's signal against the shared promise in
  // getCachedCatalog, so one caller's abort never propagates to unrelated
  // callers sharing the same in-flight fetch.
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`catalog: fetch timeout (${CATALOG_FETCH_TIMEOUT_MS}ms)`)),
    CATALOG_FETCH_TIMEOUT_MS,
  );

  let resp: Response;
  try {
    resp = await fetch(`${resolveDevinApiBaseUrl(host)}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1' },
      body: new Uint8Array(reqBody),
      // This body carries the api_key; a redirect would replay it elsewhere.
      redirect: 'error',
      signal: ac.signal,
    });
    if (!resp.ok) {
      // Status only: the error body can quote the api_key-bearing request.
      throw new Error(`GetCascadeModelConfigs failed (HTTP ${resp.status})`);
    }
    // Read the body BEFORE clearing the timeout — fetch resolves on headers,
    // not body completion. A stalled body would otherwise block indefinitely.
    const buf = Buffer.from(await resp.arrayBuffer());
    return parseCatalogBuffer(buf, apiKey, host);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Get the cached catalog for `(apiKey, host)`, fetching when missing or stale.
 *
 * Concurrent callers for the SAME (apiKey, host) share one in-flight fetch
 * (no thundering herd on startup). Concurrent callers for DIFFERENT keys
 * serialise the in-flight slot but only one of them holds it at a time —
 * good enough for opencode's single-account-at-a-time usage pattern.
 *
 * Returns `null` on fetch failure (network, transient 5xx, auth issue). The
 * caller treats `null` as "skip pre-flight and let the chat path surface the
 * server-side error itself."
 */
export async function getCachedCatalog(
  apiKey: string,
  host: string,
  signal?: AbortSignal,
): Promise<CacheEntry | null> {
  if (cached && cached.apiKey === apiKey && cached.host === host) {
    if (Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return cached;
    }
  }

  const key = flightKey(apiKey, host);
  // Race the caller's signal against the shared promise so one caller's
  // cancellation doesn't propagate to unrelated callers sharing the fetch.
  const raceSignal = <T>(p: Promise<T>): Promise<T> =>
    signal
      ? Promise.race([
          p,
          new Promise<T>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        ])
      : p;

  if (inFlight && inFlightKey === key) {
    try {
      return await raceSignal(inFlight);
    } catch {
      return null;
    }
  }

  const promise = fetchCatalog(apiKey, host);
  inFlight = promise;
  inFlightKey = key;
  const epochAtStart = cacheEpoch;
  try {
    const result = await raceSignal(promise);
    if (cacheEpoch === epochAtStart) {
      cached = result;
    }
    return result;
  } catch {
    return null;
  } finally {
    if (inFlight === promise) {
      inFlight = null;
      inFlightKey = null;
    }
  }
}

/**
 * Drop the cached catalog. Call after logout/account switch so a fresh
 * sign-in doesn't see a previous account's allow-list. Bumps the cache
 * epoch so an in-flight fetch racing with this clear can't repopulate
 * the cache with the just-invalidated catalog.
 */
export function clearCachedCatalog(): void {
  cached = null;
  inFlight = null;
  inFlightKey = null;
  cacheEpoch++;
}

/**
 * Tier-disabled error — thrown by the chat pre-flight when the catalog lists
 * a model as `disabled: true` for this account. The message names the model
 * and points at the plan page, replacing Cognition's opaque
 * "an internal error occurred" trailer.
 */
export class ModelNotAvailableError extends Error {
  constructor(
    public readonly modelUid: string,
    public readonly label: string,
    public readonly reason: 'disabled' | 'not_listed',
  ) {
    super(
      reason === 'disabled'
        ? `Model "${label}" (uid=${modelUid}) is not enabled for your Cognition account. ` +
          `The Cognition catalog returned it with disabled=true — meaning your current plan/tier ` +
          `does not include this model. ` +
          `Check the model picker on https://codeium.com/account, or pick a different model. ` +
          `(This message replaces Cognition's "an internal error occurred" — same root cause.)`
        : `Model uid "${modelUid}" is not listed in the Cognition catalog for your account. ` +
          `Either the UID has been retired upstream or your account/region doesn't serve it. ` +
          `Run \`curl http://127.0.0.1:42100/v1/models\` to see the canonical names your plan accepts.`,
    );
    this.name = 'ModelNotAvailableError';
  }
}
