import { createHmac, randomBytes } from "node:crypto";
import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  CodexCredentialRefreshBusyError,
  CodexCredentialRefreshStaleError,
  getValidCodexToken,
  isCodexAccountGenerationLive,
} from "./account-store";
import { isAccountNeedsReauth, markAccountNeedsReauth } from "./account-runtime-state";
import { isCodexAccountPaused } from "./account-pause";
import { ConfigMutationLockError } from "../config";
import { isCodexAccountUsable } from "./account-usability";
import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import { MAIN_CODEX_ACCOUNT_ID, getMainAccountToken, isMainAccountTokenLive } from "./main-account";
import { isNativeMainTrafficBlocked, nativeMainStartupGateSnapshot } from "./native-profile-startup";
import type { NativeMainStartupBlockReason } from "./native-profile-startup";
import {
  codexQuotaScopeForModel,
  getCodexQuotaHealthSnapshot,
  releaseCodexQuotaProbeLease,
  releaseCodexQuotaScopeProbeLease,
  tryAcquireCodexQuotaProbeLease,
  tryAcquireCodexQuotaScopeProbeLease,
  pickAlternateCodexAccount,
  resolveCodexAccountForThreadDetailed,
} from "./routing";
import {
  entitledCodexAccountIdsForModel,
  isDirectCallerEntitledToCodexModel,
  resolveCodexModelEntitlements,
  type CodexModelEntitlementSnapshot,
} from "./model-entitlements";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./catalog/native-models";
import type { CodexCooldownSource, CodexQuotaScope } from "./routing";
import { maskAccountId } from "../lib/privacy";
import { formatErrorResponse } from "../bridge";
import { getAccountQuota } from "./quota";
import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";

const CODEX_AFFINITY_COMPONENT_MAX_BYTES = 512;
const CODEX_APP_AFFINITY_KEY = randomBytes(32);

function boundedCodexAffinityComponent(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (retainedUtf8Bytes(normalized) > CODEX_AFFINITY_COMPONENT_MAX_BYTES) return undefined;
  return normalized;
}

/**
 * Preserve Codex's parent-thread affinity when present. Desktop App requests can omit that
 * header while retaining a stable session/thread pair, so derive an opaque process-local key
 * only from the complete bounded pair. Raw identifiers and durable hashes never enter Pool state.
 */
export function codexPoolAffinityKey(headers: Headers): string | undefined {
  const parentThreadId = boundedCodexAffinityComponent(headers.get("x-codex-parent-thread-id"));
  if (parentThreadId) return parentThreadId;

  const sessionId = boundedCodexAffinityComponent(headers.get("session-id"));
  const threadId = boundedCodexAffinityComponent(headers.get("thread-id"));
  if (!sessionId || !threadId) return undefined;

  return `app:${createHmac("sha256", CODEX_APP_AFFINITY_KEY)
    .update("opencodex-app-pool-affinity-v1\0")
    .update(sessionId)
    .update("\0")
    .update(threadId)
    .digest("base64url")}`;
}

export type CodexAuthContext =
  | { kind: "main"; accountId: null }
  | {
      kind: "pool";
      accountId: string;
      writerGeneration: number;
      generation: number;
      accessToken: string;
      chatgptAccountId: string;
      /** Bypass Pool selection and suppress quota/transient failover for an exact selector. */
      fixedAccount?: boolean;
      /** Pool binding key; the Desktop fallback is an opaque process-local HMAC. */
      affinityKey?: string;
      /**
       * Set when this request was admitted through an active quota cooldown as
       * the account's single probe. Must be echoed into the upstream outcome so
       * only this request can clear the cooldown (#433).
      */
      probeLeaseId?: string;
      /** Native model quota group selected for this request, when known. */
      quotaScope?: CodexQuotaScope;
      /** Scope that owns `probeLeaseId`, when it is a scoped recovery probe. */
      probeQuotaScope?: CodexQuotaScope;
    }
  | {
      // Main Codex account participating in rotation: token injected from ~/.codex/auth.json
      // (Option A). Distinct from "main" (passthrough fallback that forwards the client token).
      kind: "main-pool";
      accountId: string;
      writerGeneration: number;
      accessToken: string;
      chatgptAccountId: string;
      /** Bypass Pool selection and suppress quota/transient failover for an exact selector. */
      fixedAccount?: boolean;
      /** See `pool.affinityKey`. */
      affinityKey?: string;
      /** See `pool.probeLeaseId`. */
      probeLeaseId?: string;
      quotaScope?: CodexQuotaScope;
      probeQuotaScope?: CodexQuotaScope;
    };

