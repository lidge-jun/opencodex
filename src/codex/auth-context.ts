import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  getValidCodexToken,
  isCodexAccountGenerationLive,
} from "./account-store";
import { markAccountNeedsReauth } from "./account-runtime-state";
import { isCodexAccountUsable } from "./account-usability";
import { reconcileMainCodexAccountRuntimeState } from "./account-lifecycle";
import { MAIN_CODEX_ACCOUNT_ID, getMainAccountToken } from "./main-account";
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
import type { CodexCooldownSource, CodexQuotaScope } from "./routing";
import { maskAccountId } from "../lib/privacy";
import { formatErrorResponse } from "../bridge";
import { getAccountQuota } from "./quota";
import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";

export type CodexAuthContext =
  | { kind: "main"; accountId: null }
  | {
      kind: "pool";
      accountId: string;
      generation: number;
      accessToken: string;
      chatgptAccountId: string;
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
      accessToken: string;
      chatgptAccountId: string;
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
  constructor() {
    super("OpenAI account pool has no usable account credential");
    this.name = "CodexPoolAuthenticationError";
  }
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
export function cooldownErrorMessage(err: CodexAccountCooldownError): string {
  const until = new Date(err.cooldownUntil).toISOString();
  const scope = err.quotaScope === "spark"
    ? "Spark quota"
    : err.quotaScope === "shared"
      ? "shared native quota"
      : null;
  return `Selected Codex account (${cooldownAccountLabel(err.accountId)})${scope ? ` ${scope} is` : " is"} cooling down until ${until}`
    + ` (source: ${err.cooldownSource ?? "default"}).`
    + ` Run 'ocx account list openai' to find the id, then`
    + ` 'ocx account clear-cooldown openai <id>' to lift it, or switch accounts with 'ocx account use openai <id>'.`;
}

/** HTTP form of {@link cooldownErrorMessage}, carrying Retry-After for well-behaved clients. */
export function cooldownErrorResponse(err: CodexAccountCooldownError, now = Date.now()): Response {
  const res = formatErrorResponse(429, "rate_limit_error", cooldownErrorMessage(err));
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
  return !(cause instanceof CodexCredentialGenerationConflictError) && !(cause instanceof CodexCredentialRefreshLockTimeoutError);
}

export interface ResolveCodexAuthContextOptions {
  excludeAccountId?: string;
  /** Final native model selected for this request, used to select its quota group. */
  modelId?: string;
}

export async function resolveCodexAuthContext(
  headers: Headers,
  config: OcxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions = {},
): Promise<CodexAuthContext> {
  if (mode === "direct") {
    if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    return { kind: "main", accountId: null };
  }
  reconcileMainCodexAccountRuntimeState();
  const threadId = headers.get("x-codex-parent-thread-id");
  const quotaScope = codexQuotaScopeForModel(options.modelId);
  const resolution = options.excludeAccountId
    ? (() => {
        const accountId = pickAlternateCodexAccount(config, options.excludeAccountId!, Date.now(), quotaScope);
        return accountId
          ? { status: "selected" as const, accountId }
          : { status: "none" as const };
      })()
    : resolveCodexAccountForThreadDetailed(threadId, config, Date.now(), quotaScope);
  if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
  let accountId = resolution.status === "selected" ? resolution.accountId : null;
  if (!accountId) throw new CodexPoolAuthenticationError();
  // Lazy prime: if the selected account has no quota yet, the pool is likely
  // unprimed (dashboard never opened, or startup prime was blocked). Kick a
  // best-effort prime so the NEXT routing decision has real scores. This never
  // blocks the current request, and the helper's single-flight guard collapses
  // repeated triggers into one pass.
  if (!getAccountQuota(accountId)) {
    import("./auth-api")
      .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "pre-route"))
      .catch(() => {});
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
    const token = getMainAccountToken();
    if (!token) {
      // Nothing will reach upstream, so give the probe back instead of burning it.
      if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
      else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
      throw new CodexPoolAuthenticationError();
    }
    return {
      kind: "main-pool",
      accountId,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
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
      generation: token.generation,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      ...(quotaScope ? { quotaScope } : {}),
      ...(probeLeaseId ? { probeLeaseId } : {}),
      ...(probeQuotaScope ? { probeQuotaScope } : {}),
    };
  } catch (cause) {
    if (probeLeaseId && probeQuotaScope) releaseCodexQuotaScopeProbeLease(accountId, probeQuotaScope, probeLeaseId);
    else if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
    if (shouldMarkAccountNeedsReauthForCodexAuthFailure(cause)) {
      markAccountNeedsReauth(accountId);
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

export function headersForCodexAuthContext(headers: Headers, ctx: CodexAuthContext): Headers {
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value) selected.set(name, value);
  }
  if (ctx.kind === "pool" || ctx.kind === "main-pool") {
    selected.set("authorization", `Bearer ${ctx.accessToken}`);
    selected.set("chatgpt-account-id", ctx.chatgptAccountId);
  }
  return selected;
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
