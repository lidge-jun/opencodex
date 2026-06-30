/**
 * First-party client fingerprints.
 *
 * Routed OAuth providers reject — or quietly flag — requests whose header signature doesn't match
 * the real first-party client that minted the token. Sending a valid OAuth token with an empty
 * header set (or a giveaway literal UA like "antigravity") is a non-first-party signature. These
 * constants mirror the headers the real Claude Code CLI and Antigravity CLI send, so the proxy's
 * request fingerprint matches the credential.
 *
 * Pinned versions live HERE (single source) so they're trivial to bump. Values that need a live
 * manifest fetch (Antigravity auto-updater) or a cryptographic billing signature (Claude cch) are
 * intentionally NOT modeled — those are brittle and a wrong guess does more harm than the gap.
 */
import { createHash } from "node:crypto";

// ── Claude Code CLI (matches Claude Code 2.1.63 / @anthropic-ai/sdk 0.74.0) ──
export const CLAUDE_CODE_HEADERS: Record<string, string> = {
  "X-App": "cli",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Timeout": "600",
};

/**
 * Stable per-credential session id, matching Claude Code's `X-Claude-Code-Session-Id`. Real Claude
 * Code keeps one session id per CLI session; we derive a deterministic UUIDv4-shaped id from the
 * OAuth token so it stays stable across a conversation's turns without persisting state. The token
 * itself never leaves this function (only its hash drives the id).
 */
export function claudeCodeSessionId(token: string | undefined): string {
  const seed = token && token.length > 0 ? token : "opencodex-anon";
  const h = createHash("sha256").update(`claude-code-session:${seed}`, "utf8").digest("hex");
  // Shape the hash into a v4-looking UUID (version nibble 4, variant nibble 8-b).
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── Antigravity CLI ──
/** Pinned fallback Antigravity CLI version (real client fetches a manifest; we pin to avoid the network dependency). */
export const ANTIGRAVITY_CLI_VERSION = "1.0.13";
const ANTIGRAVITY_CLI_CLIENT_NAME = "aidev_client";
const ANTIGRAVITY_CLI_PLATFORM = "darwin/arm64";
/** Secondary Google API client UA the Antigravity client library reports. */
export const ANTIGRAVITY_GOOG_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";

/**
 * The real Antigravity CLI User-Agent, e.g.
 * `antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)`.
 * A `GOOGLE_ANTIGRAVITY_USER_AGENT` override (set by the caller) takes precedence upstream.
 */
export function antigravityUserAgent(version = ANTIGRAVITY_CLI_VERSION): string {
  const [osType, arch] = ANTIGRAVITY_CLI_PLATFORM.split("/");
  return `antigravity/cli/${version} (${ANTIGRAVITY_CLI_CLIENT_NAME}; os_type=${osType}; arch=${arch})`;
}
