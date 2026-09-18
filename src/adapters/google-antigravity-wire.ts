import { createHash } from "node:crypto";
import type { OcxContentPart, OcxParsedRequest } from "../types";
import { antigravityUserAgent } from "./client-fingerprint";

/**
 * Antigravity request User-Agent. Mirrors the real Antigravity IDE UA
 * (`antigravity/ide/{ver} (aidev_client; os_type=windows; arch=amd64)`) so the request fingerprint
 * matches the OAuth credential — the prior literal `"antigravity"` was a giveaway no real client
 * sends. The IDE client family is also required to unlock newer agent models (the backend 404s
 * CLI-shaped UAs for `gemini-3.7-*`). A `GOOGLE_ANTIGRAVITY_USER_AGENT` override still wins.
 */
export const ANTIGRAVITY_REQUEST_UA = antigravityUserAgent();

/**
 * Whether a stored `OcxToolCall.thoughtSignature` is a REAL upstream Gemini signature versus a
 * foreign id that must not be forwarded to Gemini/Antigravity.
 *
 * Foreign ids that have 400'd Antigravity (`TYPE_BYTES` / Base64 decoding failed) include:
 * - Responses/bridge item ids: `fc_...`, `ctc_...` (custom_tool_call), `tsc_...` (tool_search_call),
 *   `call_...`, `rs_...`, …
 * - Anthropic tool-use ids: `toolu_...`
 *
 * Only real signatures may be forwarded — sending a foreign id as `thoughtSignature` breaks
 * multi-turn reasoning continuity. Real signatures are opaque base64-ish blobs with no
 * Responses/Anthropic id prefix.
 *
 * Note: do NOT reject a bare `sig_` / `sig-` prefix — existing Gemini replay fixtures and some
 * upstream blobs use that shape; a deny-list entry for `sig` would drop valid continuity tokens.
 */
export function isLikelyRealThoughtSignature(sig: string | undefined): boolean {
  if (typeof sig !== "string" || sig.length < 16) return false;
  // The validator-bypass sentinel is something WE fabricate for outbound requests when no real
  // signature exists. It is alphanumeric with underscores, so it would otherwise satisfy every
  // check below and be re-ingested as genuine — cached, replayed, and eventually treated as
  // evidence that a turn was signed. It is never a real signature.
  if (sig === "skip_thought_signature_validator") return false;
  // Reject synthetic Responses/tool-call ids and Anthropic tool-use ids (`_` or `-` separators).
  if (/^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|ws|toolu|tool|func|function)[-_]/i.test(sig)) return false;
  // Real Gemini thought signatures are opaque base64/base64url blobs: only [A-Za-z0-9+/_=-].
  // Anything containing other characters (or whitespace) is not a real signature.
  return /^[A-Za-z0-9+/_=-]+$/.test(sig);
}

function firstUserText(parsed: OcxParsedRequest): string | undefined {
  for (const msg of parsed.context.messages) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    const first = (msg.content as OcxContentPart[]).find(p => p.type === "text" && typeof p.text === "string");
    if (first && first.type === "text") return first.text;
  }
  return undefined;
}

/**
 * Deterministic Cloud Code Assist session id from the first user message text. Mirrors
 * CLIProxyAPI `generateStableSessionID`: sha256(firstUserText) → BigEndian uint64 masked with
 * 0x7FFFFFFFFFFFFFFF, prefixed with "-". Falls back to a random "-<digits>" id when there is no text.
 */
