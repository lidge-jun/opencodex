import { isCodexAccountGenerationLive } from "../account-store";
import { NATIVE_RESERVE_MODEL } from "../catalog/native-models";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { POOL_KEY_CODEX } from "../pool-rotation";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import type { OcxConfig } from "../../types";
import type { CodexCooldownSource } from "./cooldown-math";

export type CodexUpstreamHealth = {
  consecutiveFailures: number;
  /** Consecutive healthy terminals observed while recovering from escalation level 2+. */
  consecutiveSuccesses?: number;
  lastFailureStatus?: number;
  lastFailureAt?: number;
  /** Hard cooldown (quota 429). Survives a later 2xx; blocks auth + selection. */
  cooldownUntil?: number;
  /**
   * How long a quota refusal keeps selection away from this account (or this native quota
   * group), as opposed to how long it is hard-blocked.
   *
   * The two are deliberately different lengths. {@link CODEX_MAX_RESET_DERIVED_COOLDOWN_MS}
   * caps the hard cooldown at 15 minutes because a reset announcement is advisory and plan
   * quota usually frees up before it — an account must stay reachable so the pool can find
   * that out (#433). The window the refusal announced is not 15 minutes, though, so once the
   * cooldown lapses the account is selectable again while its burst window is still spent,
   * and the strategy picks it straight back: this proxy reads a weekly bar a burst limit never
   * touches, so a refused account still scores as the coolest in the pool. Every request then
   * earns the same 429 until the process restarts, which is the only thing that drops this map.
   *
   * So the announcement governs avoidance and the cap still governs blocking. Avoidance is soft
   * in the {@link softAvoidUntil} sense: it reorders the pool and releases a bound thread, and
   * the last-resort paths still reach the account when nothing else can serve, so one pessimistic
   * announcement cannot stall routing.
   */
  quotaAvoidUntil?: number;
  /** When the current cooldown was recorded; origin of the probe interval clock. */
  cooldownSince?: number;
  /**
   * What produced the cooldown. An explicit Retry-After is a literal retry
   * directive and is never probed; a quota resetAt only announces a window
   * refresh, so it may be probed early (#433).
   */
  cooldownSource?: CodexCooldownSource;
  /**
   * Bumped on every cooldown write. A probe lease records the generation it was
   * issued for so a lease cannot clear a cooldown that a later 429 replaced.
   */
  cooldownGeneration?: number;
  /**
   * Identity of the in-flight probe. A cooled-down account sends no traffic, so
   * no organic 2xx can prove recovery; only the outcome carrying this id may
   * clear the cooldown.
   */
  probeLeaseId?: string;
  /** Cooldown generation at the moment the lease was granted. */
  probeLeaseGeneration?: number;
  /** Last probe grant or conclusion; paces the probe interval. */
  lastProbeAt?: number;
  /**
   * Soft avoid after connect_error / timeout / transient 5xx. Cleared on 2xx.
   * Blocks pool selection + thread affinity reuse so a sticky session can leave a
   * flaky account without throwing CodexAccountCooldownError (hard-only).
   */
  softAvoidUntil?: number;
  /**
   * Credential generation a 401/403 quarantine was derived from (#2892 gap 4).
   *
   * Provenance lives ON the entry rather than in a side map keyed by account id. A side map spends
   * "whatever health is current when the old credential is found dead", which deletes a later
   * unrelated entry: a G1 401, then a G2 save, then a genuine G2 503 would lose the 503. Only the
   * entry that carries this field can be spent, and any later write simply replaces it.
   */
  credentialFailureGeneration?: number;
};

const upstreamHealth = new Map<string, CodexUpstreamHealth>();
/**
 * Reset-derived 429s can describe a quota owned by one native model family,
 * rather than the whole ChatGPT account. Keep those advisory cooldowns apart
 * from account-wide Retry-After/default throttles and transient health.
 */