/** Probe lease carried by this context, when it holds one. */
export function codexProbeLeaseId(ctx: CodexAuthContext | undefined): string | undefined {
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.probeLeaseId : undefined;
}

/** Scope of a lease carried by this context, when it probes a model-specific quota. */
export function codexProbeQuotaScope(ctx: CodexAuthContext | undefined): CodexQuotaScope | undefined {
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.probeQuotaScope : undefined;
}

/**
 * Hand back a probe lease for a request that will not reach upstream. Safe to
 * call with a context that holds no lease.
 */
export function releaseCodexAuthContextProbeLease(ctx: CodexAuthContext | undefined): void {
  const leaseId = codexProbeLeaseId(ctx);
  if (!ctx || ctx.kind === "main" || !leaseId) return;
  if (ctx.probeQuotaScope) releaseCodexQuotaScopeProbeLease(ctx.accountId!, ctx.probeQuotaScope, leaseId);
  else releaseCodexQuotaProbeLease(ctx.accountId!, leaseId);
}

export type OcxRuntimeProviderConfig = OcxProviderConfig & {
  _codexAccountOverride?: { accessToken: string; chatgptAccountId: string };
  _codexAccountRequired?: boolean;
};

export class CodexAuthContextError extends Error {
  accountId: string;

  constructor(accountId: string, cause: unknown) {
    super("Codex pool account auth failed", { cause });
    this.name = "CodexAuthContextError";
    this.accountId = accountId;
  }
}

export class CodexPoolAuthenticationError extends Error {
  constructor(message = "OpenAI account pool has no usable account credential") {
    super(message);
    this.name = "CodexPoolAuthenticationError";
  }
}

export const CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE =
  "OpenCodex local native-main profile maintenance is active; retry this request";

export class CodexMainProfileDrainingError extends Error {
  /**
   * Which startup-gate state fenced this request, when one did. Undefined means the
   * fence came from somewhere other than the startup gate — the turn-drain claim race
   * throws this same error while the gate reads `ready`, and inventing a reason there
   * would point the next report at a gate that never closed.
   *
   * Captured here rather than at the throw sites because this is the last moment it is
   * both in scope and still true: every catch site has already lost it, and re-reading
   * the gate later can observe a recovery that completed in between (#2108).
   */
  readonly reason?: NativeMainStartupBlockReason;

  constructor() {
    super(CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE);
    this.name = "CodexMainProfileDrainingError";
    const gate = nativeMainStartupGateSnapshot();
    if (gate.status !== "blocked") return;
    this.reason = gate.reason;
    reportNativeMainFenceReason(gate.reason);
  }
}

/**
 * #2108: a reboot could leave this fence closed until `ocx restart`, and the report was
 * unactionable because the settled reason was never written anywhere. It cannot ride the
 * message (claude-messages.ts matches that string exactly to keep the fence a 503 rather
 * than an Anthropic 529) and it cannot ride a header (/api/logs reads only error.message
 * from the body, and the Claude surface rebuilds its response headers from scratch), so
 * stdout is the one surface that covers every path this fence fires on.
 *
 * Deduped per distinct reason: the original report shows three 503s in eleven seconds and
 * a real client retries harder than that, so a per-request line would bury the signal.
 * Only the reason is emitted; the snapshot's homeId is derived from a profile directory.
 */
const reportedFenceReasons = new Set<NativeMainStartupBlockReason>();

