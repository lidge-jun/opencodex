/**
 * Codex pool account-change conversation-state portability (#4546).
 *
 * OpenAI `encrypted_content` blobs and `previous_response_id` are bound to the
 * account that minted them. When pool routing serves a live conversation on a
 * different account, the next turn must drop that state once before dispatch so
 * the new account can continue from readable history instead of rejecting the
 * ciphertext.
 *
 * The issuer association lives next to thread affinity in `src/codex/routing.ts`.
 */

import type { CodexAuthContext } from "../../codex/auth-context";
import {
  peekConversationStateIssuer,
  rememberConversationStateIssuer,
} from "../../codex/routing";
import type { OcxParsedRequest } from "../../types";
import type { RequestLogContext } from "../request-log";

export type ConversationStateScrubReason = "account-change";

export type PortabilityDenial =
  | "previous-response-id"
  | "provider-conversation-id"
  | "uploaded-file-ids"
  | "encrypted-reasoning";

/**
 * The parts of a request that bind it to the credential that produced them.
 * Presence is what matters; the values stay opaque so nothing here logs ids.
 */
export interface ConversationStateCarriers {
  readonly previousResponseId?: string | null;
  readonly providerConversationId?: string | null;
  readonly fileIds?: readonly string[];
  readonly encryptedReasoning?: unknown;
}

export type PortabilityVerdict =
  | { readonly portable: true }
  | { readonly portable: false; readonly reason: PortabilityDenial };

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Whether a request's conversational state can move credentials at all.
 *
 * `src/routing/identity-domains.ts` owns this decision once that module lands
 * on this integration line (#4546). Keep the check in this one function so it
 * can be swapped for the shared export without hunting call sites.
 */
export function canPortConversationState(
  state: ConversationStateCarriers,
): PortabilityVerdict {
  if (present(state.previousResponseId)) {
    return { portable: false, reason: "previous-response-id" };
  }
  if (present(state.providerConversationId)) {
    return { portable: false, reason: "provider-conversation-id" };
  }
  if (present(state.fileIds)) {
    return { portable: false, reason: "uploaded-file-ids" };
  }
  if (present(state.encryptedReasoning)) {
    return { portable: false, reason: "encrypted-reasoning" };
  }
  return { portable: true };
}

function providerConversationIdFromBody(body: Record<string, unknown>): string | undefined {
  const conversation = body.conversation;
  if (typeof conversation === "string" && conversation.trim()) return conversation.trim();
  if (conversation && typeof conversation === "object" && !Array.isArray(conversation)) {
    const id = (conversation as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return undefined;
}

function collectFileIds(input: unknown): string[] {
  const ids: string[] = [];
  if (!Array.isArray(input)) return ids;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.file_id === "string" && record.file_id.trim()) ids.push(record.file_id);
    if (Array.isArray(record.file_ids)) {
      for (const id of record.file_ids) {
        if (typeof id === "string" && id.trim()) ids.push(id);
      }
    }
    for (const key of ["content", "output"]) {
      const parts = record[key];
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const partRecord = part as Record<string, unknown>;
        if (typeof partRecord.file_id === "string" && partRecord.file_id.trim()) {
          ids.push(partRecord.file_id);
        }
      }
    }
  }
  return ids;
}

function hasEncryptedReasoning(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.encrypted_content === "string" && record.encrypted_content.length > 0) {
      return true;
    }
    for (const key of ["content", "output"]) {
      const parts = record[key];
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        const encrypted = (part as { encrypted_content?: unknown }).encrypted_content;
        if (typeof encrypted === "string" && encrypted.length > 0) return true;
      }
    }
  }
  return false;
}

export function collectConversationStateCarriers(body: unknown): ConversationStateCarriers {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const previousResponseId = typeof record.previous_response_id === "string"
    ? record.previous_response_id
    : undefined;
  return {
    previousResponseId,
    providerConversationId: providerConversationIdFromBody(record),
    fileIds: collectFileIds(record.input),
    encryptedReasoning: hasEncryptedReasoning(record.input) ? true : undefined,
  };
}


/**
 * Drop account-bound continuation from a request body in place. Readable user
 * messages and plaintext survive; ciphertext and continuation ids do not.
 */
export function scrubUnportableConversationStateInPlace(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  let changed = false;
  if (typeof record.previous_response_id === "string") {
    delete record.previous_response_id;
    changed = true;
  }
  if (record.conversation != null) {
    delete record.conversation;
    changed = true;
  }
  // Encrypted reasoning and compaction ciphertext are deliberately NOT touched here. #2247
  // already strips them when a pooled thread moves accounts, and in a specific shape: the
  // reasoning item keeps its readable summary with an emptied content array, and the compaction
  // item becomes an operator-readable note. Stripping again from this side produced a different
  // shape and broke that contract for no gain. What #2247 does not cover, and what this function
  // owns, is the continuation state naming server-side objects the new account cannot read:
  // `previous_response_id` and a provider-side conversation id.
  return changed;
}

export function conversationStateBindingFromAuth(
  authCtx: CodexAuthContext,
  fallbackAffinityKey?: string | null,
): { accountId: string; bindingKey: string } | null {
  if (authCtx.kind !== "pool" && authCtx.kind !== "main-pool") return null;
  const bindingKey = authCtx.affinityKey ?? fallbackAffinityKey ?? undefined;
  if (!bindingKey || !authCtx.accountId) return null;
  return { accountId: authCtx.accountId, bindingKey };
}

export function rememberServingConversationStateIssuer(
  authCtx: CodexAuthContext,
  fallbackAffinityKey?: string | null,
): void {
  const binding = conversationStateBindingFromAuth(authCtx, fallbackAffinityKey);
  if (!binding) return;
  rememberConversationStateIssuer(binding.bindingKey, binding.accountId);
}

export interface ApplyAccountChangeConversationStateScrubArgs {
  body: unknown;
  bindingKey: string;
  servingAccountId: string;
  /** Account this request body was prepared for, when this is an in-request move. */
  priorAccountId?: string | null;
  parsed?: Pick<OcxParsedRequest, "previousResponseId" | "_stripReasoningEncryptedContent">;
  logCtx?: RequestLogContext;
}

/**
 * If the serving account is not the issuer of the carried state, strip that
 * state from the outbound body before dispatch. One cold turn, not a permanent
 * downgrade: the next successful serve records the new issuer.
 */
export function applyAccountChangeConversationStateScrub(
  args: ApplyAccountChangeConversationStateScrubArgs,
): boolean {
  const { body, bindingKey, servingAccountId, priorAccountId, parsed, logCtx } = args;
  if (!servingAccountId || !bindingKey) return false;
  const issuer = peekConversationStateIssuer(bindingKey);
  const accountChanged = (issuer != null && issuer !== servingAccountId)
    || (priorAccountId != null && priorAccountId !== servingAccountId);
  if (!accountChanged) return false;
  if (canPortConversationState(collectConversationStateCarriers(body)).portable) return false;
  const scrubbed = scrubUnportableConversationStateInPlace(body);
  if (!scrubbed) return false;
  if (parsed) {
    delete parsed.previousResponseId;
    parsed._stripReasoningEncryptedContent = true;
  }
  if (logCtx && logCtx.conversationStateScrub !== "account-change") {
    console.warn(
      "[opencodex] dropped continuation state after a Codex pool account change; continuing fresh",
    );
    logCtx.conversationStateScrub = "account-change";
  } else if (logCtx) {
    logCtx.conversationStateScrub = "account-change";
  }
  return true;
}
