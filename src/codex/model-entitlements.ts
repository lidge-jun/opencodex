import { createHash } from "node:crypto";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import { getValidCodexToken, readCodexAccountRecord } from "./account-store";
import {
  getMainAccountToken,
  getValidMainAccountToken,
  MAIN_CODEX_ACCOUNT_ID,
  type NativeMainRefreshDependencies,
} from "./main-account";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./catalog/native-models";
import { loadPersistedCodexRuntime } from "./runtime";
import { codexRuntimeStateEpoch } from "./runtime";
import upstreamModelsSnapshot from "./data/upstream-models.json";
import { codexCredentialMutationEpoch } from "./credential-mutation-epoch";

const CODEX_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";

/**
 * Upstream filters this roster by the client version it is told, and `client_version` is a
 * required parameter — a measured `0.60.0` returns zero models where `0.142.2` returns five
 * (devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md). Asking as
 * `0.0.0` therefore describes what a prehistoric client may use, and treating that as the
 * account's entitlement hides models the account genuinely owns (#2886).
 *
 * A version must be supplied by the caller. There is deliberately no default: inventing one
 * either manufactures a confirmed negative (the defect) or advertises models the installed
 * runtime cannot drive (#2548, from the opposite side).
 */
function codexModelsUrl(clientVersion: string): string {
  return `${CODEX_MODELS_ENDPOINT}?client_version=${encodeURIComponent(clientVersion)}`;
}

/** A version string upstream can filter on. Rejects empty and the `0.0.0` placeholder. */
export function isUsableCodexClientVersion(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0.0.0") return false;
  // Bounded: the value reaches an outbound URL, and no real client version is this long.
  if (trimmed.length > 64) return false;
  if (!/^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(trimmed)) return false;
  // An all-zero numeric core is the same claim `0.0.0` makes — a client predating every gated
  // model — so `0`, `0.0`, `00.0.0`, and `0.0.0-dev` must fail for the same reason, by value
  // rather than by exact string.
  const core = trimmed.split(/[-+]/, 1)[0]!;
  if (core.split(".").every(segment => Number(segment) === 0)) return false;
  return true;
}

/**
 * Highest `minimal_client_version` this build's bundled roster records for the models that
 * are account-gated. Derived, not hardcoded: if the snapshot is refreshed with a model that
 * requires a newer client, the floor follows it, so the two can never drift apart.
 *
 * Used only as the last tier of version precedence, for background work that has no request
 * and no resolved runtime to speak for. It answers "what does this build believe the gated
 * models need?", which is a claim the repository can actually substantiate.
 */
export function deriveGatedClientVersionFloor(
  rows: ReadonlyArray<Record<string, unknown>>,
  gatedSlugs: ReadonlySet<string> = ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
): string | null {
  const floors = rows
    .filter(row => typeof row.slug === "string" && gatedSlugs.has(row.slug))
    .map(row => (typeof row.minimal_client_version === "string" ? row.minimal_client_version : null))
    .filter((value): value is string => isUsableCodexClientVersion(value));
  return floors.reduce<string | null>(
    (best, candidate) => (best === null || compareClientVersions(candidate, best) > 0 ? candidate : best),
    null,
  );
}

/**
 * Lowest `client_version` MEASURED to actually return the account-gated rows.
 *
 * The bundled snapshot is not sufficient on its own. It records `0.142.2` for the gpt-5.6
 * rows, and `0.142.2` is a version upstream answers with 200 and five models, none of them
 * gpt-5.6; `0.144.0` and above answer with the gated rows present
 * (devlog/_fin/260817_native_gpt56_1m_context/001_measurement_evidence.md, independently
 * reproduced by the #2886 and #3022 reporters). So a floor derived from the snapshot alone
 * asks a question whose honest answer is an empty gated set — and the fail-closed gate then
 * reads that absence as a confirmed denial, which is how 2.36.0 removed sol/terra/luna from
 * accounts that own them (#3022).
 *
 * This is a measurement, not a preference, which is why it composes with the derivation
 * instead of replacing it: see `composeGatedClientVersionFloor`.
 */
const MEASURED_GATED_CLIENT_VERSION_MINIMUM = "0.144.0";

/**
 * Lowest versions measured to return each account-gated model when the account owns it.
 *
 * This is deliberately independent of the bundled upstream snapshot. The snapshot still
 * records 0.142.2 for sol/terra/luna, while live measurements show that upstream omits them
 * below 0.144.0. Daybreak has no snapshot row or independent minimum, so its omission remains
 * authoritative instead of inheriting a guessed floor from another model.
 */
export const ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS: ReadonlyMap<string, string> = new Map([
  ["gpt-5.6-sol", MEASURED_GATED_CLIENT_VERSION_MINIMUM],
  ["gpt-5.6-terra", MEASURED_GATED_CLIENT_VERSION_MINIMUM],
  ["gpt-5.6-luna", MEASURED_GATED_CLIENT_VERSION_MINIMUM],
]);

/**
 * Fallback when the snapshot records no usable gated floor.
 *
 * Not every gated slug carries a `minimal_client_version` — `gpt-daybreak-blue-latest` has no
 * row in the current snapshot at all — so the derivation can legitimately come back empty as the
 * gated set changes. This is the last resort behind it, and it is still a version upstream can
 * filter on rather than the placeholder that caused #2886.
 */
const GATED_MODEL_CLIENT_VERSION_FLOOR_FALLBACK = "0.142.2";

/**
 * The floor actually used: the highest of what the snapshot derives, what we have measured
 * upstream to honour, and the fallback.
 *
 * Composed rather than hardcoded so the two sources cannot drift into a contradiction. The
 * snapshot may raise the floor; it may never lower it below a measurement. When a future
 * snapshot refresh records `0.144.0` or higher, the derivation takes over naturally and
 * `MEASURED_GATED_CLIENT_VERSION_MINIMUM` goes inert instead of fighting it.
 */