export function antigravitySessionId(parsed: OcxParsedRequest): string {
  // The id must be IDENTICAL on turn N and turn N+1: the replay cache observes thought signatures
  // on turn N's response and re-injects them on turn N+1's request, so a changing id loses the
  // association entirely. (A *shared* id does not — signatures are keyed on functionCall identity,
  // name+args, so cross-conversation collisions stay harmless. Instability is the failure mode.)
  //
  // First-user text does not guarantee that. It is stable only while the first user message
  // survives verbatim in what this adapter sees, and Codex compacts, summarises, and trims long
  // histories — at which point the anchor changes mid-conversation (#1295's sibling, #1297).
  //
  // `_clientThreadId` is Codex's own thread identity from `x-codex-parent-thread-id`. It survives
  // compaction because it does not depend on message content, which is the property first-user
  // text fails to provide. Deliberately NOT `promptCacheKey`: that is arbitrary Responses input
  // and is explicitly shared across conversations for some clients
  // (`adapters/cursor/request-builder.ts`), so it identifies a cache cohort, not a conversation.
  //
  // What is NOT claimed: that Google treats this id as anything but opaque, or that upstream
  // signatures are not session-bound. Only the local association is verified here.
  //
  // Clients that send no thread header keep the text anchor and its instability; this is a scoped
  // repair, not a universal one.
  const text = clientThreadAnchor(parsed) ?? firstUserText(parsed);
  if (!text) return `-${Math.floor(Math.random() * 9e18).toString()}`;
  const digest = createHash("sha256").update(text, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}

/**
 * Codex's stable client thread id, prefixed before hashing so it does not collide with a first
 * user message equal to the bare thread id.
 *
 * This is a prefix, not full domain separation: a textless-anchor request whose first message is
 * literally `codex-thread:<id>` still hashes the same preimage. Tagging BOTH anchor classes would
 * separate them completely, but it would also change every existing text-derived id — a
 * Google-visible wire value for live conversations — which is a larger blast radius than the
 * collision it removes. A collision is harmless here anyway: the replay cache keys signatures on
 * functionCall identity (name+args), so a shared id does not misattribute them. Instability, not
 * collision, is the failure mode this function exists to prevent.
 */
function clientThreadAnchor(parsed: OcxParsedRequest): string | undefined {
  // `_clientThreadId` carries `x-codex-parent-thread-id`, which every parallel child of one
  // parent presents identically, so anchoring on it alone collapsed concurrent children onto a
  // single upstream Cloud Code Assist session (#5033).
  //
  // A thread id is only unique WITHIN its parent, which is why `codexConversationIdentity` keys
  // on both. #5054 anchored on the child alone and therefore only moved the collision: two
  // parents can each have a child of the same id (#5058). The pair is the identity, joined by a
  // NUL so the encoding is injective: no Codex id contains one, so a pair cannot be re-read as a
  // different pair, nor as the parent-only anchor below.
  //
  // Deliberately NOT the general lane key: `codexConversationKeyFor` is an HMAC under a
  // process-random secret, so it changes across a proxy restart — and instability, not sharing,
  // is the failure mode this derivation has to avoid. These ids are Codex's own values and
  // survive both compaction and restart.
  const own = parsed._codexOwnThreadId?.trim();
  const parent = parsed._clientThreadId?.trim();
  if (own && parent) return `codex-thread:${parent}\u0000${own}`;
  // Parent-only clients keep the anchor they already had.
  if (parent) return `codex-thread:${parent}`;
  // A parentless ROOT deliberately omits the parent header. `src/server/context-history.ts` says
  // so in as many words: root model requests use (session-id=root, thread-id=root) and do not
  // fabricate a parent key. It has no pair to key on, and #5054's claim that a root presents
  // `thread-id` equal to its parent was simply wrong.
  //
  // So it keeps the pre-#5054 anchor rather than gaining an own-thread one. That is not a
  // preference: durable Antigravity replay state is keyed by model plus session id, and moving a
  // root's anchor on upgrade strands every signature stored under the old session — the exact
  // instability this derivation exists to avoid, introduced while fixing sharing.
  return undefined;
}

/** A Gemini content part as it appears in an Antigravity request body. */
interface GeminiPart {
  thought?: boolean;
  thoughtSignature?: string;
  thought_signature?: string;
  text?: string;
  [key: string]: unknown;
}
interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
  [key: string]: unknown;
}

function hasSignature(part: GeminiPart): boolean {
  return typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
    || typeof part.thought_signature === "string" && part.thought_signature.length > 0;
}

/**
 * Claude-on-Antigravity signature sanitization (the no-cache path). Mirrors CLIProxyAPI's
 * `StripEmptySignatureThinkingBlocks` + non-model signature stripping: drop thinking parts that
 * carry no valid signature (they would 400 upstream), and strip signature fields from non-model
 * (user) content. Mutates and returns `contents`.
 */
export function sanitizeAntigravityClaudeSignatures(contents: unknown[]): unknown[] {
  if (!Array.isArray(contents)) return contents;
  for (const raw of contents as GeminiContent[]) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.parts)) continue;
    const isModel = raw.role === "model";
    if (!isModel) {
      // Non-model parts must not carry thought signatures.
      for (const part of raw.parts) {
        delete part.thoughtSignature;
        delete part.thought_signature;
      }
      continue;
    }
    // Model turn: drop thinking blocks lacking a valid signature.
    raw.parts = raw.parts.filter(part => !(part.thought === true && !hasSignature(part)));
  }
  return contents;
}
