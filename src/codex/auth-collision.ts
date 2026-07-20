import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexAccountCredential } from "./account-store";
import { loadConfig } from "../config";
import { resolveCodexHomeDir } from "./home";
import { extractAccountId } from "../oauth/chatgpt";

export function readCodexTokens(): { access_token: string; account_id: string; id_token?: string } | null {
  try {
    const codexHome = resolveCodexHomeDir();
    const authPath = join(codexHome, "auth.json");
    if (!existsSync(authPath)) return null;
    const j = JSON.parse(readFileSync(authPath, "utf-8")) as {
      tokens?: { access_token?: string; account_id?: string; id_token?: string };
    };
    if (!j?.tokens?.access_token) return null;
    return {
      access_token: j.tokens.access_token,
      account_id: j.tokens.account_id ?? "",
      id_token: j.tokens.id_token,
    };
  } catch { return null; }
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

function isWorkspacePlan(plan: string | undefined | null): boolean {
  return !!plan && /team|business|enterprise|workspace|edu/i.test(plan);
}

// Main login and managed pool accounts are separate duplicate buckets.
// Inside the pool, personal and workspace subscriptions are also separate buckets.
// Within each pool bucket, keep the original ChatGPT account id + email collision guard.
export function checkAccountIdCollision(
  chatgptAccountId: string,
  email?: string | null,
  plan?: string | null,
  excludeAccountId?: string | null,
): { collision: true; reason: string } | { collision: false } {
  const candidateEmail = normalizedEmail(email);
  const candidateWorkspace = isWorkspacePlan(plan);
  for (const account of loadConfig().codexAccounts ?? []) {
    if (excludeAccountId && account.id === excludeAccountId) continue;
    if (account.isMain) continue;
    if (isWorkspacePlan(account.plan) !== candidateWorkspace) continue;
    const cred = getCodexAccountCredential(account.id);
    const poolEmail = normalizedEmail(account.email);
    if (cred && cred.chatgptAccountId === chatgptAccountId && (!candidateEmail || !poolEmail || poolEmail === candidateEmail)) {
      return { collision: true, reason: `Account is already in the pool (${account.id}).` };
    }
  }
  return { collision: false };
}