function composeGatedClientVersionFloor(
  rows: ReadonlyArray<Record<string, unknown>>,
  gatedSlugs: ReadonlySet<string> = ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
): string {
  const derived = deriveGatedClientVersionFloor(rows, gatedSlugs) ?? GATED_MODEL_CLIENT_VERSION_FLOOR_FALLBACK;
  return compareClientVersions(derived, MEASURED_GATED_CLIENT_VERSION_MINIMUM) >= 0
    ? derived
    : MEASURED_GATED_CLIENT_VERSION_MINIMUM;
}

export const GATED_MODEL_CLIENT_VERSION_FLOOR: string = composeGatedClientVersionFloor(
  (upstreamModelsSnapshot as { models?: Array<Record<string, unknown>> }).models ?? [],
);

/** Test-only seam: the composition on synthetic rows, so both directions can be proven. */
export function composeGatedClientVersionFloorForTests(
  rows: ReadonlyArray<Record<string, unknown>>,
  gatedSlugs?: ReadonlySet<string>,
): string {
  return composeGatedClientVersionFloor(rows, gatedSlugs);
}

/** Test-only seam: the ordering the floor composition relies on. */
export function compareClientVersionsForTests(left: string, right: string): number {
  return compareClientVersions(left, right);
}

/** Numeric-segment comparison. Only used to pick the highest floor in a known-good set. */
function compareClientVersions(left: string, right: string): number {
  const l = left.split(/[.+-]/).map(Number);
  const r = right.split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(l.length, r.length); i += 1) {
    const a = Number.isFinite(l[i]) ? l[i]! : 0;
    const b = Number.isFinite(r[i]) ? r[i]! : 0;
    if (a !== b) return a - b;
  }
  return 0;
}

/**
 * Version authority, in precedence order:
 *
 * 1. the inbound request's own `client_version` — the only value certainly describing the
 *    client being answered;
 * 2. the selected Codex runtime version, for background sync where no request exists.
 *    Retained sync refreshes runtime evidence before discovery, which is what makes this
 *    usable here; the persisted file itself carries no freshness guarantee.
 * 3. the floor this build's own bundled roster records for the models being gated
 *    (`GATED_MODEL_CLIENT_VERSION_FLOOR`).
 *
 * Tier 3 exists because background catalog sync has no request and, on a host where Codex
 * has never been resolved, no persisted runtime either — yet it is exactly the path that
 * publishes account-confirmed native rows. Skipping discovery there suppressed the rows this
 * fix is meant to restore. The floor is not invented: it is the version this build's own
 * snapshot states the gated models require, so asking under it is the narrowest question
 * that can still return them.
 *
 * There is deliberately no `0.0.0`-style fallback. A placeholder describes a client that
 * predates every gated model, which is what made upstream answer with an empty roster and
 * turned absent evidence into a manufactured confirmed negative (#2886).
 */
export function resolveCodexEntitlementClientVersion(
  inbound?: string | null,
  loadRuntime: () => { selectedVersion?: string | null } | null = loadPersistedCodexRuntime,
  options: { readonly bypassRuntimeMemo?: boolean; readonly now?: number } = {},
): string {
  if (isUsableCodexClientVersion(inbound)) return inbound.trim();
  // The memo describes the real runtime file, so a caller supplying a different loader is asking
  // a different question and must not be answered from it. Detected rather than left to the
  // caller, because forgetting the flag would silently cross-answer.
  const bypass = options.bypassRuntimeMemo === true || loadRuntime !== loadPersistedCodexRuntime;
  const selected = bypass
    ? readRuntimeVersion(loadRuntime)
    : memoizedPersistedRuntimeVersion(loadRuntime, options.now ?? Date.now());
  return selected ?? GATED_MODEL_CLIENT_VERSION_FLOOR;
}
const MODEL_ROSTER_TTL_MS = 5 * 60_000;

/**
 * How long a persisted-runtime version read is reused.
 *
 * Tier 2 of the version chain reads `codex-runtime.json` from disk, and it is consulted on
 * every gated Direct authorization and every `/v1/models` resolution — including when the
 * five-minute roster cache is hot, so the entitlement answer needs no I/O at all. Left
 * unmemoized that is a synchronous `readFileSync` on the request path under concurrent gated
 * traffic. `persistCodexRuntime` is the only writer, and it clears the runtime's own resolve
 * cache; this window is short enough that a runtime switch is picked up promptly either way.
 */
const RUNTIME_VERSION_MEMO_MS = 5_000;

let runtimeVersionMemo: { at: number; epoch: number; version: string | null } | null = null;

function readRuntimeVersion(
  loadRuntime: () => { selectedVersion?: string | null } | null,
): string | null {
  try {
    const value = loadRuntime()?.selectedVersion;
    return isUsableCodexClientVersion(value) ? value.trim() : null;
  } catch {
    // An unreadable or malformed runtime file is an absent version, not a failure worth
    // propagating into entitlement resolution.
    return null;
  }
}

function memoizedPersistedRuntimeVersion(
  loadRuntime: () => { selectedVersion?: string | null } | null,
  now: number,
): string | null {
  const epoch = codexRuntimeStateEpoch();
  // Time bounds staleness; the epoch makes a runtime switch invalidate this immediately, so the
  // window can never answer under the version that was just replaced.
  if (
    runtimeVersionMemo
    && runtimeVersionMemo.epoch === epoch
    && now - runtimeVersionMemo.at < RUNTIME_VERSION_MEMO_MS
  ) {
    return runtimeVersionMemo.version;
  }
  const selected = readRuntimeVersion(loadRuntime);
  runtimeVersionMemo = { at: now, epoch, version: selected };
  return selected;
}
const MODEL_ROSTER_FAILURE_TTL_MS = 15_000;
const MODEL_ROSTER_NEGATIVE_CREDENTIAL_TTL_MS = 5_000;
const MODEL_ROSTER_TIMEOUT_MS = 8_000;
const MODEL_ROSTER_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_ROSTER_CACHE_MAX = 64;

