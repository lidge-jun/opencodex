import { createHash } from "node:crypto";
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { OcxConfig } from "../types";
import { isSelectableCodexPoolAccount } from "./account-id";
import { getValidCodexToken, readCodexAccountRecord } from "./account-store";
import { getMainAccountToken, MAIN_CODEX_ACCOUNT_ID } from "./main-account";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./catalog/native-models";

const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.0.0";
const MODEL_ROSTER_TTL_MS = 5 * 60_000;
const MODEL_ROSTER_FAILURE_TTL_MS = 15_000;
const MODEL_ROSTER_TIMEOUT_MS = 8_000;
const MODEL_ROSTER_MAX_BYTES = 2 * 1024 * 1024;
const MODEL_ROSTER_CACHE_MAX = 64;
const DIRECT_CALLER_ACCOUNT_PREFIX = "__direct_codex__:";

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
    return token ? `main:${token.chatgptAccountId}` : undefined;
  }
  const record = readCodexAccountRecord(accountId);
  if (!record?.credential || record.deletedAt != null) return undefined;
  return `pool:${record.generation}:${record.credential.chatgptAccountId}`;
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
  const credentials = options.credentials
    ? [...options.credentials]
    : (await Promise.all(candidateAccountIds(config).map(accountCredentialSnapshot)))
      .filter((value): value is CodexModelEntitlementCredentialSnapshot => value !== null);
  const results = await Promise.all(credentials.map(async credential => ({
    credential,
    result: await modelsForCredential(credential, fetcher, now),
  })));
  return {
    modelsByAccount: new Map(results.map(({ credential, result }) => [credential.accountId, result.models])),
    confirmedAccountIds: new Set(results.flatMap(({ credential, result }) => result.confirmed ? [credential.accountId] : [])),
    credentialIdentities: new Map(results.map(({ credential }) => [credential.accountId, credential.credentialIdentity])),
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
