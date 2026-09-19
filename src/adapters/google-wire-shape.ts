import { MAX_DEBUG_LINE_BYTES } from "../lib/debug-log-buffer";
import { THOUGHT_SIGNATURE_BYPASS } from "./google-antigravity-replay";
import type { AntigravitySessionAnchor } from "./google-antigravity-wire";
import { isGoogleThinkingConfigErrorText, isGoogleToolSchemaErrorText } from "./google-wire-compiler";

/**
 * Content-free structural projection of a compiled Google-family wire request (#5008).
 *
 * Why this exists. The report behind #5008 is an intermittent HTTP 400 on the FIRST upstream
 * send of a long, tool-heavy Antigravity session: "Please ensure that function call turn comes
 * immediately after a user turn or after a function response turn." The reporter's own static
 * matrix (A-F on the issue) exercised every adjacency hazard the translator can produce and all
 * of them returned 200, so the failing wire cannot be reconstructed from the repro shapes. What
 * is missing is a description of the request that actually failed, and the only description a
 * user can attach to a public bug report is one that carries no conversation in it.
 *
 * This module is that description. It reads the request object AFTER compileGoogleWireBody and
 * after Antigravity replay/signature adjustment — the exact object the envelope carries — and
 * returns counts, positions, kinds and booleans.
 *
 * What it never retains, by construction rather than by redaction: prompt or system text, tool
 * arguments, tool results, tool or function names, original or wire tool-call ids, thought
 * signature text or any hash of it, inline file bytes, project or account identifiers, the
 * request id, the Cloud Code Assist session id, the Codex thread or session ids, and the first
 * user message. Tool-call identity survives only as a request-internal ordinal assigned in
 * first-appearance order, which is enough to show pairing structure and is meaningless outside
 * the single request that produced it.
 *
 * Totals are computed over the whole request; per-turn detail is cut at
 * GOOGLE_WIRE_SHAPE_TURN_CEILING and the summary is marked truncated. A 440-message session
 * therefore still reports its true turn and call counts.
 *
 * This is a projection, not a validator. It does not decide whether a request is acceptable to
 * the upstream, and nothing in the request path consults its output.
 *
 * What it costs. With provider debug off the projection never runs: the call site passes a
 * builder to debugProviderDiagnosticLazy, which returns before invoking it. With provider debug
 * ON it runs synchronously on the dispatch path, before the request is sent, and it walks every
 * turn, every part and every call id, then serializes, redacts and writes one line. The cost is
 * linear in history length, which is largest for exactly the long sessions this exists to
 * describe. That is the price of observing the real outbound body rather than a reconstruction,
 * and an operator who turns provider debug on for a 440-message session is paying it on every
 * turn.
 */

/** Per-turn detail beyond this many turns is dropped; totals are unaffected. */
export const GOOGLE_WIRE_SHAPE_TURN_CEILING = 64;

/** Per-turn ordinal lists are cut here; the turn's own counts are unaffected. */
export const GOOGLE_WIRE_SHAPE_ORDINAL_CEILING = 16;

/** Longest error text inspected by classifyGoogleWireUpstreamError. */
const UPSTREAM_ERROR_SCAN_LIMIT = 2048;

/**
 * Serialized ceiling for one summary, held at half the debug buffer's per-line cap so the event
 * prefix and any redaction copy still fit under it.
 *
 * The item ceilings above are not sufficient on their own: 64 retained turns carrying 16 ordinals
 * each serialize past the buffer's limit, and the buffer truncates at a byte boundary. That
 * leaves a consumer with JSON it cannot parse whose retained prefix still says truncated is
 * false — a cut that hides itself. Trimming here instead keeps the line parseable and keeps the
 * flag honest.
 */
export const GOOGLE_WIRE_SHAPE_MAX_SERIALIZED_BYTES = Math.floor(MAX_DEBUG_LINE_BYTES / 2);

export type GoogleWireTurnRole = "user" | "model" | "other";

export type GoogleWirePartKind =
  | "text"
  | "thought"
  | "functionCall"
  | "functionResponse"
  | "inlineData"
  | "other";

/**
 * Ordering classes transcribed from the upstream error text, not inferred from it.
 *
 * The message names one relationship — a function-call turn must follow a user turn or a
 * function-response turn — so call-turn-opens-request and call-turn-after-model-turn are the two
 * ways a well-formed request can contradict it, call-turn-after-unknown-turn covers a predecessor
 * that is neither, and response-turn-without-call-turn is its converse.
 * request-ends-with-model-turn is a different upstream 400 that messagesToGeminiFormat already
 * guards with its "(continue)" nudge; it is projected so a defeated guard is visible rather than
 * silent.
 *
 * A flag is not a verdict. The reporter's case A produces call-turn-after-model-turn and
 * returned 200, which is itself worth being able to observe in a real failing request.
 */