const quotaScopedHealth = new Map<string, Map<CodexQuotaScope, CodexUpstreamHealth>>();
/**
 * Spend a credential-failure health entry whose credential no longer exists (#2892 gap 4).
 *
 * A 401/403 describes one CREDENTIAL, not an account, and a replacement can land at any point after
 * the outcome is recorded — so re-reading the store inside `recordCodexUpstreamOutcome` narrows the
 * window without closing it. The reader decides instead, and it may only spend an entry that
 * actually carries credential provenance: a later transient or quota write replaces the entry and
 * with it the tag, so this can never delete evidence that belongs to a different failure.
 */
export function dropSpentCredentialFailure(accountId: string): void {
  const health = upstreamHealth.get(accountId);
  const generation = health?.credentialFailureGeneration;
  if (health === undefined || generation === undefined) return;
  if (isCodexAccountGenerationLive(accountId, generation)) return;
  upstreamHealth.delete(accountId);
}
let lastReconciledGeneration = 0;
let liveHealthAccountIds = new Set<string>();

/**
 * Native Codex quota groups known to be independent upstream. Keep the mapping
 * deliberately conservative: unlisted models share the normal native group.
 * Add a new explicit group here only when its independent upstream quota is
 * confirmed, so shared limits never receive cross-model bypasses.
 */
export type CodexQuotaScope = "shared" | "reserve";


export const NATIVE_MODEL_QUOTA_SCOPES: Readonly<Record<string, CodexQuotaScope>> = {
  [NATIVE_RESERVE_MODEL]: "reserve",
};

export function codexQuotaScopeForModel(modelId: string | undefined): CodexQuotaScope | undefined {
  if (!modelId?.trim()) return undefined;
  return NATIVE_MODEL_QUOTA_SCOPES[modelId.trim().toLowerCase()] ?? "shared";
}

/** Independent quota groups must not mutate the shared active-account cursor. */
export function isIndependentCodexQuotaScope(quotaScope?: CodexQuotaScope): boolean {
  return quotaScope !== undefined && quotaScope !== "shared";
}

export function codexPoolKeyForScope(quotaScope?: CodexQuotaScope): string {
  return isIndependentCodexQuotaScope(quotaScope) ? `${POOL_KEY_CODEX}:${quotaScope}` : POOL_KEY_CODEX;
}

export function listLiveCodexAccountIds(config: OcxConfig): ReadonlySet<string> {
  const ids = new Set((config.codexAccounts ?? []).map(account => account.id));
  const openai = config.providers.openai;
  if (openai && openai.disabled !== true && isCanonicalOpenAiForwardProvider(openai)) {
    ids.add(MAIN_CODEX_ACCOUNT_ID);
  }
  return ids;
}

export function getCodexUpstreamHealth(
  accountId: string,
): CodexUpstreamHealth | null {
  dropSpentCredentialFailure(accountId);
  return upstreamHealth.get(accountId) ?? null;
}

export function scopedHealthFor(accountId: string, scope: CodexQuotaScope): CodexUpstreamHealth | undefined {
  return quotaScopedHealth.get(accountId)?.get(scope);
}

export function setScopedHealth(accountId: string, scope: CodexQuotaScope, health: CodexUpstreamHealth): void {
  let scopes = quotaScopedHealth.get(accountId);
  if (!scopes) {
    scopes = new Map();
    quotaScopedHealth.set(accountId, scopes);
  }
  scopes.set(scope, health);
}

export function deleteScopedHealth(accountId: string, scope: CodexQuotaScope): void {
  const scopes = quotaScopedHealth.get(accountId);
  if (!scopes) return;
  scopes.delete(scope);
  if (scopes.size === 0) quotaScopedHealth.delete(accountId);
}