function reportNativeMainFenceReason(reason: NativeMainStartupBlockReason): void {
  if (reportedFenceReasons.has(reason)) return;
  reportedFenceReasons.add(reason);
  console.warn(
    `native-main admission is fenced (reason: ${reason}); native model requests return 503 until it clears`,
  );
}

/**
 * Test-only reset for the dedup set above.
 *
 * The dedup is process-lifetime module state, so it is order-sensitive across test files
 * sharing one Bun process: whichever file constructs this error first consumes the one-shot
 * warn, and a later file asserting on it would see nothing and pass vacuously. Any test that
 * asserts on the warn must call this first — an `afterEach` in the asserting file is not
 * enough on its own, because the consuming file may not be the asserting one.
 */
export function __resetNativeMainFenceReasonLog(): void {
  reportedFenceReasons.clear();
}

export function codexMainProfileDrainingResponse(): Response {
  const response = formatErrorResponse(503, "server_busy", CODEX_MAIN_PROFILE_MAINTENANCE_MESSAGE);
  const headers = new Headers(response.headers);
  headers.set("Retry-After", "1");
  return new Response(response.body, { status: response.status, headers });
}

export class CodexDirectAuthenticationError extends Error {
  constructor() {
    super("Codex Direct requires a caller Authorization bearer token");
    this.name = "CodexDirectAuthenticationError";
  }
}

export function hasCallerCodexBearer(headers: Headers): boolean {
  return /^Bearer\s+\S+/i.test(headers.get("authorization")?.trim() ?? "");
}

export class CodexAccountCooldownError extends Error {
  accountId: string;
  cooldownUntil: number;
  cooldownSource?: CodexCooldownSource;
  quotaScope?: CodexQuotaScope;

  constructor(
    accountId: string,
    cooldownUntil: number,
    cooldownSource?: CodexCooldownSource,
    quotaScope?: CodexQuotaScope,
  ) {
    super("Selected Codex account is cooling down");
    this.name = "CodexAccountCooldownError";
    this.accountId = accountId;
    this.cooldownUntil = cooldownUntil;
    this.cooldownSource = cooldownSource;
    this.quotaScope = quotaScope;
  }
}

/**
 * Human-readable account label for a client-visible error. NEVER the raw id: the proxy
 * supports non-loopback binds (auth-cors.ts `isApiAuthRequired` requires a token there
 * rather than refusing), so data-plane bodies can reach remote authenticated clients.
 * The main login has no secret id, so it renders as the literal alias users type.
 */
export function cooldownAccountLabel(accountId: string): string {
  return accountId === MAIN_CODEX_ACCOUNT_ID ? "main" : maskAccountId(accountId) ?? "account-…????";
}

/**
 * Actionable message for a cooled-down account: until when, why, and how to escape.
 * Shared by every transport so the WebSocket surface (Codex Desktop) says the same thing
 * as HTTP. The bare "cooling down" string left users with no route but commenting out the
 * injected `openai_base_url` in config.toml.
 */
export function cooldownErrorMessage(err: CodexAccountCooldownError, accountSelector?: string): string {
  const until = new Date(err.cooldownUntil).toISOString();
  const scope = err.quotaScope === "spark"
    ? "Spark quota"
    : err.quotaScope === "shared"
      ? "shared native quota"
      : null;
  const selected = accountSelector
    ? `Selected Codex account selector (${accountSelector})`
    : `Selected Codex account (${cooldownAccountLabel(err.accountId)})`;
  const recovery = accountSelector
    ? " This request is pinned to that selector and will not switch accounts; choose another account-qualified model or retry later."
    : " Run 'ocx account list openai' to find the id, then"
      + " 'ocx account clear-cooldown openai <id>' to lift it, or switch accounts with 'ocx account use openai <id>'.";
  return `${selected}${scope ? ` ${scope} is` : " is"} cooling down until ${until}`
    + ` (source: ${err.cooldownSource ?? "default"}).${recovery}`;
}