/**
 * Versions retained per account.
 *
 * `client_version` arrives on the inbound `/v1/models` request, so making it part of the cache
 * key handed callers a knob on key cardinality. With a flat per-key budget, one account cycling
 * 64 versions filled its whole class and pushed other accounts' confirmed grants out — the same
 * fail-closed catalog flapping the two-class budget exists to prevent, reached by a different
 * axis. A handful of versions per account is all any real deployment needs (a client, a runtime,
 * the floor), and the budget below counts ACCOUNTS so one noisy account cannot spend another's
 * share.
 */
const MODEL_ROSTER_VERSIONS_PER_ACCOUNT_MAX = 4;

/**
 * Concurrent roster requests allowed per account.
 *
 * The cache is bounded on write, but an in-flight request is not a cache entry: distinct
 * `client_version` values miss the flight key by design, so a caller cycling versions could open
 * arbitrarily many concurrent upstream requests, each holding an eight-second timer. This bounds
 * the concurrency itself. Exceeding it is reported as unconfirmed — the same fail-closed answer a
 * discovery failure produces, and cheaper than either queueing or serving another version's
 * roster.
 */
const MODEL_ROSTER_FLIGHTS_PER_ACCOUNT_MAX = 4;
const DIRECT_CALLER_ACCOUNT_PREFIX = "__direct_codex__:";

export interface CodexModelEntitlementCredentialSnapshot {
  readonly accountId: string;
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  /** Stable local identity for rejecting a catalog commit after credential replacement. */
  readonly credentialIdentity: string;
}

export type CodexModelEntitlementProvenance =
  | { readonly kind: "parsed-empty" }
  | { readonly kind: "http-error"; readonly httpStatus: number }
  | { readonly kind: "network-error" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unparseable" };

export type CodexModelEntitlementStatus =
  | { readonly status: "unavailable" }
  | { readonly status: "fresh" }
  | { readonly status: "unconfirmed-empty" }
  | { readonly status: "failed"; readonly reason: "http-error"; readonly httpStatus: number }
  | {
      readonly status: "failed";
      readonly reason: Exclude<CodexModelEntitlementProvenance["kind"], "parsed-empty" | "http-error">;
      readonly httpStatus?: never;
    }
  | { readonly status: "expired-refresh-in-flight" };

interface CachedAccountModels {
  readonly credentialIdentity: string;
  /**
   * Client version this roster was fetched under. Upstream filters by it, so a roster is
   * only an answer for that version — an entry fetched under one must never satisfy a read
   * for another (#2886).
   */
  readonly clientVersion: string;
  readonly expiresAt: number;
  readonly models: ReadonlySet<string>;
  readonly confirmed: boolean;
  readonly provenance?: CodexModelEntitlementProvenance;
}

export interface CodexModelEntitlementSnapshot {
  readonly modelsByAccount: ReadonlyMap<string, ReadonlySet<string>>;
  readonly clientVersionByAccount: ReadonlyMap<string, string>;
  readonly confirmedAccountIds: ReadonlySet<string>;
  readonly credentialIdentities: ReadonlyMap<string, string>;
}

export type CodexModelEntitlementState = "granted" | "denied" | "unknown";

export interface CodexModelEntitlementResolveOptions {
  readonly fetcher?: typeof fetch;
  /**
   * Client version to ask upstream about. Absent means no trustworthy version was
   * available, and discovery is skipped rather than asked under a placeholder.
   */
  readonly clientVersion?: string | null;
  /**
   * Test-only seam for the persisted-runtime half of the version precedence chain, so a case
   * can reach the no-trustworthy-version branch without depending on the host's own runtime
   * state file.
   */
  readonly loadPersistedRuntime?: () => { selectedVersion?: string | null } | null;
  readonly nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  readonly now?: number;
  readonly signal?: AbortSignal;
  /** Test-only credential seam; production callers enumerate local main + Pool credentials. */
  readonly credentials?: readonly CodexModelEntitlementCredentialSnapshot[];
  /** Test-only seam for proving lifecycle exclusions happen before credential reads. */
  readonly credentialSnapshot?: typeof accountCredentialSnapshot;
  /** Accounts whose credentials must not be read while another lifecycle owns them. */
  readonly excludeAccountIds?: ReadonlySet<string>;
  /** Ensure-only fence; ordinary request resolvers retain their established flight identity. */
  readonly credentialMutationEpoch?: number;
}

export interface CodexEntitlementFreshnessOptions extends Pick<
  CodexModelEntitlementResolveOptions,
  | "clientVersion"
  | "credentialSnapshot"
  | "fetcher"
  | "loadPersistedRuntime"
  | "nativeMainRefreshDependencies"
  | "now"
  | "signal"
> {
  readonly waitMs?: number;
}

const accountModelsCache = new Map<string, CachedAccountModels>();
const accountModelsFlights = new Map<string, Promise<CachedAccountModels>>();

interface NegativeCredentialMemo {
  readonly credentialIdentity: string | null;
  readonly mutationEpoch: number;
  readonly expiresAt: number;
}

interface EntitlementEnsureFlight {
  readonly startedAt: number;
  readonly promise: Promise<void>;
  readonly clientVersion: string;
  readonly identityVector: ReadonlyMap<string, string | null>;
  readonly workset: readonly string[];
}

const negativeCredentialMemo = new Map<string, NegativeCredentialMemo>();
const entitlementEnsureFlights = new Map<string, EntitlementEnsureFlight>();

/**
 * Cache key. The roster is version-specific, so the version has to be part of the identity —
 * with an account-only key, two versions in flight for one account race to overwrite each
 * other, and the unversioned projection readers in `catalog/metadata.ts` then publish
 * whichever landed last.
 */
function cacheKeyFor(accountId: string, clientVersion: string): string {
  return `${accountId}\u0000${clientVersion}`;
}

/** Account component of a cache key, for eviction budgets and per-account invalidation. */
function accountIdOfCacheKey(key: string): string {
  const separator = key.indexOf("\u0000");
  return separator === -1 ? key : key.slice(0, separator);
}

/**
 * Direct-caller entries are evicted separately from main/Pool entries.
 *
 * Direct keys are per-credential (`__direct_codex__:<hash>`) and unbounded in practice, while
 * main/Pool keys are the evidence the CATALOG projects from. Sharing one LRU let 64 distinct
 * Direct callers evict `__main__` and the Pool accounts, which makes the gated row vanish from
 * the catalog until rediscovery — fail-closed flapping rather than a leak, but still a visible
 * model disappearing for a reason the operator cannot see. Two budgets keep one class of caller
 * from erasing the other's evidence.
 */
function boundedCacheSet(accountId: string, value: CachedAccountModels): void {
  const key = cacheKeyFor(accountId, value.clientVersion);
  accountModelsCache.delete(key);
  accountModelsCache.set(key, value);
  const isDirect = (candidate: string): boolean =>
    accountIdOfCacheKey(candidate).startsWith(DIRECT_CALLER_ACCOUNT_PREFIX);

  // First, bound THIS account's versions, so a caller cycling client_version evicts only its
  // own older entries and never reaches another account's evidence.
  const ownKeys = [...accountModelsCache.keys()].filter(k => accountIdOfCacheKey(k) === accountId);
  for (const stale of ownKeys.slice(0, Math.max(0, ownKeys.length - MODEL_ROSTER_VERSIONS_PER_ACCOUNT_MAX))) {
    accountModelsCache.delete(stale);
  }

  // Then bound the class by DISTINCT ACCOUNTS. Counting keys would let one account's versions
  // consume the budget; counting accounts keeps each account's share independent of how many
  // versions any other account is using.
  const evictClass = (direct: boolean): void => {
    const accountsInOrder: string[] = [];
    for (const key of accountModelsCache.keys()) {
      if (isDirect(key) !== direct) continue;
      const account = accountIdOfCacheKey(key);
      if (!accountsInOrder.includes(account)) accountsInOrder.push(account);
    }
    // Never evict the account just written, even if it is the least-recently-inserted.
    for (const victim of accountsInOrder.slice(0, Math.max(0, accountsInOrder.length - MODEL_ROSTER_CACHE_MAX))) {
      if (victim === accountId) continue;
      for (const key of [...accountModelsCache.keys()]) {
        if (accountIdOfCacheKey(key) === victim) accountModelsCache.delete(key);
      }
    }
  };
  evictClass(accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX));
}

