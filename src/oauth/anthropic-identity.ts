/** Private account proof from an authenticated Anthropic response, bound to its exact bearer. */
import { hasClaudeCredentialContinuity } from "./local-token-detect";
import { createHash } from "node:crypto";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { CLAUDE_CLI_USER_AGENT } from "../providers/claude-cli-identity";
import type { OAuthCredentials } from "./types";
import { normalizeOAuthOrganizationName } from "./plan";
import { normalizeAnthropicPlan } from "../providers/anthropic-subscription";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const PROFILE_TIMEOUT_MS = 10_000;
const PROFILE_MAX_BYTES = 65_536;
export type AnthropicIdentity = NonNullable<OAuthCredentials["anthropicIdentity"]>;
type AnthropicOrganizationScope = NonNullable<OAuthCredentials["anthropicOrganizationScope"]>;
export type AnthropicIdentityResolver = (access: string, signal?: AbortSignal) => Promise<(AnthropicIdentity & { plan?: string; organizationName?: string }) | undefined>;

const ORGANIZATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed organization UUID in canonical lowercase, or undefined. */
export function normalizeAnthropicOrganizationUuid(value: unknown): string | undefined {
  return typeof value === "string" && ORGANIZATION_UUID_RE.test(value) ? value.toLowerCase() : undefined;
}

export function bindAnthropicIdentity(access: string, accountUuid: unknown, organizationUuid?: unknown): AnthropicIdentity | undefined {
  if (!access || typeof accountUuid !== "string" || !accountUuid.length || accountUuid.length > 128
    || accountUuid !== accountUuid.trim() || /[\x00-\x1f\x7f]/.test(accountUuid)) return undefined;
  const organization = normalizeAnthropicOrganizationUuid(organizationUuid);
  return { v: 1, accountUuid, bearerSha256: createHash("sha256").update(access).digest("hex"),
    ...(organization ? { organizationUuid: organization } : {}) };
}

export function normalizeAnthropicIdentity(value: unknown, access: string): AnthropicIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proof = value as Partial<AnthropicIdentity>;
  const bound = bindAnthropicIdentity(access, proof.accountUuid, proof.organizationUuid);
  return proof.v === 1 && bound && proof.bearerSha256 === bound.bearerSha256 ? bound : undefined;
}

export function bindAnthropicOrganizationScope(access: string, value: unknown): AnthropicOrganizationScope | undefined {
  const organizationUuid = normalizeAnthropicOrganizationUuid(value);
  if (!access || !organizationUuid) return undefined;
  return { v: 1, organizationUuid, bearerSha256: createHash("sha256").update(access).digest("hex") };
}

export function normalizeAnthropicOrganizationScope(value: unknown, access: string): AnthropicOrganizationScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proof = value as Partial<AnthropicOrganizationScope>;
  const bound = bindAnthropicOrganizationScope(access, proof.organizationUuid);
  return proof.v === 1 && bound && proof.bearerSha256 === bound.bearerSha256 ? bound : undefined;
}

/**
 * The organization a credential's grant is scoped to, when its own bearer proved it. One Claude
 * account can belong to several organizations, and each OAuth grant serves exactly one of them.
 */
export function anthropicOrganization(credential: OAuthCredentials): string | undefined {
  return normalizeAnthropicOrganizationScope(credential.anthropicOrganizationScope, credential.access)?.organizationUuid
    ?? normalizeAnthropicIdentity(credential.anthropicIdentity, credential.access)?.organizationUuid;
}

/** True only when both credentials prove different organizations; an unknown side never conflicts. */
export function anthropicOrganizationsConflict(a: OAuthCredentials, b: OAuthCredentials): boolean {
  const left = anthropicOrganization(a);
  const right = anthropicOrganization(b);
  return left !== undefined && right !== undefined && left !== right;
}

