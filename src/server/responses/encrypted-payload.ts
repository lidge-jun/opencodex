import type { Server } from "bun";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse, type ResponsesTerminalStatus } from "../../bridge";
import {
  getConfigPath,
  multiAgentGuidanceEnabled,
  resolveEnvValue,
} from "../../config";
import { parseRequest } from "../../responses/parser";
import { buildCompactV1Output, COMPACT_PROMPT, decodeCompactionSummary, extractCompactUserMessages } from "../../responses/compaction";
import { FORWARD_HEADERS, sanitizeReasoningInputContent } from "../../adapters/openai-responses";
import { expandPreviousResponseInput, previousResponseProviderState, rememberResponseState } from "../../responses/state";
import { routeModel } from "../../router";
import {
  advanceComboAfterFailure,
  comboDefaultEffort,
  comboFailureDecision,
  comboIdFromRawBody,
  concreteComboRequestBody,
  getCombo,
  isComboTargetInCooldown,
  NoAvailableComboTargetsError,
  noteComboSuccess,
  parseRetryAfterMs,
  pickComboTarget,
  targetKey,
} from "../../combos";
import { isInjectionDebugEnabled } from "../../lib/debug-settings";
import { injectionDebugLog } from "../../lib/injection-debug-log";
import { modelInList, namespacedToolName } from "../../types";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig, OcxProviderContinuationState, OcxUsage } from "../../types";
import {
  forceRefreshOAuthAccessSnapshot,
  getOAuthCredentialApiBaseUrl,
  getOAuthCredentialProjectId,
  getValidAccessTokenSnapshot,
  type OAuthAccessSnapshot,
  UnsupportedOAuthProviderError,
} from "../../oauth";
import { buildWebSearchTool, planWebSearch, runWithWebSearch, shouldResolveOpenAiWebSearchSidecar } from "../../web-search";
import { describeImagesInPlace, planVisionSidecar, shouldResolveOpenAiVisionSidecar, stripImagesInPlace } from "../../vision";
import { createAdapterEventQueue, preflightAdapterEvents } from "../../adapters/run-turn-queue";
import {
  applyCodexAuthContextToProvider,
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexDirectAuthenticationError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
  headersForCodexAuthContext,
  isCodexAuthContextUsable,
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../../codex/auth-context";
import {
  formatCodexProviderForLog,
  recordCodexUpstreamOutcome,
  type CodexUpstreamOutcome,
} from "../../codex/routing";
import { fetchWithResetRetry, fetchWithTransientRetry, applyUpstreamRecoveryInit } from "../../lib/upstream-retry";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "../auth-cors";
import { listOpenAiForwardSidecarCandidates, resolveFirstUsableOpenAiSidecar, type ResolvedOpenAiForwardSidecar } from "../../providers/openai-sidecar";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { slugsEquivalent } from "../../providers/slug-codec";
import { applyOpenAiVirtualModel, resolveOpenAiCompactModel } from "../../providers/openai-virtual-models";
import { isUsageDebugEnabled } from "../../usage/debug";
import { readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../request-decompress";
import { resolveAdapter, resolveWireProtocolOverride } from "../adapter-resolve";
import { hasKeyPoolFailover, rotateProviderTransportOn429 } from "../../providers/key-failover";
import { shouldAttemptImageTierRetry } from "../image-retry";
import { resolveProviderTransport } from "../../providers/xai-transport";
import type { WsData } from "../ws-bridge";
import { registerTurn, trackStreamLifetime, unregisterTurn } from "../lifecycle";
import { redactSecretString } from "../../lib/redact";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { supportedLadderFor } from "../effort-policy";
import {
  beginRequestAttempt,
  catalogModelSupportsServiceTier,
  finishRequestAttempt,
  inspectResponseLogJson,
  noteAttemptSend,
  readConfiguredCodexServiceTier,
  requestLogSpeedLabel,
  sealRequestAttemptIdentity,
  usageFromResponsesPayload,
  type RequestLogContext,
} from "../request-log";
import type { AttemptRecoveryKind } from "../../usage/log";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  markNativePassthroughSseResponse,
  relaySseWithFailedTail,
  relayWithAbort,
  sanitizePassthroughHeaders,
} from "../relay";
import { hasResponsesItemIdRepair, relaySseWithResponsesItemIdRepair } from "../responses-item-id-repair";
import type { EffectiveSubagentRoster, SpawnAgentSurface } from "../../codex/catalog";


export function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && /^[A-Za-z0-9+/=_-]+$/.test(payload);
}



/**
 * Backend-minted ciphertext runs are Fernet tokens (base64url, version byte 0x80).
 * Used to carve embedded blobs out of MIXED slots: plugin hooks may prepend
 * plaintext control metadata to a task body that is already backend-encrypted.
 */
