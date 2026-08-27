import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import { getValidCodexToken, readCodexAccountRecord } from "./account-store";
import { getMainAccountToken, MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./catalog/native-models";
import { getCodexHome, readRootTomlString } from "./paths";

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.0.0";
const MODEL_ROSTER_TTL_MS = 5 * 60_000;
const MODEL_ROSTER_FAILURE_TTL_MS = 15_000;
const MODEL_ROSTER_TIMEOUT_MS = 8_000;
const MODEL_ROSTER_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_ROSTER_CACHE_MAX = 64;
const DIRECT_CALLER_ACCOUNT_PREFIX = "__direct_codex__:";
const OPEN_CODEX_CACHE_TIMESTAMP = "2000-01-01T00:00:00Z";
export const SYNTHETIC_MAIN_MODEL_CREDENTIAL_PREFIX = "synthetic-cache:";

export interface CodexModelEntitlementCredentialSnapshot {
  readonly accountId: string;
  readonly accessToken: string;
  readonly chatgptAccountId: string;
  /** Stable local identity for rejecting a catalog commit after credential replacement. */
  readonly credentialIdentity: string;
}

interface CachedAccountModels {
  readonly credentialIdentity: string;
  readonly expiresAt: number;
  readonly models: ReadonlySet<string>;
  readonly confirmed: boolean;
}

export interface CodexModelEntitlementSnapshot {
  readonly modelsByAccount: ReadonlyMap<string, ReadonlySet<string>>;
  readonly confirmedAccountIds: ReadonlySet<string>;
  readonly credentialIdentities: ReadonlyMap<string, string>;
}

export interface CodexModelEntitlementResolveOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: number;
  /** Test-only credential seam; production callers enumerate local main + Pool credentials. */
  readonly credentials?: readonly CodexModelEntitlementCredentialSnapshot[];
  /** Test-only seam for proving lifecycle exclusions happen before credential reads. */
  readonly credentialSnapshot?: typeof accountCredentialSnapshot;
  /** Accounts whose credentials must not be read while another lifecycle owns them. */
  readonly excludeAccountIds?: ReadonlySet<string>;
  /** Focused test seam for Codex's authenticated native models cache. */
  readonly nativeMainModels?: readonly string[] | null;
}

const accountModelsCache = new Map<string, CachedAccountModels>();
const accountModelsFlights = new Map<string, Promise<CachedAccountModels>>();

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
  accountModelsCache.delete(accountId);
  accountModelsCache.set(accountId, value);
  const isDirect = (key: string): boolean => key.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX);
  const evictClass = (direct: boolean): void => {
    let count = 0;
    for (const key of accountModelsCache.keys()) if (isDirect(key) === direct) count += 1;
    while (count > MODEL_ROSTER_CACHE_MAX) {
      let oldest: string | undefined;
      for (const key of accountModelsCache.keys()) {
        if (isDirect(key) === direct) { oldest = key; break; }
      }
      if (oldest === undefined) break;
      accountModelsCache.delete(oldest);
      count -= 1;
    }
  };
  evictClass(isDirect(accountId));
}

function currentCredentialIdentity(accountId: string): string | undefined {
  if (accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)) {
    return `direct:${accountId.slice(DIRECT_CALLER_ACCOUNT_PREFIX.length)}`;
  }
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    const token = getMainAccountToken();
    return token
      ? `main:${token.chatgptAccountId}`
      : accountModelsCache.get(MAIN_CODEX_ACCOUNT_ID)?.credentialIdentity;
  }
  const record = readCodexAccountRecord(accountId);
  if (!record?.credential || record.deletedAt != null) return undefined;
  return `pool:${record.generation}:${record.credential.chatgptAccountId}`;
}

