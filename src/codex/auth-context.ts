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
import { ConfigMutationLockError } from "../config";
import { NativeProfileError } from "./native-profile-types";
import { isCodexAccountUsable } from "./account-usability";
import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import {
  MAIN_CODEX_ACCOUNT_ID,
  MainAccountTokenRefreshError,
  MainAuthJsonChangedDuringRefreshError,
  getMainAccountToken,
  getValidMainAccountToken,
  isMainAccountTokenLive,
  type NativeMainRefreshDependencies,
} from "./main-account";
import { isNativeMainTrafficBlocked, nativeMainStartupGateSnapshot } from "./native-profile-startup";
import type { NativeMainStartupBlockReason } from "./native-profile-startup";
import {
  codexQuotaScopeForModel,
  computeCodexUsageScore,
  getCodexQuotaHealthSnapshot,
  isEffectiveCodexAccountPinned,
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
} from "./model-entitlements";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS, NATIVE_RESERVE_MODEL } from "./catalog/native-models";
import type { CodexCooldownSource, CodexQuotaScope } from "./routing";
import { maskAccountId } from "../lib/privacy";
import { formatErrorResponse } from "../bridge";
import { CODEX_UNKNOWN_USAGE_SCORE, getAccountQuota, parseUsageQuota, parseMainPolicyUsageQuota, setAccountQuotaFromParsed } from "./quota";
import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { retainedUtf8Bytes } from "../lib/admission";
import { extractAccountId } from "../oauth/chatgpt";
import { getMainAccountHardLockStatus, isMainAccountHardLocked } from "./main-account-hard-lock";
import {
  captureMainAccountIdentityGeneration,
  captureMainQuotaWriter,
  getObservedMainQuotaIdentityKey,
  isMainQuotaWriterLive,
  matchesMainQuotaCredential,
  observeMainQuotaCredential,
  type MainQuotaWriter,
} from "./main-account-cache";
import { CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE, isCodexReserveHelperUnsupported, isCodexReserveRequestEligible } from "./loopback-target";
import type { DataPlaneAdmission } from "../server/auth-cors";
import { getMainReserveAuthorization, isMainReserveAuthorizationLive, type MainReserveAuthorization } from "./reserve-availability";
import { UpstreamRetryEvidenceError } from "../lib/upstream-retry";

const CODEX_AFFINITY_COMPONENT_MAX_BYTES = 512;
const CODEX_APP_AFFINITY_KEY = randomBytes(32);

/**
 * A request-owned bearer cannot inspect the physical main credential for its plan, but cached
 * WHAM usage is still valid routing evidence for the same logical main account. Score it with
 * the conservative unknown-plan rule: an unobserved governing window preserves the pin, while
 * any known weekly/monthly/short value at the threshold releases it through the ordinary Pool
 * path. This keeps the keyring boundary intact instead of reading auth.json just to classify a
 * request that already brought its own credential (#3157).
 */
function requestOwnedMainPinHasQuotaHeadroom(config: OcxConfig): boolean {
  const threshold = config.autoSwitchThreshold ?? 80;
  if (threshold <= 0) return true;
  const usage = computeCodexUsageScore(getAccountQuota(MAIN_CODEX_ACCOUNT_ID));
  return usage >= CODEX_UNKNOWN_USAGE_SCORE || usage < threshold;
}

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
  | { kind: "main"; accountId: null; reserveAuthorization?: MainReserveAuthorization }
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
      // (Option A). Distinct from "main" (request-owned passthrough or Direct mode).
      kind: "main-pool";
      accountId: string;
      writerGeneration: number;
      /** Captured before async credential work; never reconstructed after the upstream response. */
      mainQuotaWriter?: MainQuotaWriter;
      reserveAuthorization?: MainReserveAuthorization;
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

export class CodexMainAccountHardLockError extends CodexAccountCooldownError {
  readonly resetAt?: number;

