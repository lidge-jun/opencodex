import { ENCRYPTED_FUNCTION_OUTPUT_REJECTION, upstreamErrorMessageFromPayload } from "../../lib/errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { isReasoningEffortRejection } from "../../providers/reasoning-metadata";
import { isAnthropicFastRefusal } from "../../providers/anthropic-fast";
import type { AdapterRequest } from "../../adapters/base";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import type { OcxParsedRequest } from "../../types";
import type { RequestLogContext } from "../request-log";
import type { AttemptRecoveryKind } from "../../usage/log";
import { rememberReasoningReplayOpaqueBlobRejection } from "../../responses/reasoning-replay-cache";
import { resolvedAdapterWire } from "../../responses/continuation-ownership";

export const OPAQUE_RESPONSES_INPUT_TYPES = new Set([
  "reasoning",
  "compaction",
  "compaction_summary",
  "context_compaction",
]);

export const FUNCTION_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

// codex-app subagent results replay as agent_message items whose content parts may carry
// backend-minted encrypted_content; the ChatGPT backend decrypts them in its function-output
// path, so a cross-identity replay of those parts produces ENCRYPTED_FUNCTION_OUTPUT_REJECTION.
export const AGENT_MESSAGE_TYPE = "agent_message";


/**
 * Whether the adapter serving this send speaks the Responses wire, as the adapter registry
 * declares it.
 *
 * Recovery used to compare the adapter name with `"openai-responses"`. Azure OpenAI wraps the same
 * passthrough under its own name, so an `invalid_encrypted_content` after moving a conversation
 * onto Azure never recovered (#5583). The registry already records that relationship as
 * `contractParent: "openai-responses"`, so reading the resolved wire covers Azure and any later
 * wrapper of the same contract by construction, while every translated wire stays excluded.
 */
export function adapterSpeaksResponsesWire(adapterName: string): boolean {
  return resolvedAdapterWire(adapterName) === "openai-responses";
}


export function encryptedFunctionOutputParts(output: unknown): boolean {
  return Array.isArray(output) && output.some(part => (
    part !== null
    && typeof part === "object"
    && !Array.isArray(part)
    && (part as { type?: unknown }).type === "encrypted_content"
    && typeof (part as { encrypted_content?: unknown }).encrypted_content === "string"
    && (part as { encrypted_content: string }).encrypted_content.length > 0
  ));
}


export function outboundResponsesInput(bodyText: string | undefined): unknown[] | undefined {
  if (!bodyText) return undefined;
  try {
    const body = JSON.parse(bodyText) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    const input = (body as { input?: unknown }).input;
    return Array.isArray(input) ? input : undefined;
  } catch {
    return undefined;
  }
}


export function outboundResponsesBodyCarriesEncryptedFunctionOutput(bodyText: string | undefined): boolean {
  const input = outboundResponsesInput(bodyText);
  if (!input) return false;
  return input.some(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const candidate = item as { type?: unknown; output?: unknown; content?: unknown };
    const type = String(candidate.type ?? "");
    if (FUNCTION_OUTPUT_TYPES.has(type) && encryptedFunctionOutputParts(candidate.output)) return true;
    return type === AGENT_MESSAGE_TYPE && encryptedFunctionOutputParts(candidate.content);
  });
}


export function outboundResponsesBodyCarriesOpaqueBlob(bodyText: string | undefined): boolean {
  const input = outboundResponsesInput(bodyText);
  if (!input) return false;
  return input.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const candidate = item as { type?: unknown; encrypted_content?: unknown; output?: unknown };
    if (
      typeof candidate.type === "string"
      && OPAQUE_RESPONSES_INPUT_TYPES.has(candidate.type)
      && typeof candidate.encrypted_content === "string"
      && candidate.encrypted_content.length > 0
    ) return true;
    if (
      typeof candidate.type === "string"
      && FUNCTION_OUTPUT_TYPES.has(candidate.type)
      && encryptedFunctionOutputParts(candidate.output)
    ) return true;
    return candidate.type === AGENT_MESSAGE_TYPE
      && encryptedFunctionOutputParts((candidate as { content?: unknown }).content);
  });
}


