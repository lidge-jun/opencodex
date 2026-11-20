/**
 * Which stored Anthropic row a login, a Claude Code import or a reauth may write.
 *
 * One Claude account (one `account.uuid`) can belong to several organizations, and every OAuth
 * grant is scoped to exactly one of them, with its own subscription and usage limits. A login
 * therefore replaces the row of the same account AND organization; a proven different
 * organization gets its own row instead of overwriting the first one.
 *
 * An email-only login with proven scope reuses a row only on a unique email match in the
 * same proven organization. When the incoming organization is unknown, the login keeps the
 * historical same-account replacement.
 */
import { createHash } from "node:crypto";
import { anthropicOrganization, matchesAnthropicImport, normalizeAnthropicIdentity,
  resolveAnthropicAccountIdentity, type AnthropicIdentityResolver } from "./anthropic-identity";
import { OAuthReauthIdentityMismatchError } from "./oauth-errors";
import type { OAuthCredentials, ProviderAccount } from "./types";

/** Interactive login waits on these reads; a slow profile falls back to the historical match. */
const LOGIN_OBSERVATION_TIMEOUT_MS = 5_000;

type SlotOrganizationProof = { accountUuid: string; organizationUuid: string; bearerSha256: string };
/** Keyed by row ID so a writer can distinguish a stale proof from an unobserved row. */
type AnthropicSlotOrganizations = ReadonlyMap<string, SlotOrganizationProof>;

type AnthropicLoginContinuity = {
  slotId: string;
  bearerSha256: string;
  accountUuid: string;
  via: "refresh" | "profile";
};

function bearerSha256(access: string): string {
  return createHash("sha256").update(access).digest("hex");
}

function slotAccountUuid(credential: OAuthCredentials): string | undefined {
  return normalizeAnthropicIdentity(credential.anthropicIdentity, credential.access)?.accountUuid
    ?? credential.accountId;
}

function loginIdentity(credential: OAuthCredentials): string | undefined {
  return slotAccountUuid(credential) ?? credential.email;
}

function slotEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim();
  if (!trimmed) return undefined;
  const separator = trimmed.lastIndexOf("@");
  if (separator < 0) return trimmed;
  const domain = trimmed.slice(separator + 1);
  // Preserve the local part and both Unicode and A-label spellings of internationalized domains.
  if (/[^\x00-\x7F]/.test(domain) || /(?:^|\.)xn--/i.test(domain)) return trimmed;
  return trimmed.slice(0, separator + 1) + domain.toLowerCase();
}

export function anthropicSlotEmailsMatch(left: string | undefined, right: string | undefined): boolean {
  const email = slotEmail(left);
  return email !== undefined && email === slotEmail(right);
}

function slotOrganization({ id, credential }: ProviderAccount, observed: AnthropicSlotOrganizations): string | undefined {
  const stored = anthropicOrganization(credential);
  if (stored) return stored;
  const proof = observed.get(id);
  return proof && proof.accountUuid === slotAccountUuid(credential) && proof.bearerSha256 === bearerSha256(credential.access)
    ? proof.organizationUuid : undefined;
}

function hasStaleSlotObservation(row: ProviderAccount, observed: AnthropicSlotOrganizations): boolean {
  return observed.has(row.id) && slotOrganization(row, observed) === undefined;
}

function sameOrganizationEmailSlots(
  accounts: readonly ProviderAccount[], incoming: OAuthCredentials, observed: AnthropicSlotOrganizations,
): ProviderAccount[] {
  const organization = anthropicOrganization(incoming);
  if (!organization) return [];
  return accounts.filter(row => anthropicSlotEmailsMatch(row.credential.email, incoming.email)
    && slotOrganization(row, observed) === organization);
}

function sharesRefreshToken(incoming: OAuthCredentials, stored: OAuthCredentials): boolean {
  return Boolean(incoming.refresh) && incoming.refresh === stored.refresh;
}

