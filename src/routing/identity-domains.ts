/**
 * Authentication identity, quota domain, and cache domain are three different
 * questions (#4546, wp6).
 *
 * A credential pool is stored as a flat list, which smuggles in two assumptions that are
 * each wrong in the opposite direction: two API keys are treated as two independent pools
 * of capacity, and two accounts on one provider are treated as not sharing a cache. The
 * first overcounts available capacity -- OpenAI rate limits are per organization and
 * project, so failing over from key A to key B inside the same limit buys nothing while
 * still paying a cold prefix. The second discards warm prefixes the provider would have
 * served, or worse, assumes a hit the provider never promised.
 *
 * This module is a conservative CLASSIFIER, not a claim about where a provider stores
 * anything. Every answer carries provenance: "operator-declared" comes from configured
 * credential groups, "provider-documented" comes from the small built-in table below for
 * the cases the PRD names, and "unknown" is a first-class result. "unknown" is never
 * silently read as "no sharing" and never as "shared" -- relations report it explicitly
 * so the caller applies its own conservative rule.
 *
 * Provenance is only half of it. A documented rule can prove that two credentials are in
 * DIFFERENT domains without proving that two others are in the SAME one, so every domain
 * also carries which of those two facts its key supports ({@link DomainEvidence}). That
 * is why two OpenAI keys in one organization and region relate "unknown" for cache: the
 * documentation separates, then declines to promise the hit.
 *
 * Conversational-state portability is a separate question from cache compatibility and
 * is deliberately not folded into the domain keys: a request carrying
 * previous_response_id, a provider-side conversation id, uploaded file ids, or encrypted
 * reasoning cannot be replayed onto another credential at all, no matter how the domains
 * relate. `canPortConversationState` is that separate check.
 */

/** Where a domain answer comes from. Order of trust: operator > provider docs > nothing. */
export type IdentityDomainProvenance = "operator-declared" | "provider-documented" | "unknown";

/**
 * What a domain key is evidence FOR, which is two facts rather than one.
 *
 * Proven SEPARATION and proven SHARING are different claims, and a provider routinely
 * gives the first without the second. OpenAI's prompt-caching guide states the separating
 * half outright -- "Caches are not shared across organizations and cannot be reused across
 * regional processing boundaries" -- and never states a sharing half at all. The page does
 * not discuss two API keys inside one organization, and what it does say about keys is that
 * they "influence routing; they do not pin requests to a machine or guarantee a cache hit."
 * So a different org-or-region key proves two domains, while an identical one proves
 * nothing. A positive cache inference needs the provider to promise the hit, and no such
 * promise exists here -- the silence is the evidence, not a documented denial. Inferring
 * "shared" from an equal key would be the same guess this module exists to refuse, only
 * pointed the other way.
 *
 * "separates" therefore means two different keys are two different domains while two
 * identical keys stay "unknown". "separates-and-shares" means the same source also
 * promised that one key is one domain.
 */
export type DomainEvidence = "separates" | "separates-and-shares";

/**
 * An opaque, comparable domain. `key` is only meaningful for equality when both sides
 * are known; two "unknown" domains never compare shared because each carries a key
 * derived from its own credential id. `evidence` decides whether an equal key is even
 * allowed to mean "shared".
 */
export interface IdentityDomain {
  readonly key: string;
  readonly provenance: IdentityDomainProvenance;
  readonly evidence: DomainEvidence;
}

/**
 * What the classifier knows about one credential. Every field beyond `credentialId` is
 * optional evidence; a documented rule that needs a field this ref does not have yields
 * "unknown", never a guess.
 */
export interface CredentialDomainRef {
  readonly credentialId: string;
  readonly provider?: string;
  readonly organizationId?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly deploymentId?: string;
  readonly region?: string;
}