/** HTTP form of {@link cooldownErrorMessage}, carrying Retry-After for well-behaved clients. */
export function cooldownErrorResponse(
  err: CodexAccountCooldownError,
  now = Date.now(),
  accountSelector?: string,
): Response {
  const res = formatErrorResponse(429, "rate_limit_error", cooldownErrorMessage(err, accountSelector));
  const headers = new Headers(res.headers);
  headers.set("Retry-After", String(Math.max(1, Math.ceil((err.cooldownUntil - now) / 1000))));
  return new Response(res.body, { status: res.status, headers });
}

export class CodexThreadAffinityExpiredError extends Error {
  accountId: string;

  constructor(accountId: string) {
    super("Codex thread account affinity expired");
    this.name = "CodexThreadAffinityExpiredError";
    this.accountId = accountId;
  }
}

export function shouldMarkAccountNeedsReauthForCodexAuthFailure(cause: unknown): boolean {
  return !(cause instanceof CodexCredentialGenerationConflictError)
    && !(cause instanceof CodexCredentialRefreshLockTimeoutError)
    && !(cause instanceof CodexCredentialRefreshBusyError)
    && !(cause instanceof CodexCredentialRefreshStaleError)
    && !(cause instanceof ConfigMutationLockError);
}

export interface ResolveCodexAuthContextOptions {
  excludeAccountId?: string;
  /** Resolve exactly this account without consulting or mutating Pool selection. */
  accountId?: string;
  /** Final native model selected for this request, used to select its quota group. */
  modelId?: string;
  /** Short reservation converted to turn ownership before native `__main__` token materialization. */
  beginCodexAccountSelection?: () => CodexAccountSelectionAdmission | undefined;
  /** Test-only native credential read seams. */
  isMainAccountTokenLive?: () => boolean;
  getMainAccountToken?: typeof getMainAccountToken;
  primeCodexPoolQuotas?: (config: OcxConfig, reason: string) => Promise<void>;
  /** Test seam for account-gated native model discovery. */
  resolveCodexModelEntitlements?: (
    config: Pick<OcxConfig, "codexAccounts">,
  ) => Promise<CodexModelEntitlementSnapshot>;
  /** Direct requests admitted with a proxy bearer substitute the stored native-main credential. */
  substituteMainCredentialForDirect?: boolean;
  /** Test seam for a Direct request's own forwarded ChatGPT credential. */
  isDirectCallerEntitledToCodexModel?: (headers: Headers, modelId: string) => Promise<boolean>;
}

export interface CodexAccountSelectionAdmission {
  readonly mainProfileDraining: boolean;
  claimMainProfile(): boolean;
  release(): void;
}