  constructor(resetAt?: number) {
    super(MAIN_CODEX_ACCOUNT_ID, resetAt ?? 0);
    this.name = "CodexMainAccountHardLockError";
    this.resetAt = resetAt;
    this.message = "Codex main account is blocked by the 99% main-account quota policy."
      + " Choose another account, wait for quota to reset, or disable codexMainAccountHardLock in Settings.";
  }
}

export class CodexReserveUnavailableError extends CodexAccountCooldownError {
  constructor() {
    super(MAIN_CODEX_ACCOUNT_ID, 0);
    this.name = "CodexReserveUnavailableError";
    this.message = "Codex Reserve is unavailable for this main credential."
      + " Use the stored main login or its matching caller credential, and retry when OpenAI grants Reserve access."
      + " Reserve compatibility requires the effective local Desktop authless opt-in; it cannot switch accounts automatically.";
  }
}

/** A local unsupported-helper refusal; retain Reserve policy error mapping on delayed sends. */
export class CodexReserveHelperUnsupportedError extends CodexReserveUnavailableError {
  constructor() {
    super();
    this.name = "CodexReserveHelperUnsupportedError";
    this.message = CODEX_RESERVE_HELPER_UNSUPPORTED_MESSAGE;
  }
}

export type CodexAuthPolicyConfig = Readonly<Pick<OcxConfig,
  "codexMainAccountHardLock" | "codexDesktopAuthless" | "runtimeRole" | "pausedCodexAccountIds"
>>;

interface CodexAuthMaterializationOptions {
  substituteMainCredential?: boolean;
  config?: CodexAuthPolicyConfig;
  modelId?: string;
  /** Trusted receiving-listener admission; never inferred from request headers or config. */
  admission?: Pick<DataPlaneAdmission, "source">;
  signal?: AbortSignal;
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  beginCodexAccountSelection?: () => CodexAccountSelectionAdmission | undefined;
}

function requiresReserveAuthorization(
  config: CodexAuthPolicyConfig | undefined,
  modelId: string | undefined,
  admission: Pick<DataPlaneAdmission, "source"> | undefined,
): boolean {
  return modelId === NATIVE_RESERVE_MODEL && !!config && isCodexReserveRequestEligible(config, admission);
}

function assertReserveAdmission(config: CodexAuthPolicyConfig): void {
  if (config.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID) || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)) {
    throw new CodexReserveUnavailableError();
  }
  assertMainAccountPolicy(config);
  const cooldown = getCodexQuotaHealthSnapshot(MAIN_CODEX_ACCOUNT_ID, "reserve");
  if (cooldown?.cooldownUntil) {
    throw new CodexAccountCooldownError(MAIN_CODEX_ACCOUNT_ID, cooldown.cooldownUntil, cooldown.cooldownSource, cooldown.quotaScope);
  }
}

async function authorizeReserveCredential(
  token: { accessToken: string; chatgptAccountId: string },
  writer: MainQuotaWriter | undefined,
  config: CodexAuthPolicyConfig,
  signal?: AbortSignal,
  existing?: MainReserveAuthorization,
  writerGeneration = captureConfigGeneration(),
): Promise<MainReserveAuthorization> {
  assertReserveAdmission(config);
  if (!writer || !isMainQuotaWriterLive(writer)
    || !matchesMainQuotaCredential(token.accessToken, token.chatgptAccountId)) {
    throw new CodexReserveUnavailableError();
  }
  const authorization = isMainReserveAuthorizationLive(existing, token) ? existing
    : await getMainReserveAuthorization({
      token, writer, signal,
      observeOrdinaryQuota(data, capturedWriter) {
        setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, parseUsageQuota(data), writerGeneration,
          capturedWriter, parseMainPolicyUsageQuota(data));
      },
    });
  // The capability read also publishes ordinary quota. A new 99% reading or cooldown wins.
  assertReserveAdmission(config);
  if (signal?.aborted) throw signal.reason;
  if (!authorization || !isMainReserveAuthorizationLive(authorization, token)) throw new CodexReserveUnavailableError();
  return authorization;
}

