/**
 * Kiro account identity (#6641).
 *
 * A Kiro profile ARN names an organization (IAM Identity Center) profile, and every user of
 * that profile shares it, so it cannot tell two users apart. The user-level identifier OCX can
 * observe is the email that same-session `kiro-cli whoami --format json` reports. Account
 * identity is therefore the ARN together with that email; `accountId` keeps the ARN because
 * request routing, rotated-session recovery and persisted evidence read it as the profile.
 *
 * Stored rows are never rewritten to a new key. A legacy row keeps matching the shape it was
 * saved with, and a row that predates the email is only claimed by a login proven to be the
 * same CLI session (identical refresh token). A login that cannot name its user keeps the legacy
 * profile identity, but is refused rather than overwrite an identified user of that profile.
 */
import type { OAuthCredentials, ProviderAccount } from "./types";

type KiroIdentityFields = Pick<OAuthCredentials, "accountId" | "email">;

export class KiroUserIdentityUnavailableError extends Error {
  constructor() {
    super(
      "Kiro CLI did not report which user is signed in, so OpenCodex cannot tell this login apart "
        + "from the identified users of the same Kiro profile. No existing account was replaced. "
        + "Confirm that `kiro-cli whoami` reports the signed-in user, then retry; to renew one "
        + "account, use its Reauthenticate action.",
    );
    this.name = "KiroUserIdentityUnavailableError";
  }
}

export function kiroUserEmail(credential: Pick<OAuthCredentials, "email">): string | undefined {
  const email = credential.email?.trim().toLowerCase();
  return email ? email : undefined;
}

/** ARN + user email when both are known; otherwise whichever one the credential carries. */
export function kiroIdentityKey(credential: KiroIdentityFields): string | undefined {
  const email = kiroUserEmail(credential);
  if (credential.accountId && email) return `${credential.accountId}\n${email}`;
  return credential.accountId ?? email;
}

function sameCliSession(account: ProviderAccount, incoming: OAuthCredentials): boolean {
  return Boolean(incoming.refresh) && account.credential.refresh === incoming.refresh;
}

/**
 * Pick the stored row an identity-bearing Kiro login updates, or undefined to append a new row.
 * Throws KiroUserIdentityUnavailableError instead of guessing between identified users.
 */
export function findKiroAccountForLogin(
  accounts: readonly ProviderAccount[],
  incoming: OAuthCredentials,
): ProviderAccount | undefined {
  const key = kiroIdentityKey(incoming);
  if (!key) return undefined;
  const profileArn = incoming.accountId;
  const sameProfile = profileArn
    ? accounts.filter(account => account.credential.accountId === profileArn)
    : [];
  if (profileArn && !kiroUserEmail(incoming)) {
    // whoami named no user. Without any identified user the profile ARN stays the identity, as it
    // always was. Once the profile has an identified user, a profile-only match could be anyone
    // in the organization: only the same CLI session may update a row; otherwise refuse.
    if (sameProfile.some(account => kiroUserEmail(account.credential))) {
      const proven = sameProfile.find(account => sameCliSession(account, incoming));
      if (proven) return proven;
      throw new KiroUserIdentityUnavailableError();
    }
  }
  const exact = accounts.find(account => kiroIdentityKey(account.credential) === key);
  if (exact) return exact;
  if (profileArn && kiroUserEmail(incoming)) {
    // A row saved before whoami named its user: only the same CLI session proves it is this user.
    return sameProfile.find(account => !kiroUserEmail(account.credential) && sameCliSession(account, incoming));
  }
  return undefined;
}

/** A proven same-session update without whoami keeps the user email the row already has. */
export function withRetainedKiroUser(incoming: OAuthCredentials, existing: OAuthCredentials): OAuthCredentials {
  if (incoming.email || !existing.email || incoming.accountId !== existing.accountId) return incoming;
  return { ...incoming, email: existing.email };
}

/**
 * Reauth may refresh a slot only with the same profile AND, once known, the same user. A slot
 * saved before its user was known is renewable only by this explicit reauth, unless the incoming
 * user already owns another slot of the profile (then it is provably someone else).
 */
export function kiroReauthIdentityMatches(
  existing: KiroIdentityFields,
  incoming: KiroIdentityFields,
  otherAccounts: readonly KiroIdentityFields[] = [],
): boolean {
  const existingEmail = kiroUserEmail(existing);
  const incomingEmail = kiroUserEmail(incoming);
  if (existing.accountId && incoming.accountId) {
    if (existing.accountId !== incoming.accountId) return false;
    if (existingEmail !== undefined) return existingEmail === incomingEmail;
    return incomingEmail === undefined || !otherAccounts.some(other =>
      other.accountId === incoming.accountId && kiroUserEmail(other) === incomingEmail);
  }
  return Boolean(existingEmail && incomingEmail && existingEmail === incomingEmail);
}