function validatedAccountGatedModels(rows: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(rows)) return null;
  return new Set(rows.flatMap(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as {
      slug?: unknown;
      visibility?: unknown;
      supported_in_api?: unknown;
      supported_reasoning_levels?: unknown;
      model_messages?: unknown;
    };
    if (typeof row.slug !== "string"
      || !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(row.slug)
      || row.visibility === "hide"
      || row.supported_in_api !== true
      || !Array.isArray(row.supported_reasoning_levels)
      || row.supported_reasoning_levels.length === 0
      || typeof row.model_messages !== "object"
      || row.model_messages === null) return [];
    return [row.slug];
  }));
}

function sameModels(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(model => right.has(model));
}

function configuredCatalogPath(codexHome: string): string {
  try {
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    const configured = readRootTomlString(config, "model_catalog_json")?.trim();
    if (configured) return isAbsolute(configured) ? resolve(configured) : resolve(codexHome, configured);
  } catch { /* A missing or unreadable config uses the managed default catalog. */ }
  return join(codexHome, "opencodex-catalog.json");
}

function corroboratedSyntheticMainModels(
  cacheRaw: string,
  cacheModels: ReadonlySet<string>,
  codexHome: string,
): CachedAccountModels | null {
  if (cacheModels.size === 0) return null;
  let catalogRaw: string;
  try {
    catalogRaw = readFileSync(configuredCatalogPath(codexHome), "utf8");
  } catch {
    return null;
  }
  try {
    const catalog = JSON.parse(catalogRaw) as { models?: unknown };
    const catalogModels = validatedAccountGatedModels(catalog.models);
    if (!catalogModels || !sameModels(cacheModels, catalogModels)) return null;
    return {
      credentialIdentity: `${SYNTHETIC_MAIN_MODEL_CREDENTIAL_PREFIX}${createHash("sha256")
        .update(cacheRaw)
        .update("\0")
        .update(catalogRaw)
        .digest("hex")}`,
      expiresAt: 0,
      models: cacheModels,
      confirmed: true,
    };
  } catch {
    return null;
  }
}

/**
 * Read model availability that the installed Codex client fetched while authenticated.
 *
 * A real Codex cache is direct startup evidence. OpenCodex's `client_version=0.0.0` wrapper is
 * accepted only when its sentinel timestamp and gated roster match the managed catalog it was
 * generated from. That preserves a previously verified keyring roster across an OpenCodex restart
 * without treating an arbitrary synthetic cache as fresh account evidence. Request routing treats
 * this persisted wrapper as provisional and verifies it against the current caller before use.
 */
