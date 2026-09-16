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
import { formatErrorResponse } from "../../bridge/errors";

export type ConversationStateScrubReason = "account-change";

/**
 * Cause AND remedy, because this refusal does not clear itself.
 *
 * Dropping a `previous_response_id` costs one cold turn and the conversation continues. This is
 * not that. The file reference lives in the conversation's history, so once pool rotation has
 * moved a conversation carrying an attachment, every following turn presents the same reference
 * and is refused the same way. A caller told only that the reference is invalid will send the
 * same request back and watch the conversation appear dead, which is the one outcome a refusal
 * is supposed to prevent. So the text says what happened, that it will keep happening, and the
 * two things that actually end it.
 *
 * Names no account id, no file id, and no conversation id.
 */
export const ACCOUNT_CHANGE_FILE_SCOPE_MESSAGE =
  "This conversation is now being served by a different account than the one its uploaded files "
  + "were sent to, and an uploaded file can only be read by the account that received it. The "
  + "request was not sent upstream, and no file was removed from it. Because the references stay "
  + "in this conversation's history, later turns will be refused the same way until this is "
  + "resolved: re-upload the files so they are issued by the account now serving this "
  + "conversation, or start a new conversation for them. Sending the same request again "
  + "unchanged will not clear it.";

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
 * Does this body reference an uploaded file?
 *
 * Answerable from the body alone, which is what lets an alternate-account path ask BEFORE it
 * resolves an alternate: the answer cannot depend on which account is chosen, because an
 * uploaded file is readable only by the account it was sent to (#4710).
 *
 * `fileIds` is optional on the carrier type, so the emptiness test lives here rather than being
 * rewritten at each caller. One of those rewrites already dereferenced it directly.
 */
export function conversationCarriesUploadedFiles(body: unknown): boolean {
  const fileIds = collectConversationStateCarriers(body).fileIds;
  return fileIds !== undefined && fileIds.length > 0;
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

/**
 * Refuse an account change that would carry an uploaded-file reference to an account that
 * cannot read it (#4710).
 *
 * The classifier has always called `file_id` account-bound, and the scrubber has always removed
 * only `previous_response_id` and `conversation`. A body whose ONLY account-bound state was an
 * uploaded file therefore reported nothing scrubbed and was replayed unchanged against the new
 * account, which is the one case the safety fix was supposed to cover.
 *
 * Deleting the references is not the fix. A file reference is not continuation state the model
 * can do without: it is content the caller attached, and silently dropping it answers a
 * different question than the one that was asked, with no way for the caller to tell. Pinning
 * the request to the issuing account is not available either — every call site resolves and
 * materialises its credential before reaching here, and the retry sites are reached precisely
 * because the issuing account just refused the request.
 *
 * So the move is refused, before dispatch, and the caller is told exactly what to do about it.
 * A 400 rather than a 409: re-uploading is required, and a retryable status would invite the
 * same request back unchanged.
 */
export function accountChangeFileReferenceRefusal(
  args: Pick<ApplyAccountChangeConversationStateScrubArgs, "body" | "bindingKey" | "servingAccountId" | "priorAccountId">,
): Response | undefined {
  const { body, bindingKey, servingAccountId, priorAccountId } = args;
  if (!servingAccountId || !bindingKey) return undefined;
  const issuer = peekConversationStateIssuer(bindingKey);
  const accountChanged = (issuer != null && issuer !== servingAccountId)
    || (priorAccountId != null && priorAccountId !== servingAccountId);
  if (!accountChanged) return undefined;
  // Checked against the carriers directly rather than through the portability verdict: that
  // verdict reports the FIRST reason it finds, so a body carrying both a previous response id
  // and a file reference reports only the former and the file would slip through the scrub.
  if (!conversationCarriesUploadedFiles(body)) return undefined;
  return formatErrorResponse(400, "invalid_request_error", ACCOUNT_CHANGE_FILE_SCOPE_MESSAGE);
}
