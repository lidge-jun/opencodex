/**
 * A connected client's view of its hub's provider, login and roster state (#4236).
 *
 * The rule this module exists to enforce: on a connected client, the hub is the authority, and
 * when the hub cannot be read the answer is "unavailable" — never the client's own local
 * credential store. That store is empty by design, and reporting it as the truth is what made an
 * agent on a connected machine conclude the hub could not serve grok while the hub was serving
 * grok. Every failure path here therefore lands on `stateSource: "unavailable"` with a reason a
 * human can act on, and none of them reaches back into local config.
 *
 * The last good response is cached at `<OPENCODEX_HOME>/hub-state.json`, 0600, stamped with the
 * connection that produced it. The owner stamp is not decoration: after `ocx disconnect` and a
 * reconnect to a different hub (or a key rotation that changes `apiKeyId`), a stale file would
 * otherwise be presented as this hub's state. `sameClientConnectionOwner` is the same triple
 * (`serverUrl`, `apiKeyId`, `connectedAt`) the rest of the client lifecycle compares on.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { atomicWriteFile } from "../config/atomic-write";
import { parseHubStateBody, type HubStateDTO } from "../remote/hub-state";
import type { OcxClientConnectionConfig } from "../types";
import { fetchHubState, HubClientError } from "./hub-client";
import { sameClientConnectionOwner } from "./state";

/** Bound the status path: `ocx status` must answer even when the hub is gone. */
const DEFAULT_HUB_STATE_TIMEOUT_MS = 3_000;
/** The cache document plus its stamp; the DTO itself is already capped by its own contract. */
const MAX_CACHE_BYTES = 128 * 1024;

export type HubStateOwner = Pick<OcxClientConnectionConfig, "serverUrl" | "apiKeyId" | "connectedAt">;

/** Where the state came from. "unavailable" is a reportable outcome, not a fallback to local. */
export type HubStateSource = "hub" | "cache" | "unavailable";

export interface HubStateResolution {
  stateSource: HubStateSource;
  state: HubStateDTO | null;
  /** Present whenever the live read did not succeed. Short, operator-facing. */
  reason?: string;
  /** ISO timestamp of the response this state came from. */
  fetchedAt?: string;
  ageSeconds?: number;
}

export function hubStateCachePath(): string {
  return join(getConfigDir(), "hub-state.json");
}

interface CacheDocument {
  version: 1;
  owner: HubStateOwner;
  fetchedAt: string;
  state: HubStateDTO;
}

function readCacheDocument(): CacheDocument | null {
  const path = hubStateCachePath();
  if (!existsSync(path)) return null;
  try {
    const stat = lstatSync(path);
    // A symlink or an oversized file is refused rather than followed: this file is written
    // 0600 by us, and anything else about it is someone else's doing.
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const doc = raw as Record<string, unknown>;
    if (doc.version !== 1) return null;
    const owner = doc.owner;
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
    const ownerRow = owner as Record<string, unknown>;
    if (typeof ownerRow.serverUrl !== "string" || typeof ownerRow.apiKeyId !== "string"
      || typeof ownerRow.connectedAt !== "string") return null;
    if (typeof doc.fetchedAt !== "string" || Number.isNaN(Date.parse(doc.fetchedAt))) return null;
    const state = parseHubStateBody(doc.state);
    if (!state) return null;
    return {
      version: 1,
      owner: {
        serverUrl: ownerRow.serverUrl,
        apiKeyId: ownerRow.apiKeyId,
        connectedAt: ownerRow.connectedAt,
      },
      fetchedAt: doc.fetchedAt,
      state,
    };
  } catch {
    return null;
  }
}

/** The cached state for THIS connection, or null when absent, malformed, or another hub's. */
export function readCachedHubState(owner: HubStateOwner): { state: HubStateDTO; fetchedAt: string } | null {
  const doc = readCacheDocument();
  if (!doc) return null;
  if (!sameClientConnectionOwner(doc.owner, owner)) return null;
  return { state: doc.state, fetchedAt: doc.fetchedAt };
}

