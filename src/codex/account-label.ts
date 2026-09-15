import { createHash, randomBytes } from "node:crypto";
import type { CodexAccount, OcxConfig } from "../types";
import type { CodexAuthContext } from "./auth-context";
import type { ProviderApiKeySelection } from "../types/provider";
import { MAIN_CODEX_ACCOUNT_ID } from "./main-account";

export const CODEX_ACCOUNT_LOG_LABEL_RE = /^p[a-f0-9]{6}$/;

/**
 * Account log labels come in three families:
 *
 * - `p<hex6>` (plus the literal `main`) — a Codex pool account.
 * - `o<hex6>` — a non-Codex OAuth provider account (xai, cursor, and siblings).
 * - `k<hex32>` — a request-owned API-key selection, scoped to provider and reference.
 *
 * Labels never contain an email, raw key/reference, or raw provider account id. That is
 * a privacy requirement, not a formatting preference: these labels are written to the usage log
 * and served over the management API.
 *
 * hex6 is 16.7M values, so two accounts CAN collide and merge into one reported row. That is a
 * reporting inaccuracy at operator scale, not a correctness or privacy failure, and it is the
 * accepted cost of keeping the existing `p` format byte-compatible.
 */
export const OAUTH_ACCOUNT_LOG_LABEL_RE = /^o[a-f0-9]{6}$/;
export const KEY_ACCOUNT_LOG_LABEL_RE = /^k[a-f0-9]{32}$/;
export const ACCOUNT_LOG_LABEL_RE = /^(?:main|[po][a-f0-9]{6}|k[a-f0-9]{32})$/;

/** Digest the request-owned configured selection, never serialize its key/reference. */
export function apiKeyAccountLogLabel(provider: string, selection: ProviderApiKeySelection | undefined): `k${string}` | undefined {
  if (!selection || typeof selection.reference !== "string" || !selection.reference.length) return undefined;
  return `k${createHash("sha256").update(JSON.stringify([
    "ocx-key-account-v1", provider, selection.entryId ?? null, selection.reference,
  ])).digest("hex").slice(0, 32)}`;
}

export function oauthAccountLogLabel(accountId: string, provider = ""): string {
  return `o${createHash("sha256").update(`${provider}\0${accountId}`).digest("hex").slice(0, 6)}`;
}

export function createCodexAccountLogLabel(existingLabels: Iterable<string | undefined | null> = []): string {
  const used = new Set([...existingLabels].filter((value): value is string => !!value));
  for (let i = 0; i < 16; i++) {
    const label = `p${randomBytes(3).toString("hex")}`;
    if (!used.has(label)) return label;
  }
  return `p${randomBytes(6).toString("hex").slice(0, 6)}`;
}

export function fallbackCodexAccountLogLabel(accountId: string): string {
  return `p${createHash("sha256").update(accountId).digest("hex").slice(0, 6)}`;
}

export function codexAccountLogLabel(account: CodexAccount): string {
  return CODEX_ACCOUNT_LOG_LABEL_RE.test(account.logLabel ?? "")
    ? account.logLabel!
    : fallbackCodexAccountLogLabel(account.id);
}

/** Effective durable label for a resolved Codex Pool account. */
export function codexAuthContextLogLabel(
  authCtx: CodexAuthContext,
  config: Pick<OcxConfig, "codexAccounts">,
): "main" | `p${string}` | undefined {
  if (authCtx.kind !== "pool" && authCtx.kind !== "main-pool") return undefined;
  if (authCtx.accountId === MAIN_CODEX_ACCOUNT_ID) return "main";
  const account = (config.codexAccounts ?? []).find(candidate => candidate.id === authCtx.accountId);
  return account ? codexAccountLogLabel(account) as `p${string}` : undefined;
}

export function withCodexAccountLogLabel(
  account: Omit<CodexAccount, "logLabel"> & Partial<Pick<CodexAccount, "logLabel">>,
  existingAccounts: readonly CodexAccount[],
): CodexAccount {
  if (account.logLabel && CODEX_ACCOUNT_LOG_LABEL_RE.test(account.logLabel)) return account as CodexAccount;
  return {
    ...account,
    logLabel: createCodexAccountLogLabel(existingAccounts.map(existing => existing.logLabel)),
  };
}
