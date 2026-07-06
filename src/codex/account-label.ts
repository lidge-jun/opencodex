import { createHash, randomBytes } from "node:crypto";
import type { CodexAccount } from "../types";

export const CODEX_ACCOUNT_LOG_LABEL_RE = /^p[a-f0-9]{6}$/;

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