/** Live quota-refusal avoidance for an account, including the lane the request belongs to. */
function codexQuotaAvoidUntil(
  accountId: string,
  quotaScope: CodexQuotaScope | undefined,
  now: number,
): number | null {
  const live = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > now ? value : null;
  const account = live(upstreamHealth.get(accountId)?.quotaAvoidUntil);
  const scoped = quotaScope === undefined
    ? null
    : live(scopedHealthFor(accountId, quotaScope)?.quotaAvoidUntil);
  if (account === null) return scoped;
  return scoped === null ? account : Math.max(account, scoped);
}

export function isCodexQuotaAvoided(
  accountId: string,
  quotaScope: CodexQuotaScope | undefined,
  now: number,
): boolean {
  return codexQuotaAvoidUntil(accountId, quotaScope, now) !== null;
}

/**
 * Hard-cooldown bookkeeping that ordinary success/transient transitions rebuild
 * their health object from. Dropping these would let one late unrelated response
 * erase a Retry-After source, a cooldown generation, or someone else's live probe.
 */
export function preservedCooldownFields(health: CodexUpstreamHealth | undefined): Partial<CodexUpstreamHealth> {
  if (!health) return {};
  // `credentialFailureGeneration` is provenance for ONE credential failure, so it must not survive
  // into a later transient or quota entry — otherwise that entry inherits the tag and gets spent
  // when the old credential dies, deleting evidence that was never about it (#2892 gap 4 review).
  const {
    consecutiveFailures: _f, consecutiveSuccesses: _s, lastFailureStatus: _st, lastFailureAt: _at,
    softAvoidUntil: _sa, credentialFailureGeneration: _cg, ...cooldownFields
  } = health;
  return cooldownFields;
}

export function getCodexAccountCooldownUntil(accountId: string, now = Date.now()): number | null {
  const cooldownUntil = upstreamHealth.get(accountId)?.cooldownUntil;
  return typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && cooldownUntil > now ? cooldownUntil : null;
}

/** Read-only cooldown snapshot for shared OAuth health projection (no write side effects). */
export function getCodexAccountHealthSnapshot(accountId: string, now = Date.now()): {
  cooldownUntil?: number;
  cooldownSource?: CodexCooldownSource;
} | null {
  const cooldownUntil = getCodexAccountCooldownUntil(accountId, now);
  if (cooldownUntil === null) return null;
  const source = upstreamHealth.get(accountId)?.cooldownSource;
  return {
    cooldownUntil,
    ...(source ? { cooldownSource: source } : {}),
  };
}

/**
 * Read the cooldown relevant to a routed native model. Account-wide cooldowns
 * (Retry-After/default) always win; reset-derived scoped state applies only to
 * its confirmed quota group.
 */
export function getCodexQuotaHealthSnapshot(
  accountId: string,
  quotaScope: CodexQuotaScope | undefined,
  now = Date.now(),
): {
  cooldownUntil?: number;
  cooldownSource?: CodexCooldownSource;
  quotaScope?: CodexQuotaScope;
} | null {
  const account = getCodexAccountHealthSnapshot(accountId, now);
  if (account) return account;
  if (!quotaScope) return null;
  const scoped = scopedHealthFor(accountId, quotaScope);
  const cooldownUntil = scoped?.cooldownUntil;
  if (typeof cooldownUntil !== "number" || !Number.isFinite(cooldownUntil) || cooldownUntil <= now) return null;
  return {
    cooldownUntil,
    ...(scoped?.cooldownSource ? { cooldownSource: scoped.cooldownSource } : {}),
    quotaScope,
  };
}

export function isCodexAccountInCooldown(accountId: string, now = Date.now()): boolean {
  return getCodexAccountCooldownUntil(accountId, now) !== null;
}

