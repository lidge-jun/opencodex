import type { OcxConfig, OcxMessage, OcxParsedRequest } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import {
  isEagerRelaySseResponse,
  isNativePassthroughSseResponse,
  markEagerRelaySseResponse,
  markNativePassthroughSseResponse,
  sanitizePassthroughHeaders,
} from "../server/relay";
import { relaySseWithBlockRewrite } from "../server/sse-payload-rewrite";
import { looksLikeSse, readBoundedPrefix } from "../lib/stream-prefix";
import {
  activeGuardrailsRuntimeSnapshot,
  captureGuardrailsPolicy,
  leaseActiveGuardrailsRuntimeSnapshot,
  leaseCapturedGuardrailsRuntimeSnapshot,
  type CapturedGuardrailsPolicy,
} from "./activation";
import {
  decodeCompactionSummary,
  encodeCompactionSummary,
} from "../responses/compaction";
import { maskAnthropicRequestFields } from "./fields/anthropic";
import { maskChatRequestFields } from "./fields/chat";
import {
  maskResponsesRequestFields,
  restoreResponsesRequestFields,
} from "./fields/responses";
import {
  GuardrailsDemaskCapacityError,
  MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES,
  demaskGuardrailsText,
  maskGuardrailsText,
} from "./placeholders";
import {
  GuardrailsSseDemaskCapacityError,
  guardrailsSseDemaskRewrite,
} from "./sse-demask";
import {
  MAX_GUARDRAILS_FINDINGS,
  MAX_GUARDRAILS_SCANNABLE_TEXT_BYTES,
  GuardrailsScanCapacityError,
  createGuardrailsScanBudget,
  scanGuardrailsText,
  type GuardrailsScanBudget,
} from "./scanner";
import { recordGuardrailsEvent, type GuardrailsTelemetrySurface } from "./telemetry";
import {
  nestedStringSlots,
  restoreGuardrailsTextSlots,
  type GuardrailsFieldMaskResult,
  type GuardrailsTextSlot,
} from "./fields/shared";
import type {
  GuardrailsDemaskBudget,
  GuardrailsFinding,
  GuardrailsPlaceholderState,
} from "./types";
import type { GuardrailsRuntimeSnapshot, GuardrailsRuntimeSnapshotLease } from "./runtime";

export type GuardrailsInboundProtocol = "anthropic" | "chat" | "responses";

interface GuardrailsTurnLedger {
  executableDeltaTails: Map<string, string>;
  findingCount: number;
  scannedTextBytes: number;
}

export interface GuardrailsTurn {
  readonly findings: readonly GuardrailsFinding[];
  readonly ledger: GuardrailsTurnLedger;
  readonly mode: "detect" | "enforce";
  readonly scanBudget: GuardrailsScanBudget;
  readonly scannedTextBytes: number;
  readonly snapshot: GuardrailsRuntimeSnapshot;
  readonly state: GuardrailsPlaceholderState;
}

export interface PreparedGuardrailsTurn<T> {
  body: T;
  turn: GuardrailsTurn | undefined;
}

/** Capture once at handler admission so one request cannot mix config generations. */
export async function captureGuardrailsRuntimeSnapshot(config: OcxConfig): Promise<GuardrailsRuntimeSnapshotLease | undefined> {
  return leaseActiveGuardrailsRuntimeSnapshot(config);
}

export interface GuardrailsRuntimeAdmission {
  lease: GuardrailsRuntimeSnapshotLease | undefined;
  passthroughFailure: boolean;
  snapshot: GuardrailsRuntimeSnapshot | undefined;
}

/**
 * Admit one logical request before its body is read. A compile/runtime setup error
 * honors the configured availability policy without exposing error details or
 * returning a partially compiled registry.
 */
