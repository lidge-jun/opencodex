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
 * Conversational-state portability is a separate question from cache compatibility and
 * is deliberately not folded into the domain keys: a request carrying
 * previous_response_id, a provider-side conversation id, uploaded file ids, or encrypted
 * reasoning cannot be replayed onto another credential at all, no matter how the domains
 * relate. `canPortConversationState` is that separate check.
 */

/** Where a domain answer comes from. Order of trust: operator > provider docs > nothing. */
export type IdentityDomainProvenance = "operator-declared" | "provider-documented" | "unknown";

/**
 * An opaque, comparable domain. `key` is only meaningful for equality when both sides
 * are known; two "unknown" domains never compare shared because each carries a key
 * derived from its own credential id.
 */
export interface IdentityDomain {
  readonly key: string;
  readonly provenance: IdentityDomainProvenance;
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
}

/**
 * How two domains relate. "unknown" is returned rather than collapsed into either
 * answer, because treating it as "distinct" rotates within a shared limit (paying a
 * cold prefix for zero capacity) and treating it as "shared" strands capacity that may
 * be independent.
 */
export type DomainRelation = "shared" | "distinct" | "unknown";

/** Operator-declared grouping from `pool.credentialGroups`. */
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
 *   limit; prompt caches are not shared across organizations or processing regions.
 * - Anthropic: prompt cache is isolated per workspace even inside one organization.
 *   (Cache-read tokens are also excluded from input TPM there, which is quota
 *   accounting, not domain shape, so it does not appear here.)
 * - Azure: limits and cache breakpoints are per deployment.
 */
const PROVIDER_DOCUMENTED_DOMAINS: Record<string, {
  quotaKey?(ref: CredentialDomainRef): string | undefined;
  cacheKey?(ref: CredentialDomainRef): string | undefined;
}> = {
  openai: {
    quotaKey: (ref) => ref.organizationId !== undefined && ref.projectId !== undefined
      ? `openai:org:${ref.organizationId}:project:${ref.projectId}`
      : undefined,
    cacheKey: (ref) => ref.organizationId !== undefined && ref.region !== undefined
      ? `openai:org:${ref.organizationId}:region:${ref.region}`
      : undefined,
  },
  anthropic: {
    cacheKey: (ref) => ref.workspaceId !== undefined
      ? `anthropic:workspace:${ref.workspaceId}`
      : undefined,
  },
  azure: {
    quotaKey: (ref) => ref.deploymentId !== undefined
      ? `azure:deployment:${ref.deploymentId}`
      : undefined,
    cacheKey: (ref) => ref.deploymentId !== undefined
      ? `azure:deployment:${ref.deploymentId}`
      : undefined,
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
  return { key: `unknown:${kind}:${credentialId}`, provenance: "unknown" };
}

/**
 * Classify one credential. `declaredGroups` is `pool.credentialGroups`; an operator
 * declaration wins over the provider table because the operator can observe account
 * topology the table cannot. Declared groups speak only to quota: sharing a usage
 * limit says nothing about cache compatibility, so the cache domain never reads them.
 */
export function classifyCredential(
  ref: CredentialDomainRef,
  declaredGroups: readonly DeclaredCredentialGroup[] = [],
): CredentialIdentity {
  const declared = declaredGroups.find((group) => group.credentials.includes(ref.credentialId));
  const documented = PROVIDER_DOCUMENTED_DOMAINS[normalizedProvider(ref.provider) ?? ""] ?? {};

  const documentedQuotaKey = documented.quotaKey?.(ref);
  const quotaDomain: IdentityDomain = declared !== undefined
    ? { key: `declared:${declared.id}`, provenance: "operator-declared" }
    : documentedQuotaKey !== undefined
      ? { key: documentedQuotaKey, provenance: "provider-documented" }
      : unknownDomain("quota", ref.credentialId);

  const documentedCacheKey = documented.cacheKey?.(ref);
  const cacheDomain: IdentityDomain = documentedCacheKey !== undefined
    ? { key: documentedCacheKey, provenance: "provider-documented" }
    : unknownDomain("cache", ref.credentialId);

  return { authIdentity: ref.credentialId, quotaDomain, cacheDomain };
}

function relateDomains(a: IdentityDomain, b: IdentityDomain): DomainRelation {
  if (a.provenance === "unknown" || b.provenance === "unknown") return "unknown";
  return a.key === b.key ? "shared" : "distinct";
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