function currentCredentialIdentity(accountId: string): string | undefined {
  if (accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)) {
    return `direct:${accountId.slice(DIRECT_CALLER_ACCOUNT_PREFIX.length)}`;
  }
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    const token = getMainAccountToken();
    return token ? `main:${token.chatgptAccountId}` : undefined;
  }
  const record = readCodexAccountRecord(accountId);
  if (!record?.credential || record.deletedAt != null) return undefined;
  return `pool:${record.generation}:${record.credential.chatgptAccountId}`;
}

async function accountCredentialSnapshot(
  accountId: string,
  options: Pick<CodexModelEntitlementResolveOptions, "nativeMainRefreshDependencies" | "signal"> = {},
): Promise<CodexModelEntitlementCredentialSnapshot | null> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    const token = await getValidMainAccountToken({
      signal: options.signal,
      ...(options.nativeMainRefreshDependencies ?? {}),
    });
    return token
      ? {
        accountId,
        accessToken: token.accessToken,
        chatgptAccountId: token.chatgptAccountId,
        credentialIdentity: `main:${token.chatgptAccountId}`,
      }
      : null;
  }
  try {
    const token = await getValidCodexToken(accountId);
    return {
      accountId,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      credentialIdentity: `pool:${token.generation}:${token.chatgptAccountId}`,
    };
  } catch {
    return null;
  }
}

function parseAccountModels(text: string): ReadonlySet<string> | null {
  try {
    const payload = JSON.parse(text) as { models?: unknown };
    if (!Array.isArray(payload.models)) return null;
    const models = payload.models.flatMap(entry => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as { slug?: unknown; supported_in_api?: unknown; visibility?: unknown };
      if (typeof row.slug !== "string" || row.supported_in_api !== true || row.visibility === "hide") return [];
      return [row.slug];
    });
    return new Set(models);
  } catch {
    return null;
  }
}

