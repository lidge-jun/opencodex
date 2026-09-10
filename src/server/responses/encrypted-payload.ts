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

export const MAX_AGENT_TASK_ENCRYPTED_PARTS = 32;
export const MAX_AGENT_TASK_CIPHERTEXT_BYTES = 2 * 1024 * 1024;

/** Detection only: joining fragments never authorizes recovery or proves authenticity. */
function splitFernetParts(content: unknown[]): Set<object> {
  const protectedParts = new Set<object>();
  let run: Array<{ part: object; text: string }> = [];
  let bytes = 0;
  let overLimit = false;
  const finish = (): void => {
    if (!overLimit && run.length > 1
      && run.every(({ text }) => !isStructurallyValidFernetToken(text))
      && isStructurallyValidFernetToken(run.map(({ text }) => text).join(""))) {
      for (const { part } of run) protectedParts.add(part);
    }
    run = [];
    bytes = 0;
    overLimit = false;
  };
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "encrypted_content"
      || typeof (part as { encrypted_content?: unknown }).encrypted_content !== "string") {
      finish();
      continue;
    }
    if (overLimit) continue;
    const text = (part as { encrypted_content: string }).encrypted_content;
    bytes += Buffer.byteLength(text);
    if (run.length >= MAX_AGENT_TASK_ENCRYPTED_PARTS || bytes > MAX_AGENT_TASK_CIPHERTEXT_BYTES) {
      overLimit = true;
      run = [];
      continue;
    }
    run.push({ part, text });
  }
  finish();
  return protectedParts;
}

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

  const fragmentParts = splitFernetParts(content);
  let hasFernetTask = fragmentParts.size > 0;
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

    if (fragmentParts.has(part)) continue;
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


/** The marker `prepareOpaqueBlobRecovery` already substitutes for an undecryptable part. */
export const OMITTED_ENCRYPTED_CONTENT_TEXT = "[encrypted content omitted]";

/**
 * The Fernet WIRE shape, without validating the body: version prefix, base64url alphabet, and a
 * canonical encoded length. Free text is judged by this rather than by
 * `looksLikeBackendCiphertext`, which is length >= 64 over a character class that a SHA-256 hex
 * digest matches exactly at 64 characters -- as do a SHA-512 digest, a long key, and adjacent
 * short encoded fragments. An `encrypted_content` slot carries ciphertext by definition and is
 * stripped whatever it holds; a text part does not, and replacing a digest a child deliberately
 * printed would destroy readable content to protect bytes that were never secret.
 */
const FERNET_SHAPED = /^g[A-Za-z0-9_-]+={0,2}$/;

function looksLikeFernetToken(text: string): boolean {
  return text.length >= 100 && text.length % 4 === 0 && FERNET_SHAPED.test(text);
}

function textWithRunsOmitted(payload: string, runs: readonly FernetTokenRun[]): string {
  let last = 0;
  let out = "";
  for (const run of runs) {
    out += payload.slice(last, run.index) + OMITTED_ENCRYPTED_CONTENT_TEXT;
    last = run.index + run.token.length;
  }
  return out + payload.slice(last);
}

/**
 * Replace ciphertext inside `agent_message` items with an omission marker, so
 * `normalizeRoutedAgentMessages` can lower them onto public messages. Returns how many items
 * were repaired. Items are replaced rather than mutated, and every other item type is left
 * alone: reasoning and function-output blobs keep their own reactive recovery.
 *
 * `hasUnreadableEncryptedAgentTask` above answers a different question: can the CURRENT worker
 * task be read at all? It inspects only the tail item and reports false the moment any plaintext
 * survives the envelope. `normalizeRoutedAgentMessages` asks the opposite question -- is EVERY
 * part lowerable? -- and forwards the private item verbatim when one is not. A mixed
 * `input_text` + `encrypted_content` item answers "readable" to the first and "not lowerable"
 * to the second, so it fell between them: the guard never fired, the adapter refused to lower it,
 * and the raw Responses passthrough put a private item and backend ciphertext on the wire
 * (#4454). Position was never the discriminator -- a replayed child result lands mid-history and
 * the tail-only scan cannot see it -- but the tail is equally exposed when it is mixed.
 *
 * This is the repair `prepareOpaqueBlobRecovery` performs after an upstream rejection, applied
 * before dispatch for a destination that cannot accept the private item under any circumstances.
 * The round trip it replaces was never going to succeed, and it sent ciphertext to a third party
 * to find that out. Nothing is decrypted, and nothing readable is lost: the parent could not read
 * these bytes either.
 *
 * The two kinds of slot are judged differently, because they carry different guarantees. An
 * `encrypted_content` slot holds ciphertext by definition, so it is stripped whatever it holds:
 * demanding a well-formed token there would reopen this defect one payload later, since a
 * truncated token, a standard-base64 blob carrying `+` or `/`, an unexpected version byte, or a
 * run past the recovery size limits would each keep the item and forward the bytes.
 *
 * A text part carries no such guarantee, so it is matched strictly: embedded runs that validate
 * as Fernet, or a whole slot with the Fernet wire shape. A loose character-class test would be
 * worse than the defect for that half -- a SHA-256 digest is exactly 64 characters of
 * `[A-Za-z0-9]` and would be replaced with a marker, silently deleting something a child
 * deliberately printed.
 */
