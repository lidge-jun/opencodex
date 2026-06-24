import { CodexCredentialGenerationConflictError, getValidCodexToken } from "./codex-account-store";
import { markAccountNeedsReauth } from "./codex-account-runtime-state";
import { isCodexAccountUsable } from "./codex-account-usability";
import { resolveCodexAccountForThread } from "./codex-routing";
import type { OcxConfig, OcxProviderConfig } from "./types";
import { FORWARD_HEADERS } from "./adapters/openai-responses";

export type CodexAuthContext =
  | { kind: "main"; accountId: null }
  | {
      kind: "pool";
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

export async function resolveCodexAuthContext(headers: Headers, config: OcxConfig): Promise<CodexAuthContext> {
  const threadId = headers.get("x-codex-parent-thread-id");
  const accountId = resolveCodexAccountForThread(threadId, config);
  if (!accountId) return { kind: "main", accountId: null };

  try {
    const token = await getValidCodexToken(accountId);
    return {
      kind: "pool",
      accountId,
      accessToken: token.accessToken,
      chatgptAccountId: token.chatgptAccountId,
    };
  } catch (cause) {
    if (!(cause instanceof CodexCredentialGenerationConflictError)) {
      markAccountNeedsReauth(accountId);
    }
    throw new CodexAuthContextError(accountId, cause);
  }
}

export function applyCodexAuthContextToProvider(
  provider: OcxProviderConfig,
  ctx: CodexAuthContext,
): OcxRuntimeProviderConfig {
  if (ctx.kind !== "pool" || provider.authMode !== "forward") return provider;
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
  if (ctx.kind === "pool") {
    selected.set("authorization", `Bearer ${ctx.accessToken}`);
    selected.set("chatgpt-account-id", ctx.chatgptAccountId);
  }
  return selected;
}

export function isCodexAuthContextUsable(ctx: CodexAuthContext, config: OcxConfig): boolean {
  if (ctx.kind === "main") return true;
  return isCodexAccountUsable(config, ctx.accountId);
}

export function stripCodexRuntimeProviderFields(provider: OcxProviderConfig): OcxProviderConfig {
  const {
    _codexAccountOverride: _override,
    _codexAccountRequired: _required,
    ...safeProvider
  } = provider as OcxRuntimeProviderConfig;
  return safeProvider;
}