export function isEncryptedFunctionOutputRejection(bodyText: string): boolean {
  if (bodyText.trim() === ENCRYPTED_FUNCTION_OUTPUT_REJECTION) return true;
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    if (upstreamErrorMessageFromPayload(payload) === ENCRYPTED_FUNCTION_OUTPUT_REJECTION) return true;
    const record = payload as { detail?: unknown; message?: unknown; error?: unknown };
    if (record.detail === ENCRYPTED_FUNCTION_OUTPUT_REJECTION) return true;
    if (record.message === ENCRYPTED_FUNCTION_OUTPUT_REJECTION) return true;
    if (record.error === ENCRYPTED_FUNCTION_OUTPUT_REJECTION) return true;
    return record.error !== null
      && typeof record.error === "object"
      && !Array.isArray(record.error)
      && (record.error as { message?: unknown }).message === ENCRYPTED_FUNCTION_OUTPUT_REJECTION;
  } catch {
    return false;
  }
}


/**
 * #4469: reasoning encrypted_content is minted per caller identity, so replaying it under a
 * different caller is rejected with "reasoning `encrypted_content` was not issued to this
 * caller". Substring checks tolerate the optional backticks and a leading or trailing
 * sentence, while the "was not issued to this caller" anchor plus an encrypted-content or
 * reasoning subject keep unrelated invalid_request_error prose from gaining a hidden resend.
 */
export function isReasoningBlobCallerMismatchMessage(message: string): boolean {
  if (!message.includes("was not issued to this caller")) return false;
  return message.includes("encrypted_content") || message.includes("reasoning");
}


/**
 * Longest embedded payload this will parse. The wrapper is a short error envelope; anything
 * larger is not the shape being matched, and refusing to walk it keeps an upstream-controlled
 * string from deciding how much work the classifier does.
 */
const LITELLM_EMBEDDED_PAYLOAD_LIMIT = 16_384;
const LITELLM_WRAPPER_PREFIX = "litellm.BadRequestError:";
const LITELLM_WRAPPER_MARKER = "OpenAIException - ";

/**
 * The JSON an OpenAI-compatible gateway embeds in its own error message, or undefined.
 *
 * Brace-aware rather than a regex because the embedded object legitimately contains braces and
 * escaped quotes inside its message, and the gateway appends its own prose after the closing
 * brace. Counting depth outside string literals is the only way to find the real end.
 */
function liteLlmEmbeddedErrorPayload(message: string): unknown {
  if (!message.startsWith(LITELLM_WRAPPER_PREFIX)) return undefined;
  const markerIndex = message.indexOf(LITELLM_WRAPPER_MARKER);
  if (markerIndex < 0) return undefined;
  const start = message.indexOf("{", markerIndex + LITELLM_WRAPPER_MARKER.length);
  if (start < 0) return undefined;
  const end = Math.min(message.length, start + LITELLM_EMBEDDED_PAYLOAD_LIMIT);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < end; index += 1) {
    const character = message[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(message.slice(start, index + 1)) as unknown; } catch { return undefined; }
      }
    }
  }
  return undefined;
}


/** True for an error message that is a gateway envelope rather than an upstream's own wording. */
function isLiteLlmEnvelopeMessage(message: string): boolean {
  return message.startsWith(LITELLM_WRAPPER_PREFIX) && message.includes(LITELLM_WRAPPER_MARKER);
}