function unconfirmedAccountModels(
  credential: CodexModelEntitlementCredentialSnapshot,
  clientVersion: string,
  now: number,
  provenance: CodexModelEntitlementProvenance,
): CachedAccountModels {
  return {
    credentialIdentity: credential.credentialIdentity,
    clientVersion,
    expiresAt: now + MODEL_ROSTER_FAILURE_TTL_MS,
    models: new Set(),
    confirmed: false,
    provenance,
  };
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

async function fetchAccountModels(
  credential: CodexModelEntitlementCredentialSnapshot,
  fetcher: typeof fetch,
  now: number,
  clientVersion: string,
): Promise<CachedAccountModels> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Codex model discovery timed out", "TimeoutError")), MODEL_ROSTER_TIMEOUT_MS);
  try {
    const headers = new Headers({
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
    });
    if (credential.chatgptAccountId) headers.set("ChatGPT-Account-Id", credential.chatgptAccountId);
    const response = await fetcher(codexModelsUrl(clientVersion), {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      return unconfirmedAccountModels(credential, clientVersion, now, {
        kind: "http-error",
        httpStatus: response.status,
      });
    }
    const body = await readBoundedResponseBody(response, {
      signal: controller.signal,
      maxBytes: MODEL_ROSTER_MAX_BYTES,
      fatalUtf8: true,
    });
    if (!body.displaySafe || body.truncated) {
      return unconfirmedAccountModels(credential, clientVersion, now, { kind: "unparseable" });
    }
    const models = parseAccountModels(body.text);
    if (models === null) {
      return unconfirmedAccountModels(credential, clientVersion, now, { kind: "unparseable" });
    }
    // A roster is a confirmation only when it lists something usable. `models` is a Set, and an
    // empty Set is truthy, so `models !== null` used to call `{"models":[]}` — and a response
    // whose every row was hidden or api-disabled — a confirmed answer, and lock it in for the
    // five-minute success TTL. Absence of evidence is not evidence of absence: an entitled
    // account asked under too old a client version answers with no gated rows, and treating
    // that as authoritative is exactly how 2.36.0 denied sol/terra/luna to accounts that own
    // them (#3022). No usable rows means unconfirmed, on the 15s failure TTL, asked again.
    const usable = models.size > 0;
    if (!usable) {
      return unconfirmedAccountModels(credential, clientVersion, now, { kind: "parsed-empty" });
    }
    const hasUnknownGatedAbsence = [...ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS]
      .some(([modelId, minimum]) => (
        !models.has(modelId) && compareClientVersions(clientVersion, minimum) < 0
      ));
    return {
      credentialIdentity: credential.credentialIdentity,
      clientVersion,
      expiresAt: now + (!hasUnknownGatedAbsence
        ? MODEL_ROSTER_TTL_MS
        : MODEL_ROSTER_FAILURE_TTL_MS),
      models,
      confirmed: true,
    };
  } catch (error) {
    const provenance = isTimeoutError(error) || isTimeoutError(controller.signal.reason)
      ? { kind: "timeout" } as const
      : { kind: "network-error" } as const;
    return unconfirmedAccountModels(credential, clientVersion, now, provenance);
  } finally {
    clearTimeout(timer);
  }
}

function directCallerCredential(headers: Headers): CodexModelEntitlementCredentialSnapshot | null {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "");
  if (!match) return null;
  const accessToken = match[1]!;
  const chatgptAccountId = headers.get("chatgpt-account-id")?.trim() ?? "";
  const fingerprint = createHash("sha256")
    .update(accessToken)
    .update("\0")
    .update(chatgptAccountId)
    .digest("hex");
  return {
    accountId: `${DIRECT_CALLER_ACCOUNT_PREFIX}${fingerprint}`,
    accessToken,
    chatgptAccountId,
    credentialIdentity: `direct:${fingerprint}`,
  };
}

async function modelsForCredential(
  credential: CodexModelEntitlementCredentialSnapshot,
  fetcher: typeof fetch,
  now: number,
  clientVersion: string,
  credentialMutationEpoch?: number,
): Promise<CachedAccountModels> {
  const cached = accountModelsCache.get(cacheKeyFor(credential.accountId, clientVersion));
  if (
    cached
    && cached.credentialIdentity === credential.credentialIdentity
    && cached.expiresAt > now
  ) return cached;

  const flightKey = `${credential.accountId}\u0000${credential.credentialIdentity}\u0000${clientVersion}`
    + (credentialMutationEpoch === undefined ? "" : `\u0000${credentialMutationEpoch}`);
  const existing = accountModelsFlights.get(flightKey);
  if (existing) return existing;

  // Bound concurrency per account before opening another upstream request.
  let liveForAccount = 0;
  for (const key of accountModelsFlights.keys()) {
    if (accountIdOfCacheKey(key) === credential.accountId) liveForAccount += 1;
  }
  if (liveForAccount >= MODEL_ROSTER_FLIGHTS_PER_ACCOUNT_MAX) {
    return {
      credentialIdentity: credential.credentialIdentity,
      clientVersion,
      expiresAt: now,
      models: new Set(),
      confirmed: false,
    };
  }
  const flight = fetchAccountModels(credential, fetcher, now, clientVersion)
    .then(result => {
      if (
        currentCredentialIdentity(credential.accountId) === credential.credentialIdentity
        && (credentialMutationEpoch === undefined
          || codexCredentialMutationEpoch() === credentialMutationEpoch)
      ) {
        boundedCacheSet(credential.accountId, result);
      }
      return result;
    })
    .finally(() => {
      if (accountModelsFlights.get(flightKey) === flight) accountModelsFlights.delete(flightKey);
    });
  accountModelsFlights.set(flightKey, flight);
  return flight;
}

function candidateAccountIds(config: Pick<OcxConfig, "codexAccounts">): string[] {
  return [
    MAIN_CODEX_ACCOUNT_ID,
    ...(config.codexAccounts ?? [])
      .filter(isSelectableCodexPoolAccount)
      .map(account => account.id),
  ];
}

function normalizedCandidateAccountIds(config: Pick<OcxConfig, "codexAccounts">): string[] {
  return [...new Set(candidateAccountIds(config))].sort();
}

function freshNegativeCredentialMemo(
  accountId: string,
  credentialIdentity: string | null,
  mutationEpoch: number,
  now: number,
): boolean {
  const memo = negativeCredentialMemo.get(accountId);
  if (
    memo
    && memo.credentialIdentity === credentialIdentity
    && memo.mutationEpoch === mutationEpoch
    && memo.expiresAt > now
  ) return true;
  if (memo) negativeCredentialMemo.delete(accountId);
  return false;
}

