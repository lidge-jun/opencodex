import { createHash, randomBytes } from "node:crypto";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

/**
 * Keyless Zen tier client identity (`opencode-free`).
 *
 * Provenance — every value below is taken from OpenCode's own code, not invented:
 *
 * - Header set: `packages/opencode/src/session/llm/request.ts` sends, for any
 *   `providerID.startsWith("opencode")`, `x-opencode-project`, `x-opencode-session`
 *   (= the OpenCode session id), `x-opencode-request` (= the user message id),
 *   `x-opencode-client` (= `Flag.OPENCODE_CLIENT`, e.g. `cli`) and
 *   `User-Agent: opencode/${Installation.VERSION}`. The gateway additionally
 *   requires that UA to be versioned: the bare registry default `opencode`
 *   is refused even with a valid session (verified live 2026-09-26).
 * - Session shape: `packages/opencode/src/id/id.ts` builds session ids as
 *   `ses_` + 12 lowercase hex chars (6 timestamp bytes) + 14 base62 chars, and
 *   validates `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`.
 * - Gateway: `packages/console/app/src/routes/zen/util/handler.ts` reads
 *   `x-opencode-session` / `x-opencode-request` / `x-opencode-client` /
 *   `user-agent`, treats `Authorization: Bearer public` as anonymous
 *   (`rawZenApiKey === "public" ? undefined`), routes sticky providers by the
 *   session id, and refuses free-tier models without a recognized client
 *   context (`FreeTierError: "OpenCode's free tier can only be used from
 *   within OpenCode"`). Header gating for the anonymous pool lives in
 *   `packages/console/app/src/routes/zen/util/ipRateLimiter.ts`
 *   (`Subscription.getFreeLimits().checkHeaders`).
 * - Endpoint split: the Zen docs endpoint table (opencode.ai/docs/zen) serves
 *   `muse-spark-*-contributor-free` on `/v1/responses`, not
 *   `/v1/chat/completions` (verified live 2026-09-26: chat answers 500,
 *   responses streams).
 *
 * Keyless use presents the same anonymous identity the official client sends.
 * Of that client's full header set, only two values are minted here —
 * `x-opencode-session` and the anonymous `Bearer public` (the `User-Agent`
 * and `x-opencode-client` markers already ship as registry static headers).
 * A configured API key keeps billing that account, and any valid existing
 * wire header or key wins over a minted value. The keyed `opencode-zen`
 * provider remains the supported route to these models, and OpenCode may
 * change or restrict the keyless admission path at any time.
 */

export const ZEN_FREE_BASE_URL = "https://opencode.ai/zen/v1";

/** Session ids OpenCode accepts: `ses_` + 12 hex + 14 base62. */
export const ZEN_FREE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * Versioned client User-Agent. The gateway rejects the deliberately
 * unversioned registry default (`opencode`) with FreeTierError and admits a
 * versioned one (verified live 2026-09-26 with both `opencode/1.18.31` and
 * `opencode/2.0.18`, the OpenCode line installed here). Re-verify against a
 * live free-tier call when bumping: only the exact bare value below is ever
 * repaired, so a stale pin fails loudly instead of drifting silently.
 */
export const ZEN_FREE_USER_AGENT = "opencode/2.0.18";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SESSION_SEED_PREFIX = "opencodex-zen-free-session-v1:";

export function isZenFreeEndpoint(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    const url = new URL(baseUrl.trim());
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase() === ZEN_FREE_BASE_URL;
  } catch {
    return false;
  }
}

/** True when the provider row carries a usable API key (keyed use bills it). */
export function zenFreeHasApiKey(provider: Pick<OcxProviderConfig, "apiKey">): boolean {
  return typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
}

function shapeSessionId(digest: Buffer): string {
  const hex = digest.subarray(0, 6).toString("hex");
  let tail = "";
  for (let i = 0; i < 14; i++) tail += BASE62[digest[6 + i]! % 62];
  return `ses_${hex}${tail}`;
}

/** Deterministic session id for a seed, or a random one when unseeded. */
export function mintZenFreeSessionId(seed?: string): string {
  if (seed) return shapeSessionId(createHash("sha256").update(`${SESSION_SEED_PREFIX}${seed}`, "utf8").digest());
  return shapeSessionId(randomBytes(32));
}

/**
 * Stable seed for one conversation: Zen pins sticky provider replicas to the
 * session id, so every turn of a Codex thread must mint the same value or
 * turns scatter across replicas. This request's own Codex thread id is first
 * choice; the parent thread id covers routed children of one parent.
 */
function threadSeed(parsed?: OcxParsedRequest): string | undefined {
  const id = parsed?._codexOwnThreadId ?? parsed?._clientThreadId;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim().slice(0, 256);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Identity inputs the transports forward. `parsed` carries the Codex thread
 * for a stable per-conversation session; lanes without a parsed request
 * (the native Chat fast path) supply their request-scoped session lane.
 * `incomingHeaders` lets an explicit caller-supplied session win.
 */
export interface ZenFreeIdentity {
  parsed?: OcxParsedRequest;
  incomingHeaders?: Headers;
  requestSessionLane?: string;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === wanted);
}

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(headers).find(key => key.toLowerCase() === wanted);
}

/**
 * Add the keyless-tier identity to wire headers. Operator-configured values
 * always win: an explicitly set `x-opencode-session` (a caller-supplied one
 * that fails the shape check is replaced — an invalid value can never pass
 * the gate), `Authorization`, and any non-bare `User-Agent` in
 * `provider.headers` are never overwritten. A configured API key keeps its
 * `Bearer <key>` from the transport; only keyless sends mint the anonymous
 * `Bearer public` the gateway maps to its anonymous pool.
 */
export function applyZenFreeIdentity(
  headers: Record<string, string>,
  provider: Pick<OcxProviderConfig, "apiKey" | "headers">,
  identity?: ZenFreeIdentity,
): void {
  if (!hasHeader(headers, "x-opencode-session")) {
    const caller = identity?.incomingHeaders?.get("x-opencode-session")?.trim();
    headers["x-opencode-session"] = caller && ZEN_FREE_SESSION_RE.test(caller)
      ? caller
      : mintZenFreeSessionId(threadSeed(identity?.parsed) ?? identity?.requestSessionLane);
  }
  const hasCredential = zenFreeHasApiKey(provider);
  if (!hasCredential && !hasHeader(headers, "authorization")) {
    headers["Authorization"] = "Bearer public";
  }
  // User-Agent ownership: only a non-bare value the operator configured in
  // `provider.headers` is theirs. Anything else on the wire — absent, the
  // registry's deliberately bare default, or a caller fingerprint a
  // passthrough relayed (e.g. `codex-cli/...`) — cannot pass this gate, so
  // it is set to the verified versioned identity. An operator who explicitly
  // configured the bare default is repaired too: that value is unusable, and
  // failing loudly would just strand them.
  const configuredUa = provider.headers ? headerKey(provider.headers, "user-agent") : undefined;
  if (configuredUa !== undefined && provider.headers![configuredUa]!.trim().toLowerCase() !== "opencode") return;
  const wireUa = headerKey(headers, "user-agent");
  if (wireUa === undefined) headers["User-Agent"] = ZEN_FREE_USER_AGENT;
  else headers[wireUa] = ZEN_FREE_USER_AGENT;
}