/**
 * Manually lift a hard quota cooldown without touching failure history.
 *
 * Injected Codex routing makes this proxy the ONLY model path for Codex Desktop, so a
 * cooldown that outlives the real upstream limit reads to the user as "the whole app is
 * broken" with no escape but editing config.toml. This is that escape hatch.
 *
 * Deliberately narrow:
 * - Failure counters and softAvoid survive. Clearing a cooldown says "the quota window
 *   moved", not "this account is healthy"; failover must keep its knowledge.
 * - Dropping `probeLeaseId` is what stops a stale in-flight probe from later "proving"
 *   recovery against a NEWER cooldown: {@link ownsProbeLease} needs the id to match.
 *   `cooldownGeneration` is preserved and bumped as redundancy only — a fresh 429 already
 *   bumps it in {@link recordCodexUpstreamOutcome}, so the bump here is not load-bearing
 *   today and is kept so the invariant survives a future change that retains the lease.
 *
 * Returns false when the account carried neither a live cooldown nor a live avoidance window.
 * The window outlives the cooldown by design — the cooldown caps at fifteen minutes and the
 * window runs up to six hours — so the moment an operator actually reaches for this escape
 * hatch is usually after the cooldown lapsed and only the window is still keeping the account
 * out of rotation. Refusing to look at the window then would leave the hatch shut in the one
 * case it exists for.
 */
export function clearCodexAccountCooldown(accountId: string, now = Date.now()): boolean {
  const clear = (health: CodexUpstreamHealth): CodexUpstreamHealth | null => {
    const cooldownUntil = health.cooldownUntil;
    const liveCooldown = typeof cooldownUntil === "number" && Number.isFinite(cooldownUntil) && cooldownUntil > now;
    const avoidUntil = health.quotaAvoidUntil;
    const liveAvoidance = typeof avoidUntil === "number" && Number.isFinite(avoidUntil) && avoidUntil > now;
    if (!liveCooldown && !liveAvoidance) return null;
    const {
      cooldownUntil: _until,
      cooldownSince: _since,
      cooldownSource: _source,
      probeLeaseId: _leaseId,
      probeLeaseGeneration: _leaseGeneration,
      // Same reasoning as the probe recovery above: "the quota window moved" is a statement
      // about the whole refusal, so the avoidance it announced goes with the block it
      // produced. Keeping it would leave this escape hatch not escaping, because selection
      // would still pass over the account for as long as the announced window runs.
      quotaAvoidUntil: _avoid,
      ...rest
    } = health;
    return {
      ...rest,
      cooldownGeneration: (health.cooldownGeneration ?? 0) + 1,
      lastProbeAt: now,
    };
  };

  let cleared = false;
  const accountHealth = upstreamHealth.get(accountId);
  if (accountHealth) {
    const next = clear(accountHealth);
    if (next) {
      upstreamHealth.set(accountId, next);
      cleared = true;
    }
  }
  for (const [scope, health] of quotaScopedHealth.get(accountId) ?? []) {
    const next = clear(health);
    if (next) {
      setScopedHealth(accountId, scope, next);
      cleared = true;
    }
  }
  return cleared;
}

export function getCodexAccountSoftAvoidUntil(accountId: string, now = Date.now()): number | null {
  const softAvoidUntil = upstreamHealth.get(accountId)?.softAvoidUntil;
  return typeof softAvoidUntil === "number" && Number.isFinite(softAvoidUntil) && softAvoidUntil > now
    ? softAvoidUntil
    : null;
}

export function isCodexAccountSoftAvoided(accountId: string, now = Date.now()): boolean {
  return getCodexAccountSoftAvoidUntil(accountId, now) !== null;
}

/**
 * Closed package-internal accessors for the account-wide health maps. Selection,
 * the probe lease, and the active cursor mutate health only through these; the
 * Map bindings themselves never leave this module.
 */
export function getAccountHealth(accountId: string): CodexUpstreamHealth | undefined {
  return upstreamHealth.get(accountId);
}

export function setAccountHealth(accountId: string, health: CodexUpstreamHealth): void {
  upstreamHealth.set(accountId, health);
}

export function deleteAccountHealth(accountId: string): void {
  upstreamHealth.delete(accountId);
}

export function carriesQuotaRefusal(health: CodexUpstreamHealth | undefined): boolean {
  return health?.lastFailureStatus === 429 || health?.lastFailureStatus === 402;
}