export async function resolveCodexAuthContext(
  headers: Headers,
  config: OcxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions = {},
): Promise<CodexAuthContext> {
  const writerGeneration = captureConfigGeneration();
  const fixedAccountId = options.accountId;
  if (fixedAccountId !== undefined && options.excludeAccountId !== undefined) {
    throw new Error("Codex auth context cannot select and exclude an account simultaneously");
  }
  // An explicit namespace binding is stronger than the provider's default mode. It must use the
  // selected stored credential even while the canonical OpenAI provider is globally Direct.
  if (mode === "direct" && fixedAccountId === undefined) {
    if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    if (options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)) {
      const entitled = options.substituteMainCredentialForDirect
        ? entitledCodexAccountIdsForModel(
            await (options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements)(config),
            options.modelId,
          )?.has(MAIN_CODEX_ACCOUNT_ID) === true
        : await (options.isDirectCallerEntitledToCodexModel ?? isDirectCallerEntitledToCodexModel)(
            headers,
            options.modelId,
          );
      if (!entitled) {
        throw new CodexPoolAuthenticationError("The selected ChatGPT account does not support this model");
      }
    }
    return { kind: "main", accountId: null };
  }
  const affinityKey = fixedAccountId === undefined ? codexPoolAffinityKey(headers) : undefined;
  const entitlementSnapshot = options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)
    ? await (options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements)(config)
    : undefined;
  const modelEligibleAccountIds = entitlementSnapshot
    ? entitledCodexAccountIdsForModel(entitlementSnapshot, options.modelId)
    : undefined;
  // Retained startup recovery makes the physical main identity ineligible. Routing
  // can still preserve service by selecting a healthy configured pool account.
  const nativeMainTrafficBlocked = isNativeMainTrafficBlocked();
  const selectionAdmission = options.beginCodexAccountSelection?.();
  const nativeMainReadsForbidden = nativeMainTrafficBlocked || selectionAdmission?.mainProfileDraining === true;
  const selectionOptions = {
    // Temporary switch drain keeps the candidate until the atomic claim rejects
    // it. Retained recovery makes main wholly ineligible so pool routing continues.
    nativeMainSelectionOnly: !nativeMainTrafficBlocked
      && selectionAdmission?.mainProfileDraining === true,
    isMainAccountTokenLive: options.isMainAccountTokenLive,
    modelEligibleAccountIds,
  };
  let accountId: string;
  const quotaScope = codexQuotaScopeForModel(options.modelId);
  try {
    // A pre-drain selector reserves the native identity while reconciliation and
    // routing inspect it. Selectors arriving after the fence skip reconciliation
    // and may still route to non-main pool accounts without touching switch state.
    if (!nativeMainReadsForbidden) reconcileMainCodexAccountRuntimeState();
    const resolution = fixedAccountId !== undefined
      ? { status: "selected" as const, accountId: fixedAccountId }
      : options.excludeAccountId
      ? (() => {
          const selected = pickAlternateCodexAccount(
            config,
            options.excludeAccountId!,
            Date.now(),
            quotaScope,
            selectionOptions,
          );
          return selected
            ? { status: "selected" as const, accountId: selected }
            : { status: "none" as const };
        })()
      : resolveCodexAccountForThreadDetailed(affinityKey ?? null, config, Date.now(), quotaScope, selectionOptions);
    if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
    const selected = resolution.status === "selected" ? resolution.accountId : null;
    if (!selected) {
      if (fixedAccountId !== undefined) {
        throw new CodexPoolAuthenticationError(
          modelEligibleAccountIds && !modelEligibleAccountIds.has(fixedAccountId)
            ? "Selected Codex account does not support this model"
            : "Selected Codex account is unavailable",
        );
      }
      // Recovery deliberately makes physical main ineligible. If no healthy
      // pool route is configured and main is the intended route, report the
      // temporary fence rather than misclassifying that credential as invalid.
      // A configured pool retry/exclusion that finds no alternate preserves its
      // ordinary pool-auth failure instead of being mislabeled as a main fence.
      if (nativeMainTrafficBlocked && !options.excludeAccountId) {
        throw new CodexMainProfileDrainingError();
      }
      throw new CodexPoolAuthenticationError(
        modelEligibleAccountIds ? "No eligible Codex account supports this model" : undefined,
      );
    }
    accountId = selected;
    if (accountId === MAIN_CODEX_ACCOUNT_ID && nativeMainTrafficBlocked) {
      throw new CodexMainProfileDrainingError();
    }
    if (
      accountId === MAIN_CODEX_ACCOUNT_ID
      && selectionAdmission
      && !selectionAdmission.claimMainProfile()
    ) {
      throw new CodexMainProfileDrainingError();
    }
    // Some legacy Pool fallbacks preserve a configured active account even when it is not
    // currently selectable, so token/cooldown code can produce the historical actionable error.
    // Model entitlement is different: sending the request would spend a turn on an account whose
    // authenticated roster already denied the model. Reassert this boundary after every selector.
    if (modelEligibleAccountIds && !modelEligibleAccountIds.has(accountId)) {
      throw new CodexPoolAuthenticationError(
        fixedAccountId !== undefined
          ? "Selected Codex account does not support this model"
          : "No eligible Codex account supports this model",
      );
    }
    if (fixedAccountId !== undefined) {
      if (isCodexAccountPaused(config, accountId)) {
        throw new CodexPoolAuthenticationError("Selected Codex account is unavailable");
      }
      if (isAccountNeedsReauth(accountId)) {
        throw new CodexPoolAuthenticationError("Selected Codex account needs reauthentication");
      }
      if (!isCodexAccountUsable(config, accountId, selectionOptions)) {
        throw new CodexPoolAuthenticationError("Selected Codex account is unavailable");
      }
    }
  } finally {
    selectionAdmission?.release();
  }
  // Lazy prime: if the selected account has no quota yet, the pool is likely
  // unprimed (dashboard never opened, or startup prime was blocked). Kick a
  // best-effort prime so the NEXT routing decision has real scores. This never
  // blocks the current request, and the helper's single-flight guard collapses
  // repeated triggers into one pass.
  if (fixedAccountId === undefined && !nativeMainReadsForbidden && !getAccountQuota(accountId)) {
    if (options.primeCodexPoolQuotas) {
      void options.primeCodexPoolQuotas(config, "pre-route").catch(() => {});
    } else {
      import("./auth-api")
        .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "pre-route"))
        .catch(() => {});
    }
  }
  // Snapshot (not just the deadline) so a refused request can report WHY it is cooled:
  // a literal Retry-After reads very differently to a user than a reset-derived guess.
  const cooldown = getCodexQuotaHealthSnapshot(accountId, quotaScope);
  const cooldownUntil = cooldown?.cooldownUntil;
  // A cooled-down account never sends traffic, so upstream recovery can never be
  // observed and the cooldown outlives the real limit. Admit one probe per
  // interval; its outcome decides whether the cooldown ends (#433).
  let probeLeaseId: string | undefined;
  let probeQuotaScope: CodexQuotaScope | undefined;
  if (cooldownUntil) {
    // Exact bindings are not Pool recovery traffic. Fail closed instead of consuming the Pool's
    // one probe lease or selecting another account.
    if (fixedAccountId !== undefined) {
      throw new CodexAccountCooldownError(accountId, cooldownUntil, cooldown?.cooldownSource, cooldown?.quotaScope);
    }
    probeQuotaScope = cooldown?.quotaScope;
    probeLeaseId = probeQuotaScope
      ? tryAcquireCodexQuotaScopeProbeLease(accountId, probeQuotaScope) ?? undefined
      : tryAcquireCodexQuotaProbeLease(accountId) ?? undefined;
    if (!probeLeaseId) {
      throw new CodexAccountCooldownError(accountId, cooldownUntil, cooldown?.cooldownSource, cooldown?.quotaScope);
    }
  }

  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // Main account in rotation: inject the read-only auth.json token and fail closed if it vanished.
    const token = (options.getMainAccountToken ?? getMainAccountToken)();
    if (!token) {
      // Nothing will reach upstream, so give the probe back instead of burning it.
      if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
      else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
      throw new CodexPoolAuthenticationError(
        fixedAccountId !== undefined ? "Selected Codex account is unavailable" : undefined,
      );
    }
    return {
      kind: "main-pool",
      accountId,
      writerGeneration,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      ...(fixedAccountId !== undefined ? { fixedAccount: true } : {}),
      ...(affinityKey ? { affinityKey } : {}),
      ...(quotaScope ? { quotaScope } : {}),
      ...(probeLeaseId ? { probeLeaseId } : {}),
      ...(probeQuotaScope ? { probeQuotaScope } : {}),
    };
  }

  try {
    const token = await getValidCodexToken(accountId);
    return {
      kind: "pool",
      accountId,
      writerGeneration,
      generation: token.generation,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      ...(fixedAccountId !== undefined ? { fixedAccount: true } : {}),
      ...(affinityKey ? { affinityKey } : {}),
      ...(quotaScope ? { quotaScope } : {}),
      ...(probeLeaseId ? { probeLeaseId } : {}),
      ...(probeQuotaScope ? { probeQuotaScope } : {}),
    };
  } catch (cause) {
    if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
    else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
    if (shouldMarkAccountNeedsReauthForCodexAuthFailure(cause)) {
      markAccountNeedsReauth(accountId, writerGeneration);
    }
    throw new CodexAuthContextError(accountId, cause);
  }
}