function selectedCodexToken(headers: Headers): { accessToken: string; chatgptAccountId: string } {
  return {
    accessToken: headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "",
    chatgptAccountId: headers.get("chatgpt-account-id") ?? "",
  };
}

function assertMaterializedReserve(headers: Headers, ctx: CodexAuthContext, options: CodexAuthMaterializationOptions): void {
  if (!requiresReserveAuthorization(options.config, options.modelId, options.admission)) return;
  assertReserveAdmission(options.config!);
  if (ctx.kind === "pool" || !isMainReserveAuthorizationLive(ctx.reserveAuthorization, selectedCodexToken(headers))) {
    throw new CodexReserveUnavailableError();
  }
}

/** A dispatch never renews permission: the next request may obtain a fresh bounded proof. */
export function createCodexReserveDispatchGuard(
  ctx: CodexAuthContext,
  config: CodexAuthPolicyConfig,
  modelId: string,
  admission?: Pick<DataPlaneAdmission, "source">,
  terminalHelper = false,
): ((headers: Headers) => void) | undefined {
  // Snapshot the resolved source value, not the caller's mutable admission object. Config stays
  // live so policy changes remain visible after pacing and retry backoff.
  const source = admission?.source;
  if (modelId !== NATIVE_RESERVE_MODEL || source !== "loopback") return undefined;
  // Only immutable request facts decide whether to install the callback. Flag/role eligibility
  // is checked inside it, including an opt-in enabled while a send waits for pacing or WS open.
  const ingress = Object.freeze({ source });
  return headers => {
    if (isCodexReserveHelperUnsupported(config, modelId, ingress, terminalHelper)) {
      throw new CodexReserveHelperUnsupportedError();
    }
    assertMaterializedReserve(headers, ctx, { config, modelId, admission: ingress });
  };
}

/** Retry history must not turn a later local admission refusal into a network failure. */
export function unwrapUpstreamRetryEvidenceError(error: unknown): unknown {
  const seen = new Set<unknown>();
  while (error instanceof UpstreamRetryEvidenceError && !seen.has(error)) {
    seen.add(error);
    error = error.cause;
  }
  return error;
}

function assertMainAccountPolicy(config: Pick<OcxConfig, "codexMainAccountHardLock"> | undefined): void {
  if (!config) return;
  const status = getMainAccountHardLockStatus(config);
  if (status.state === "blocked") throw new CodexMainAccountHardLockError(status.resetAt);
}

/** No auth-file I/O: an unsigned claim alone never identifies a caller as stored main. */
function callerMatchesObservedMain(headers: Headers): boolean {
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return false;
  const effectiveAccountId = headers.get("chatgpt-account-id")
    ?? extractAccountId(undefined, bearer);
  return matchesMainQuotaCredential(bearer, effectiveAccountId);
}

function captureObservedMainWriter(): MainQuotaWriter | undefined {
  const identityKey = getObservedMainQuotaIdentityKey();
  return identityKey === undefined ? undefined : {
    identityKey,
    identityGeneration: captureMainAccountIdentityGeneration(),
  };
}

function observeSelectedMainCredential(
  token: { accessToken: string; chatgptAccountId: string },
  writer: MainQuotaWriter | undefined,
): MainQuotaWriter | undefined {
  if (!writer) return undefined;
  // Carry an explicitly stale writer through to quota's rejection fence; turning it into an
  // untagged write would instead invalidate the replacement account's trusted observation.
  if (!isMainQuotaWriterLive(writer)) return writer;
  const observed = observeMainQuotaCredential(token.accessToken, token.chatgptAccountId);
  return observed?.identityKey === writer.identityKey ? writer : undefined;
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
  if (err instanceof CodexMainAccountHardLockError || err instanceof CodexReserveUnavailableError) return err.message;
  const until = new Date(err.cooldownUntil).toISOString();
  const scopeLabels: Record<CodexQuotaScope, string> = {
    spark: "Spark quota", shared: "shared native quota", reserve: "Reserve quota",
  };
  const scope = err.quotaScope ? scopeLabels[err.quotaScope] : null;
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
  if (!(err instanceof CodexReserveUnavailableError)
    && (!(err instanceof CodexMainAccountHardLockError) || err.resetAt !== undefined)) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil((err.cooldownUntil - now) / 1000))));
  }
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
  return !(cause instanceof CodexMainAccountHardLockError)
    && !(cause instanceof CodexReserveUnavailableError)
    && !(cause instanceof CodexCredentialGenerationConflictError)
    && !(cause instanceof CodexCredentialRefreshLockTimeoutError)
    && !(cause instanceof CodexCredentialRefreshBusyError)
    && !(cause instanceof CodexCredentialRefreshStaleError)
    && !(cause instanceof MainAuthJsonChangedDuringRefreshError)
    && !(cause instanceof MainAccountTokenRefreshError && cause.reason === "transient")
    && !(cause instanceof NativeProfileError && cause.retryable)
    && !(cause instanceof DOMException && cause.name === "AbortError")
    && !(cause instanceof ConfigMutationLockError);
}

