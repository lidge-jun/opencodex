import { extractEmail, inspectChatGptDomainClaim } from "../oauth/chatgpt";
import type { CodexTokens } from "./auth-collision";

export type CodexLoginIdentity = Readonly<{ accountId: string; email: string }>;
let observed: CodexLoginIdentity | undefined;

export function codexLoginIdentity(accountId: unknown, email: unknown): CodexLoginIdentity | undefined {
  const member = typeof email === "string" ? email.trim().toLowerCase() : "";
  const workspace = typeof accountId === "string" ? accountId.trim() : "";
  return workspace && member ? { accountId: workspace, email: member } : undefined;
}

/** Undefined is insufficient evidence; null means conflicting or malformed token evidence. */
export function codexTokenIdentity(tokens: CodexTokens): CodexLoginIdentity | undefined | null {
  if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string"
    || (tokens.id_token !== undefined && typeof tokens.id_token !== "string")) return null;
  const claims = [tokens.id_token, tokens.access_token]
    .filter((token): token is string => typeof token === "string")
    .map(inspectChatGptDomainClaim);
  if (claims.some(claim => claim.kind === "invalid")) return null;
  const claimIds = claims.flatMap(claim => claim.kind === "valid" ? [claim.accountId] : []);
  const accountId = tokens.account_id.trim() || claimIds[0];
  if (claimIds.some(claim => claim !== accountId)) return null;
  const emails = new Set([extractEmail(tokens.id_token), extractEmail(undefined, tokens.access_token)]
    .flatMap(email => email?.trim() ? [email.trim().toLowerCase()] : []));
  if (emails.size > 1) return null;
  return codexLoginIdentity(accountId, [...emails][0]);
}

/** Publish only from an existing physical-login observation, never an incoming bearer. */
export function observeSignedInCodexIdentity(tokens?: CodexTokens): void {
  if (!tokens) { observed = undefined; return; }
  const next = codexTokenIdentity(tokens);
  // Conflicting claims can be a partial external write, never proof of a new login.
  if (next !== null) observed = next;
}

/** Routing reads memory only, including while the native profile is fenced. */
export function getSignedInCodexIdentity(): CodexLoginIdentity | undefined { return observed; }

export function sameCodexLogin(a: CodexLoginIdentity, b: CodexLoginIdentity | undefined): boolean {
  return a.accountId === b?.accountId && a.email === b.email;
}
