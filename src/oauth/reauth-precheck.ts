import { isAnthropicOAuthInstance } from "../providers/anthropic-instance";
import { anthropicSlotEmailsMatch } from "./anthropic-login-slot";
import { kiroReauthIdentityMatches } from "./kiro-account-identity";
import { OAuthReauthIdentityMismatchError, OAuthReauthIdentityUnverifiedError } from "./oauth-errors";
import { getAccountCredential, getAccountSet } from "./store";
import type { OAuthCredentials } from "./types";

export function precheckOAuthReauthIdentity(
  provider: string, reauthAccountId: string, cred: OAuthCredentials,
): OAuthCredentials {
  const existing = getAccountCredential(provider, reauthAccountId);
  if (!existing) throw new Error(`Unknown account for reauth: ${reauthAccountId}`);
  if (!existing.accountId && !existing.email) {
    throw new OAuthReauthIdentityUnverifiedError();
  }
  // A Kiro organization profile ARN is shared by its users, so it alone is not the account.
  const identityMatches = provider === "kiro"
    ? kiroReauthIdentityMatches(existing, cred, getAccountSet("kiro")?.accounts
      .filter(account => account.id !== reauthAccountId).map(account => account.credential))
    : existing.accountId && cred.accountId
      ? existing.accountId === cred.accountId
      : isAnthropicOAuthInstance(provider)
        ? anthropicSlotEmailsMatch(existing.email, cred.email)
        : Boolean(existing.email && cred.email && existing.email.trim().toLowerCase() === cred.email.trim().toLowerCase());
  if (!identityMatches) throw new OAuthReauthIdentityMismatchError();
  return existing;
}