/** Fixed destination, no redirects, bounded body and deadline; failures never include response data. */
export const resolveAnthropicAccountIdentity: AnthropicIdentityResolver = async (access, signal) => {
  if (!access || signal?.aborted) return undefined;
  const deadline = AbortSignal.timeout(PROFILE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetch(PROFILE_URL, {
      method: "GET", redirect: "error", signal: combined,
      headers: { Authorization: `Bearer ${access}`, Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "Cache-Control": "no-cache", "User-Agent": CLAUDE_CLI_USER_AGENT },
    });
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      return undefined;
    }
    const body = await readBoundedResponseBody(response, {
      signal: combined, maxBytes: PROFILE_MAX_BYTES, fatalUtf8: true,
      totalTimeoutMs: PROFILE_TIMEOUT_MS, inactivityTimeoutMs: PROFILE_TIMEOUT_MS,
    });
    if (body.truncated || body.oversized || body.timedOut || combined.aborted) return undefined;
    const data: unknown = JSON.parse(body.text);
    if (!data || typeof data !== "object" || !("account" in data)) return undefined;
    const account = data.account;
    const organization = "organization" in data ? data.organization : undefined;
    const org = organization && typeof organization === "object"
      ? organization as Record<string, unknown> : undefined;
    const identity = account && typeof account === "object" && "uuid" in account
      ? bindAnthropicIdentity(access, account.uuid, org?.uuid) : undefined;
    if (!identity) return undefined;
    const plan = normalizeAnthropicPlan(org?.rate_limit_tier) ?? normalizeAnthropicPlan(org?.organization_type);
    const organizationName = identity.organizationUuid ? normalizeOAuthOrganizationName(org?.name) : undefined;
    return { ...identity, ...(plan ? { plan } : {}), ...(organizationName ? { organizationName } : {}) };
  } catch {
    // Unavailable identity is an explicit unresolved result, never an ownership guess.
    return undefined;
  }
};

/**
 * A changed access bearer cannot inherit the previous bearer's proof. `sameGrant` marks a
 * provider refresh of this row's own refresh token: the grant's organization cannot change
 * there, so a freshly proven same account keeps the stored organization when the refresh
 * response and its profile read did not repeat it, and an unproven one keeps it as the new
 * bearer's organization scope. The organization is a scope, not identity:
 * a refresh that reports another one keeps the fresh answer instead of discarding a rotated grant.
 */
export function mergeAnthropicIdentity(
  fresh: OAuthCredentials, previous: OAuthCredentials, opts: { sameGrant?: boolean } = {},
): Pick<OAuthCredentials, "anthropicIdentity" | "anthropicOrganizationScope"> {
  const before = normalizeAnthropicIdentity(previous.anthropicIdentity, previous.access);
  const after = normalizeAnthropicIdentity(fresh.anthropicIdentity, fresh.access);
  if (before && after && before.accountUuid !== after.accountUuid) {
    throw new Error("Anthropic credential identity changed; explicit account login required");
  }
  const sameBearer = fresh.access === previous.access;
  const scope = normalizeAnthropicOrganizationScope(fresh.anthropicOrganizationScope, fresh.access)
    ?? (sameBearer ? normalizeAnthropicOrganizationScope(previous.anthropicOrganizationScope, previous.access) : undefined);
  const previousOrganization = opts.sameGrant && !after?.organizationUuid && !scope
    ? anthropicOrganization(previous) : undefined;
  return {
    anthropicIdentity: after && previousOrganization ? { ...after, organizationUuid: previousOrganization }
      : after ?? (sameBearer ? before : undefined),
    // Without a fresh account proof the organization stays a scope of the new bearer, never an identity.
    anthropicOrganizationScope: scope ?? (!after && !sameBearer && previousOrganization
      ? bindAnthropicOrganizationScope(fresh.access, previousOrganization) : undefined),
  };
}

/** Explicit imports enrich only a proven slot; labels and paths never establish ownership. */
export function matchesAnthropicImport(stored: OAuthCredentials, imported: OAuthCredentials): boolean {
  if (anthropicOrganizationsConflict(stored, imported)) return false;
  const before = normalizeAnthropicIdentity(stored.anthropicIdentity, stored.access);
  const after = normalizeAnthropicIdentity(imported.anthropicIdentity, imported.access);
  if (before && after) return before.accountUuid === after.accountUuid;
  return hasClaudeCredentialContinuity(stored, imported);
}