/** Outside the writer lock, establish continuity for the unique UUID-less recovery candidate. */
export async function observeAnthropicLoginContinuity(
  accounts: readonly ProviderAccount[], incoming: OAuthCredentials,
): Promise<AnthropicLoginContinuity | undefined> {
  if (incoming.source === "local-cli") return undefined;
  const accountUuid = normalizeAnthropicIdentity(incoming.anthropicIdentity, incoming.access)?.accountUuid;
  if (!accountUuid) return undefined;
  const [row, ambiguous] = sameOrganizationEmailSlots(accounts, incoming, new Map());
  if (!row || ambiguous || slotAccountUuid(row.credential) !== undefined) return undefined;
  const { access, expires } = row.credential;
  const observation = { slotId: row.id, bearerSha256: bearerSha256(access), accountUuid };
  if (sharesRefreshToken(incoming, row.credential)) return { ...observation, via: "refresh" };
  if (!access || expires <= Date.now()) return undefined;
  const proof = await resolveAnthropicAccountIdentity(access, AbortSignal.timeout(LOGIN_OBSERVATION_TIMEOUT_MS));
  if (proof?.accountUuid === accountUuid && proof.bearerSha256 === observation.bearerSha256
    && (!proof.organizationUuid || proof.organizationUuid === anthropicOrganization(incoming))) {
    return { ...observation, via: "profile" };
  }
  return undefined;
}

/**
 * Before the store lock: read the organization of each same-account row that has none recorded
 * (rows saved before organizations were tracked), so the login can tell its org from theirs.
 * Only an unexpired bearer is asked, each answer is bound to that exact bearer, and nothing is
 * written here.
 */
export async function observeAnthropicSlotOrganizations(
  accounts: readonly ProviderAccount[],
  incoming: OAuthCredentials,
  reauthAccountId?: string,
  resolve: AnthropicIdentityResolver = resolveAnthropicAccountIdentity,
  now: () => number = Date.now,
): Promise<AnthropicSlotOrganizations> {
  const identity = loginIdentity(incoming);
  if (!identity || !anthropicOrganization(incoming)) return new Map();
  // An email-only reauth cannot name its target's stored account UUID, so it asks that target too.
  const isEmailOnlyReauthTarget = (row: ProviderAccount) => row.id === reauthAccountId && !slotAccountUuid(incoming)
    && slotAccountUuid(row.credential) !== undefined && anthropicSlotEmailsMatch(row.credential.email, incoming.email);
  const pending = accounts.filter(row => (loginIdentity(row.credential) === identity || isEmailOnlyReauthTarget(row))
    && anthropicOrganization(row.credential) === undefined
    && row.credential.access && row.credential.expires > now());
  if (pending.length === 0) return new Map();
  const signal = AbortSignal.timeout(LOGIN_OBSERVATION_TIMEOUT_MS);
  const proofs = await Promise.all(pending.map(row => resolve(row.credential.access, signal)));
  const observed = new Map<string, SlotOrganizationProof>();
  pending.forEach((row, index) => {
    const proof = normalizeAnthropicIdentity(proofs[index], row.credential.access);
    if (proof?.organizationUuid && proof.accountUuid === slotAccountUuid(row.credential)) {
      observed.set(row.id, { accountUuid: proof.accountUuid, organizationUuid: proof.organizationUuid, bearerSha256: proof.bearerSha256 });
    }
  });
  return observed;
}

/**
 * One rule for every writer. A known incoming organization takes its own row, else a row whose
 * organization is still unknown; a row proven to serve another organization is never chosen.
 * An unknown incoming organization prefers an unknown row, then the active one, so it never
 * displaces a proven slot while a better candidate exists.
 */
function pickSlot(
  accounts: readonly ProviderAccount[], incoming: OAuthCredentials, observed: AnthropicSlotOrganizations,
  isCandidate: (row: ProviderAccount) => boolean, activeAccountId?: string,
): ProviderAccount | undefined {
  if (observed.size > 0) {
    const accountUuid = slotAccountUuid(incoming);
    if (accounts.some(row => hasStaleSlotObservation(row, observed) && (isCandidate(row)
      || (slotAccountUuid(row.credential) ?? observed.get(row.id)?.accountUuid) === accountUuid))) {
      throw new Error("Anthropic account changed during organization verification. Retry login or import.");
    }
  }
  const candidates = accounts.filter(isCandidate);
  const organizationOf = (row: ProviderAccount) => slotOrganization(row, observed);
  const organization = anthropicOrganization(incoming);
  if (organization) {
    return candidates.find(row => organizationOf(row) === organization)
      ?? candidates.find(row => organizationOf(row) === undefined);
  }
  return candidates.find(row => organizationOf(row) === undefined)
    ?? candidates.find(row => row.id === activeAccountId) ?? candidates[0];
}