export function assertCodexAuthContextNotCooled(ctx: CodexAuthContext | undefined): void {
  if (ctx?.kind !== "pool" && ctx?.kind !== "main-pool") return;
  // A context holding the probe lease was deliberately admitted through the cooldown.
  if (ctx.probeLeaseId) return;
  const cooldown = getCodexQuotaHealthSnapshot(ctx.accountId, ctx.quotaScope);
  if (cooldown?.cooldownUntil) {
    throw new CodexAccountCooldownError(ctx.accountId, cooldown.cooldownUntil, cooldown.cooldownSource, cooldown.quotaScope);
  }
}

export function applyCodexAuthContextToProvider(
  provider: OcxProviderConfig,
  ctx: CodexAuthContext,
  mode: CodexAccountMode | undefined,
): OcxRuntimeProviderConfig {
  if (mode !== "pool" || (ctx.kind !== "pool" && ctx.kind !== "main-pool") || provider.authMode !== "forward") return provider;
  return {
    ...provider,
    _codexAccountOverride: {
      accessToken: ctx.accessToken,
      chatgptAccountId: ctx.chatgptAccountId,
    },
    _codexAccountRequired: true,
  };
}

export class CodexMainSubstitutionUnavailableError extends Error {
  constructor() {
    super("No usable Codex main credential to substitute for an admission bearer");
    this.name = "CodexMainSubstitutionUnavailableError";
  }
}

