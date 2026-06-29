import { createHash } from "node:crypto";
import type { OcxContentPart, OcxParsedRequest } from "../types";

/** Antigravity request User-Agent (overridable). Mirrors the Antigravity desktop client UA. */
export const ANTIGRAVITY_REQUEST_UA = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT || "antigravity";

/**
 * Whether a stored `OcxToolCall.thoughtSignature` is a REAL upstream Gemini signature versus a
 * synthetic Responses item id (`fc_...`, `call_...`, `rs_...`, etc) that the bridge/parser stashes
 * on the field. Only real signatures may be forwarded to Gemini/Antigravity — sending a synthetic
 * id as `thoughtSignature` breaks multi-turn reasoning continuity (upstream rejects it). Real
 * signatures are opaque base64-ish blobs with no Responses-id prefix.
 */
export function isLikelyRealThoughtSignature(sig: string | undefined): boolean {
  if (typeof sig !== "string" || sig.length < 16) return false;
  // Reject synthetic Responses/tool-call ids in both `_` and `-` separated spellings
  // (e.g. `fc_...`, `call_...`, `function-call-...`, `tool-call-...`).
  if (/^(fc|call|msg|rs|resp|reasoning|item|ws|tool|func|function)[-_]/i.test(sig)) return false;
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
  // Anchored on the first user message text: this is the one value that stays STABLE across every
  // turn of a conversation, which the replay cache requires (it observes signatures on turn N's
  // response and re-injects them on turn N+1's request, so both turns must map to the same id).
  // Cross-conversation collisions (two threads opening with identical text) are made harmless by
  // the replay cache keying signatures on functionCall identity (name+args), not on this id alone.
  const text = firstUserText(parsed);
  if (!text) return `-${Math.floor(Math.random() * 9e18).toString()}`;
  const digest = createHash("sha256").update(text, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
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