export async function admitGuardrailsRuntime(
  config: OcxConfig,
  surface: GuardrailsTelemetrySurface = "responses",
  providerId?: string,
  capturedPolicy: CapturedGuardrailsPolicy | undefined = captureGuardrailsPolicy(config),
): Promise<GuardrailsRuntimeAdmission> {
  const admittedFailurePolicy = capturedPolicy?.failurePolicy ?? "block";
  const admittedMode = capturedPolicy?.mode ?? "enforce";
  try {
    const lease = await leaseCapturedGuardrailsRuntimeSnapshot(
      config,
      capturedPolicy,
      providerId,
    );
    return {
      lease,
      passthroughFailure: false,
      snapshot: lease?.snapshot,
    };
  } catch (error) {
    if (admittedFailurePolicy !== "passthrough") throw error;
    console.warn(
      `[opencodex] Guardrails runtime admission failed in passthrough mode: ${
        error instanceof Error ? error.name : "unknown"
      }`,
    );
    recordGuardrailsEvent({
      surface,
      mode: admittedMode,
      result: "passthrough",
      registryGeneration: 0,
      count: 1,
      categoryIds: [],
      ruleIds: [],
      latencyMs: 0,
      severity: "high",
    });
    return {
      lease: undefined,
      passthroughFailure: true,
      snapshot: undefined,
    };
  }
}

export function guardrailsFailureCode(error: unknown): "guardrails_capacity_exceeded" | "guardrails_scan_failed" {
  return isGuardrailsCapacityError(error)
    ? "guardrails_capacity_exceeded"
    : "guardrails_scan_failed";
}

export function guardrailsFailureStatus(error: unknown): 400 | 413 {
  return isGuardrailsCapacityError(error) ? 413 : 400;
}

export class GuardrailsOutputCapacityError extends Error {
  constructor() {
    super("Guardrails response demasking exceeded its safe traversal limit");
  }
}

const MAX_GUARDRAILS_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_GUARDRAILS_OUTPUT_DEPTH = 64;
const MAX_GUARDRAILS_OUTPUT_NODES = 100_000;
const MAX_EXECUTABLE_DELTA_STREAMS = 128;
const MAX_PLACEHOLDER_TOKEN_LENGTH = 256;
const GENERATED_PLACEHOLDER_TOKEN_PATTERN = /<[A-Z][A-Z0-9_]{2,253}>/g;

interface DemaskTraversal {
  demaskBudget: GuardrailsDemaskBudget;
  executableDeltaTails: Map<string, string>;
  nodes: number;
  placeholders: ReadonlySet<string>;
  toolArgumentRestoreSkipped: number;
}

function consumeDemaskNodes(traversal: DemaskTraversal, count = 1): void {
  traversal.nodes += count;
  if (traversal.nodes > MAX_GUARDRAILS_OUTPUT_NODES) {
    throw new GuardrailsOutputCapacityError();
  }
}

function executablePlaceholderTail(value: string): string {
  const start = value.lastIndexOf("<");
  if (start < 0) return "";
  const tail = value.slice(start);
  return tail.length < MAX_PLACEHOLDER_TOKEN_LENGTH
    && /^<[A-Z][A-Z0-9_]{0,252}$/.test(tail)
    ? tail
    : "";
}

function rememberExecutableTail(
  traversal: DemaskTraversal,
  streamKey: string,
  tail: string,
): void {
  traversal.executableDeltaTails.delete(streamKey);
  if (!tail) return;
  while (traversal.executableDeltaTails.size >= MAX_EXECUTABLE_DELTA_STREAMS) {
    const oldest = traversal.executableDeltaTails.keys().next().value;
    if (typeof oldest !== "string") break;
    traversal.executableDeltaTails.delete(oldest);
  }
  traversal.executableDeltaTails.set(streamKey, tail);
}

function countPlaceholderTokens(
  value: string,
  traversal: DemaskTraversal,
  streamKey?: string,
): void {
  const combined = streamKey
    ? `${traversal.executableDeltaTails.get(streamKey) ?? ""}${value}`
    : value;
  GENERATED_PLACEHOLDER_TOKEN_PATTERN.lastIndex = 0;
  for (const match of combined.matchAll(GENERATED_PLACEHOLDER_TOKEN_PATTERN)) {
    if (traversal.placeholders.has(match[0])) {
      traversal.toolArgumentRestoreSkipped += 1;
    }
  }
  if (streamKey) {
    rememberExecutableTail(traversal, streamKey, executablePlaceholderTail(combined));
  }
}

