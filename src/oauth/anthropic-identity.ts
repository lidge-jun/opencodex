/** Private account proof from an authenticated Anthropic response, bound to its exact bearer. */
import { hasClaudeCredentialContinuity } from "./local-token-detect";
import { createHash } from "node:crypto";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { CLAUDE_CLI_USER_AGENT } from "../providers/claude-cli-identity";
import type { OAuthCredentials } from "./types";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const PROFILE_TIMEOUT_MS = 10_000;
const PROFILE_MAX_BYTES = 65_536;
export type AnthropicIdentity = NonNullable<OAuthCredentials["anthropicIdentity"]>;
export type AnthropicIdentityResolver = (access: string, signal?: AbortSignal) => Promise<AnthropicIdentity | undefined>;

export function bindAnthropicIdentity(access: string, accountUuid: unknown): AnthropicIdentity | undefined {
  if (!access || typeof accountUuid !== "string" || !accountUuid.length || accountUuid.length > 128
    || accountUuid !== accountUuid.trim() || /[\x00-\x1f\x7f]/.test(accountUuid)) return undefined;
  return { v: 1, accountUuid, bearerSha256: createHash("sha256").update(access).digest("hex") };
}

export function normalizeAnthropicIdentity(value: unknown, access: string): AnthropicIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const proof = value as Partial<AnthropicIdentity>;
  const bound = bindAnthropicIdentity(access, proof.accountUuid);
  return proof.v === 1 && bound && proof.bearerSha256 === bound.bearerSha256 ? bound : undefined;
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
    return account && typeof account === "object" && "uuid" in account
      ? bindAnthropicIdentity(access, account.uuid) : undefined;
  } catch {
    // Unavailable identity is an explicit unresolved result, never an ownership guess.
    return undefined;
  }
};

/** A changed access bearer cannot inherit the previous bearer's proof. */
export function mergeAnthropicIdentity(fresh: OAuthCredentials, previous: OAuthCredentials): Pick<OAuthCredentials, "anthropicIdentity"> {
  const before = normalizeAnthropicIdentity(previous.anthropicIdentity, previous.access);
  const after = normalizeAnthropicIdentity(fresh.anthropicIdentity, fresh.access);
  if (before && after && before.accountUuid !== after.accountUuid) {
    throw new Error("Anthropic credential identity changed; explicit account login required");
  }
  return { anthropicIdentity: after ?? (fresh.access === previous.access ? before : undefined) };
}

/** Explicit imports enrich only a proven slot; labels and paths never establish ownership. */
export function matchesAnthropicImport(stored: OAuthCredentials, imported: OAuthCredentials): boolean {
  const before = normalizeAnthropicIdentity(stored.anthropicIdentity, stored.access);
  const after = normalizeAnthropicIdentity(imported.anthropicIdentity, imported.access);
  if (before && after) return before.accountUuid === after.accountUuid;
  return hasClaudeCredentialContinuity(stored, imported);
}
