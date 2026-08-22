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
  "X-Stainless-Arch": process.arch,
  "X-Stainless-OS": process.platform,
  "X-Stainless-Package-Version": "0.74.0",
  "X-Stainless-Runtime-Version": process.version.slice(1),
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

// ── Antigravity IDE ──
/** Pinned fallback Antigravity IDE language-server version (matches the bundled LS 2.5.5). */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";
const ANTIGRAVITY_IDE_CLIENT_NAME = "aidev_client";
const ANTIGRAVITY_IDE_PLATFORM = "windows/amd64";

/**
 * Real Antigravity IDE User-Agent format, decompiled from 2.5.5 Go LS (`setHeaders` @ `0x1018fbe00`):
 * `antigravity/ide/${version} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`
 *
 * Token ordering from decompiled binary: `os_type` -> `arch` -> `aidev_client` -> `auth_method=oauth`.
 *
 * Must be the IDE client family (`antigravity/ide/...`): Cloud Code Assist backend gates
 * newer agent models (e.g. `gemini-3.7-flash`) by User-Agent and answers 404 NOT_FOUND to
 * CLI-shaped UAs even with a valid OAuth token. Only `antigravity/ide/<ver>` unlocks them.
 * A `GOOGLE_ANTIGRAVITY_USER_AGENT` override (set by the caller) takes precedence upstream.
 */
export function antigravityUserAgent(version = ANTIGRAVITY_IDE_VERSION, authMethod = "oauth"): string {
  const ov = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (ov) return ov;
  const [osType, arch] = ANTIGRAVITY_IDE_PLATFORM.split("/");
  return `antigravity/ide/${version} (os_type=${osType}; arch=${arch}; ${ANTIGRAVITY_IDE_CLIENT_NAME}; auth_method=${authMethod})`;
}