function inspectExecutableValue(
  value: unknown,
  traversal: DemaskTraversal,
  depth = 0,
  streamKey?: string,
): void {
  if (depth > MAX_GUARDRAILS_OUTPUT_DEPTH) throw new GuardrailsOutputCapacityError();
  if (typeof value === "string") {
    countPlaceholderTokens(value, traversal, streamKey);
    return;
  }
  if (Array.isArray(value)) {
    consumeDemaskNodes(traversal, value.length);
    for (const entry of value) inspectExecutableValue(entry, traversal, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  const entries = Object.values(value);
  consumeDemaskNodes(traversal, entries.length);
  for (const entry of entries) inspectExecutableValue(entry, traversal, depth + 1);
}

function inspectResponseToolCall(value: JsonRecord, traversal: DemaskTraversal): void {
  if (typeof value.type !== "string"
    || (!value.type.endsWith("_call") && !value.type.endsWith("_tool_call"))) {
    return;
  }
  for (const field of ["arguments", "input", "action"]) {
    if (value[field] !== undefined) inspectExecutableValue(value[field], traversal);
  }
}

function inspectChatToolCalls(
  value: JsonRecord,
  traversal: DemaskTraversal,
  streamPrefix?: string,
): void {
  if (isRecord(value.function_call)) {
    inspectExecutableValue(
      value.function_call.arguments,
      traversal,
      0,
      streamPrefix ? `${streamPrefix}:function_call` : undefined,
    );
  }
  if (!Array.isArray(value.tool_calls)) return;
  consumeDemaskNodes(traversal, value.tool_calls.length);
  for (let index = 0; index < value.tool_calls.length; index += 1) {
    const toolCall = value.tool_calls[index];
    if (!isRecord(toolCall)) continue;
    consumeDemaskNodes(traversal);
    const callIdentity = typeof toolCall.id === "string"
      ? toolCall.id
      : typeof toolCall.index === "number"
        ? String(toolCall.index)
        : String(index);
    if (isRecord(toolCall.function)) {
      inspectExecutableValue(
        toolCall.function.arguments,
        traversal,
        0,
        streamPrefix ? `${streamPrefix}:${callIdentity}:function` : undefined,
      );
    }
    if (isRecord(toolCall.custom)) {
      inspectExecutableValue(
        toolCall.custom.input,
        traversal,
        0,
        streamPrefix ? `${streamPrefix}:${callIdentity}:custom` : undefined,
      );
    }
  }
}

function maskFields<T>(
  protocol: GuardrailsInboundProtocol,
  body: T,
  snapshot: GuardrailsRuntimeSnapshot,
  previousState?: GuardrailsPlaceholderState,
  scanBudget?: GuardrailsScanBudget,
  options?: PrepareGuardrailsTurnOptions,
): GuardrailsFieldMaskResult<T> {
  switch (protocol) {
    case "anthropic":
      return maskAnthropicRequestFields(
        body,
        snapshot.registry,
        previousState,
        scanBudget,
        { scanDocumentSources: options?.scanAnthropicDocumentSources },
      );
    case "chat":
      return maskChatRequestFields(body, snapshot.registry, previousState, scanBudget);
    case "responses":
      return maskResponsesRequestFields(body, snapshot.registry, previousState, scanBudget);
  }
}

export interface PrepareGuardrailsTurnOptions {
  scanAnthropicDocumentSources?: boolean;
}

export async function prepareGuardrailsTurn<T>(
  config: OcxConfig,
  protocol: GuardrailsInboundProtocol,
  body: T,
  previousState?: GuardrailsPlaceholderState,
  capturedSnapshot?: GuardrailsRuntimeSnapshot,
  options?: PrepareGuardrailsTurnOptions,
): Promise<PreparedGuardrailsTurn<T>> {
  const snapshot = capturedSnapshot ?? await activeGuardrailsRuntimeSnapshot(config);
  if (!snapshot) return { body, turn: undefined };
  const result = maskFields(
    protocol,
    body,
    snapshot,
    previousState,
    createGuardrailsScanBudget(),
    options,
  );
  const turn: GuardrailsTurn = {
    findings: result.findings,
    ledger: {
      executableDeltaTails: new Map(),
      findingCount: result.findings.length,
      scannedTextBytes: result.scannedTextBytes,
    },
    mode: snapshot.mode,
    scanBudget: result.scanBudget,
    scannedTextBytes: result.scannedTextBytes,
    snapshot,
    state: result.state,
  };
  return { body: snapshot.mode === "enforce" ? result.body : body, turn };
}

/** Scan plaintext introduced by a later local transformation without changing detect-mode wire text. */
export function rescanGuardrailsResponsesBody<T>(body: T, turn: GuardrailsTurn): { body: T; turn: GuardrailsTurn } {
  const result = maskResponsesRequestFields(body, turn.snapshot.registry, turn.state, turn.scanBudget);
  if (turn.ledger.scannedTextBytes + result.scannedTextBytes > MAX_GUARDRAILS_SCANNABLE_TEXT_BYTES) {
    throw new GuardrailsScanCapacityError("Guardrails logical turn exceeded the maximum scannable text size");
  }
  if (turn.ledger.findingCount + result.findings.length > MAX_GUARDRAILS_FINDINGS) {
    throw new GuardrailsScanCapacityError("Guardrails logical turn exceeded the maximum findings limit");
  }
  turn.ledger.scannedTextBytes += result.scannedTextBytes;
  turn.ledger.findingCount += result.findings.length;
  return {
    body: turn.mode === "enforce" ? result.body : body,
    turn: {
      findings: [...turn.findings, ...result.findings],
      ledger: turn.ledger,
      mode: turn.mode,
      scanBudget: result.scanBudget,
      scannedTextBytes: turn.ledger.scannedTextBytes,
      snapshot: turn.snapshot,
      state: result.state,
    },
  };
}

/** Transactionally mask one newly materialized semantic text leaf in this logical turn. */
export function extendGuardrailsTurnText(
  value: string,
  turn: GuardrailsTurn,
): { text: string; turn: GuardrailsTurn } {
  const bytes = Buffer.byteLength(value, "utf8");
  if (turn.ledger.scannedTextBytes + bytes > MAX_GUARDRAILS_SCANNABLE_TEXT_BYTES) {
    throw new GuardrailsScanCapacityError("Guardrails logical turn exceeded the maximum scannable text size");
  }
  const findings = scanGuardrailsText(turn.snapshot.registry, value, turn.scanBudget);
  if (turn.ledger.findingCount + findings.length > MAX_GUARDRAILS_FINDINGS) {
    throw new GuardrailsScanCapacityError("Guardrails logical turn exceeded the maximum findings limit");
  }
  const masked = maskGuardrailsText(value, findings, turn.state);
  turn.ledger.scannedTextBytes += bytes;
  turn.ledger.findingCount += findings.length;
  return {
    text: turn.mode === "enforce" ? masked.maskedText : value,
    turn: {
      ...turn,
      findings: [...turn.findings, ...findings],
      scannedTextBytes: turn.ledger.scannedTextBytes,
      state: masked.state,
    },
  };
}

/** Protect plaintext inside OpenCodex-owned `ocx1:` envelopes; real provider ciphertext stays opaque. */
export function maskLocalCompactionArtifacts<T>(
  body: T,
  turn: GuardrailsTurn,
): { body: T; turn: GuardrailsTurn } {
  const copy = structuredClone(body);
  if (!isRecord(copy) || !Array.isArray(copy.input)) return { body: copy, turn };
  let nextTurn = turn;
  for (const item of copy.input) {
    if (!isRecord(item)
      || (item.type !== "compaction" && item.type !== "compaction_summary" && item.type !== "context_compaction")
      || typeof item.encrypted_content !== "string") {
      continue;
    }
    const decoded = decodeCompactionSummary(item.encrypted_content);
    if (decoded === null) continue;
    const extended = extendGuardrailsTurnText(decoded, nextTurn);
    item.encrypted_content = encodeCompactionSummary(extended.text);
    nextTurn = extended.turn;
  }
  return { body: copy, turn: nextTurn };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageTextSlots(messages: OcxMessage[]): GuardrailsTextSlot[] {
  const slots: GuardrailsTextSlot[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      slots.push({
        value: message.content,
        replace(next) { message.content = next; },
      });
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text") {
        slots.push({
          value: part.text,
          replace(next) { part.text = next; },
        });
      } else if (part.type === "toolCall") {
        slots.push(...nestedStringSlots(part.arguments));
      }
    }
  }
  return slots;
}

export function restoreGuardrailsMessages(
  messages: OcxMessage[],
  turn: GuardrailsTurn,
): OcxMessage[] {
  return restoreGuardrailsTextSlots(
    messages,
    turn.state,
    copy => messageTextSlots(copy),
  );
}

export function restoreGuardrailsResponsesBody<T>(
  body: T,
  turn: GuardrailsTurn,
): T {
  return restoreResponsesRequestFields(body, turn.state);
}

/** Restore only request fields that were eligible for masking; opaque metadata stays untouched. */
export function restoreGuardrailsResponsesParsedRequest(
  parsed: OcxParsedRequest,
  turn: GuardrailsTurn,
): OcxParsedRequest {
  const budget: GuardrailsDemaskBudget = {
    remainingExpansionBytes: MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES,
  };
  const rawBody = parsed._rawBody;
  const parsedWithoutRawBody: OcxParsedRequest = { ...parsed };
  delete parsedWithoutRawBody._rawBody;
  const restored = restoreGuardrailsTextSlots(
    parsedWithoutRawBody,
    turn.state,
    copy => {
      const slots = messageTextSlots(copy.context.messages);
      for (let index = 0; index < (copy.context.systemPrompt?.length ?? 0); index += 1) {
        slots.push({
          value: copy.context.systemPrompt![index]!,
          replace(next) { copy.context.systemPrompt![index] = next; },
        });
      }
      return slots;
    },
    budget,
  );
  if (rawBody !== undefined) {
    restored._rawBody = restoreResponsesRequestFields(rawBody, turn.state, budget);
  }
  return restored;
}

function demaskText(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
): unknown {
  return typeof value === "string"
    ? demaskGuardrailsText(value, state, {
        allowNormalizedPlaceholderDrift: true,
        budget: traversal.demaskBudget,
      })
    : value;
}

function withDemaskedField(
  record: JsonRecord,
  field: string,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
): JsonRecord {
  const original = record[field];
  const demasked = demaskText(original, state, traversal);
  return demasked === original ? record : { ...record, [field]: demasked };
}

/** Only model-visible prose is restored. Tool calls and their executable arguments stay masked. */
function demaskAssistantContentPart(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
): unknown {
  if (!isRecord(value)) return value;
  consumeDemaskNodes(traversal);
  switch (value.type) {
    case "output_text":
    case "text":
      return withDemaskedField(value, "text", state, traversal);
    case "refusal":
      return withDemaskedField(value, "refusal", state, traversal);
    case "tool_use":
    case "server_tool_use":
    case "computer_tool_use":
      inspectExecutableValue(value.input, traversal);
      return value;
    default:
      return value;
  }
}

function demaskContentParts(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
): unknown {
  if (!Array.isArray(value)) return value;
  consumeDemaskNodes(traversal, value.length);
  const mapped = value.map(part => demaskAssistantContentPart(part, state, traversal));
  return mapped.some((part, index) => part !== value[index]) ? mapped : value;
}

function demaskResponsesOutputItem(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
): unknown {
  if (!isRecord(value)) return value;
  consumeDemaskNodes(traversal);
  inspectResponseToolCall(value, traversal);
  if (value.type !== "message" || value.role !== "assistant") return value;
  const content = demaskContentParts(value.content, state, traversal);
  return content === value.content ? value : { ...value, content };
}

function demaskChatMessage(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
  streamPrefix?: string,
): unknown {
  if (!isRecord(value)) return value;
  consumeDemaskNodes(traversal);
  inspectChatToolCalls(value, traversal, streamPrefix);
  const assistantProse = streamPrefix === undefined
    ? value.role === "assistant"
    : value.role === undefined || value.role === "assistant";
  if (!assistantProse) return value;
  let next = withDemaskedField(value, "refusal", state, traversal);
  if (Array.isArray(value.content)) {
    const content = demaskContentParts(value.content, state, traversal);
    if (content !== value.content) next = { ...next, content };
  } else {
    next = withDemaskedField(next, "content", state, traversal);
  }
  return next;
}

function demaskChatChoices(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
): unknown {
  if (!Array.isArray(value)) return value;
  consumeDemaskNodes(traversal, value.length);
  const mapped = value.map((choice, arrayIndex) => {
    if (!isRecord(choice)) return choice;
    consumeDemaskNodes(traversal);
    const choiceIndex = typeof choice.index === "number" ? choice.index : arrayIndex;
    const message = demaskChatMessage(choice.message, state, traversal);
    const delta = demaskChatMessage(choice.delta, state, traversal, `chat:${choiceIndex}`);
    return message === choice.message && delta === choice.delta ? choice : { ...choice, message, delta };
  });
  return mapped.some((choice, index) => choice !== value[index]) ? mapped : value;
}

function demaskAnthropicDelta(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
  streamKey?: string,
): unknown {
  if (!isRecord(value)) return value;
  if (value.type === "text_delta") return withDemaskedField(value, "text", state, traversal);
  if (value.type === "input_json_delta") {
    inspectExecutableValue(value.partial_json, traversal, 0, streamKey);
  }
  return value;
}

function payloadStreamIdentity(payload: JsonRecord, prefix: string): string {
  const identity = ["item_id", "call_id", "output_index", "index"]
    .map(key => payload[key])
    .find(value => typeof value === "string" || typeof value === "number");
  return `${prefix}:${identity ?? "0"}`;
}

function demaskSsePayload(
  payload: JsonRecord,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
): JsonRecord {
  switch (payload.type) {
    case "response.output_text.delta":
    case "response.output_text.done":
      return withDemaskedField(
        payload,
        payload.type.endsWith(".delta") ? "delta" : "text",
        state,
        traversal,
      );
    case "response.refusal.delta":
    case "response.refusal.done":
      return withDemaskedField(
        payload,
        payload.type.endsWith(".delta") ? "delta" : "refusal",
        state,
        traversal,
      );
    case "response.function_call_arguments.delta":
      inspectExecutableValue(
        payload.delta,
        traversal,
        0,
        payloadStreamIdentity(payload, "responses:function"),
      );
      return payload;
    case "response.function_call_arguments.done":
      inspectExecutableValue(payload.arguments, traversal);
      return payload;
    case "response.output_item.added":
    case "response.output_item.done": {
      const item = demaskResponsesOutputItem(payload.item, state, traversal);
      return item === payload.item ? payload : { ...payload, item };
    }
    case "response.content_part.added":
    case "response.content_part.done": {
      const part = demaskAssistantContentPart(payload.part, state, traversal);
      return part === payload.part ? payload : { ...payload, part };
    }
    case "content_block_start": {
      const contentBlock = demaskAssistantContentPart(payload.content_block, state, traversal);
      return contentBlock === payload.content_block ? payload : { ...payload, content_block: contentBlock };
    }
    case "content_block_delta": {
      const delta = demaskAnthropicDelta(
        payload.delta,
        state,
        traversal,
        payloadStreamIdentity(payload, "anthropic:content"),
      );
      return delta === payload.delta ? payload : { ...payload, delta };
    }
    default:
      return payload;
  }
}

function demaskKnownResponsePayload(
  value: unknown,
  state: GuardrailsPlaceholderState,
  traversal: DemaskTraversal,
  depth = 0,
): unknown {
  if (!isRecord(value)) return value;
  if (depth > MAX_GUARDRAILS_OUTPUT_DEPTH) throw new GuardrailsOutputCapacityError();
  consumeDemaskNodes(traversal);
  let next = value;
  const originalOutput = value.output;
  if (Array.isArray(originalOutput)) {
    consumeDemaskNodes(traversal, originalOutput.length);
    const output = originalOutput.map(item => demaskResponsesOutputItem(item, state, traversal));
    if (output.some((item, index) => item !== originalOutput[index])) {
      next = { ...next, output };
    }
  }
  const content = value.role === undefined || value.role === "assistant"
    ? demaskContentParts(value.content, state, traversal)
    : value.content;
  if (content !== value.content) next = { ...next, content };
  const choices = demaskChatChoices(value.choices, state, traversal);
  if (choices !== value.choices) next = { ...next, choices };
  const response = isRecord(value.response)
    ? demaskKnownResponsePayload(value.response, state, traversal, depth + 1)
    : value.response;
  if (response !== value.response) next = { ...next, response };
  return demaskSsePayload(next, state, traversal);
}

export function demaskGuardrailsJsonPayload(
  payload: string,
  turn: GuardrailsTurn,
  onToolArgumentRestoreSkipped?: (count: number) => void,
  sharedBudget?: GuardrailsDemaskBudget,
  onWarning?: () => void,
): string {
  if (turn.mode !== "enforce" || turn.state.replacements.length === 0) return payload;
  try {
    const parsed: unknown = JSON.parse(payload);
    const traversal: DemaskTraversal = {
      demaskBudget: sharedBudget ?? {
        remainingExpansionBytes: Math.max(
          0,
          MAX_GUARDRAILS_OUTPUT_BYTES - Buffer.byteLength(payload, "utf8"),
        ),
      },
      executableDeltaTails: turn.ledger.executableDeltaTails,
      nodes: 0,
      placeholders: new Set(turn.state.replacements.map(replacement => replacement.placeholder)),
      toolArgumentRestoreSkipped: 0,
    };
    const demasked = JSON.stringify(demaskKnownResponsePayload(parsed, turn.state, traversal));
    if (Buffer.byteLength(demasked, "utf8") > MAX_GUARDRAILS_OUTPUT_BYTES) {
      throw new GuardrailsOutputCapacityError();
    }
    if (traversal.toolArgumentRestoreSkipped > 0) {
      onToolArgumentRestoreSkipped?.(traversal.toolArgumentRestoreSkipped);
    }
    return demasked;
  } catch (error) {
    if (error instanceof GuardrailsOutputCapacityError || error instanceof GuardrailsDemaskCapacityError) {
      throw error;
    }
    onWarning?.();
    return payload;
  }
}

function preserveResponseMarkers(source: Response, replacement: Response): Response {
  if (isNativePassthroughSseResponse(source)) markNativePassthroughSseResponse(replacement);
  if (isEagerRelaySseResponse(source)) markEagerRelaySseResponse(replacement);
  return replacement;
}

function transformedResponseHeaders(headers: Headers): Headers {
  const transformed = sanitizePassthroughHeaders(headers);
  for (const name of [
    "content-md5",
    "content-digest",
    "digest",
    "etag",
    "repr-digest",
  ]) {
    transformed.delete(name);
  }
  return transformed;
}

function replayBufferedBody(
  chunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

async function bufferGuardrailsJsonBody(
  response: Response,
): Promise<
  | { bytes: Uint8Array<ArrayBuffer>; kind: "complete" }
  | { body: ReadableStream<Uint8Array>; kind: "passthrough" }
> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    total += next.value.byteLength;
    if (total > MAX_GUARDRAILS_OUTPUT_BYTES) {
      return { kind: "passthrough", body: replayBufferedBody(chunks, reader) };
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "complete", bytes };
}

type GuardrailsResponsePrefixKind = "json" | "pending" | "sse" | "unknown";
const GUARDRAILS_RESPONSE_SNIFF_TIMEOUT_MS = 25;

function isPartialUtf8Bom(prefix: Uint8Array): boolean {
  const bom = [0xef, 0xbb, 0xbf];
  return prefix.byteLength > 0
    && prefix.byteLength < bom.length
    && [...prefix].every((value, index) => value === bom[index]);
}

function classifyGuardrailsResponsePrefix(prefix: Uint8Array): GuardrailsResponsePrefixKind {
  if (isPartialUtf8Bom(prefix)) return "pending";
  const text = new TextDecoder().decode(prefix);
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.length === 0) return "pending";
  if (looksLikeSse(prefix)) return "sse";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (trimmed.startsWith(":")
    || trimmed.startsWith("event:")
    || trimmed.startsWith("data:")
    || trimmed.startsWith("id:")
    || trimmed.startsWith("retry:")) return "sse";
  if (["event:", "data:", "id:", "retry:"].some(field => field.startsWith(trimmed))) return "pending";
  return "unknown";
}