export type GoogleWireOrderingViolation =
  | "call-turn-opens-request"
  | "call-turn-after-model-turn"
  | "call-turn-after-unknown-turn"
  | "response-turn-without-call-turn"
  | "request-ends-with-model-turn";

/** Bounded classes for an upstream rejection. The error text itself is never retained. */
export type GoogleWireUpstreamErrorClass =
  | "turn-adjacency"
  | "thought-signature"
  | "tool-schema"
  | "thinking-config"
  | "other";

export interface GoogleWireTurnShape {
  /** Position in contents. */
  index: number;
  role: GoogleWireTurnRole;
  /** Number of parts in this turn. */
  parts: number;
  /** Distinct part kinds, in first-appearance order. */
  kinds: GoogleWirePartKind[];
  /** Request-internal ordinals of the function calls in this turn. */
  calls: number[];
  /** Request-internal ordinals of the function responses in this turn. */
  responses: number[];
  /** Function calls carrying any thought signature. */
  signedCalls: number;
  /** Of those, the ones carrying only the validator-bypass sentinel. */
  sentinelCalls: number;
  violation?: GoogleWireOrderingViolation;
}

/** Facts the caller knows and the wire body does not carry. */
export interface GoogleWireShapeFacts {
  /** Which anchor class produced the Antigravity session id. Never the id itself. */
  sessionAnchor?: AntigravitySessionAnchor;
  /**
   * Function calls the translator signed from client history or the durable replay store,
   * counted before the Antigravity session cache runs.
   */
  historySignedCalls?: number;
  /** A durable replay scope was attached to this request. Its completeness is NOT asserted. */
  replayScopeBound?: boolean;
  /** The real physical send this body belongs to, 1 for the first send. */
  sendOrdinal?: number;
  /** Bounded class of the upstream rejection, when this body was rejected. */
  errorClass?: GoogleWireUpstreamErrorClass;
}