/**
 * Has this account refused a request on quota without serving one since?
 *
 * Thread affinity is a prompt-cache optimization and every rule around it is a preference:
 * `autoSwitchThreshold` is a hint that an account is getting busy, and `pool.cacheAffinity`
 * deliberately raises that bar further. A refusal is not a preference, and once the account has
 * told THIS thread it cannot serve, the binding has nothing left to optimize.
 *
 * The distinction matters because the cooldown a 429 writes is deliberately short. A reset
 * announcement is advisory — plan quota routinely frees up before the advertised instant — so
 * {@link CODEX_MAX_RESET_DERIVED_COOLDOWN_MS} caps it at 15 minutes. The five-hour window that
 * announcement describes is not capped, so an account whose burst window is spent looks
 * selectable again long before it is. For an unbound request that is correct: going back to find
 * out is how the pool learns the window moved. For a BOUND thread it is a loop with no exit —
 * the cooldown lapses, the account still scores lowest on the only window this proxy has a
 * reading for (its weekly bar, untouched by a burst limit), the thread rebinds, and earns the
 * identical 429. Cleared affinity does not help: the next request re-derives the same choice.
 * From the Codex side that reads exactly as reported — a new session rotates normally while an
 * existing one is locked to an exhausted account until the proxy is restarted, because a restart
 * is the only thing that drops the binding and the stale health together.
 *
 * `lastFailureStatus` is the right evidence because of when it ends: {@link preservedCooldownFields}
 * strips it from every recovery write, so it survives exactly until the account actually serves a
 * request again. Nothing here blocks that — selection is untouched, so unbound traffic still probes
 * the account and the first success releases every thread this refused.
 *
 * Scope follows where the refusal was recorded. An account-wide throttle lands in
 * `upstreamHealth` and releases every lane; a reset-derived refusal lands against one native
 * quota group, so a spent Spark window still cannot displace the same thread's Terra binding.
 */
export function hasUnrecoveredCodexQuotaRefusal(accountId: string, quotaScope?: CodexQuotaScope): boolean {
  if (carriesQuotaRefusal(getAccountHealth(accountId))) return true;
  return quotaScope !== undefined && carriesQuotaRefusal(scopedHealthFor(accountId, quotaScope));
}

export function listScopedHealthEntries(accountId: string): Array<[CodexQuotaScope, CodexUpstreamHealth]> {
  return [...(quotaScopedHealth.get(accountId) ?? [])];
}

export function deleteAllScopedHealth(accountId: string): void {
  quotaScopedHealth.delete(accountId);
}

export function isHealthAccountAdmissible(accountId: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveHealthAccountIds.has(accountId);
}

export function isHealthGenerationReconciled(generation: number): boolean {
  return generation <= lastReconciledGeneration;
}

export function pruneHealthAccountsForContext(codexAccountIds: ReadonlySet<string>): number {
  let removed = 0;
  for (const accountId of upstreamHealth.keys()) {
    if (codexAccountIds.has(accountId)) continue;
    upstreamHealth.delete(accountId);
    removed += 1;
  }
  for (const accountId of quotaScopedHealth.keys()) {
    if (codexAccountIds.has(accountId)) continue;
    quotaScopedHealth.delete(accountId);
    removed += 1;
  }
  return removed;
}

export function commitHealthReconcile(generation: number, codexAccountIds: ReadonlySet<string>): void {
  liveHealthAccountIds = new Set(codexAccountIds);
  lastReconciledGeneration = generation;
}

export function clearUpstreamHealthState(): void {
  upstreamHealth.clear();
  quotaScopedHealth.clear();
}

export function resetHealthReconcileState(): void {
  lastReconciledGeneration = 0;
  liveHealthAccountIds = new Set();
}

export function deleteAllHealthForAccount(accountId: string): void {
  upstreamHealth.delete(accountId);
  quotaScopedHealth.delete(accountId);
}