/** Best-effort: a cache that cannot be written must never fail the command that asked. */
export function writeCachedHubState(owner: HubStateOwner, state: HubStateDTO, fetchedAt: string): boolean {
  try {
    const document: CacheDocument = {
      version: 1,
      owner: { serverUrl: owner.serverUrl, apiKeyId: owner.apiKeyId, connectedAt: owner.connectedAt },
      fetchedAt,
      state,
    };
    atomicWriteFile(hubStateCachePath(), `${JSON.stringify(document, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why the live read did not land, in words an operator can act on.
 *
 * `hub_state_unsupported` is the version-skew case and gets an explicit upgrade instruction:
 * left as a bare code it reads like a bug in the client.
 *
 * Every code `fetchHubState` can throw has a sentence here, including the open-ended
 * `hub_state_http_<status>` family. This reason is printed in the `ocx status` banner, and a
 * banner reading `state unavailable (hub_state_http_507)` sends the reader looking for a client
 * bug when the hub has in fact answered and said something.
 */
export function hubStateFailureReason(error: unknown): string {
  if (error instanceof HubClientError) {
    switch (error.code) {
      case "hub_state_unsupported":
        return "this hub is too old to report its state; upgrade the hub";
      case "hub_state_unauthorized":
        return "the hub rejected this client's data key";
      case "hub_state_schema_invalid":
      case "hub_state_invalid":
        return "the hub returned an unreadable hub-state document";
      case "hub_state_content_type_invalid":
        // Usually a captive portal, a TLS-terminating proxy or an error page in front of the
        // hub: the request reached SOMETHING, and that something is not the hub's API.
        return "the hub's state response was not JSON";
      case "body_too_large":
        return "the hub's state response exceeded the allowed size";
      case "unreachable":
        return "the hub is unreachable";
      case "redirect_refused":
        return "the hub redirected the state request";
      default: {
        const status = error.code.startsWith("hub_state_http_")
          ? error.code.slice("hub_state_http_".length)
          : null;
        return status && /^\d+$/.test(status)
          ? `the hub answered HTTP ${status} to the state request`
          : error.code;
      }
    }
  }
  return "the hub state could not be read";
}

export interface ResolveHubStateOptions {
  owner: HubStateOwner;
  /** The per-client data key. Null when the token file is missing or unsafe. */
  token: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: number;
  /** False reads only the cache — for paths that must not make a network call. */
  allowNetwork?: boolean;
  /** False skips the cache write, for read-only callers. */
  persist?: boolean;
}

function withAge(
  source: HubStateSource,
  state: HubStateDTO | null,
  fetchedAt: string | undefined,
  now: number,
  reason?: string,
): HubStateResolution {
  const ageSeconds = fetchedAt ? Math.max(0, Math.floor((now - Date.parse(fetchedAt)) / 1000)) : undefined;
  return {
    stateSource: source,
    state,
    ...(reason ? { reason } : {}),
    ...(fetchedAt ? { fetchedAt } : {}),
    ...(ageSeconds === undefined || Number.isNaN(ageSeconds) ? {} : { ageSeconds }),
  };
}

export async function resolveHubState(options: ResolveHubStateOptions): Promise<HubStateResolution> {
  const now = options.now ?? Date.now();
  const fromCache = (reason: string): HubStateResolution => {
    const cached = readCachedHubState(options.owner);
    return cached
      ? withAge("cache", cached.state, cached.fetchedAt, now, reason)
      : withAge("unavailable", null, undefined, now, reason);
  };
  if (!options.token) return fromCache("this client has no usable data-plane token");
  if (options.allowNetwork === false) return fromCache("a live hub read was not attempted");
  let state: HubStateDTO;
  try {
    state = await fetchHubState(options.owner.serverUrl, options.token, {
      timeoutMs: options.timeoutMs ?? DEFAULT_HUB_STATE_TIMEOUT_MS,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    // Deliberately no local-state fallback here. A stale cache is still the HUB's state; the
    // client's own providers and logins are not, at any age.
    return fromCache(hubStateFailureReason(error));
  }
  const fetchedAt = new Date(now).toISOString();
  if (options.persist !== false) writeCachedHubState(options.owner, state, fetchedAt);
  return withAge("hub", state, fetchedAt, now);
}
