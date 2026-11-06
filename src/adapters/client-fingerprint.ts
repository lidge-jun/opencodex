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
import {
  CLAUDE_CLI_RUNTIME_VERSION,
  CLAUDE_CLI_SDK_PACKAGE_VERSION,
} from "../providers/claude-cli-identity";

export function stainlessOsName(platform: string = process.platform): string {
  switch (platform.toLowerCase()) {
    case "darwin":
      return "MacOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    case "freebsd":
      return "FreeBSD";
    case "openbsd":
      return "OpenBSD";
    default:
      return platform ? `Other:${platform}` : "Unknown";
  }
}

export function stainlessArchName(arch: string = process.arch): string {
  if (arch === "x64" || arch === "x86_64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  if (arch === "arm") return "arm";
  if (arch === "ia32" || arch === "x32") return "x32";
  return arch ? `other:${arch}` : "unknown";
}

// ── Claude Code CLI (matches Claude Code 2.1.280 / @anthropic-ai/sdk 0.112.1) ──
export const CLAUDE_CODE_HEADERS: Record<string, string> = {
  "X-App": "cli",
  "anthropic-dangerous-direct-browser-access": "true",
  "X-Stainless-Retry-Count": "0",
  "X-Stainless-Runtime": "node",
  "X-Stainless-Lang": "js",
  "X-Stainless-Timeout": "600",
  "X-Stainless-Arch": stainlessArchName(),
  "X-Stainless-OS": stainlessOsName(),
  "X-Stainless-Package-Version": CLAUDE_CLI_SDK_PACKAGE_VERSION,
  "X-Stainless-Runtime-Version": CLAUDE_CLI_RUNTIME_VERSION,
};

/**
 * Stable per-credential session id, matching Claude Code's `X-Claude-Code-Session-Id`. Real Claude
 * Code keeps one session id per CLI session; we derive a deterministic UUIDv4-shaped id from the
 * OAuth token and optional conversation key so concurrent conversations do not collide while turns
 * within a conversation stay stable without persisting state. The token
 * itself never leaves this function (only its hash drives the id).
 */
export function claudeCodeSessionId(token: string | undefined, sessionKey?: string | null): string {
  const seed = token && token.length > 0 ? token : "opencodex-anon";
  const conv = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const input = conv ? `claude-code-session:${seed}:conv:${conv}` : `claude-code-session:${seed}`;
  const h = createHash("sha256").update(input, "utf8").digest("hex");
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
 * The one exception is Gemini 4 Argon, which CCA serves ONLY to the CLI family; see
 * `antigravityCliUserAgent`.
 * A `GOOGLE_ANTIGRAVITY_USER_AGENT` override (set by the caller) takes precedence upstream.
 */
export function antigravityUserAgent(version = ANTIGRAVITY_IDE_VERSION, authMethod = "oauth"): string {
  const ov = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (ov) return ov;
  const [osType, arch] = ANTIGRAVITY_IDE_PLATFORM.split("/");
  return `antigravity/ide/${version} (os_type=${osType}; arch=${arch}; ${ANTIGRAVITY_IDE_CLIENT_NAME}; auth_method=${authMethod})`;
}

// ── Antigravity CLI ──
/** Antigravity CLI version whose User-Agent CCA was verified to serve Gemini 4 Argon to. */
export const ANTIGRAVITY_CLI_VERSION = "1.3.4";
const ANTIGRAVITY_CLI_PLATFORM = "darwin/arm64";

/**
 * Antigravity CLI User-Agent:
 * `antigravity/cli/${version} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`.
 *
 * Verified 2026-10-14 against live CCA: `gemini-4-argon-{low,medium,high}` answer only to this
 * family and return 404 "Requested entity was not found" to the IDE UA above, while
 * `gemini-3.7-flash-tiered` and `gemini-3.1-pro-low` 404 under this one. So it is used ONLY for
 * Argon requests, model discovery and the quota summary (whose Argon group is likewise CLI-only),
 * never as a general replacement for the IDE UA.
 *
 * `GOOGLE_ANTIGRAVITY_USER_AGENT` deliberately does not apply here: that override names the IDE
 * header, and letting it replace this one would re-lock Argon for anyone who set it.
 */
export function antigravityCliUserAgent(version = ANTIGRAVITY_CLI_VERSION, authMethod = "oauth"): string {
  const [osType, arch] = ANTIGRAVITY_CLI_PLATFORM.split("/");
  return `antigravity/cli/${version} (os_type=${osType}; arch=${arch}; ${ANTIGRAVITY_IDE_CLIENT_NAME}; auth_method=${authMethod})`;
}