/**
 * Build the upstream auth headers for one Codex turn.
 *
 * The two credential domains meet here, and only here:
 *
 * - `pool` / `main-pool` always OVERWRITE with the stored account credential. Whatever the
 *   caller sent is irrelevant to what we send upstream.
 * - `main` with an admission-bearer caller (#1686) must substitute the stored main credential.
 *   The caller proved admission with one of OUR secrets, which must never leave the process, so
 *   the only two acceptable outcomes are replaced-with-stored-main or fail-before-any-IO.
 *   Silently forwarding would be the leak validateForwardAdmissionCredential exists to prevent.
 * - `main` with a dedicated-header caller keeps the existing intentional passthrough: the bearer
 *   there is the user's own ChatGPT credential, not ours.
 */
export function materializeCodexUpstreamAuth(
  headers: Headers,
  ctx: CodexAuthContext,
  options: { substituteMainCredential?: boolean } = {},
): Headers {
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value) selected.set(name, value);
  }
  if (ctx.kind === "pool" || ctx.kind === "main-pool") {
    selected.set("authorization", `Bearer ${ctx.accessToken}`);
    selected.set("chatgpt-account-id", ctx.chatgptAccountId);
    return selected;
  }
  if (ctx.kind === "main" && options.substituteMainCredential === true) {
    const stored = getMainAccountToken();
    // Fail BEFORE any upstream I/O. Falling through here would send the admission secret.
    if (!stored?.accessToken || !isMainAccountTokenLive()) {
      throw new CodexMainSubstitutionUnavailableError();
    }
    selected.set("authorization", `Bearer ${stored.accessToken}`);
    if (stored.chatgptAccountId) selected.set("chatgpt-account-id", stored.chatgptAccountId);
    return selected;
  }
  return selected;
}

/** @deprecated Prefer materializeCodexUpstreamAuth; kept for call sites without admission context. */
export function headersForCodexAuthContext(headers: Headers, ctx: CodexAuthContext): Headers {
  return materializeCodexUpstreamAuth(headers, ctx);
}

export function isCodexAuthContextUsable(ctx: CodexAuthContext, config: OcxConfig): boolean {
  if (ctx.kind === "main") return true;
  if (ctx.kind === "main-pool") return isCodexAccountUsable(config, ctx.accountId);
  return isCodexAccountUsable(config, ctx.accountId) && isCodexAccountGenerationLive(ctx.accountId, ctx.generation);
}

export function stripCodexRuntimeProviderFields(provider: OcxProviderConfig): OcxProviderConfig {
  const {
    _codexAccountOverride: _override,
    _codexAccountRequired: _required,
    ...safeProvider
  } = provider as OcxRuntimeProviderConfig;
  return safeProvider;
}