export interface CredentialIdentity {
  /** The credential the request is sent as. Never grouped, never shared. */
  readonly authIdentity: string;
  /** The set of credentials that demonstrably share one usage limit. */
  readonly quotaDomain: IdentityDomain;
  /** The conservative prompt-cache compatibility class. */
  readonly cacheDomain: IdentityDomain;
  /**
   * Group ids that claim this credential when the declaration is ambiguous: the same
   * group id declared twice, or the credential listed in more than one group. An
   * ambiguous declaration is never resolved by list order -- the quota domain falls back
   * to the provider-documented or unknown answer and the conflict is reported here.
   * `pool.credentialGroups` rejects such a declaration on write and drops it on load, so
   * this covers a caller that assembled groups some other way.
   */
  readonly declaredGroupConflict?: readonly string[];
}

/**
 * How two domains relate. "unknown" is returned rather than collapsed into either
 * answer, because treating it as "distinct" rotates within a shared limit (paying a
 * cold prefix for zero capacity) and treating it as "shared" strands capacity that may
 * be independent. An equal key whose evidence only proves separation also relates
 * "unknown", which is how a documented non-sharing rule stays a non-sharing rule.
 */
export type DomainRelation = "shared" | "distinct" | "unknown";

/**
 * Operator-declared grouping from `pool.credentialGroups`.
 *
 * `credentials` holds PROVIDER-QUALIFIED ids, `"<provider>:<credential-id>"`. A bare id
 * is ambiguous: credential ids are provider-scoped everywhere else -- `src/oauth/store.ts`
 * keys an account by provider and id -- so `"acct-1"` names one credential per provider,
 * and a bare declaration would silently merge unrelated quota domains. The provider
 * segment normalizes through the same alias table as a classified ref, so
 * `"chatgpt:acct-1"` and `"codex:acct-1"` name the same credential.
 *
 * Group ids must be unique, `credentials` must be non-empty, and a credential may appear
 * in at most one group. {@link credentialGroupIssues} is the shared checker.
 */
export interface DeclaredCredentialGroup {
  readonly id: string;
  readonly credentials: readonly string[];
  readonly note?: string;
}

/**
 * The provider-documented cases the PRD names, and only those. A rule returns
 * undefined when the ref lacks the evidence the documentation requires; the caller
 * then classifies "unknown" rather than extrapolating.
 *
 * - OpenAI: rate limits are per organization and project, with model groups sharing a
 *   limit ("Rate limits are defined at the organization level and at the project level, not
 *   user level", plus the documented shared limit across a model family); prompt caches are
 *   not shared across organizations or regional processing boundaries.
 * - Anthropic: prompt cache is isolated per workspace even inside one organization.
 *   (Cache-read tokens are also excluded from input TPM there, which is quota
 *   accounting, not domain shape, so it does not appear here.)
 * - Azure: limits and cache breakpoints are per deployment.
 *
 * Each rule also carries what its documented sentence proves ({@link DomainEvidence}),
 * because two of these are separation rules and the rest promise sharing as well.
 */
interface DocumentedDomainRule {
  key(ref: CredentialDomainRef): string | undefined;
  readonly evidence: DomainEvidence;
}

