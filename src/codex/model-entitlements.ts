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
  return /^\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?$/.test(trimmed);
}

/**
 * Version authority, in precedence order:
 *
 * 1. the inbound request's own `client_version` — the only value certainly describing the
 *    client being answered;
 * 2. the selected Codex runtime version, for background sync where no request exists.
 *    Retained sync refreshes runtime evidence before discovery, which is what makes this
 *    usable here; the persisted file itself carries no freshness guarantee.
 *
 * Neither available means the roster is not requested at all. Unconfirmed already suppresses
 * the gated rows and routing already rejects them, so failing closed on ABSENT evidence is
 * the existing contract; failing closed on INVENTED evidence was the bug.
 */
export function resolveCodexEntitlementClientVersion(
  inbound?: string | null,
  loadRuntime: () => { selectedVersion?: string | null } | null = loadPersistedCodexRuntime,
): string | null {
  if (isUsableCodexClientVersion(inbound)) return inbound.trim();
  let persisted: { selectedVersion?: string | null } | null = null;
  try {
    persisted = loadRuntime();
  } catch {
    persisted = null;
  }
  const selected = persisted?.selectedVersion;
  return isUsableCodexClientVersion(selected) ? selected.trim() : null;
}
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
  /**
   * Client version this roster was fetched under. Upstream filters by it, so a roster is
   * only an answer for that version — an entry fetched under one must never satisfy a read
   * for another (#2886).
   */
  readonly clientVersion: string;
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
      clientVersion,
      expiresAt: now + (models ? MODEL_ROSTER_TTL_MS : MODEL_ROSTER_FAILURE_TTL_MS),
      models: models ?? new Set(),
      confirmed: models !== null,
    };
  } catch {
    return {
      credentialIdentity: credential.credentialIdentity,
      clientVersion,
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
  clientVersion: string,
): Promise<CachedAccountModels> {
  const cached = accountModelsCache.get(credential.accountId);
  if (
    cached
    && cached.credentialIdentity === credential.credentialIdentity
    // Upstream filters by client version, so a roster fetched under a different one is a
    // different question's answer and must not be reused.
    && cached.clientVersion === clientVersion
    && cached.expiresAt > now
  ) return cached;

  const flightKey = `${credential.accountId}\u0000${credential.credentialIdentity}\u0000${clientVersion}`;
  const existing = accountModelsFlights.get(flightKey);
  if (existing) return existing;
  const flight = fetchAccountModels(credential, fetcher, now, clientVersion)
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
  // No trustworthy client version means the roster cannot be asked for meaningfully.
  // Report every account as UNCONFIRMED rather than fetching under a placeholder that
  // upstream would answer with an empty or truncated roster (#2886).
  if (clientVersion === null) {
    return {
      modelsByAccount: new Map(credentials.map(credential => [credential.accountId, new Set<string>()])),
      confirmedAccountIds: new Set<string>(),
      credentialIdentities: new Map(credentials.map(credential => [credential.accountId, credential.credentialIdentity])),
    };
  }
  const results = await Promise.all(credentials.map(async credential => ({
    credential,
    result: await modelsForCredential(credential, fetcher, now, clientVersion),
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
  options: Pick<CodexModelEntitlementResolveOptions, "fetcher" | "now" | "clientVersion"> = {},
): Promise<boolean> {
  if (!ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(modelId)) return true;
  const credential = directCallerCredential(headers);
  if (!credential) return false;
  const clientVersion = resolveCodexEntitlementClientVersion(options.clientVersion);
  // Fail closed on absent evidence, exactly as an unconfirmed roster does.
  if (clientVersion === null) return false;
  const result = await modelsForCredential(
    credential,
    options.fetcher ?? fetch,
    options.now ?? Date.now(),
    clientVersion,
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
      (!eligibleAccountIds || eligibleAccountIds.has(accountId))
      && !accountId.startsWith(DIRECT_CALLER_ACCOUNT_PREFIX)
      && (version === null || entry.clientVersion === version)
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
  clientVersion = "0.146.0",
): void {
  boundedCacheSet(accountId, {
    credentialIdentity: `test:${accountId}`,
    clientVersion,
    expiresAt: now + MODEL_ROSTER_TTL_MS,
    models: new Set(models),
    confirmed: true,
  });
}
