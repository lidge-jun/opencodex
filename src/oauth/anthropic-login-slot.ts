/**
 * Which stored Anthropic row a login, a Claude Code import or a reauth may write.
 *
 * One Claude account (one `account.uuid`) can belong to several organizations, and every OAuth
 * grant is scoped to exactly one of them, with its own subscription and usage limits. A login
 * therefore replaces the row of the same account AND organization; a proven different
 * organization gets its own row instead of overwriting the first one.
 *
 * The organization only scopes a slot. It never proves identity: matching still starts from
 * the same account identity the store always used. When the incoming organization is unknown,
 * the login keeps the historical same-account replacement, so a row stored before
 * organizations were recorded is never duplicated by re-login.
 */
import { createHash } from "node:crypto";
import { anthropicOrganization, matchesAnthropicImport, normalizeAnthropicIdentity,
  resolveAnthropicAccountIdentity, type AnthropicIdentityResolver } from "./anthropic-identity";
import type { OAuthCredentials, ProviderAccount } from "./types";

/** Interactive login waits on these reads; a slow profile falls back to the historical match. */
const LOGIN_OBSERVATION_TIMEOUT_MS = 5_000;

/** Organizations observed for stored rows, keyed by the SHA-256 of the bearer that proved them. */
export type AnthropicSlotOrganizations = ReadonlyMap<string, string>;

function bearerSha256(access: string): string {
  return createHash("sha256").update(access).digest("hex");
}

function loginIdentity(credential: OAuthCredentials): string | undefined {
  return credential.accountId ?? credential.email;
}

/**
 * Before the store lock: read the organization of each same-account row that has none recorded
 * (rows saved before organizations were tracked), so the login can tell its org from theirs.
 * Only an unexpired bearer is asked, each answer is bound to that exact bearer, and nothing is
 * written here; a row whose bearer changes before the write simply stays unknown.
 */
export async function observeAnthropicSlotOrganizations(
  accounts: readonly ProviderAccount[],
  incoming: OAuthCredentials,
  resolve: AnthropicIdentityResolver = resolveAnthropicAccountIdentity,
  now: () => number = Date.now,
): Promise<AnthropicSlotOrganizations> {
  const identity = loginIdentity(incoming);
  if (!identity || !anthropicOrganization(incoming)) return new Map();
  const pending = accounts.filter(row => loginIdentity(row.credential) === identity
    && anthropicOrganization(row.credential) === undefined
    && row.credential.access && row.credential.expires > now());
  if (pending.length === 0) return new Map();
  const signal = AbortSignal.timeout(LOGIN_OBSERVATION_TIMEOUT_MS);
  const proofs = await Promise.all(pending.map(row => resolve(row.credential.access, signal)));
  const observed = new Map<string, string>();
  pending.forEach((row, index) => {
    const proof = normalizeAnthropicIdentity(proofs[index], row.credential.access);
    if (proof?.organizationUuid && proof.accountUuid === row.credential.accountId) {
      observed.set(proof.bearerSha256, proof.organizationUuid);
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
  candidates: readonly ProviderAccount[], incoming: OAuthCredentials,
  observed: AnthropicSlotOrganizations, activeAccountId?: string,
): ProviderAccount | undefined {
  const organizationOf = (row: ProviderAccount) => anthropicOrganization(row.credential)
    ?? observed.get(bearerSha256(row.credential.access));
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
): ProviderAccount | undefined {
  const identity = loginIdentity(incoming);
  return pickSlot(accounts.filter(row => loginIdentity(row.credential) === identity), incoming, observed, activeAccountId);
}

/** Inside the store lock: the row a Claude Code credential import enriches, or undefined for a new row. */
export function findAnthropicImportSlot(
  accounts: readonly ProviderAccount[], incoming: OAuthCredentials,
  observed: AnthropicSlotOrganizations = new Map(), activeAccountId?: string,
): ProviderAccount | undefined {
  return pickSlot(accounts.filter(row => matchesAnthropicImport(row.credential, incoming)), incoming, observed, activeAccountId);
}

/**
 * A reauth must not turn a row into a second copy of an organization another row of the same
 * account already proves; that would leave two rows on one quota and drop the first grant.
 */
export function anthropicOrganizationHeldElsewhere(
  accounts: readonly ProviderAccount[], accountId: string, incoming: OAuthCredentials,
): boolean {
  const organization = anthropicOrganization(incoming);
  const identity = loginIdentity(incoming);
  return organization !== undefined && accounts.some(row => row.id !== accountId
    && loginIdentity(row.credential) === identity && anthropicOrganization(row.credential) === organization);
}
