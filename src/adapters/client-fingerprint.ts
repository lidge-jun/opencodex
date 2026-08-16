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
// Decompiled Antigravity 2.5.5 arm64 (1.107.0, language_server_macos_arm 126MB Go1.26.5, __lrodata_gopcln 37MB):
// - gosym NewTable 126300 funcs:
//   IDE GetUserAgentName 0x1018e9a70 sz48, CLI 0x1018ec950 sz48, Hub 0x1018ef450 sz48 (identical bytes)
//   0x1018e9a70: adrp x27,#0x107b91000; add #0x880 -> bss override (SetUserAgentNameOverride @ override_user_agent_name 0x254cd06)
//            ldp x2,x3,[x27]; cmp x3,#0; mov x4,#0xb; csel x1,x3,x4,ne; adrp x3,#0x102472000; add #0xc7b; csel x0,x2,x3,ne; ret
//   fallback va 0x102472c7b fileoff 0x2472c7b len 0xb (11) => "antigravity" (616e746967726176697479)
//   raw "antigravity-ide" @0x24c59ab va 0x1024c59ab count2 doc "**IDE**: `antigravity-ide/`" ADRP page 0x1024c5000+0x9ab exact 0 hits
//   "antigravity/ide" count0, "aidev_client" 1 (log cloudcode-paaidev_client), windows/amd64 0
// - x-goog-api-client: raw count1 @0x24ea019 "generationConfig.x-goog-api-clientsystemInstruction" false positive,
//   ADRP page 0x1024ea000 0 hits, google-api-nodejs-client 0, gl-node 0, Client-Metadata 0
// - SetHTTPHeaders: IDE 0x1018e9ca0 16 ret, Standalone 0x1018ea350 16 ret, Stubby 0x1018f01d0 16 ret,
//   CLI 0x1018ecfc0 704 1 ADRP X-Goog-User-Project @0x1018ed1b8, Hub 0x1018ef6d0 832 cloudcode-paaidev_client + X-Goog-User-Project,
//   no UA/x-goog-api-client ADRP (capstone 69 hits for User-Agent page 0x1024d7000 are other strings)
// 2.0.3 x64 private ("antigravity-ide" LEA RDX,[RIP-0x284fc90]->0x367b554, -override_user_agent @0x5ecbc37) is stale.
/** Pinned fallback Antigravity IDE language-server version (metadata only, not UA). */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";
/** Deprecated: not sent on wire (decompiled 0 hits). Kept for compat. */
export const ANTIGRAVITY_GOOG_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";

/**
 * Real Antigravity IDE User-Agent: literal "antigravity" (11).
 * Decompiled 2.5.5 fallback len 0xb; override via GOOGLE_ANTIGRAVITY_USER_AGENT / PI_AI_ANTIGRAVITY_USER_AGENT
 * (flag override_user_agent_name @0x254cd06, SetUserAgentNameOverride sets bss 0x107b91880).
 */
export function antigravityUserAgent(_version?: string): string {
  const ov = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim()
    || process.env.PI_AI_ANTIGRAVITY_USER_AGENT?.trim();
  if (ov) return ov;
  return "antigravity";
}