export type GoogleWireShapeSummary = {
  version: 1;
  /** Per-turn detail was cut by a ceiling. Totals below remain exact. */
  truncated: boolean;
  turns: number;
  roles: Record<GoogleWireTurnRole, number>;
  functionCalls: number;
  functionResponses: number;
  /** Distinct tool-call ids seen anywhere in the request. */
  distinctCallIds: number;
  /** Function calls that carried no id at all. */
  callsWithoutId: number;
  /** Function responses that carried no id at all. */
  responsesWithoutId: number;
  /** Call ordinals no response answers. */
  unansweredCalls: number;
  /** Response ordinals no call introduced. */
  unmatchedResponses: number;
  toolDeclarations: number;
  hasSystemInstruction: boolean;
  hasSessionId: boolean;
  sessionAnchor: AntigravitySessionAnchor | "unknown";
  signature: {
    /** At least one function call reaches the wire with a signature. */
    present: boolean;
    /** Every signed call carries only the validator-bypass sentinel. */
    sentinelOnly: boolean;
    signedCalls: number;
    sentinelCalls: number;
    /** Signed at translation time, from client history or the durable replay store. */
    historySignedCalls: number;
    /**
     * The remainder the Antigravity session cache supplied, clamped at zero. The cache never
     * overwrites an existing signature, so the three counts partition the signed calls.
     */
    sessionCacheSignedCalls: number;
    /**
     * A durable replay scope was attached. Whether it was COMPLETE enough to key a lookup is
     * decided inside lookupReplayThoughtSignature and is deliberately not claimed here.
     */
    replayScopeBound: boolean;
  };
  orderingViolations: number;
  firstOrderingViolation: { index: number; kind: GoogleWireOrderingViolation } | null;
  /** Present only when the caller supplied send facts. */
  send: { ordinal: number; errorClass: GoogleWireUpstreamErrorClass | null } | null;
  turnShapes: GoogleWireTurnShape[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function turnRole(content: Record<string, unknown>): GoogleWireTurnRole {
  const role = content.role;
  return role === "user" || role === "model" ? role : "other";
}

function partKind(part: Record<string, unknown>): GoogleWirePartKind {
  if (part.thought === true) return "thought";
  if (isRecord(part.functionCall)) return "functionCall";
  if (isRecord(part.functionResponse)) return "functionResponse";
  if (isRecord(part.inline_data) || isRecord(part.inlineData)) return "inlineData";
  if (typeof part.text === "string") return "text";
  return "other";
}

/**
 * A function call or response id, read only to be replaced by an ordinal. The value never
 * leaves this function.
 */
function callIdOf(call: Record<string, unknown>): string | undefined {
  const id = call.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function signatureOf(part: Record<string, unknown>): string | undefined {
  const camel = part.thoughtSignature;
  if (typeof camel === "string" && camel.length > 0) return camel;
  const snake = part.thought_signature;
  if (typeof snake === "string" && snake.length > 0) return snake;
  return undefined;
}

/** Request-internal renumbering: first appearance wins, and the mapping dies with the call. */
function ordinalAllocator(): (rawId: string) => number {
  const ordinals = new Map<string, number>();
  return rawId => {
    const existing = ordinals.get(rawId);
    if (existing !== undefined) return existing;
    const next = ordinals.size + 1;
    ordinals.set(rawId, next);
    return next;
  };
}

function countToolDeclarations(tools: unknown): number {
  if (!Array.isArray(tools)) return 0;
  let total = 0;
  for (const tool of tools) {
    if (!isRecord(tool) || !Array.isArray(tool.functionDeclarations)) continue;
    total += tool.functionDeclarations.length;
  }
  return total;
}

interface TurnFacts {
  role: GoogleWireTurnRole;
  hasFunctionCall: boolean;
  hasFunctionResponse: boolean;
}

/**
 * The first ordering class this turn contradicts, judged against the turn before it.
 *
 * "Function response turn" is read as a user turn carrying at least one functionResponse, which
 * is the shape messagesToGeminiFormat emits for a tool-result batch. A plain user turn satisfies
 * the rule on its own, so a call turn after either one is unflagged.
 */
function violationFor(turn: TurnFacts, previous: TurnFacts | undefined, isLast: boolean): GoogleWireOrderingViolation | undefined {
  if (turn.role === "model" && turn.hasFunctionCall) {
    if (!previous) return "call-turn-opens-request";
    if (previous.role === "model") return "call-turn-after-model-turn";
    if (previous.role !== "user") return "call-turn-after-unknown-turn";
  }
  if (turn.role === "user" && turn.hasFunctionResponse) {
    if (!previous || previous.role !== "model" || !previous.hasFunctionCall) {
      return "response-turn-without-call-turn";
    }
  }
  if (isLast && turn.role === "model") return "request-ends-with-model-turn";
  return undefined;
}

function serializedBytes(summary: GoogleWireShapeSummary): number {
  return new TextEncoder().encode(JSON.stringify(summary)).length;
}

/**
 * Drop per-turn detail from the tail until the summary serializes under its byte budget.
 *
 * Trimming from the tail rather than the head is deliberate: the opening turns of a request are
 * where a first-send ordering violation lives, and they are what a reader needs most.
 */
function fitToSerializedBudget(summary: GoogleWireShapeSummary): GoogleWireShapeSummary {
  if (serializedBytes(summary) <= GOOGLE_WIRE_SHAPE_MAX_SERIALIZED_BYTES) return summary;
  let kept = summary.turnShapes.length;
  let fitted: GoogleWireShapeSummary = { ...summary, truncated: true, turnShapes: summary.turnShapes };
  while (kept > 0 && serializedBytes(fitted) > GOOGLE_WIRE_SHAPE_MAX_SERIALIZED_BYTES) {
    kept -= 1;
    fitted = { ...summary, truncated: true, turnShapes: summary.turnShapes.slice(0, kept) };
  }
  return fitted;
}

/**
 * Project the structure of a compiled Google wire request body.
 *
 * Pure and non-mutating: every field is read, nothing is written back, and the returned object
 * shares no reference with the input.
 */
export function summarizeGoogleWireShape(
  body: unknown,
  facts: GoogleWireShapeFacts = {},
): GoogleWireShapeSummary {
  const root = isRecord(body) ? body : {};
  const contents: unknown[] = Array.isArray(root.contents) ? root.contents : [];
  const ordinalFor = ordinalAllocator();
  const historySignedCalls = Math.max(0, facts.historySignedCalls ?? 0);

  const roles: Record<GoogleWireTurnRole, number> = { user: 0, model: 0, other: 0 };
  const callOrdinals = new Set<number>();
  const responseOrdinals = new Set<number>();
  const turnShapes: GoogleWireTurnShape[] = [];

  let functionCalls = 0;
  let functionResponses = 0;
  let callsWithoutId = 0;
  let responsesWithoutId = 0;
  let signedCalls = 0;
  let sentinelCalls = 0;
  let orderingViolations = 0;
  let truncated = false;
  let firstOrderingViolation: GoogleWireShapeSummary["firstOrderingViolation"] = null;
  let previous: TurnFacts | undefined;

  for (let index = 0; index < contents.length; index++) {
    const rawContent: unknown = contents[index];
    const content = isRecord(rawContent) ? rawContent : {};
    const role = turnRole(content);
    roles[role] += 1;
    const parts: unknown[] = Array.isArray(content.parts) ? content.parts : [];
    const kinds: GoogleWirePartKind[] = [];
    const calls: number[] = [];
    const responses: number[] = [];
    let turnSignedCalls = 0;
    let turnSentinelCalls = 0;

    for (const rawPart of parts) {
      const part = isRecord(rawPart) ? rawPart : {};
      const kind = partKind(part);
      if (!kinds.includes(kind)) kinds.push(kind);
      if (kind === "functionCall") {
        functionCalls += 1;
        const id = callIdOf(part.functionCall as Record<string, unknown>);
        if (id === undefined) {
          callsWithoutId += 1;
        } else {
          const ordinal = ordinalFor(id);
          callOrdinals.add(ordinal);
          if (calls.length < GOOGLE_WIRE_SHAPE_ORDINAL_CEILING) calls.push(ordinal);
          else truncated = true;
        }
        const signature = signatureOf(part);
        if (signature !== undefined) {
          turnSignedCalls += 1;
          if (signature === THOUGHT_SIGNATURE_BYPASS) turnSentinelCalls += 1;
        }
      } else if (kind === "functionResponse") {
        functionResponses += 1;
        const id = callIdOf(part.functionResponse as Record<string, unknown>);
        if (id === undefined) {
          responsesWithoutId += 1;
        } else {
          const ordinal = ordinalFor(id);
          responseOrdinals.add(ordinal);
          if (responses.length < GOOGLE_WIRE_SHAPE_ORDINAL_CEILING) responses.push(ordinal);
          else truncated = true;
        }
      }
    }

    signedCalls += turnSignedCalls;
    sentinelCalls += turnSentinelCalls;
    const current: TurnFacts = {
      role,
      hasFunctionCall: kinds.includes("functionCall"),
      hasFunctionResponse: kinds.includes("functionResponse"),
    };
    const violation = violationFor(current, previous, index === contents.length - 1);
    if (violation) {
      orderingViolations += 1;
      if (!firstOrderingViolation) firstOrderingViolation = { index, kind: violation };
    }
    if (turnShapes.length < GOOGLE_WIRE_SHAPE_TURN_CEILING) {
      turnShapes.push({
        index,
        role,
        parts: parts.length,
        kinds,
        calls,
        responses,
        signedCalls: turnSignedCalls,
        sentinelCalls: turnSentinelCalls,
        ...(violation ? { violation } : {}),
      });
    } else {
      truncated = true;
    }
    previous = current;
  }

  let unansweredCalls = 0;
  for (const ordinal of callOrdinals) if (!responseOrdinals.has(ordinal)) unansweredCalls += 1;
  let unmatchedResponses = 0;
  for (const ordinal of responseOrdinals) if (!callOrdinals.has(ordinal)) unmatchedResponses += 1;

  return fitToSerializedBudget({
    version: 1,
    truncated,
    turns: contents.length,
    roles,
    functionCalls,
    functionResponses,
    distinctCallIds: new Set([...callOrdinals, ...responseOrdinals]).size,
    callsWithoutId,
    responsesWithoutId,
    unansweredCalls,
    unmatchedResponses,
    toolDeclarations: countToolDeclarations(root.tools),
    hasSystemInstruction: isRecord(root.systemInstruction),
    hasSessionId: typeof root.sessionId === "string" && root.sessionId.length > 0,
    sessionAnchor: facts.sessionAnchor ?? "unknown",
    signature: {
      present: signedCalls > 0,
      sentinelOnly: signedCalls > 0 && signedCalls === sentinelCalls,
      signedCalls,
      sentinelCalls,
      historySignedCalls,
      sessionCacheSignedCalls: Math.max(0, signedCalls - sentinelCalls - historySignedCalls),
      replayScopeBound: facts.replayScopeBound === true,
    },
    orderingViolations,
    firstOrderingViolation,
    send: facts.sendOrdinal === undefined
      ? null
      : { ordinal: facts.sendOrdinal, errorClass: facts.errorClass ?? null },
    turnShapes,
  });
}

/**
 * Classify an upstream rejection into one of a fixed set of classes.
 *
 * Bounded in both directions: at most UPSTREAM_ERROR_SCAN_LIMIT characters are inspected, and
 * only the class is returned, so no upstream text reaches a caller through this function.
 */
export function classifyGoogleWireUpstreamError(message: unknown): GoogleWireUpstreamErrorClass {
  if (typeof message !== "string" || message.length === 0) return "other";
  const scanned = message.slice(0, UPSTREAM_ERROR_SCAN_LIMIT);
  if (/function\s+call\s+turn|function\s+response\s+turn|model\s+turn\s+are\s+not\s+supported|assistant\s+message\s+prefill/i.test(scanned)) {
    return "turn-adjacency";
  }
  if (/thought[_\s-]?signature|TYPE_BYTES/i.test(scanned)) return "thought-signature";
  // Shared with the wire compiler's repair path so a payload cannot be repaired as one class
  // and described as another.
  if (isGoogleToolSchemaErrorText(scanned)) return "tool-schema";
  if (isGoogleThinkingConfigErrorText(scanned)) return "thinking-config";
  return "other";
}