const FERNET_TOKEN_CANDIDATE = /g[A-Za-z0-9_-]{97,}={0,2}/g;
const FERNET_TOKEN_BOUNDARY_CHAR = /[A-Za-z0-9_=-]/;

interface FernetTokenRun {
  index: number;
  token: string;
}

/**
 * Validate only the key-independent Fernet wire structure. Authenticity cannot be
 * checked without the backend key, but a real token must still be canonical base64url
 * containing version(1) + timestamp(8) + IV(16) + AES-CBC ciphertext(16*n) + HMAC(32).
 * Timestamp freshness is deliberately not enforced: old history can contain valid tokens.
 */
function isStructurallyValidFernetToken(token: string): boolean {
  if (token.length < 100 || token.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(token)) return false;

  const unpadded = token.replace(/=+$/, "");
  const paddingLength = token.length - unpadded.length;
  const expectedPadding = (4 - (unpadded.length % 4)) % 4;
  if (expectedPadding > 2 || paddingLength !== expectedPadding) return false;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(unpadded, "base64url");
  } catch {
    return false;
  }
  if (decoded.toString("base64url") !== unpadded) return false;
  if (decoded.length < 73 || decoded[0] !== 0x80) return false;

  const ciphertextLength = decoded.length - 57;
  return ciphertextLength >= 16 && ciphertextLength % 16 === 0;
}

export function structurallyValidFernetTokens(payload: string): string[] {
  return fernetTokenRuns(payload).map(run => run.token);
}

/** Maximal, boundary-delimited and structurally valid Fernet runs embedded in a slot. */
function fernetTokenRuns(payload: string): FernetTokenRun[] {
  const runs: FernetTokenRun[] = [];
  for (const match of payload.matchAll(FERNET_TOKEN_CANDIDATE)) {
    const index = match.index ?? 0;
    const token = match[0];
    const before = index > 0 ? payload[index - 1] : undefined;
    const after = payload[index + token.length];
    if (before && FERNET_TOKEN_BOUNDARY_CHAR.test(before)) continue;
    if (after && FERNET_TOKEN_BOUNDARY_CHAR.test(after)) continue;
    if (!isStructurallyValidFernetToken(token)) continue;
    runs.push({ index, token });
  }
  return runs;
}

function textWithoutFernetRuns(payload: string, runs: readonly FernetTokenRun[]): string {
  let last = 0;
  let text = "";
  for (const run of runs) {
    text += `${payload.slice(last, run.index)}\n\n`;
    last = run.index + run.token.length;
  }
  return `${text}${payload.slice(last)}`;
}

/**
 * The routing header codex-rs writes above a delegated agent payload.
 *
 * `MESSAGE` is matched as well as `NEW_TASK`, and only for the unreadability CHECK --
 * recovery stays NEW_TASK-only. #3021 reported a subagent `MESSAGE` arriving in the
 * parent conversation as raw `gAAAA...` ciphertext after an `adapter_eof`. The detector
 * decides "unreadable" by stripping the envelope and asking whether any plaintext
 * survives, so an envelope shape it does not recognise counts as surviving text: a
 * `MESSAGE` whose entire body is one Fernet token measured as READABLE and was forwarded
 * verbatim.
 *
 * Widening the strip is not the same as widening recovery. Recovery decrypts, and
 * decrypting a `MESSAGE` on the parent's behalf would build a plaintext oracle out of a
 * payload the parent's session may have no right to read. This only lets the proxy
 * NOTICE that what it is about to forward is unreadable ciphertext, which is what the
 * report asks for: fail closed with a structured error rather than paste the token.
 */
export const AGENT_MESSAGE_ROUTING_ENVELOPE = /(?:^|\n)Message Type\s*:\s*(?:NEW_TASK|MESSAGE)[^\n]*\nTask name\s*:[^\n]*\nSender\s*:[^\n]*\nPayload\s*:\s*(?:\n|$)/gi;

// CXC is the compatibility-hook control namespace. Strip only the tagged paragraph:
// later untagged paragraphs may be genuine task text. Repeated CXC paragraphs are
// removed independently, and a following routing envelope remains available to the
// envelope stripper below.
export const AGENT_MESSAGE_CONTROL_PREAMBLE = /(?:^|\n)\[CXC-[A-Z0-9-]+\][^\n]*(?:\n(?!\n|Message Type\s*:)[^\n]*)*(?=\n{2,}|\nMessage Type\s*:|$)/gi;

