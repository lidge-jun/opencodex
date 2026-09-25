/**
 * Chat Completions codec entry points (PF-06).
 *
 * A named surface over the existing translator so an ingress calls one codec per protocol.
 * No behavior of its own: `chatToResponsesBody` is `chatCompletionsToResponsesBody`
 * (`src/chat/inbound.ts`), including its validation and the fields it drops, which
 * `src/protocols/features.ts` declares.
 */
import { chatCompletionsToResponsesBody } from "../../chat/inbound";
import { featuresFromChatBody } from "../features";

/** Project a Chat Completions body onto the internal Responses bridge body. */
export function chatToResponsesBody(body: unknown): Record<string, unknown> {
  return chatCompletionsToResponsesBody(body);
}

export const chatFeatures = featuresFromChatBody;
