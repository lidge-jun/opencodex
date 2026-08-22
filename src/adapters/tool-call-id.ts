import { createHash } from "node:crypto";

/**
 * Anthropic rejects a `tool_use.id` longer than this. Collision disambiguation has to fit
 * inside it too, which is why candidates are assembled from parts instead of sliced at the end.
 */
export const MAX_TOOL_CALL_ID_LENGTH = 64;

/** Hex characters of the deterministic tail. Fixed width: it is a discriminator, not a payload. */
const TOOL_CALL_ID_HASH_WIDTH = 8;

const CONFORMING_TOOL_CALL_ID = /^[a-zA-Z0-9_-]+$/;

/** An id Anthropic accepts as-is: right character set AND within the length bound. */
export function isConformingToolCallId(rawId: string): boolean {
  return rawId.length > 0
    && rawId.length <= MAX_TOOL_CALL_ID_LENGTH
    && CONFORMING_TOOL_CALL_ID.test(rawId);
}

/**
 * The parts a rewritten id is built from: the sanitized prefix and a deterministic tail
 * derived from the raw id. Kept separate so collision handling can truncate the prefix
 * without destroying the discriminator.
 */
function toolCallIdComponents(rawId: string | undefined): { cleaned: string; hash: string } | undefined {
  const raw = rawId ?? "";
  if (raw.length === 0) return undefined;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, TOOL_CALL_ID_HASH_WIDTH);
  return { cleaned, hash };
}

/** Assemble `prefix_hash`, truncating only the prefix, leaving `reserve` characters spare. */
function fitToolCallId(cleaned: string, hash: string, reserve = 0): string {
  const tail = `_${hash}`;
  const room = MAX_TOOL_CALL_ID_LENGTH - reserve - tail.length;
  return cleaned.slice(0, Math.max(1, room)) + tail;
}

/**
 * Normalize a tool call id into the character set and length Anthropic accepts.
 *
 * This is the stateless view, kept for callers that only need the shape of one id. It is NOT
 * injective on its own: `anthropicToolCallId("call:a")` returns something like `call_a_1f2e3d4c`,
 * and a raw id that already equals that value is returned unchanged — two distinct sources, one
 * wire id. Anything building a whole request must use {@link createToolCallIdAllocator}, which
 * reserves the conforming ids first and resolves collisions.
 *
 * Returns `undefined` for an empty id. Callers must handle that rather than falling back to the
 * raw value: restoring `""` puts an id on the wire that Anthropic rejects (#1767).
 */
export function anthropicToolCallId(rawId: string | undefined): string | undefined {
  const raw = rawId ?? "";
  if (raw.length === 0) return undefined;
  if (isConformingToolCallId(raw)) return raw;
  const parts = toolCallIdComponents(raw);
  if (!parts) return undefined;
  return fitToolCallId(parts.cleaned, parts.hash);
}

export type ToolCallIdAllocator = {
  /** Claim an already-conforming source id so no rewrite can be handed the same value. */
  reserve(rawId: string | undefined): void;
  /** Wire id for a raw id, stable within the request. `undefined` means "not representable". */
  allocate(rawId: string | undefined): string | undefined;
  /** Wire id previously allocated for this raw id, without creating one. */
  lookup(rawId: string | undefined): string | undefined;
};

/**
 * Request-scoped raw-id to wire-id mapping.
 *
 * Two properties the stateless transform cannot provide:
 *
 * - **Injective.** Reserve every already-conforming id first, then allocate rewrites around them,
 *   appending a numeric suffix when a candidate is taken. Two distinct raw ids never share a wire id,
 *   including the case where one raw id already looks like another's normalized form, and including
 *   an ordinary 32-bit hash collision.
 * - **Stable.** A tool result asks for the same raw id its call used and gets the same wire id, so
 *   call/result pairing survives normalization.
 */
export function createToolCallIdAllocator(): ToolCallIdAllocator {
  const rawToWire = new Map<string, string>();
  const occupied = new Set<string>();

  return {
    reserve(rawId) {
      if (!rawId || rawToWire.has(rawId)) return;
      if (!isConformingToolCallId(rawId)) return;
      rawToWire.set(rawId, rawId);
      occupied.add(rawId);
    },
    allocate(rawId) {
      if (!rawId) return undefined;
      const existing = rawToWire.get(rawId);
      if (existing) return existing;
      if (isConformingToolCallId(rawId) && !occupied.has(rawId)) {
        rawToWire.set(rawId, rawId);
        occupied.add(rawId);
        return rawId;
      }
      const parts = toolCallIdComponents(rawId);
      if (!parts) return undefined;
      let candidate = fitToolCallId(parts.cleaned, parts.hash);
      for (let n = 2; occupied.has(candidate); n++) {
        const suffix = `_${n}`;
        candidate = fitToolCallId(parts.cleaned, parts.hash, suffix.length) + suffix;
      }
      rawToWire.set(rawId, candidate);
      occupied.add(candidate);
      return candidate;
    },
    lookup(rawId) {
      if (!rawId) return undefined;
      return rawToWire.get(rawId);
    },
  };
}