export interface ResolveCodexAuthContextOptions {
  admission?: Pick<DataPlaneAdmission, "source">;
  /** Live policy owner when the routing config is a caller-specific replay snapshot. */
  codexAuthPolicy?: CodexAuthPolicyConfig;
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
  getValidMainAccountToken?: typeof getValidMainAccountToken;
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  signal?: AbortSignal;
  primeCodexPoolQuotas?: (config: OcxConfig, reason: string) => Promise<void>;
  /** Test seam for account-gated native model discovery. */
  resolveCodexModelEntitlements?: typeof resolveCodexModelEntitlements;
  /** Direct requests admitted with a proxy bearer substitute the stored native-main credential. */
  substituteMainCredentialForDirect?: boolean;
  /** A validated native Codex bearer may serve this request without entering Pool state. */
  requestScopedMainCredential?: boolean;
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
  const policy = options.codexAuthPolicy ?? config;
  const requestScopedMainCredential = options.requestScopedMainCredential === true
    && hasCallerCodexBearer(headers);
  const reserve = requiresReserveAuthorization(policy, options.modelId, options.admission);
  if (reserve && (options.excludeAccountId !== undefined
    || (options.accountId !== undefined && options.accountId !== MAIN_CODEX_ACCOUNT_ID))) {
    throw new CodexReserveUnavailableError();
  }
  const fixedAccountId = reserve ? MAIN_CODEX_ACCOUNT_ID : options.accountId;
  const preserveRequestOwnedMainPin = requestScopedMainCredential
    && fixedAccountId === undefined
    && config.activeCodexAccountPinned === MAIN_CODEX_ACCOUNT_ID
    && isEffectiveCodexAccountPinned(config)
    && !policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID)
    && !(callerMatchesObservedMain(headers) && isMainAccountHardLocked(policy))
    && requestOwnedMainPinHasQuotaHeadroom(config);
  if (fixedAccountId !== undefined && options.excludeAccountId !== undefined) {
    throw new Error("Codex auth context cannot select and exclude an account simultaneously");
  }
  const resolveCallerOwnedMainContext = async (): Promise<CodexAuthContext> => {
    if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    const substituteStoredMain = options.substituteMainCredentialForDirect === true;
    if (!substituteStoredMain) {
      if (callerMatchesObservedMain(headers)) assertMainAccountPolicy(policy);
      if (reserve) {
        const selected = materializeCodexUpstreamAuth(headers, { kind: "main", accountId: null }, { config: policy });
        const token = selectedCodexToken(selected);
        const reserveAuthorization = await authorizeReserveCredential(token, captureMainQuotaWriter(token.chatgptAccountId),
          policy, options.signal, undefined, writerGeneration);
        return { kind: "main", accountId: null, reserveAuthorization };
      }
      if (options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)) {
        const entitled = await (
          options.isDirectCallerEntitledToCodexModel ?? isDirectCallerEntitledToCodexModel
        )(headers, options.modelId);
        if (!entitled) {
          throw new CodexPoolAuthenticationError("The selected ChatGPT account does not support this model");
        }
      }
      if (callerMatchesObservedMain(headers)) assertMainAccountPolicy(policy);
      return { kind: "main", accountId: null };
    }

    // Admission-bearer Direct requests later replace the proxy secret with the stored
    // native-main credential. Reserve and claim that physical profile before entitlement
    // discovery or materialization can read it; caller-owned Direct credentials never enter
    // this branch. A missing turn admission must fail closed instead of recreating an
    // untracked native-main read.
    if (isNativeMainTrafficBlocked()) throw new CodexMainProfileDrainingError();
    const directSelectionAdmission = options.beginCodexAccountSelection?.();
    if (!directSelectionAdmission) throw new CodexMainProfileDrainingError();
    try {
      if (
        directSelectionAdmission.mainProfileDraining
        || !directSelectionAdmission.claimMainProfile()
        || isNativeMainTrafficBlocked()
      ) {
        throw new CodexMainProfileDrainingError();
      }
      if (policy.codexMainAccountHardLock === true) reconcileMainCodexAccountRuntimeState();
      assertMainAccountPolicy(policy);
      if (options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)) {
        const entitled = entitledCodexAccountIdsForModel(
          await (options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements)(config, {
            signal: options.signal,
            nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
          }),
          options.modelId,
        )?.has(MAIN_CODEX_ACCOUNT_ID) === true;
        if (!entitled) {
          throw new CodexPoolAuthenticationError("The selected ChatGPT account does not support this model");
        }
      }
      assertMainAccountPolicy(policy);
      return { kind: "main", accountId: null };
    } finally {
      // The short selector reservation ends here. A successful claim remains owned by
      // the enclosing turn lease until the request or transferred stream settles.
      directSelectionAdmission.release();
    }
  };
  // Pool discovery excludes request-owned main credentials by design: they must never be folded
  // into stored-account entitlement, affinity, or persistence state. An effective manual main pin
  // is the one exception where that exclusion is selection evidence in the opposite direction.
  // Validate the caller's own gated-model roster before using it, and fall through to a Pool model
  // detour when it lacks the grant. This branch performs no physical-main credential read.
  if (preserveRequestOwnedMainPin) {
    const callerEntitled = !options.modelId
      || !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)
      || await (
        options.isDirectCallerEntitledToCodexModel ?? isDirectCallerEntitledToCodexModel
      )(headers, options.modelId);
    if (callerEntitled && !(callerMatchesObservedMain(headers) && isMainAccountHardLocked(policy))) {
      return { kind: "main", accountId: null };
    }
  }
  // An explicit namespace binding is stronger than the provider's default mode. It must use the
  // selected stored credential even while the canonical OpenAI provider is globally Direct.
  // A request-owned bearer is deliberately not represented as `main-pool`: Pool account ids own
  // durable health, quota, and affinity state, while this credential exists for one request only.
  if ((reserve && hasCallerCodexBearer(headers) && !options.substituteMainCredentialForDirect
      && (requestScopedMainCredential || mode === "direct"))
    || (mode === "direct" && fixedAccountId === undefined)
    || (requestScopedMainCredential && fixedAccountId === MAIN_CODEX_ACCOUNT_ID)) {
    return resolveCallerOwnedMainContext();
  }
  // A caller bearer can still accompany a request that selects a configured Pool account. Do not
  // let that request read, delete, or create a file-main affinity binding while deciding whether a
  // stored account is available; only the stored credential selected below may own Pool state.
  const affinityKey = fixedAccountId === undefined && !requestScopedMainCredential
    ? codexPoolAffinityKey(headers)
    : undefined;
  // Retained startup recovery makes the physical main identity ineligible. Routing
  // can still preserve service by selecting a healthy configured pool account. A
  // request-owned bearer likewise cannot inspect or reconcile file-main state.
  const nativeMainTrafficBlocked = isNativeMainTrafficBlocked();
  const selectionAdmission = options.beginCodexAccountSelection?.();
  const nativeMainReadsForbidden = requestScopedMainCredential
    || nativeMainTrafficBlocked
    || selectionAdmission?.mainProfileDraining === true;
  const nativeMainSelectionOnly = !nativeMainTrafficBlocked
    && selectionAdmission?.mainProfileDraining === true;
  let accountId: string;
  const quotaScope = codexQuotaScopeForModel(options.modelId);
  try {
    const excludeAccountIds = nativeMainReadsForbidden
      ? new Set([MAIN_CODEX_ACCOUNT_ID])
      : undefined;
    const mainModelGrantUnobserved = excludeAccountIds?.has(MAIN_CODEX_ACCOUNT_ID) === true;
    const entitlementSnapshot = options.modelId && ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(options.modelId)
      ? await (options.resolveCodexModelEntitlements ?? resolveCodexModelEntitlements)(config, {
        excludeAccountIds,
        signal: options.signal,
        nativeMainRefreshDependencies: options.nativeMainRefreshDependencies,
      })
      : undefined;
    const entitledAccountIds = entitlementSnapshot
      ? entitledCodexAccountIdsForModel(entitlementSnapshot, options.modelId)
      : undefined;
    const modelEligibleAccountIds = entitledAccountIds
      ? new Set([...entitledAccountIds].filter(candidate => !excludeAccountIds?.has(candidate)))
      : undefined;
    const selectionOptions = {
      // Temporary switch drain keeps the candidate until the atomic claim rejects
      // it. Retained recovery makes main wholly ineligible so pool routing continues.
      nativeMainSelectionOnly,
      isMainAccountTokenLive: requestScopedMainCredential
        // Main stays excluded from this request's model roster below. This synthetic liveness is
        // consulted only by shared-state preservation, so a caller-owned pin survives a model
        // detour without reading or selecting the physical main credential.
        ? () => preserveRequestOwnedMainPin
        : options.isMainAccountTokenLive,
      modelEligibleAccountIds,
    };
    // A pre-drain selector reserves the native identity while reconciliation and
    // routing inspect it. Selectors arriving after the fence skip reconciliation
    // and may still route to non-main pool accounts without touching switch state.
    if (reserve && !nativeMainReadsForbidden && !selectionAdmission) throw new CodexMainProfileDrainingError();
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
      : resolveCodexAccountForThreadDetailed(
          affinityKey ?? null,
          config,
          Date.now(),
          quotaScope,
          selectionOptions,
          options.modelId,
        );
    if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
    const selected = resolution.status === "selected" ? resolution.accountId : null;
    if (!selected) {
      // A retry that excluded a failed Pool account may still use the validated caller-owned
      // main credential. Treating every exclusion as if main itself had failed strands a healthy
      // native bearer after the first Pool attempt. Preserve the exactly-once boundary by refusing
      // this fallback only when the excluded credential is main.
      if (
        requestScopedMainCredential
        && fixedAccountId === undefined
        && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
      ) {
        return await resolveCallerOwnedMainContext();
      }
      if (fixedAccountId !== undefined) {
        throw new CodexPoolAuthenticationError(
          modelEligibleAccountIds && !modelEligibleAccountIds.has(fixedAccountId)
            ? "Selected Codex account does not support this model"
            : "Selected Codex account is unavailable",
        );
      }
      // Recovery or a turn drain deliberately makes physical main unobservable.
      // If no healthy pool route is available, report the temporary fence rather
      // than turning a credential we were forbidden to inspect into a permanent
      // model-entitlement denial.
      // A configured pool retry/exclusion that finds no alternate preserves its
      // ordinary pool-auth failure instead of being mislabeled as a main fence.
      if (nativeMainReadsForbidden && !options.excludeAccountId) {
        throw new CodexMainProfileDrainingError();
      }
      if (!nativeMainReadsForbidden && options.excludeAccountId !== MAIN_CODEX_ACCOUNT_ID
        && !policy.pausedCodexAccountIds?.includes(MAIN_CODEX_ACCOUNT_ID)
        && (!modelEligibleAccountIds || modelEligibleAccountIds.has(MAIN_CODEX_ACCOUNT_ID))) {
        assertMainAccountPolicy(policy);
      }
      throw new CodexPoolAuthenticationError(
        modelEligibleAccountIds === undefined
          ? undefined
          : entitledAccountIds?.size === 0 && !mainModelGrantUnobserved
          ? "No eligible Codex account supports this model"
          : "Codex accounts that support this model are currently unavailable",
      );
    }
    accountId = selected;
    if (accountId === MAIN_CODEX_ACCOUNT_ID) assertMainAccountPolicy(policy);
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
      if (policy.pausedCodexAccountIds?.includes(accountId)) {
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
    // Main account in rotation: refresh auth.json before upstream I/O and fail closed if it vanished.
    let token: { accessToken: string; chatgptAccountId: string } | null;
    let mainQuotaWriter = captureObservedMainWriter();
    try {
      token = await (options.getValidMainAccountToken ?? getValidMainAccountToken)({
        signal: options.signal,
        ...(options.nativeMainRefreshDependencies ?? {}),
      });
      if (token) mainQuotaWriter = observeSelectedMainCredential(token, mainQuotaWriter);
      assertMainAccountPolicy(policy);
    } catch (cause) {
      if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
      else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
      if (cause instanceof CodexMainAccountHardLockError) throw cause;
      if (!options.signal?.aborted && shouldMarkAccountNeedsReauthForCodexAuthFailure(cause)) {
        markAccountNeedsReauth(accountId, writerGeneration);
      }
      throw new CodexAuthContextError(accountId, cause);
    }
    if (!token) {
      // Nothing will reach upstream, so give the probe back instead of burning it.
      if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
      else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
      throw new CodexPoolAuthenticationError(
        fixedAccountId !== undefined ? "Selected Codex account is unavailable" : undefined,
      );
    }
    const reserveAuthorization = reserve
      ? await authorizeReserveCredential(token, mainQuotaWriter, policy, options.signal, undefined, writerGeneration)
      : undefined;
    return {
      kind: "main-pool",
      accountId,
      writerGeneration,
      mainQuotaWriter,
      ...(reserveAuthorization ? { reserveAuthorization } : {}),
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
    if (!options.signal?.aborted && shouldMarkAccountNeedsReauthForCodexAuthFailure(cause)) {
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
  options: CodexAuthMaterializationOptions = {},
): Headers {
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value) selected.set(name, value);
  }
  if (ctx.kind === "pool" || ctx.kind === "main-pool") {
    selected.set("authorization", `Bearer ${ctx.accessToken}`);
    selected.set("chatgpt-account-id", ctx.chatgptAccountId);
    if (ctx.kind === "main-pool") {
      ctx.mainQuotaWriter = observeSelectedMainCredential(ctx, ctx.mainQuotaWriter);
      assertMainAccountPolicy(options.config);
    }
    assertMaterializedReserve(selected, ctx, options);
    return selected;
  }
  if (ctx.kind === "main" && options.substituteMainCredential !== true
    && !selected.has("chatgpt-account-id")) {
    const bearer = selected.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
    const accountId = bearer ? extractAccountId(undefined, bearer) : undefined;
    if (accountId) selected.set("chatgpt-account-id", accountId);
  }
  if (ctx.kind === "main" && options.substituteMainCredential === true) {
    if (options.config?.codexMainAccountHardLock === true) reconcileMainCodexAccountRuntimeState();
    const writer = captureObservedMainWriter();
    const stored = getMainAccountToken();
    // Fail BEFORE any upstream I/O. Falling through here would send the admission secret.
    if (!stored?.accessToken || !isMainAccountTokenLive()) {
      throw new CodexMainSubstitutionUnavailableError();
    }
    selected.set("authorization", `Bearer ${stored.accessToken}`);
    if (stored.chatgptAccountId) selected.set("chatgpt-account-id", stored.chatgptAccountId);
    observeSelectedMainCredential(stored, writer);
    assertMainAccountPolicy(options.config);
    assertMaterializedReserve(selected, ctx, options);
    return selected;
  }
  if (callerMatchesObservedMain(selected)) assertMainAccountPolicy(options.config);
  assertMaterializedReserve(selected, ctx, options);
  return selected;
}

/** The model producer, not an optional context marker, decides whether a grant is required. */
async function materializeReserveUpstreamAuth(
  headers: Headers,
  ctx: CodexAuthContext,
  options: CodexAuthMaterializationOptions,
): Promise<Headers> {
  if (ctx.kind === "pool") throw new CodexReserveUnavailableError();
  const config = options.config!;
  assertReserveAdmission(config);
  const writerGeneration = ctx.kind === "main-pool" ? ctx.writerGeneration : captureConfigGeneration();
  const storedMain = ctx.kind === "main"
    && (options.substituteMainCredential === true || !hasCallerCodexBearer(headers));
  let admission: CodexAccountSelectionAdmission | undefined;
  let writer = ctx.kind === "main-pool" ? ctx.mainQuotaWriter : undefined;
  try {
    if (storedMain) {
      if (isNativeMainTrafficBlocked()) throw new CodexMainProfileDrainingError();
      admission = options.beginCodexAccountSelection?.();
      if (!admission || admission.mainProfileDraining || !admission.claimMainProfile() || isNativeMainTrafficBlocked()) {
        throw new CodexMainProfileDrainingError();
      }
      reconcileMainCodexAccountRuntimeState();
      writer = captureObservedMainWriter();
      assertReserveAdmission(config);
    }
    // Build the real credential first, without recursively requiring a not-yet-fetched proof.
    // The ordinary hard lock remains enabled, including the post-refresh check.
    const selected = await materializeCodexUpstreamAuthAsync(headers, ctx, {
      ...options, modelId: undefined, substituteMainCredential: storedMain,
    });
    const token = selectedCodexToken(selected);
    if (ctx.kind === "main-pool") writer = ctx.mainQuotaWriter;
    else if (!storedMain) writer = captureMainQuotaWriter(token.chatgptAccountId);
    ctx.reserveAuthorization = await authorizeReserveCredential(token, writer, config, options.signal,
      ctx.reserveAuthorization, writerGeneration);
    assertMaterializedReserve(selected, ctx, options);
    return selected;
  } finally {
    admission?.release();
  }
}

export async function materializeCodexUpstreamAuthAsync(
  headers: Headers,
  ctx: CodexAuthContext,
  options: CodexAuthMaterializationOptions = {},
): Promise<Headers> {
  if (requiresReserveAuthorization(options.config, options.modelId, options.admission)) {
    return materializeReserveUpstreamAuth(headers, ctx, options);
  }
  if (ctx.kind !== "main" || options.substituteMainCredential !== true) {
    return materializeCodexUpstreamAuth(headers, ctx, options);
  }
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value) selected.set(name, value);
  }
  if (options.config?.codexMainAccountHardLock === true) reconcileMainCodexAccountRuntimeState();
  const writer = captureObservedMainWriter();
  const stored = await getValidMainAccountToken({
    signal: options.signal,
    ...(options.nativeMainRefreshDependencies ?? {}),
  });
  if (!stored?.accessToken) throw new CodexMainSubstitutionUnavailableError();
  selected.set("authorization", `Bearer ${stored.accessToken}`);
  if (stored.chatgptAccountId) selected.set("chatgpt-account-id", stored.chatgptAccountId);
  observeSelectedMainCredential(stored, writer);
  assertMainAccountPolicy(options.config);
  // An opt-in enabled during token refresh must not turn a proof-less context into Reserve.
  assertMaterializedReserve(selected, ctx, options);
  return selected;
}

/** @deprecated Prefer materializeCodexUpstreamAuth; kept for call sites without admission context. */
export function headersForCodexAuthContext(
  headers: Headers,
  ctx: CodexAuthContext,
  config?: CodexAuthPolicyConfig,
  modelId?: string,
  admission?: Pick<DataPlaneAdmission, "source">,
): Headers {
  return materializeCodexUpstreamAuth(headers, ctx, { config, modelId, admission });
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
