import {
  CodexCredentialGenerationConflictError,
  CodexCredentialRefreshLockTimeoutError,
  getValidCodexToken,
  isCodexAccountGenerationLive,
} from "./account-store";
import { markAccountNeedsReauth } from "./account-runtime-state";
import { isCodexAccountUsable } from "./account-usability";
import { MAIN_CODEX_ACCOUNT_ID, getMainAccountToken } from "./main-account";
import { getCodexAccountCooldownUntil, resolveCodexAccountForThreadDetailed } from "./routing";
import { getAccountQuota } from "./quota";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { FORWARD_HEADERS } from "../adapters/openai-responses";

export type CodexAuthContext =
  | { kind: "main"; accountId: null }
  | {
      kind: "pool";
      accountId: string;
      generation: number;
      accessToken: string;
      chatgptAccountId: string;
    }
  | {
      // Main Codex account participating in rotation: token injected from ~/.codex/auth.json
      // (Option A). Distinct from "main" (passthrough fallback that forwards the client token).
      kind: "main-pool";
      accountId: string;
      accessToken: string;
      chatgptAccountId: string;
    };

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

export async function resolveCodexAuthContext(headers: Headers, config: OcxConfig): Promise<CodexAuthContext> {
  const threadId = headers.get("x-codex-parent-thread-id");
  const resolution = resolveCodexAccountForThreadDetailed(threadId, config);
  if (resolution.status === "expired") throw new CodexThreadAffinityExpiredError(resolution.accountId);
  const accountId = resolution.status === "selected" ? resolution.accountId : null;
  if (!accountId) return { kind: "main", accountId: null };
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
  const cooldownUntil = getCodexAccountCooldownUntil(accountId);
  if (cooldownUntil) throw new CodexAccountCooldownError(accountId, cooldownUntil);

  if (accountId === MAIN_CODEX_ACCOUNT_ID) {
    // Main account in rotation: inject the read-only auth.json token. If the token vanished
    // since selection, fall back to passthrough rather than failing the request.
    const token = getMainAccountToken();
    if (!token) return { kind: "main", accountId: null };
    return { kind: "main-pool", accountId, accessToken: token.accessToken, chatgptAccountId: token.chatgptAccountId };
  }

  try {
    const token = await getValidCodexToken(accountId);
    return {
      kind: "pool",
      accountId,
      generation: token.generation,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
    };
  } catch (cause) {
    if (shouldMarkAccountNeedsReauthForCodexAuthFailure(cause)) {
      markAccountNeedsReauth(accountId);
    }
    throw new CodexAuthContextError(accountId, cause);
  }
}

export function assertCodexAuthContextNotCooled(ctx: CodexAuthContext | undefined): void {
  if (ctx?.kind !== "pool" && ctx?.kind !== "main-pool") return;
  const cooldownUntil = getCodexAccountCooldownUntil(ctx.accountId);
  if (cooldownUntil) throw new CodexAccountCooldownError(ctx.accountId, cooldownUntil);
}

export function applyCodexAuthContextToProvider(
  provider: OcxProviderConfig,
  ctx: CodexAuthContext,
): OcxRuntimeProviderConfig {
  if ((ctx.kind !== "pool" && ctx.kind !== "main-pool") || provider.authMode !== "forward") return provider;
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