const PROVIDER_DOCUMENTED_DOMAINS: Record<string, {
  quota?: DocumentedDomainRule;
  cache?: DocumentedDomainRule;
}> = {
  openai: {
    quota: {
      // Positive on both halves: the limit is defined per organization and project, and
      // model groups share one limit, so two keys in one org and project are one limit.
      key: (ref) => ref.organizationId !== undefined && ref.projectId !== undefined
        ? `openai:org:${ref.organizationId}:project:${ref.projectId}`
        : undefined,
      evidence: "separates-and-shares",
    },
    cache: {
      // Separation only, and the asymmetry is in the source. The prompt-caching guide says
      // "Caches are not shared across organizations and cannot be reused across regional
      // processing boundaries", which settles a DIFFERENT org or region as distinct. It
      // states no counterpart for an identical one: the guide never discusses two keys in
      // one organization, and a key is documented to "influence routing" without
      // guaranteeing a hit. Same org and region therefore stays "unknown" -- claiming
      // "shared" would assert a warm prefix the provider never promised, and the caller
      // would pay for the guess by replaying a long prompt that misses.
      key: (ref) => ref.organizationId !== undefined && ref.region !== undefined
        ? `openai:org:${ref.organizationId}:region:${ref.region}`
        : undefined,
      evidence: "separates",
    },
  },
  anthropic: {
    cache: {
      // The cache is scoped to the workspace as a resource: isolated from other
      // workspaces inside one organization, and reused within it. Both halves come from
      // the same documented scoping, so an equal key may mean shared.
      key: (ref) => ref.workspaceId !== undefined
        ? `anthropic:workspace:${ref.workspaceId}`
        : undefined,
      evidence: "separates-and-shares",
    },
  },
  azure: {
    quota: {
      // Quota and cache are both properties of the deployment resource itself.
      key: (ref) => ref.deploymentId !== undefined
        ? `azure:deployment:${ref.deploymentId}`
        : undefined,
      evidence: "separates-and-shares",
    },
    cache: {
      key: (ref) => ref.deploymentId !== undefined
        ? `azure:deployment:${ref.deploymentId}`
        : undefined,
      evidence: "separates-and-shares",
    },
  },
};

const PROVIDER_ALIASES: Record<string, string> = {
  "azure-openai": "azure",
  "chatgpt": "openai",
  "codex": "openai",
};

function normalizedProvider(provider: string | undefined): string | undefined {
  if (provider === undefined) return undefined;
  const lowered = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[lowered] ?? lowered;
}

function unknownDomain(kind: "quota" | "cache", credentialId: string): IdentityDomain {
  // The credential id in the key keeps two unknown domains from ever comparing equal:
  // uniqueness is what makes "unknown" impossible to misread as "shared".
  return { key: `unknown:${kind}:${credentialId}`, provenance: "unknown", evidence: "separates" };
}

function documentedDomain(
  rule: DocumentedDomainRule | undefined,
  ref: CredentialDomainRef,
): IdentityDomain | undefined {
  const key = rule?.key(ref);
  if (rule === undefined || key === undefined) return undefined;
  return { key, provenance: "provider-documented", evidence: rule.evidence };
}

/** `"<provider>:<credential-id>"`, the only accepted spelling of a declared member. */
export const CREDENTIAL_GROUP_MEMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*:\S+$/;

function splitMember(member: string): { provider: string; credentialId: string } | undefined {
  if (!CREDENTIAL_GROUP_MEMBER_PATTERN.test(member)) return undefined;
  const separator = member.indexOf(":");
  const provider = normalizedProvider(member.slice(0, separator));
  if (provider === undefined || provider === "") return undefined;
  return { provider, credentialId: member.slice(separator + 1) };
}

function canonicalMember(member: string): string {
  const parsed = splitMember(member);
  return parsed === undefined ? `unqualified:${member}` : `${parsed.provider}:${parsed.credentialId}`;
}

function memberMatches(member: string, ref: CredentialDomainRef): boolean {
  const parsed = splitMember(member);
  if (parsed === undefined) return false;
  if (parsed.credentialId !== ref.credentialId) return false;
  const refProvider = normalizedProvider(ref.provider);
  // A ref without a provider cannot be matched to a provider-scoped declaration, so it
  // keeps the documented or unknown answer instead of borrowing someone else's group.
  return refProvider !== undefined && refProvider === parsed.provider;
}

/**
 * Every way a declared grouping can be ambiguous, reported by position only. Messages
 * name group and member indexes, never the operator-supplied strings — a malformed
 * credential pasted into this list would otherwise be printed verbatim into shared
 * logs. The config write path rejects on any of these and the load path drops the
 * list, so an ambiguous declaration is reported rather than resolved by whichever
 * group came first.
 */
