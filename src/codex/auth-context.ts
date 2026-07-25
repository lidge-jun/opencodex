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
  getCodexAccountCooldownUntil,
  releaseCodexQuotaProbeLease,
  tryAcquireCodexQuotaProbeLease,
  pickLowestUsageCodexAccount,
  resolveCodexAccountForThreadDetailed,
} from "./routing";
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
      /** Prevent pool affinity or active-account mutation for an exact selector. */
      fixedAccount?: boolean;
      /**
       * Set when this request was admitted through an active quota cooldown as
       * the account's single probe. Must be echoed into the upstream outcome so
       * only this request can clear the cooldown (#433).
       */
      probeLeaseId?: string;
    }
  | {
      // Main Codex account participating in rotation: token injected from ~/.codex/auth.json
      // (Option A). Distinct from "main" (passthrough fallback that forwards the client token).
      kind: "main-pool";
      accountId: string;
      accessToken: string;
      chatgptAccountId: string;
      /** Prevent pool affinity or active-account mutation for an exact selector. */
      fixedAccount?: boolean;
      /** See `pool.probeLeaseId`. */
      probeLeaseId?: string;
    };

/** Probe lease carried by this context, when it holds one. */
export function codexProbeLeaseId(ctx: CodexAuthContext | undefined): string | undefined {
  return ctx?.kind === "pool" || ctx?.kind === "main-pool" ? ctx.probeLeaseId : undefined;
}

/**
 * Hand back a probe lease for a request that will not reach upstream. Safe to
 * call with a context that holds no lease.
 */
export function releaseCodexAuthContextProbeLease(ctx: CodexAuthContext | undefined): void {
  const leaseId = codexProbeLeaseId(ctx);
  if (ctx && leaseId) releaseCodexQuotaProbeLease(ctx.accountId!, leaseId);
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

  constructor(accountId: string, cooldownUntil: number) {
    super("Selected Codex account is cooling down");
    this.name = "CodexAccountCooldownError";
    this.accountId = accountId;
    this.cooldownUntil = cooldownUntil;
  }
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
  /** Resolve exactly this account without consulting or mutating pool selection/affinity. */
  accountId?: string;
}

export async function resolveCodexAuthContext(
  headers: Headers,
  config: OcxConfig,
  mode: CodexAccountMode,
  options: ResolveCodexAuthContextOptions = {},
): Promise<CodexAuthContext> {
  if (options.accountId && options.excludeAccountId) {
    throw new Error("Codex auth context cannot select and exclude an account simultaneously");
  }
  // An explicit account binding is stronger than the provider's default mode. Account-qualified
  // model selectors must resolve that exact credential even while the canonical provider is in
  // Direct mode; otherwise they would silently fall back to the caller's current login.
  if (mode === "direct" && !options.accountId) {
    if (!hasCallerCodexBearer(headers)) throw new CodexDirectAuthenticationError();
    return { kind: "main", accountId: null };
  }
  reconcileMainCodexAccountRuntimeState();
  const threadId = headers.get("x-codex-parent-thread-id");
  const resolution = options.accountId
    ? { status: "selected" as const, accountId: options.accountId }
    : options.excludeAccountId
    ? (() => {
        const accountId = pickLowestUsageCodexAccount(config, options.excludeAccountId);
        return accountId
          ? { status: "selected" as const, accountId }
          : { status: "none" as const };
      })()
    : resolveCodexAccountForThreadDetailed(threadId, config);
  if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
  const accountId = resolution.status === "selected" ? resolution.accountId : null;
  if (!accountId) throw new CodexPoolAuthenticationError();
  if (options.accountId && !isCodexAccountUsable(config, accountId)) {
    throw new CodexPoolAuthenticationError();
  }
  // Lazy prime: if the selected account has no quota yet, the pool is likely
  // unprimed (dashboard never opened, or startup prime was blocked). Kick a
  // best-effort prime so the NEXT routing decision has real scores. This never
  // blocks the current request, and the helper's single-flight guard collapses
  // repeated triggers into one pass.
  if (!options.accountId && !getAccountQuota(accountId)) {
    import("./auth-api")
      .then(({ primeCodexPoolQuotas }) => primeCodexPoolQuotas(config, "pre-route"))
      .catch(() => {});
  }
  const cooldownUntil = getCodexAccountCooldownUntil(accountId);
  // A cooled-down account never sends traffic, so upstream recovery can never be
  // observed and the cooldown outlives the real limit. Admit one probe per
  // interval; its outcome decides whether the cooldown ends (#433).
  let probeLeaseId: string | undefined;
  if (cooldownUntil) {
    probeLeaseId = tryAcquireCodexQuotaProbeLease(accountId) ?? undefined;
    if (!probeLeaseId) throw new CodexAccountCooldownError(accountId, cooldownUntil);
  }

  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // Main account in rotation: inject the read-only auth.json token and fail closed if it vanished.
    const token = getMainAccountToken();
    if (!token) {
      // Nothing will reach upstream, so give the probe back instead of burning it.
      if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
      throw new CodexPoolAuthenticationError();
    }
    return {
      kind: "main-pool",
      accountId,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
      ...(options.accountId ? { fixedAccount: true } : {}),
      ...(probeLeaseId ? { probeLeaseId } : {}),
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
      ...(options.accountId ? { fixedAccount: true } : {}),
      ...(probeLeaseId ? { probeLeaseId } : {}),
    };
  } catch (cause) {
    if (probeLeaseId) releaseCodexQuotaProbeLease(accountId, probeLeaseId);
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
  const cooldownUntil = getCodexAccountCooldownUntil(ctx.accountId);
  if (cooldownUntil) throw new CodexAccountCooldownError(ctx.accountId, cooldownUntil);
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
