/**
 * Chat Completions codec entry points (PF-06).
 *
 * A named surface over the existing translator so an ingress calls one codec per protocol.
 * No behavior of its own: `chatToResponsesBody` is `chatCompletionsToResponsesBody`
 * (`src/chat/inbound.ts`), including its validation and the fields it drops, which
 * `src/protocols/features.ts` declares.
 */
import { chatCompletionsToResponsesBody, chatSettingsToResponsesBody } from "../../chat/inbound";
import { featuresFromChatBody } from "../features";

/** Project a Chat Completions body onto the internal Responses bridge body. */
export function chatToResponsesBody(body: unknown): Record<string, unknown> {
  return chatCompletionsToResponsesBody(body);
}

/**
 * The request settings alone, as a Responses body with an empty conversation: what the
 * Antigravity direct lane hands the Responses core while the conversation is decoded by
 * `chatConversationToIr` (`chat-ir.ts`).
 */
export function chatSettingsBody(body: unknown): Record<string, unknown> {
  return chatSettingsToResponsesBody(body);
}

export const chatFeatures = featuresFromChatBody;