export function credentialGroupIssues(groups: readonly DeclaredCredentialGroup[]): string[] {
  const issues: string[] = [];
  const seenIds = new Map<string, number>();
  const owner = new Map<string, { groupIndex: number; memberIndex: number }>();
  for (const [groupIndex, group] of groups.entries()) {
    // A duplicate id is not cosmetic: both groups key to `declared:<id>`, so the second
    // group's members join the first group's quota domain without anyone saying so.
    const firstGroupIndex = seenIds.get(group.id);
    if (firstGroupIndex !== undefined) {
      issues.push(`duplicate group id at group index ${groupIndex} (first declared at group index ${firstGroupIndex})`);
    } else {
      seenIds.set(group.id, groupIndex);
    }
    if (group.credentials.length === 0) {
      issues.push(`group at index ${groupIndex} lists no credentials`);
    }
    for (const [memberIndex, member] of group.credentials.entries()) {
      if (splitMember(member) === undefined) {
        issues.push(
          `credential at member index ${memberIndex} in group index ${groupIndex} must be provider-qualified as "<provider>:<credential-id>"`,
        );
        continue;
      }
      const existing = owner.get(canonicalMember(member));
      if (existing?.groupIndex === groupIndex) {
        issues.push(`credential at member index ${memberIndex} is listed twice in group index ${groupIndex}`);
      } else if (existing !== undefined) {
        issues.push(
          `credential at member index ${memberIndex} in group index ${groupIndex} is declared in more than one group (first declared at group index ${existing.groupIndex}, member index ${existing.memberIndex})`,
        );
      } else {
        owner.set(canonicalMember(member), { groupIndex, memberIndex });
      }
    }
  }
  return issues;
}

function resolveDeclaredGroup(
  ref: CredentialDomainRef,
  groups: readonly DeclaredCredentialGroup[],
): { group?: DeclaredCredentialGroup; conflict?: readonly string[] } {
  const matches = groups.filter((group) => group.credentials.some((member) => memberMatches(member, ref)));
  if (matches.length === 0) return {};
  const conflicting = new Set<string>();
  for (const match of matches) {
    if (matches.length > 1) conflicting.add(match.id);
    if (groups.filter((group) => group.id === match.id).length > 1) conflicting.add(match.id);
  }
  if (conflicting.size > 0) return { conflict: [...conflicting] };
  return { group: matches[0] };
}

/**
 * Classify one credential. `declaredGroups` is `pool.credentialGroups`; an operator
 * declaration wins over the provider table because the operator can observe account
 * topology the table cannot. Declared groups speak only to quota: sharing a usage
 * limit says nothing about cache compatibility, so the cache domain never reads them.
 *
 * An ambiguous declaration -- a duplicated group id, or a credential claimed by two
 * groups -- is not resolved by taking the first match. It is reported on
 * `declaredGroupConflict` and the quota domain falls back to the documented or unknown
 * answer, so a config that slipped past validation cannot silently merge two unrelated
 * quota domains.
 */
export function classifyCredential(
  ref: CredentialDomainRef,
  declaredGroups: readonly DeclaredCredentialGroup[] = [],
): CredentialIdentity {
  const { group: declared, conflict } = resolveDeclaredGroup(ref, declaredGroups);
  const documented = PROVIDER_DOCUMENTED_DOMAINS[normalizedProvider(ref.provider) ?? ""] ?? {};

  const quotaDomain: IdentityDomain = declared !== undefined
    ? { key: `declared:${declared.id}`, provenance: "operator-declared", evidence: "separates-and-shares" }
    : documentedDomain(documented.quota, ref) ?? unknownDomain("quota", ref.credentialId);

  const cacheDomain: IdentityDomain = documentedDomain(documented.cache, ref)
    ?? unknownDomain("cache", ref.credentialId);

  return conflict === undefined
    ? { authIdentity: ref.credentialId, quotaDomain, cacheDomain }
    : { authIdentity: ref.credentialId, quotaDomain, cacheDomain, declaredGroupConflict: conflict };
}

