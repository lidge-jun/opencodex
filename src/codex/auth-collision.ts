import { join } from "node:path";
import { getCodexAccountCredential } from "./account-store";
import { loadConfig } from "../config";
import { resolveCodexHomeDir } from "./home";
import { extractAccountId } from "../oauth/chatgpt";
import { isSelectableCodexPoolAccount, MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { codexPlanKey } from "./plan";
import { getObservedMainCodexCollisionIdentity, sameCodexCollisionIdentity, type CodexCollisionIdentity } from "./collision-identity";
import { readNativeMainAuthBytes } from "./native-main-auth-file";

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

function parseCodexTokens(raw: string): CodexTokenReadResult {
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

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

/**
 * Reads the Codex CLI credential file and classifies the outcome. Reads once instead of doing an
 * `existsSync` pre-check, so a file replaced between check and read cannot be misread as absent.
 * An already-owned lifecycle may supply its pinned auth path instead of resolving ambient home.
 * `bounded` opts into the native-profile bounded reader (regular file, size-capped, no-follow,
 * non-blocking) for startup observation paths that run inside the owner claim; bounded violations
 * classify as `unreadable`. Legacy callers keep the unbounded read.
 * Never returns or logs the raw error or any token material.
 */
export function readCodexTokensResult(
  authPath = join(resolveCodexHomeDir(), "auth.json"),
  options?: { bounded?: boolean },
): CodexTokenReadResult {
  let raw: string;
  try {
    raw = readNativeMainAuthBytes(authPath, options?.bounded === true ? "bounded" : "plain").toString("utf-8");
  } catch (error) {
    return { status: hasErrnoCode(error, "ENOENT") ? "missing" : "unreadable" };
  }
  return parseCodexTokens(raw);
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

// Main login and pool accounts share the account id + email collision guard.
// Personal and workspace subscriptions remain separate buckets.
export function checkAccountIdCollision(
  chatgptAccountId: string,
  email?: string | null,
  plan?: unknown,
  excludeAccountId?: string | null,
  main: CodexCollisionIdentity | null = getObservedMainCodexCollisionIdentity() ?? null,
): { collision: true; reason: string } | { collision: false } {
  const candidateEmail = normalizedEmail(email);
  const candidateWorkspace = isWorkspacePlan(plan);

  if (excludeAccountId !== MAIN_CODEX_ACCOUNT_ID && main
    && sameCodexCollisionIdentity({ accountId: chatgptAccountId, email, plan }, main)) {
    return { collision: true, reason: "Account is already configured as the native Codex main account." };
  }

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

export type MainAuth = CodexTokenReadResult | { status: "api-key-only" };

/** A valid API-key login has no ChatGPT identity; anything else unreadable stays unknown. */
export function readMainAuth(authPath = join(resolveCodexHomeDir(), "auth.json")): MainAuth {
  const main = readCodexTokensResult(authPath, { bounded: true });
  if (main.status !== "invalid") return main;
  try {
    const j: unknown = JSON.parse(readNativeMainAuthBytes(authPath, "bounded").toString("utf-8"));
    if (j === null || typeof j !== "object" || Array.isArray(j)) return main;
    const envelope = j as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: unknown };
    const apiKeyOnly = envelope.tokens == null
      && (envelope.auth_mode === undefined || envelope.auth_mode === "api_key")
      && typeof envelope.OPENAI_API_KEY === "string" && envelope.OPENAI_API_KEY.trim() !== "";
    return apiKeyOnly ? { status: "api-key-only" } : main;
  } catch {
    return main;
  }
}