export function hasUnreadableEncryptedAgentTask(input: unknown): boolean {
  if (!Array.isArray(input)) return false;

  // codex-rs appends one NEW_TASK agent_message at the current input tail. Historical
  // agent messages may be adjacent in full-history bodies; they must not poison the
  // later task. compaction_trigger/additional_tools are trailing metadata rather than
  // a newer user turn.
  let index = input.length - 1;
  while (index >= 0) {
    const item = input[index];
    const type = item && typeof item === "object" ? (item as { type?: unknown }).type : undefined;
    if (type !== "compaction_trigger" && type !== "additional_tools") break;
    index -= 1;
  }
  const item = input[index];
  if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "agent_message") {
    return false;
  }

  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;

  let hasFernetTask = false;
  const readableParts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown; encrypted_content?: unknown };
    if (
      (record.type === "input_text" || record.type === "text")
      && typeof record.text === "string"
    ) {
      readableParts.push(record.text);
      continue;
    }
    if (record.type !== "encrypted_content" || typeof record.encrypted_content !== "string") {
      continue;
    }

    const runs = fernetTokenRuns(record.encrypted_content);
    if (runs.length > 0) hasFernetTask = true;
    readableParts.push(textWithoutFernetRuns(record.encrypted_content, runs));
  }

  if (!hasFernetTask) return false;
  const readableTask = readableParts
    .join("\n\n")
    .replace(AGENT_MESSAGE_CONTROL_PREAMBLE, "\n")
    .replace(AGENT_MESSAGE_ROUTING_ENVELOPE, "\n")
    .trim();
  return readableTask.length === 0;
}



export function encryptedSlotParts(payload: string): Array<Record<string, string>> {
  const parts: Array<Record<string, string>> = [];
  let last = 0;
  for (const run of fernetTokenRuns(payload)) {
    const before = payload.slice(last, run.index);
    if (before.trim().length > 0) parts.push({ type: "input_text", text: before });
    parts.push({ type: "encrypted_content", encrypted_content: run.token });
    last = run.index + run.token.length;
  }
  const rest = payload.slice(last);
  if (rest.trim().length > 0) parts.push({ type: "input_text", text: rest });
  return parts.length > 0 ? parts : [{ type: "input_text", text: payload }];
}



export function hasEncryptedContentPart(content: unknown): boolean {
  return Array.isArray(content) && content.some(part => (
    part && typeof part === "object"
    && (part as { type?: unknown }).type === "encrypted_content"
  ));
}



export function sanitizeEncryptedContentInPlace(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let rewritten = 0;
  type VisitFrame =
    | { kind: "visit"; node: unknown }
    | { kind: "array"; node: unknown[]; index: number }
    | { kind: "object"; values: unknown[]; index: number }
    | { kind: "agent"; message: Record<string, unknown>; rewrittenBefore: number };
  const stack: VisitFrame[] = [{ kind: "visit", node: input }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === "visit") {
      if (Array.isArray(frame.node)) {
        stack.push({ kind: "array", node: frame.node, index: 0 });
      } else if (frame.node && typeof frame.node === "object") {
        stack.push({ kind: "object", values: Object.values(frame.node), index: 0 });
      }
      continue;
    }

    if (frame.kind === "array") {
      if (frame.index >= frame.node.length) continue;
      const child = frame.node[frame.index] as unknown;
      if (
        child && typeof child === "object"
        && (child as { type?: unknown }).type === "encrypted_content"
        && typeof (child as { encrypted_content?: unknown }).encrypted_content === "string"
      ) {
        const payload = (child as { encrypted_content: string }).encrypted_content;
        if (!looksLikeBackendCiphertext(payload)) {
          const parts = encryptedSlotParts(payload);
          frame.node.splice(frame.index, 1, ...parts);
          rewritten += 1;
          stack.push({ kind: "array", node: frame.node, index: frame.index + parts.length });
          continue;
        }
      }
      stack.push({ kind: "array", node: frame.node, index: frame.index + 1 });
      if (child && typeof child === "object" && (child as { type?: unknown }).type === "agent_message") {
        stack.push({ kind: "agent", message: child as Record<string, unknown>, rewrittenBefore: rewritten });
      }
      stack.push({ kind: "visit", node: child });
      continue;
    }

    if (frame.kind === "object") {
      if (frame.index >= frame.values.length) continue;
      stack.push({ kind: "object", values: frame.values, index: frame.index + 1 });
      stack.push({ kind: "visit", node: frame.values[frame.index] });
      continue;
    }

    if (
      rewritten > frame.rewrittenBefore
      && frame.message.type === "agent_message"
      && !hasEncryptedContentPart(frame.message.content)
    ) {
      frame.message.type = "message";
      frame.message.role = "user";
      delete frame.message.id;
      delete frame.message.author;
      delete frame.message.recipient;
    }
  }
  return rewritten;
}