function relateDomains(a: IdentityDomain, b: IdentityDomain): DomainRelation {
  if (a.provenance === "unknown" || b.provenance === "unknown") return "unknown";
  if (a.key !== b.key) return "distinct";
  // Equal keys are proof of sharing only when both sides' evidence includes the sharing
  // half. A separation-only rule (OpenAI's cache) stops here at "unknown".
  return a.evidence === "separates-and-shares" && b.evidence === "separates-and-shares"
    ? "shared"
    : "unknown";
}

export function relateQuotaDomain(a: CredentialIdentity, b: CredentialIdentity): DomainRelation {
  return relateDomains(a.quotaDomain, b.quotaDomain);
}

export function relateCacheDomain(a: CredentialIdentity, b: CredentialIdentity): DomainRelation {
  return relateDomains(a.cacheDomain, b.cacheDomain);
}

/**
 * What a quota refusal on `from` means for rotating to `to`. A refusal inside a known
 * shared domain must not be answered by rotating within it -- the limit is the same,
 * so the move pays a cold prefix for zero new capacity. "unknown" hands the decision
 * back to the caller, which applies its own conservative rule.
 */
export type QuotaRotationVerdict = "same-domain" | "distinct-domain" | "unknown";

export function assessQuotaRotation(
  from: CredentialIdentity,
  to: CredentialIdentity,
): QuotaRotationVerdict {
  const relation = relateQuotaDomain(from, to);
  if (relation === "shared") return "same-domain";
  if (relation === "distinct") return "distinct-domain";
  return "unknown";
}

/**
 * Available capacity across a credential set. Credentials in one known quota domain
 * count ONCE. Unknown-domain credentials are reported separately rather than merged
 * into either count, so the caller decides whether each is its own pool or not.
 */
export function countQuotaCapacity(identities: readonly CredentialIdentity[]): {
  readonly known: number;
  readonly unknown: number;
} {
  const knownKeys = new Set<string>();
  let unknown = 0;
  for (const identity of identities) {
    if (identity.quotaDomain.provenance === "unknown") {
      unknown += 1;
    } else {
      knownKeys.add(identity.quotaDomain.key);
    }
  }
  return { known: knownKeys.size, unknown };
}

/** Why a conversation cannot be replayed onto a different credential. */
export type PortabilityDenial =
  | "previous-response-id"
  | "provider-conversation-id"
  | "uploaded-file-ids"
  | "encrypted-reasoning";

/**
 * The parts of a request that bind it to the credential that produced them. Presence
 * is what matters; the values stay opaque so nothing here logs or inspects ids.
 */
export interface ConversationStateCarriers {
  readonly previousResponseId?: string | null;
  readonly providerConversationId?: string | null;
  readonly fileIds?: readonly string[];
  readonly encryptedReasoning?: unknown;
}

export type PortabilityVerdict =
  | { readonly portable: true }
  | { readonly portable: false; readonly reason: PortabilityDenial };

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Whether a request's conversational state can move credentials at all. This is NOT
 * cache compatibility: a shared cacheDomain means a replayed prefix might hit, while a
 * refusal here means replaying is wrong regardless of warmth -- a previous_response_id
 * or provider conversation id names server-side state another credential cannot see,
 * and an uploaded file id or encrypted reasoning payload is bound to the account that
 * issued it. A same-cacheDomain answer must never be read as portability, and a
 * portable request gains no cache promise.
 */
export function canPortConversationState(
  state: ConversationStateCarriers,
): PortabilityVerdict {
  if (present(state.previousResponseId)) {
    return { portable: false, reason: "previous-response-id" };
  }
  if (present(state.providerConversationId)) {
    return { portable: false, reason: "provider-conversation-id" };
  }
  if (present(state.fileIds)) {
    return { portable: false, reason: "uploaded-file-ids" };
  }
  if (present(state.encryptedReasoning)) {
    return { portable: false, reason: "encrypted-reasoning" };
  }
  return { portable: true };
}
