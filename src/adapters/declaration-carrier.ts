// Type-only: erased at compile time, so this does not create an import cycle with the registry.
import type { AdapterWire } from "./registry";
import type { OcxMessage, OcxParsedRequest } from "../types";
import { toolRestrictsCallers } from "../types";

/**
 * Wires that can actually carry a constraint, as a default-deny allowlist.
 *
 * A per-adapter opt-in is the wrong shape for this: an adapter that never learned about a
 * carrier rebuilds the declaration or the message without it and returns a normal completion,
 * which is exactly the silent widening this batch exists to remove. Listing the wires that CAN
 * carry it means a new wire refuses until someone teaches it, and adding a member to
 * `AdapterWire` makes the omission visible here rather than at a customer's upstream.
 */
const CALLER_RESTRICTION_WIRES: ReadonlySet<AdapterWire> = new Set<AdapterWire>(["anthropic"]);
const INLINE_DOCUMENT_WIRES: ReadonlySet<AdapterWire> = new Set<AdapterWire>([
  "anthropic",
  "openai-chat",
  "google",
]);

/** A fixed-vocabulary refusal, or `undefined` when this wire can hold everything the request carries. */
export function unrepresentableDeclaration(parsed: OcxParsedRequest, wire: AdapterWire): string | undefined {
  if (!CALLER_RESTRICTION_WIRES.has(wire) && parsed.context.tools?.some(toolRestrictsCallers)) {
    // The name is deliberately absent: it is caller-controlled and would put client metadata
    // into an error body.
    return "OpenCodex cannot express tools[].allowed_callers on this route. "
      + "Route the request to an Anthropic-protocol provider, or remove the caller restriction.";
  }
  if (!INLINE_DOCUMENT_WIRES.has(wire) && parsed.context.messages.some(carriesDocument)) {
    return "OpenCodex cannot translate document input on this route. "
      + "Use a native input wire that supports the attachment, or convert it to text first.";
  }
  return undefined;
}

/**
 * Typed structurally rather than as `OcxContentPart[]`: an assistant turn's content is
 * `OcxAssistantContentPart[]`, which carries thinking and tool-call members and is not
 * assignable to the user-content union. Only the discriminant is read here.
 */
function carriesDocument(message: OcxMessage): boolean {
  const content: unknown = message.content;
  return Array.isArray(content) && (content as ReadonlyArray<{ type: string }>).some(part => part.type === "document");
}
