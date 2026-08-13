import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexAccountCredential } from "./account-store";
import { loadConfig } from "../config";
import { resolveCodexHomeDir } from "./home";
import { extractAccountId } from "../oauth/chatgpt";
import { isSelectableCodexPoolAccount } from "./account-id";
import { codexPlanKey } from "./plan";

export interface CodexTokens {
  access_token: string;
  account_id: string;
  id_token?: string;
}

/**
 * Why a read *outcome* and not just `Tokens | null`: callers need to tell a real sign-out apart
 * from a transient read failure. A single null collapsed "file absent", "malformed JSON", and
 * "read error" into one answer, so a half-written `auth.json` looked exactly like a logout and
 * callers destroyed healthy cached account state because of it.
 */
export type CodexTokenReadResult =
  | { status: "ok"; tokens: CodexTokens }
  | { status: "missing" | "invalid" | "unreadable" };

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

/**
 * Reads the Codex CLI credential file and classifies the outcome. Reads once instead of doing an
 * `existsSync` pre-check, so a file replaced between check and read cannot be misread as absent.
 * Never returns or logs the raw error or any token material.
 */
export function readCodexTokensResult(): CodexTokenReadResult {
  let raw: string;
  try {
    raw = readFileSync(join(resolveCodexHomeDir(), "auth.json"), "utf-8");
  } catch (error) {
    return { status: hasErrnoCode(error, "ENOENT") ? "missing" : "unreadable" };
  }
  try {
    const j = JSON.parse(raw) as {
      tokens?: { access_token?: string; account_id?: string; id_token?: string };
    };
    if (!j?.tokens?.access_token) return { status: "invalid" };
    return {
      status: "ok",
      tokens: {
        access_token: j.tokens.access_token,
        account_id: j.tokens.account_id ?? "",
        id_token: j.tokens.id_token,
      },
    };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * Compatibility wrapper: any usable-token check keeps the original null contract, which keeps
 * request routing fail-closed. Only callers that must distinguish the failure reason should use
 * `readCodexTokensResult()`.
 */
export function readCodexTokens(): CodexTokens | null {
  const result = readCodexTokensResult();
  return result.status === "ok" ? result.tokens : null;
}

export function getMainChatgptAccountId(): string | null {
  const tokens = readCodexTokens();
  if (!tokens) return null;
  return extractAccountId(tokens.id_token, tokens.access_token) ?? (tokens.account_id || null);
}

function normalizedEmail(email: string | undefined | null): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed || null;
}

function isWorkspacePlan(plan: unknown): boolean {
  const key = codexPlanKey(plan);
  return !!key && /team|business|enterprise|workspace|edu/.test(key);
}

// Main login and managed pool accounts are separate duplicate buckets.
// Inside the pool, personal and workspace subscriptions are also separate buckets.
// Within each pool bucket, keep the original ChatGPT account id + email collision guard.
export function checkAccountIdCollision(
  chatgptAccountId: string,
  email?: string | null,
  plan?: unknown,
  excludeAccountId?: string | null,
): { collision: true; reason: string } | { collision: false } {
  const candidateEmail = normalizedEmail(email);
  const candidateWorkspace = isWorkspacePlan(plan);
  for (const account of loadConfig().codexAccounts ?? []) {
    if (excludeAccountId && account.id === excludeAccountId) continue;
    if (!isSelectableCodexPoolAccount(account)) continue;
    if (isWorkspacePlan(account.plan) !== candidateWorkspace) continue;
    const cred = getCodexAccountCredential(account.id);
    const poolEmail = normalizedEmail(account.email);
    if (cred && cred.chatgptAccountId === chatgptAccountId && (!candidateEmail || !poolEmail || poolEmail === candidateEmail)) {
      return { collision: true, reason: `Account is already in the pool (${account.id}).` };
    }
  }
  return { collision: false };
}