function boundedNegativeCredentialMemoSet(accountId: string, memo: NegativeCredentialMemo): void {
  negativeCredentialMemo.delete(accountId);
  negativeCredentialMemo.set(accountId, memo);
  for (const oldest of [...negativeCredentialMemo.keys()].slice(0, Math.max(
    0,
    negativeCredentialMemo.size - MODEL_ROSTER_CACHE_MAX,
  ))) negativeCredentialMemo.delete(oldest);
}

function needsEntitlementRefresh(
  accountId: string,
  credentialIdentity: string | null,
  clientVersion: string,
  mutationEpoch: number,
  now: number,
): boolean {
  const cached = accountModelsCache.get(cacheKeyFor(accountId, clientVersion));
  if (cached && cached.credentialIdentity !== credentialIdentity) {
    invalidateCodexModelEntitlementsForAccount(accountId);
  } else if (cached && cached.expiresAt > now) {
    return false;
  }
  return !freshNegativeCredentialMemo(accountId, credentialIdentity, mutationEpoch, now);
}

function entitlementEnsureFlightKey(
  candidateAccountIds: readonly string[],
  clientVersion: string,
  mutationEpoch: number,
  identityVector: readonly (readonly [string, string | null])[],
  workset: readonly string[],
): string {
  return JSON.stringify([candidateAccountIds, clientVersion, mutationEpoch, identityVector, workset]);
}

async function refreshCodexEntitlementWorkset(
  config: Pick<OcxConfig, "codexAccounts">,
  workset: readonly string[],
  identityVector: ReadonlyMap<string, string | null>,
  clientVersion: string,
  mutationEpoch: number,
  options: CodexEntitlementFreshnessOptions,
): Promise<void> {
  const credentialSnapshot = options.credentialSnapshot ?? accountCredentialSnapshot;
  const observations = await Promise.all(workset.map(async accountId => {
    const credential = await credentialSnapshot(accountId, options);
    return {
      accountId,
      credential,
      absenceObservedAt: options.now ?? Date.now(),
    };
  }));
  const credentials = observations.flatMap(observation => observation.credential
    ? [observation.credential]
    : []);
  if (credentials.length > 0) {
    await resolveCodexModelEntitlements(config, {
      ...options,
      clientVersion,
      credentialMutationEpoch: mutationEpoch,
      credentials,
    });
  }

  for (const observation of observations) {
    if (observation.credential) continue;
    const capturedIdentity = identityVector.get(observation.accountId) ?? null;
    if (codexCredentialMutationEpoch() !== mutationEpoch) continue;
    if ((currentCredentialIdentity(observation.accountId) ?? null) !== capturedIdentity) continue;
    boundedNegativeCredentialMemoSet(observation.accountId, {
      credentialIdentity: capturedIdentity,
      mutationEpoch,
      expiresAt: observation.absenceObservedAt + MODEL_ROSTER_NEGATIVE_CREDENTIAL_TTL_MS,
    });
  }
}

function waitForEntitlementEnsureFlight(
  flight: EntitlementEnsureFlight,
  waitMs: number,
): Promise<void> {
  const remaining = Math.max(0, waitMs - Math.max(0, Date.now() - flight.startedAt));
  if (remaining === 0) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, remaining);
    void flight.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Refreshes only missing, expired, or credential-mismatched local entitlement entries.
 * Management deadlines bound the wait, not the upstream work, so a timed-out poll still warms
 * the cache for the first poll after the shared flight settles.
 */
export async function ensureCodexEntitlementFreshness(
  config: Pick<OcxConfig, "codexAccounts">,
  options: CodexEntitlementFreshnessOptions = {},
): Promise<void> {
  try {
    const now = options.now ?? Date.now();
    const clientVersion = resolveCodexEntitlementClientVersion(
      options.clientVersion,
      options.loadPersistedRuntime ?? loadPersistedCodexRuntime,
    );
    const candidates = normalizedCandidateAccountIds(config);
    const mutationEpoch = codexCredentialMutationEpoch();
    const identityEntries = candidates.map(accountId => (
      [accountId, currentCredentialIdentity(accountId) ?? null] as const
    ));
    const identityVector = new Map(identityEntries);
    const workset = candidates.filter(accountId => needsEntitlementRefresh(
      accountId,
      identityVector.get(accountId) ?? null,
      clientVersion,
      mutationEpoch,
      now,
    ));
    if (workset.length === 0) return;

    const key = entitlementEnsureFlightKey(
      candidates,
      clientVersion,
      mutationEpoch,
      identityEntries,
      workset,
    );
    let flight = entitlementEnsureFlights.get(key);
    if (!flight) {
      const startedAt = Date.now();
      let created!: EntitlementEnsureFlight;
      const promise = refreshCodexEntitlementWorkset(
        config,
        workset,
        identityVector,
        clientVersion,
        mutationEpoch,
        options,
      ).catch(() => {
        // Entitlement discovery is fail-closed: callers project only confirmed cache entries.
      }).finally(() => {
        if (entitlementEnsureFlights.get(key) === created) entitlementEnsureFlights.delete(key);
      });
      created = { startedAt, promise, clientVersion, identityVector, workset };
      entitlementEnsureFlights.set(key, created);
      flight = created;
    }
    const requestedWaitMs = options.waitMs ?? 3_000;
    const waitMs = Number.isFinite(requestedWaitMs) ? Math.max(0, requestedWaitMs) : 0;
    await waitForEntitlementEnsureFlight(flight, waitMs);
  } catch {
    // The shared management boundary must degrade to the last confirmed fail-closed projection.
  }
}