/**
 * An OpenAI-compatible gateway relaying the one authoritative ciphertext rejection inside its
 * own error string.
 *
 * Deliberately narrower than {@link isSelfIdentifiedOpaqueBlobRejection}. The embedded payload is
 * matched against exactly one identity -- `invalid_request_error` carrying
 * `invalid_encrypted_content` -- and the generic classifier is NOT re-run against it. Re-running
 * it would let every other opaque identity arrive through the wrapper as well: the code-less
 * unverifiable-ciphertext wording, the #4469 caller mismatch, and the two xAI decoder strings.
 * Each of those was admitted on evidence from a specific upstream about how that upstream words
 * its own rejection, and a gateway in between is not that evidence. Only the coded identity is
 * unambiguous enough to survive relaying.
 */
export function isLiteLlmWrappedCiphertextRejection(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const outer = (payload as { error?: unknown }).error;
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return false;
  const message = (outer as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  const embedded = liteLlmEmbeddedErrorPayload(message);
  if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) return false;
  const inner = (embedded as { error?: unknown }).error;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return false;
  const { type, code } = inner as { type?: unknown; code?: unknown };
  return type === "invalid_request_error" && code === "invalid_encrypted_content";
}


export function isSelfIdentifiedOpaqueBlobRejection(bodyText: string): boolean {
  if (isEncryptedFunctionOutputRejection(bodyText)) return true;
  try {
    if (upstreamErrorMessageFromPayload(JSON.parse(bodyText) as unknown) === ENCRYPTED_FUNCTION_OUTPUT_REJECTION) {
      return true;
    }
  } catch {
    /* invalid JSON bodies fall through to the exact nested envelope checks */
  }
  try {
    const payload = JSON.parse(bodyText) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const record = payload as { code?: unknown; type?: unknown; message?: unknown; error?: unknown };

    if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
      const error = record.error as { type?: unknown; code?: unknown; message?: unknown };
      // A gateway envelope is decided ONLY by its embedded payload, before any wording check
      // below runs. Those checks match anchored phrases anywhere in the message, and a gateway
      // quotes the upstream's message inside its own -- so without this the relayed text would
      // satisfy the caller-mismatch identity and gain a resend the strict wrapper check exists to
      // withhold. Returning here rather than falling through is the point.
      if (typeof error.message === "string" && isLiteLlmEnvelopeMessage(error.message)) {
        return isLiteLlmWrappedCiphertextRejection(payload);
      }
      if (error.type === "invalid_request_error") {
        if (error.code === "invalid_encrypted_content") return true;
        if (
          (error.code === null || error.code === undefined)
          && typeof error.message === "string"
          && error.message.startsWith("The encrypted content ")
          && error.message.endsWith(
            " could not be verified. Reason: Encrypted content could not be decrypted or parsed.",
          )
        ) return true;
        // #4469: the caller-mismatch wording arrives without a dedicated code, so the
        // message itself is the identity. It is not gated on code being null — the upstream
        // may attach a generic code — because the anchored phrase is already specific.
        if (typeof error.message === "string" && isReasoningBlobCallerMismatchMessage(error.message)) {
          return true;
        }
      }
    }

    // The flat stream-error envelope carries type/message at the top level rather than under
    // an error object; the same anchored identity applies there.
    if (
      record.type === "invalid_request_error"
      && typeof record.message === "string"
      && isReasoningBlobCallerMismatchMessage(record.message)
    ) return true;

    if (record.code !== "invalid-argument" || typeof record.error !== "string") return false;
    return record.error.startsWith("Could not decode the compaction blob")
      || record.error.startsWith("Could not decrypt the provided encrypted_content");
  } catch {
    return false;
  }
}


/**
 * Whether an upstream Responses 4xx authoritatively rejected opaque replay state.
 *
 * The outbound-body check is intentional: the inbound transcript may contain a proxy envelope or
 * compaction blob that the adapter already lowered, in which case a replay would be byte-identical.
 * OpenAI usually exposes a dedicated nested code; ChatGPT also emits one exact code-less
 * unverifiable-ciphertext message, and #4469 added the anchored caller-mismatch wording for
 * reasoning blobs minted under a different caller. xAI's code is generic, so its two concrete
 * decoder error identities are also required. Unrelated error prose must never gain a hidden resend.
 */