/** Inside the store lock: the row a browser login replaces, or undefined for a new row. */
export function findAnthropicLoginSlot(
  accounts: readonly ProviderAccount[], incoming: OAuthCredentials,
  observed: AnthropicSlotOrganizations = new Map(), activeAccountId?: string,
  continuity?: AnthropicLoginContinuity,
): ProviderAccount | undefined {
  const accountUuid = slotAccountUuid(incoming);
  const email = slotEmail(incoming.email);
  if (!accountUuid && email) {
    const organization = anthropicOrganization(incoming);
    if (organization) {
      const [match, ambiguous] = accounts.filter(row => slotEmail(row.credential.email) === email
        && slotOrganization(row, observed) === organization);
      if (ambiguous) throw new Error("Multiple Anthropic login slots match this organization and email. Try signing in again.");
      return match;
    }
  }
  return pickSlot(accounts, incoming, observed, row => accountUuid
    ? slotAccountUuid(row.credential) === accountUuid
    : loginIdentity(row.credential) === incoming.email, activeAccountId)
    ?? (accountUuid ? emailOnlyLoginSlot(accounts, incoming, observed, continuity) : undefined);
}

/**
 * Email and organization only locate a candidate. Recheck continuity against the locked slot and
 * bearer before replacing the credential. Another same-email row in the org makes it ambiguous.
 */
function emailOnlyLoginSlot(
  accounts: readonly ProviderAccount[], incoming: OAuthCredentials, observed: AnthropicSlotOrganizations,
  continuity?: AnthropicLoginContinuity,
): ProviderAccount | undefined {
  const sameEmail = sameOrganizationEmailSlots(accounts, incoming, observed);
  const match = sameEmail.find(row => slotAccountUuid(row.credential) === undefined);
  if (!match) return undefined;
  if (sameEmail.length > 1) throw new Error("Multiple Anthropic login slots match this organization and email. Try signing in again.");
  if (continuity?.slotId !== match.id || continuity.accountUuid !== slotAccountUuid(incoming)
    || continuity.bearerSha256 !== bearerSha256(match.credential.access)
    || (continuity.via === "refresh" && !sharesRefreshToken(incoming, match.credential))) return undefined;
  return match;
}

/** Inside the store lock: the row a Claude Code credential import enriches, or undefined for a new row. */
export function findAnthropicImportSlot(
  accounts: readonly ProviderAccount[], incoming: OAuthCredentials,
  observed: AnthropicSlotOrganizations = new Map(), activeAccountId?: string,
): ProviderAccount | undefined {
  return pickSlot(accounts, incoming, observed, row => matchesAnthropicImport(row.credential, incoming), activeAccountId);
}

export function anthropicSiblingSlots(accounts: readonly ProviderAccount[], accountId: string | undefined, accountUuid: string): ProviderAccount[] {
  return accounts.filter(row => row.id !== accountId && slotAccountUuid(row.credential) === accountUuid);
}

/**
 * Recheck the target and siblings under the writer lock. A persisted proof takes precedence, and
 * a pre-lock observation applies only to the same bearer and account that were observed. Refuse
 * the write if a relevant observation went stale and the current row has no replacement proof.
 */
export function anthropicReauthSlotGuard(
  accountId: string, incoming: OAuthCredentials, observed: AnthropicSlotOrganizations,
): (accounts: readonly ProviderAccount[]) => void {
  const organization = anthropicOrganization(incoming);
  const accountUuid = slotAccountUuid(incoming);
  return accounts => {
    const target = accounts.find(row => row.id === accountId);
    if (!target) return;
    const targetAccountUuid = slotAccountUuid(target.credential);
    if (targetAccountUuid && accountUuid && targetAccountUuid !== accountUuid) throw new OAuthReauthIdentityMismatchError();
    if (!organization) return;
    const targetOrganization = slotOrganization(target, observed);
    if (!accountUuid) {
      // Another row of the organization with the same email could own this grant, as on login.
      if (targetOrganization !== organization || !anthropicSlotEmailsMatch(target.credential.email, incoming.email)
        || accounts.some(row => row.id !== accountId && slotOrganization(row, observed) === organization
          && anthropicSlotEmailsMatch(row.credential.email, target.credential.email))) {
        throw new OAuthReauthIdentityMismatchError();
      }
      return;
    }
    if (targetOrganization ? targetOrganization !== organization : observed.has(target.id)) throw new OAuthReauthIdentityMismatchError();
    const siblingConflict = accounts.some(row => {
      const prior = observed.get(row.id);
      if (row.id === accountId || (slotAccountUuid(row.credential) ?? prior?.accountUuid) !== accountUuid) return false;
      const siblingOrganization = slotOrganization(row, observed);
      return siblingOrganization === organization || (!siblingOrganization && prior !== undefined);
    });
    if (siblingConflict) throw new OAuthReauthIdentityMismatchError();
  };
}