export function getCodexModelEntitlementStatus(
  config: Pick<OcxConfig, "codexAccounts">,
  now = Date.now(),
  clientVersion?: string | null,
): CodexModelEntitlementStatus {
  const version = resolveCodexEntitlementClientVersion(clientVersion);
  const accounts = candidateAccountIds(config).flatMap(accountId => {
    const credentialIdentity = currentCredentialIdentity(accountId);
    return credentialIdentity ? [{ accountId, credentialIdentity }] : [];
  });
  if (accounts.length === 0) return { status: "unavailable" };

  const entries = accounts.map(({ accountId, credentialIdentity }) => ({
    accountId,
    credentialIdentity,
    entry: accountModelsCache.get(cacheKeyFor(accountId, version)),
  }));
  const hasRefreshFlight = (accountId: string, credentialIdentity: string): boolean => {
    return [...entitlementEnsureFlights.values()].some(flight => (
      flight.clientVersion === version
      && flight.identityVector.get(accountId) === credentialIdentity
      && flight.workset.includes(accountId)
    ));
  };
  if (entries.some(({ accountId, credentialIdentity, entry }) => (
    entry
    && entry.credentialIdentity === credentialIdentity
    && entry.expiresAt <= now
    && hasRefreshFlight(accountId, credentialIdentity)
  ))) return { status: "expired-refresh-in-flight" };
  const live = entries.flatMap(({ credentialIdentity, entry }) => (
    entry && entry.credentialIdentity === credentialIdentity && entry.expiresAt > now ? [entry] : []
  ));
  // Deliberate failure-first aggregation keeps a partial Pool refresh failure visible.
  const failed = live.find(entry => entry.provenance && entry.provenance.kind !== "parsed-empty");
  if (failed?.provenance?.kind === "http-error") {
    return { status: "failed", reason: "http-error", httpStatus: failed.provenance.httpStatus };
  }
  if (failed?.provenance?.kind === "network-error") return { status: "failed", reason: "network-error" };
  if (failed?.provenance?.kind === "timeout") return { status: "failed", reason: "timeout" };
  if (failed?.provenance?.kind === "unparseable") return { status: "failed", reason: "unparseable" };
  if (live.some(entry => entry.provenance?.kind === "parsed-empty")) {
    return { status: "unconfirmed-empty" };
  }
  if (live.some(entry => entry.confirmed)) return { status: "fresh" };
  return { status: "unavailable" };
}

/**
 * Fetch the authenticated model roster for every locally usable Codex account.
 *
 * [Decision Log]
 * - 목적과 의도: Account-gated native models must be advertised and selected only for accounts
 *   whose own authenticated upstream catalog confirms the model.
 * - 기존 구현 및 제약 조건: The injected Codex catalog is static, while Pool may contain
 *   accounts with different entitlements. A global allowlist therefore exposed unusable rows.
 * - 검토한 주요 대안: Infer access from plan labels, learn only after a failed prompt, or rewrite
 *   Daybreak to its current physical model.
 * - 선택한 방식: Cache bounded authenticated `/models` rosters per credential generation and
 *   fail closed for unconfirmed accounts.
 * - 다른 대안 대신 이 방식을 선택한 이유: Plan names do not prove grants, post-failure
 *   learning spends a real turn, and model rewriting changes the requested product identity.
 * - 장점, 단점 및 영향: Catalog and routing share exact account evidence. Cold gated requests
 *   pay one bounded discovery call per account; discovery failure temporarily hides the gated row.
 */
export async function resolveCodexModelEntitlements(
  config: Pick<OcxConfig, "codexAccounts">,
  options: CodexModelEntitlementResolveOptions = {},
): Promise<CodexModelEntitlementSnapshot> {
  const now = options.now ?? Date.now();
  const fetcher = options.fetcher ?? fetch;
  const clientVersion = resolveCodexEntitlementClientVersion(
    options.clientVersion,
    options.loadPersistedRuntime ?? loadPersistedCodexRuntime,
  );
  const allowedAccountIds = candidateAccountIds(config)
    .filter(accountId => !options.excludeAccountIds?.has(accountId));
  const credentialSnapshot = options.credentialSnapshot ?? accountCredentialSnapshot;
  const credentials = options.credentials
    ? [...options.credentials].filter(credential => !options.excludeAccountIds?.has(credential.accountId))
    : (await Promise.all(allowedAccountIds.map(accountId => credentialSnapshot(accountId, options))))
      .filter((value): value is CodexModelEntitlementCredentialSnapshot => value !== null);
  const results = await Promise.all(credentials.map(async credential => ({
    credential,
    result: await modelsForCredential(
      credential,
      fetcher,
      now,
      clientVersion,
      options.credentialMutationEpoch,
    ),
  })));
  return {
    modelsByAccount: new Map(results.map(({ credential, result }) => [credential.accountId, result.models])),
    clientVersionByAccount: new Map(results.map(({ credential, result }) => (
      [credential.accountId, result.clientVersion]
    ))),
    confirmedAccountIds: new Set(results.flatMap(({ credential, result }) => result.confirmed ? [credential.accountId] : [])),
    credentialIdentities: new Map(results.map(({ credential }) => [credential.accountId, credential.credentialIdentity])),
  };
}

function codexModelEntitlementStateForRoster(
  models: ReadonlySet<string> | undefined,
  confirmed: boolean,
  clientVersion: string | undefined,
  modelId: string,
): CodexModelEntitlementState {
  if (!models || !confirmed) return "unknown";
  // Positive evidence is authoritative regardless of which client version asked for it.
  if (models.has(modelId)) return "granted";
  const minimum = ACCOUNT_GATED_NATIVE_MODEL_MINIMUM_CLIENT_VERSIONS.get(modelId);
  if (minimum && (!clientVersion || compareClientVersions(clientVersion, minimum) < 0)) {
    return "unknown";
  }
  return "denied";
}