export function shouldAttemptOpaqueBlobRecovery(args: {
  status: number;
  adapterName: string;
  outboundBody?: string;
  errorBody: string;
  alreadyAttempted: boolean;
}): boolean {
  const acceptedStatus = (args.status >= 400 && args.status < 500)
    || (
      args.status === 502
      && outboundResponsesBodyCarriesEncryptedFunctionOutput(args.outboundBody)
      && isEncryptedFunctionOutputRejection(args.errorBody)
    );
  return acceptedStatus
    && adapterSpeaksResponsesWire(args.adapterName)
    && !args.alreadyAttempted
    && outboundResponsesBodyCarriesOpaqueBlob(args.outboundBody)
    && isSelfIdentifiedOpaqueBlobRejection(args.errorBody);
}


/**
 * Peek the upstream error body for the reasoning-effort downgrade. Only 400/403 are considered
 * and the body must be complete and display-safe, the same contract the other rejection peeks
 * use. The match is deliberately narrow: the upstream has to name reasoning effort, so an
 * unrelated 400 never triggers a replay.
 */
export async function reasoningEffortRejectionText(
  response: Response,
  alreadyAttempted: boolean,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (alreadyAttempted) return undefined;
  if (response.status !== 400 && response.status !== 403) return undefined;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    if (!body.displaySafe || body.truncated) return undefined;
    return isReasoningEffortRejection(body.text) ? body.text : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Whether an Anthropic response refused the fast lane of a request that actually sent it.
 *
 * "Actually sent" is read from the adapter's own tier record for that exact request, never from
 * the route: a request built without `speed` can be refused for other reasons and must not be
 * downgraded. The body is read from a clone, so a refusal that is not recovered (or whose resend
 * is not admitted) still reaches the caller intact.
 */
export async function anthropicFastRefused(
  response: Response,
  sentRequest: AdapterRequest | undefined,
  adapterName: string,
  alreadyAttempted: boolean,
  signal: AbortSignal,
): Promise<boolean> {
  if (alreadyAttempted || adapterName !== "anthropic") return false;
  if (response.status !== 400 && response.status !== 429) return false;
  const outcome = sentRequest?.tierLog?.outcome;
  if (outcome?.wireKind !== "anthropic-speed" || typeof outcome.wireValue !== "string") return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return isAnthropicFastRefusal(response.status, response.headers, body.truncated ? undefined : body.text);
  } catch {
    return isAnthropicFastRefusal(response.status, response.headers, undefined);
  }
}

export async function opaqueBlobRejectionBodyForRecovery(
  response: Response,
  outboundBody: string | undefined,
  adapterName: string,
  alreadyAttempted: boolean,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (
    isNonReplayableResponse(response)
    || response.status < 400
    || (response.status >= 500 && response.status !== 502)
    || !adapterSpeaksResponsesWire(adapterName)
    || alreadyAttempted
    || !outboundResponsesBodyCarriesOpaqueBlob(outboundBody)
  ) return undefined;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return body.displaySafe && !body.truncated ? body.text : undefined;
  } catch {
    return undefined;
  }
}


/**
 * Backoff for the single exact-request replay after a canonical Console upload rejection.
 */
export const CONSOLE_GO_UPLOAD_RETRY_DELAY_MS = 800;


/**
 * Peek the upstream error body for the Console Go transient-400 recovery. Only a complete,
 * display-safe body may drive a retry decision (same contract as
 * opaqueBlobRejectionBodyForRecovery), and reading a clone leaves the original response intact
 * for the caller's own error surface when no retry is taken.
 */
export async function consoleGoUploadRejectionBody(
  response: Response,
  alreadyAttempted: boolean,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (isNonReplayableResponse(response) || response.status !== 400 || alreadyAttempted) return undefined;
  try {
    const body = await readBoundedResponseBody(response.clone(), { signal });
    return body.displaySafe && !body.truncated ? body.text : undefined;
  } catch {
    return undefined;
  }
}


