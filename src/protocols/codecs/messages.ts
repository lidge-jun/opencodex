/**
 * Anthropic Messages codec entry points (PF-06).
 *
 * A named surface over the existing translator; no behavior of its own.
 * `messagesToResponsesTranslation` is `anthropicToResponsesTranslation` (`src/claude/inbound.ts`)
 * with the same model resolution, budget charging and prompt-cache key derivation.
 */
import { anthropicToResponsesTranslation, type ClaudeInboundTranslation } from "../../claude/inbound";
import { featuresFromMessagesBody } from "../features";

/** Project a Messages body onto the internal Responses bridge body. */
export function messagesToResponsesTranslation(
  ...args: Parameters<typeof anthropicToResponsesTranslation>
): ClaudeInboundTranslation {
  return anthropicToResponsesTranslation(...args);
}

export const messagesFeatures = featuresFromMessagesBody;