export function stripAgentMessageCiphertextInPlace(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let repaired = 0;
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "agent_message") continue;
    const content = record.content;
    if (typeof content === "string") {
      const replaced = textWithoutCiphertext(content);
      if (replaced === content) continue;
      input[index] = { ...record, content: replaced };
      repaired += 1;
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts = contentWithoutCiphertext(content);
    if (parts === content) continue;
    input[index] = { ...record, content: parts };
    repaired += 1;
  }
  return repaired;
}

/** Free text: drop embedded token runs, and replace a slot that is nothing but a token. */
function textWithoutCiphertext(text: string): string {
  const runs = fernetTokenRuns(text);
  if (runs.length > 0) return textWithRunsOmitted(text, runs);
  return looksLikeFernetToken(text.trim()) ? OMITTED_ENCRYPTED_CONTENT_TEXT : text;
}

function ciphertextTextOfPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const record = part as { type?: unknown; text?: unknown };
  return (record.type === "input_text" || record.type === "text") && typeof record.text === "string"
    ? record.text
    : undefined;
}

/**
 * Adjacent text slots that are one token between them. Each fragment can be too short to judge on
 * its own, which is the text-side twin of the split `encrypted_content` run. The join must still
 * be Fernet-shaped, so two ordinary encoded fragments do not become a marker by being adjacent.
 */
function joinedCiphertextTextParts(content: readonly unknown[]): Set<object> {
  const flagged = new Set<object>();
  let run: Array<{ part: object; text: string }> = [];
  const finish = (): void => {
    if (run.length > 1 && looksLikeFernetToken(run.map(entry => entry.text).join(""))) {
      for (const entry of run) flagged.add(entry.part);
    }
    run = [];
  };
  for (const part of content) {
    const text = ciphertextTextOfPart(part);
    if (text === undefined || text.trim().length === 0 || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) {
      finish();
      continue;
    }
    run.push({ part: part as object, text });
  }
  finish();
  return flagged;
}

function contentWithoutCiphertext(content: unknown[]): unknown[] {
  let changed = false;
  const joined = joinedCiphertextTextParts(content);
  const parts = content.map((part: unknown) => {
    if (!part || typeof part !== "object") return part;
    if (joined.has(part)) {
      changed = true;
      return { type: "input_text", text: OMITTED_ENCRYPTED_CONTENT_TEXT };
    }
    const record = part as { type?: unknown; text?: unknown; encrypted_content?: unknown };
    if (record.type === "encrypted_content" && typeof record.encrypted_content === "string") {
      changed = true;
      // Keep whatever plaintext a recognizable slot carries around its token; a slot this
      // cannot parse is replaced whole rather than forwarded on the chance that it is benign.
      const runs = fernetTokenRuns(record.encrypted_content);
      return {
        type: "input_text",
        text: runs.length > 0
          ? textWithRunsOmitted(record.encrypted_content, runs)
          : OMITTED_ENCRYPTED_CONTENT_TEXT,
      };
    }
    const text = ciphertextTextOfPart(part);
    if (text === undefined) return part;
    const replaced = textWithoutCiphertext(text);
    if (replaced === text) return part;
    changed = true;
    return { ...record, text: replaced };
  });
  return changed ? parts : content;
}



export function sanitizeEncryptedContentInPlace(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let rewritten = 0;
  const protectedFragments = new WeakSet<object>();
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
        for (const part of splitFernetParts(frame.node)) protectedFragments.add(part);
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
        if (!protectedFragments.has(child) && !looksLikeBackendCiphertext(payload)) {
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