/** Demask only successful model output; upstream error payloads remain untouched. */
export async function demaskGuardrailsResponse(
  response: Response,
  turn: GuardrailsTurn | undefined,
  translatorBudget: TranslatorBudget,
  onWarning?: () => void,
  onToolArgumentRestoreSkipped?: (count: number) => void,
): Promise<Response> {
  if (!turn || turn.mode !== "enforce" || turn.state.replacements.length === 0 || !response.ok || !response.body) {
    return response;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim() ?? "";
  const declaredSse = mediaType === "text/event-stream";
  const declaredJson = mediaType === "application/json" || /^application\/[^/;]+\+json$/.test(mediaType);
  const prefixed = await readBoundedPrefix(
    response.body,
    4096,
    prefix => classifyGuardrailsResponsePrefix(prefix) !== "pending",
    GUARDRAILS_RESPONSE_SNIFF_TIMEOUT_MS,
  );
  const detected = classifyGuardrailsResponsePrefix(prefixed.prefix);
  const isSse = detected === "sse" || (detected !== "json" && declaredSse);
  const isJson = detected === "json" || (detected !== "sse" && declaredJson);
  const body: ReadableStream<Uint8Array<ArrayBufferLike>> = prefixed.stream;
  if (!isSse && !isJson) {
    onWarning?.();
    return preserveResponseMarkers(response, new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }));
  }
  if (isSse) {
    const demaskBudget: GuardrailsDemaskBudget = {
      remainingExpansionBytes: MAX_GUARDRAILS_DEMASK_EXPANSION_BYTES,
    };
    const headers = transformedResponseHeaders(response.headers);
    if (!declaredSse) headers.set("content-type", "text/event-stream");
    return preserveResponseMarkers(response, new Response(
      relaySseWithBlockRewrite(
        body,
        guardrailsSseDemaskRewrite(
          turn.state,
          payload => demaskGuardrailsJsonPayload(
            payload,
            turn,
            onToolArgumentRestoreSkipped,
            demaskBudget,
            onWarning,
          ),
          onWarning,
          demaskBudget,
          error => error instanceof GuardrailsOutputCapacityError,
        ),
        translatorBudget,
      ),
      { status: response.status, statusText: response.statusText, headers },
    ));
  }
  const jsonHeaders = transformedResponseHeaders(response.headers);
  if (!declaredJson) jsonHeaders.set("content-type", "application/json");
  const buffered = await bufferGuardrailsJsonBody(new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: jsonHeaders,
  }));
  if (buffered.kind === "passthrough") {
    onWarning?.();
    return preserveResponseMarkers(response, new Response(buffered.body, {
      status: response.status,
      statusText: response.statusText,
      headers: jsonHeaders,
    }));
  }
  void translatorBudget.observeExternallyCapped("passthrough_serialization", buffered.bytes.byteLength);
  let original: string;
  try {
    original = new TextDecoder("utf-8", { fatal: true }).decode(buffered.bytes);
  } catch {
    onWarning?.();
    return preserveResponseMarkers(response, new Response(buffered.bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: jsonHeaders,
    }));
  }
  let demasked: string;
  try {
    demasked = demaskGuardrailsJsonPayload(
      original,
      turn,
      onToolArgumentRestoreSkipped,
      undefined,
      onWarning,
    );
  } catch (error) {
    if (!(error instanceof GuardrailsOutputCapacityError || error instanceof GuardrailsDemaskCapacityError)) {
      throw error;
    }
    onWarning?.();
    demasked = original;
  }
  return preserveResponseMarkers(response, new Response(demasked, {
    status: response.status,
    statusText: response.statusText,
    headers: jsonHeaders,
  }));
}

export function isGuardrailsCapacityError(error: unknown): boolean {
  return error instanceof GuardrailsScanCapacityError
    || error instanceof GuardrailsOutputCapacityError
    || error instanceof GuardrailsDemaskCapacityError
    || error instanceof GuardrailsSseDemaskCapacityError;
}