function nativeCodexMainModelsCache(now: number, codexHome = getCodexHome()): CachedAccountModels | null {
  let raw: string;
  try {
    raw = readFileSync(join(codexHome, "models_cache.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { fetched_at?: unknown; client_version?: unknown; models?: unknown };
    if (typeof parsed.client_version !== "string"
      || parsed.client_version.trim() === ""
      || !Array.isArray(parsed.models)) return null;
    const models = validatedAccountGatedModels(parsed.models);
    if (!models) return null;
    if (parsed.client_version.trim() === "0.0.0") {
      if (parsed.fetched_at !== OPEN_CODEX_CACHE_TIMESTAMP) return null;
      const synthetic = corroboratedSyntheticMainModels(raw, models, codexHome);
      return synthetic ? { ...synthetic, expiresAt: now + MODEL_ROSTER_TTL_MS } : null;
    }
    return {
      credentialIdentity: `native-cache:${createHash("sha256").update(raw).digest("hex")}`,
      expiresAt: now + MODEL_ROSTER_TTL_MS,
      models,
      confirmed: true,
    };
  } catch {
    return null;
  }
}

/**
 * Preserve native Codex's authenticated roster before server startup rewrites models_cache.json.
 * The startup cache rewrite is synchronous and deliberately precedes the later catalog gather;
 * without this snapshot the gather sees only OpenCodex's synthetic `client_version=0.0.0` cache.
 */
export function seedMainCodexModelEntitlementsFromNativeCache(options: {
  readonly codexHome?: string;
  readonly now?: number;
} = {}): boolean {
  const now = options.now ?? Date.now();
  const existing = accountModelsCache.get(MAIN_CODEX_ACCOUNT_ID);
  if (existing && existing.expiresAt > now) return existing.confirmed;
  const native = nativeCodexMainModelsCache(now, options.codexHome);
  if (!native) return false;
  boundedCacheSet(MAIN_CODEX_ACCOUNT_ID, native);
  return true;
}

async function accountCredentialSnapshot(accountId: string): Promise<CodexModelEntitlementCredentialSnapshot | null> {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    const token = getMainAccountToken();
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

async function fetchAccountModels(
  credential: CodexModelEntitlementCredentialSnapshot,
  fetcher: typeof fetch,
  now: number,
): Promise<CachedAccountModels> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Codex model discovery timed out", "TimeoutError")), MODEL_ROSTER_TIMEOUT_MS);
  try {
    const headers = new Headers({
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: "application/json",
    });
    if (credential.chatgptAccountId) headers.set("ChatGPT-Account-Id", credential.chatgptAccountId);
    const response = await fetcher(CODEX_MODELS_URL, {
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBoundedResponseBody(response, {
      signal: controller.signal,
      maxBytes: MODEL_ROSTER_MAX_BYTES,
      fatalUtf8: true,
    });
    const models = response.ok && body.displaySafe && !body.truncated
      ? parseAccountModels(body.text)
      : null;
    return {
      credentialIdentity: credential.credentialIdentity,
      expiresAt: now + (models ? MODEL_ROSTER_TTL_MS : MODEL_ROSTER_FAILURE_TTL_MS),
      models: models ?? new Set(),
      confirmed: models !== null,
    };
  } catch {
    return {
      credentialIdentity: credential.credentialIdentity,
      expiresAt: now + MODEL_ROSTER_FAILURE_TTL_MS,
      models: new Set(),
      confirmed: false,
    };
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
): Promise<CachedAccountModels> {
  const cached = accountModelsCache.get(credential.accountId);
  if (
    cached
    && cached.credentialIdentity === credential.credentialIdentity
    && cached.expiresAt > now
  ) return cached;

  const flightKey = `${credential.accountId}\u0000${credential.credentialIdentity}`;
  const existing = accountModelsFlights.get(flightKey);
  if (existing) return existing;
  const flight = fetchAccountModels(credential, fetcher, now)
    .then(result => {
      if (currentCredentialIdentity(credential.accountId) === credential.credentialIdentity) {
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
  const allowedAccountIds = candidateAccountIds(config)
    .filter(accountId => !options.excludeAccountIds?.has(accountId));
  const credentialSnapshot = options.credentialSnapshot ?? accountCredentialSnapshot;
  const credentials = options.credentials
    ? [...options.credentials].filter(credential => !options.excludeAccountIds?.has(credential.accountId))
    : (await Promise.all(allowedAccountIds.map(credentialSnapshot)))
      .filter((value): value is CodexModelEntitlementCredentialSnapshot => value !== null);
  const results = await Promise.all(credentials.map(async credential => ({
    credential,
    result: await modelsForCredential(credential, fetcher, now),
  })));
  const resolved = new Map(results.map(({ credential, result }) => [credential.accountId, result]));
  // Keyring-managed main auth has no credential snapshot for OpenCodex to read. Reuse a recent
  // live-request observation, or seed it from Codex's own non-synthetic authenticated cache.
  if (options.credentials === undefined
    && allowedAccountIds.includes(MAIN_CODEX_ACCOUNT_ID)
    && !resolved.has(MAIN_CODEX_ACCOUNT_ID)) {
    let cached = accountModelsCache.get(MAIN_CODEX_ACCOUNT_ID);
    if (!cached || cached.expiresAt <= now) {
      cached = options.nativeMainModels !== undefined
        ? options.nativeMainModels === null
          ? undefined
          : {
              credentialIdentity: "native-cache:test",
              expiresAt: now + MODEL_ROSTER_TTL_MS,
              models: new Set(options.nativeMainModels),
              confirmed: true,
            }
        : nativeCodexMainModelsCache(now) ?? undefined;
      if (cached) boundedCacheSet(MAIN_CODEX_ACCOUNT_ID, cached);
    }
    if (cached && cached.expiresAt > now) resolved.set(MAIN_CODEX_ACCOUNT_ID, cached);
  }
  return {
    modelsByAccount: new Map([...resolved].map(([accountId, result]) => [accountId, result.models])),
    confirmedAccountIds: new Set([...resolved].flatMap(([accountId, result]) => result.confirmed ? [accountId] : [])),
    credentialIdentities: new Map([...resolved].map(([accountId, result]) => [accountId, result.credentialIdentity])),
  };
}

/** Fail-closed entitlement check for a Direct request's own forwarded ChatGPT credential. */
export async function isDirectCallerEntitledToCodexModel(
  headers: Headers,
  modelId: string,
  options: Pick<CodexModelEntitlementResolveOptions, "fetcher" | "now"> = {},
): Promise<boolean> {
  if (!ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return true;
  const credential = directCallerCredential(headers);
  if (!credential) return false;
  const result = await modelsForCredential(
    credential,
    options.fetcher ?? fetch,
    options.now ?? Date.now(),
  );
  return result.confirmed && result.models.has(modelId);
}

/** Verify and remember the gated roster carried by a request-scoped keyring credential. */
export async function isRequestScopedMainCallerEntitledToCodexModel(
  headers: Headers,
  modelId: string,
  options: Pick<CodexModelEntitlementResolveOptions, "fetcher" | "now"> = {},
): Promise<boolean> {
  if (!ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return true;
  const credential = directCallerCredential(headers);
  if (!credential) return false;
  const result = await modelsForCredential(
    credential,
    options.fetcher ?? fetch,
    options.now ?? Date.now(),
  );
  if (result.confirmed) {
    boundedCacheSet(MAIN_CODEX_ACCOUNT_ID, {
      ...result,
      credentialIdentity: `caller:${credential.credentialIdentity.slice("direct:".length)}`,
    });
  }
  return result.confirmed && result.models.has(modelId);
}

export function entitledCodexAccountIdsForModel(
  snapshot: CodexModelEntitlementSnapshot,
  modelId: string | undefined,
): ReadonlySet<string> | undefined {
  if (!modelId || !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return undefined;
  return new Set([...snapshot.modelsByAccount].flatMap(([accountId, models]) => (
    snapshot.confirmedAccountIds.has(accountId) && models.has(modelId) ? [accountId] : []
  )));
}

export function availableAccountGatedNativeModels(
  snapshot: CodexModelEntitlementSnapshot,
  eligibleAccountIds?: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(modelId => (
    [...snapshot.modelsByAccount].some(([accountId, models]) => (
      (!eligibleAccountIds || eligibleAccountIds.has(accountId))
      && snapshot.confirmedAccountIds.has(accountId)
      && models.has(modelId)
    ))
  )));
}

/** Synchronous projection for management/catalog readers after a discovery pass. */
export function cachedAvailableAccountGatedNativeModels(
  now = Date.now(),
  eligibleAccountIds?: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(modelId => (
    [...accountModelsCache].some(([accountId, entry]) => (
      (!eligibleAccountIds || eligibleAccountIds.has(accountId))
      && !accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)
      && entry.confirmed
      && entry.expiresAt > now
      && entry.models.has(modelId)
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
  if (accountId) accountModelsCache.delete(accountId);
}

export function resetCodexModelEntitlementCacheForTests(): void {
  accountModelsCache.clear();
  accountModelsFlights.clear();
}

export function seedCodexModelEntitlementsForTests(
  accountId: string,
  models: readonly string[],
  now = Date.now(),
): void {
  boundedCacheSet(accountId, {
    credentialIdentity: `test:${accountId}`,
    expiresAt: now + MODEL_ROSTER_TTL_MS,
    models: new Set(models),
    confirmed: true,
  });
}