/** Per-account tri-state authority. Positive projections admit only `granted`. */
export function codexModelEntitlementStateForAccount(
  snapshot: CodexModelEntitlementSnapshot,
  accountId: string,
  modelId: string,
): CodexModelEntitlementState {
  return codexModelEntitlementStateForRoster(
    snapshot.modelsByAccount.get(accountId),
    snapshot.confirmedAccountIds.has(accountId),
    snapshot.clientVersionByAccount?.get(accountId),
    modelId,
  );
}

/** Fail-closed entitlement check for a Direct request's own forwarded ChatGPT credential. */
export async function isDirectCallerEntitledToCodexModel(
  headers: Headers,
  modelId: string,
  options: Pick<CodexModelEntitlementResolveOptions, "fetcher" | "now" | "clientVersion"> = {},
): Promise<boolean> {
  if (!ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return true;
  const credential = directCallerCredential(headers);
  if (!credential) return false;
  const clientVersion = resolveCodexEntitlementClientVersion(options.clientVersion);
  const result = await modelsForCredential(
    credential,
    options.fetcher ?? fetch,
    options.now ?? Date.now(),
    clientVersion,
  );
  return codexModelEntitlementStateForRoster(
    result.models,
    result.confirmed,
    result.clientVersion,
    modelId,
  ) === "granted";
}

export function entitledCodexAccountIdsForModel(
  snapshot: CodexModelEntitlementSnapshot,
  modelId: string | undefined,
): ReadonlySet<string> | undefined {
  if (!modelId || !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return undefined;
  return new Set([...snapshot.modelsByAccount.keys()].flatMap(accountId => (
    codexModelEntitlementStateForAccount(snapshot, accountId, modelId) === "granted"
      ? [accountId]
      : []
  )));
}

export function availableAccountGatedNativeModels(
  snapshot: CodexModelEntitlementSnapshot,
  eligibleAccountIds?: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(modelId => (
    [...snapshot.modelsByAccount.keys()].some(accountId => (
      (!eligibleAccountIds || eligibleAccountIds.has(accountId))
      && codexModelEntitlementStateForAccount(snapshot, accountId, modelId) === "granted"
    ))
  )));
}

/** Synchronous projection for management/catalog readers after a discovery pass. */
export function cachedAvailableAccountGatedNativeModels(
  now = Date.now(),
  eligibleAccountIds?: ReadonlySet<string>,
  clientVersion?: string | null,
): ReadonlySet<string> {
  // Entries fetched under a different client version answer a different question, so a caller
  // that knows which version it is projecting for must say so — otherwise a newer client's
  // roster leaks into an older client's projection (#2548 from the opposite direction).
  //
  // Omitting the argument deliberately does NOT filter. This is a synchronous read of
  // whatever discovery already proved, and its callers (catalog metadata) are not
  // request-scoped: resolving a version here would silently discard every entry fetched under
  // a different one, which is a suppression this function has no evidence to justify.
  const version = isUsableCodexClientVersion(clientVersion) ? clientVersion.trim() : null;
  return new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(modelId => (
    [...accountModelsCache].some(([accountId, entry]) => (
      (!eligibleAccountIds || eligibleAccountIds.has(accountIdOfCacheKey(accountId)))
      && !accountIdOfCacheKey(accountId).startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)
      && (version === null || entry.clientVersion === version)
      && entry.expiresAt > now
      && codexModelEntitlementStateForRoster(
        entry.models,
        entry.confirmed,
        entry.clientVersion,
        modelId,
      ) === "granted"
    ))
  )));
}

export function isCodexModelEntitlementSnapshotCurrent(snapshot: CodexModelEntitlementSnapshot): boolean {
  for (const [accountId, identity] of snapshot.credentialIdentities) {
    if (currentCredentialIdentity(accountId) !== identity) return false;
  }
  return true;
}

export function invalidateCodexModelEntitlementsForAccount(accountId: string | null | undefined): void {
  if (!accountId) return;
  // Every version's entry for this account, since a credential change invalidates the
  // account's entitlement evidence regardless of which client version asked for it.
  for (const key of [...accountModelsCache.keys()]) {
    if (accountIdOfCacheKey(key) === accountId) accountModelsCache.delete(key);
  }
}

export function resetCodexModelEntitlementCacheForTests(): void {
  accountModelsCache.clear();
  accountModelsFlights.clear();
  negativeCredentialMemo.clear();
  entitlementEnsureFlights.clear();
  runtimeVersionMemo = null;
}

/** Test-only snapshot for proving publication fences, which cache lookup intentionally masks. */
export function codexEntitlementNegativeMemoForTests(
  accountId: string,
): Readonly<{
  credentialIdentity: string | null;
  mutationEpoch: number;
  expiresAt: number;
}> | null {
  const memo = negativeCredentialMemo.get(accountId);
  return memo ? { ...memo } : null;
}

/**
 * Test-only seam for the memoized tier-2 read.
 *
 * The memo is deliberately reachable only through the DEFAULT loader (a supplied loader is
 * auto-bypassed, so it cannot be cross-answered), which leaves no way to observe memo behavior
 * from a test without either touching the real state file or exposing this.
 */
export function memoizeRuntimeVersionForTests(
  loadRuntime: () => { selectedVersion?: string | null } | null,
  now: number,
): string | null {
  return memoizedPersistedRuntimeVersion(loadRuntime, now);
}

export function seedCodexModelEntitlementsForTests(
  accountId: string,
  models: readonly string[],
  now = Date.now(),
  clientVersion = "0.146.0",
  credentialIdentity = `test:${accountId}`,
): void {
  boundedCacheSet(accountId, {
    credentialIdentity,
    clientVersion,
    expiresAt: now + MODEL_ROSTER_TTL_MS,
    models: new Set(models),
    confirmed: true,
  });
}