export function prepareOpaqueBlobRecovery(parsed: OcxParsedRequest): void {
  parsed._stripReasoningEncryptedContent = true;
  // The destination rejected state another serving identity minted. A reasoning item's id names
  // an item in that identity's store, so it goes with the blob.
  parsed._dropForeignReasoningItemIds = true;
  const rawBody = parsed._rawBody;
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return;
  const input = (rawBody as { input?: unknown }).input;
  if (!Array.isArray(input)) return;
  const stripEncryptedParts = (parts: unknown[]): unknown[] => {
    let changed = false;
    const stripped = parts.map(part => {
      if (
        part !== null
        && typeof part === "object"
        && !Array.isArray(part)
        && (part as { type?: unknown }).type === "encrypted_content"
        && typeof (part as { encrypted_content?: unknown }).encrypted_content === "string"
        && (part as { encrypted_content: string }).encrypted_content.length > 0
      ) {
        changed = true;
        return { type: "input_text", text: "[encrypted content omitted]" };
      }
      return part;
    });
    return changed ? stripped : parts;
  };
  const strippedInput = input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (FUNCTION_OUTPUT_TYPES.has(type) && Array.isArray(record.output)) {
      const output = stripEncryptedParts(record.output);
      return output !== record.output ? { ...record, output } : item;
    }
    if (type === AGENT_MESSAGE_TYPE && Array.isArray(record.content)) {
      const content = stripEncryptedParts(record.content);
      return content !== record.content ? { ...record, content } : item;
    }
    return item;
  });
  Object.assign(rawBody, { input: strippedInput });
}


export function resetStreamedOpaqueBlobLogContext(logCtx: RequestLogContext): void {
  delete logCtx.upstreamError;
  delete logCtx.terminalHttpStatus;
  delete logCtx.terminalErrorCode;
  delete logCtx.terminalIncompleteReason;
}


export type OpaqueBlobRecoveryGuard = { attempted: boolean };


export type OpaqueBlobRecoveryResult =
  | { kind: "skipped" }
  | { kind: "recovered"; response: Response }
  | { kind: "failed"; response: Response };


export async function attemptOpaqueBlobRecovery(
  args: {
    response: Response;
    outboundBody?: string;
    adapterName: string;
    parsed: OcxParsedRequest;
    guard: OpaqueBlobRecoveryGuard;
    signal: AbortSignal;
  },
  rebuild: (kind: AttemptRecoveryKind) => Promise<Response | { failed: Response }>,
): Promise<OpaqueBlobRecoveryResult> {
  const errorBody = await opaqueBlobRejectionBodyForRecovery(
    args.response,
    args.outboundBody,
    args.adapterName,
    args.guard.attempted,
    args.signal,
  );
  if (errorBody === undefined || !shouldAttemptOpaqueBlobRecovery({
    status: args.response.status,
    adapterName: args.adapterName,
    outboundBody: args.outboundBody,
    errorBody,
    alreadyAttempted: args.guard.attempted,
  })) {
    return { kind: "skipped" };
  }

  args.guard.attempted = true;
  const rejectedScope = args.parsed._reasoningReplayScope
    ? {
        clientThreadId: args.parsed._reasoningReplayScope.clientThreadId,
        ...(args.parsed._reasoningReplayScope.current
          ? { current: { ...args.parsed._reasoningReplayScope.current } }
          : {}),
      }
    : undefined;
  prepareOpaqueBlobRecovery(args.parsed);
  try { void args.response.body?.cancel().catch(() => {}); } catch { /* already consumed/closed */ }
  const result = await rebuild("opaque-blob-rejection");
  if (!("failed" in result) && result.ok) {
    rememberReasoningReplayOpaqueBlobRejection(rejectedScope);
  }
  return "failed" in result
    ? { kind: "failed", response: result.failed }
    : { kind: "recovered", response: result };
}
