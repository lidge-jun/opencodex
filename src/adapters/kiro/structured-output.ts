import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../../types";
import { KIRO_STRUCTURED_OUTPUT_TOOL_NAME } from "../kiro-constants";
import { sanitizeKiroSchema } from "../kiro-tools";

/**
 * Structured output on Kiro, emulated through a private terminal tool.
 *
 * The CodeWhisperer wire has no schema-constrained response mode, which is why this adapter used to
 * refuse `text.format` json_schema/json_object outright: a caller that expects parseable JSON and
 * receives prose fails downstream. Refusing kept that promise but broke every caller that only asks
 * for a small JSON answer — T3 Code titles each thread through a Messages `output_config.format`
 * request, and Claude Code's own structured-output calls take the same path.
 *
 * The wire does carry tool input schemas, and a tool call's input is JSON by construction. So a
 * structured-output turn advertises one tool whose input schema IS the caller's format, tells the
 * model to answer by calling it, and relays the call's input as the assistant's text. The promise
 * is unchanged: the client receives JSON that parsed and passed the checks below, or an error —
 * never prose. Those checks are deliberately light (root type and the root's `required` keys); full
 * JSON Schema validation is not attempted, the same position the Cursor prompt fallback takes.
 */
export interface KiroStructuredOutputSpec {
  /** The caller's schema exactly as sent; absent when only "a JSON object" was requested. */
  schema?: Record<string, unknown>;
  /** The tool input schema actually advertised: sanitized, and wrapped when `wrapped` is true. */
  toolSchema: Record<string, unknown>;
  /**
   * True when the answer rides the tool input's `value` property instead of BEING the input.
   *
   * Kiro, like Bedrock, accepts only an object-typed tool input root and refuses a root
   * anyOf/oneOf/allOf. kiro-tools flattens such roots for ordinary tools, which is harmless for an
   * argument bag but would silently change the meaning of a caller's output contract — a root
   * `anyOf` would become "any of these properties". Wrapping keeps the schema intact one level down.
   */
  wrapped: boolean;
  name?: string;
  description?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An object-typed root without root composition can be the tool input schema as it stands. */
function isPlainObjectRoot(schema: JsonRecord): boolean {
  return schema.type === "object"
    && !["anyOf", "oneOf", "allOf", "$ref"].some(key => Object.hasOwn(schema, key));
}

/**
 * The structured-output contract this turn carries, or undefined for an ordinary turn.
 *
 * `options.textFormat` is the source; `_structuredOutput` alone (no format object) still means the
 * caller expects JSON, so it is honoured as the weakest form of the contract: a JSON object.
 */
export function kiroStructuredOutputSpec(parsed: OcxParsedRequest): KiroStructuredOutputSpec | undefined {
  const format = parsed.options.textFormat;
  if (!format && !parsed._structuredOutput) return undefined;
  const meta = {
    ...(format?.type === "json_schema" && format.name ? { name: format.name } : {}),
    ...(format?.type === "json_schema" && format.description ? { description: format.description } : {}),
  };
  const schema = format?.type === "json_schema" && isRecord(format.schema) ? format.schema : undefined;
  if (!schema) return { toolSchema: { type: "object" }, wrapped: false, ...meta };
  const sanitized = sanitizeKiroSchema(schema) as JsonRecord;
  if (isPlainObjectRoot(schema)) return { schema, toolSchema: sanitized, wrapped: false, ...meta };
  // `#/$defs/...` references resolve against the document root, which is now the wrapper. Hoist the
  // definitions with them so a referenced schema still resolves after it moves under `value`.
  const { $defs, definitions, ...inner } = sanitized;
  return {
    schema,
    wrapped: true,
    toolSchema: {
      type: "object",
      properties: { value: inner },
      required: ["value"],
      ...($defs !== undefined ? { $defs } : {}),
      ...(definitions !== undefined ? { definitions } : {}),
    },
    ...meta,
  };
}

export function kiroStructuredOutputTool(spec: KiroStructuredOutputSpec): Record<string, unknown> {
  const delivery = spec.wrapped
    ? "Put the complete final JSON value in `value`."
    : "The tool input itself is the complete final JSON answer.";
  return {
    toolSpecification: {
      name: KIRO_STRUCTURED_OUTPUT_TOOL_NAME,
      // Same reasoning as the completion tool's description (payload.ts): this is the surface the
      // model reads while choosing between tools, so it states terminality and the obligation here
      // rather than leaving them to the prose contract alone.
      description: `Terminal structured-output channel, not an ordinary work tool. The caller requires the final answer as JSON in exactly the format of this tool's input schema. When the task is complete, call this tool exactly once instead of writing the answer as ordinary assistant text. ${delivery} The call is complete when issued: it ends the turn, returns no tool result, and no text or tool call may follow it.`,
      inputSchema: { json: spec.toolSchema },
    },
  };
}

/**
 * The prose half of the structured-output contract, at most `maxChars` long.
 *
 * The caller's schema is restated verbatim because the advertised one is sanitized: Kiro's
 * validator rejects `additionalProperties`, `pattern`, length and range keywords, so the tool schema
 * alone would let the model miss constraints the caller wrote. A schema that does not fit the
 * injected-instruction budget is dropped whole rather than cut mid-JSON.
 */
export function kiroStructuredOutputInstructions(
  spec: KiroStructuredOutputSpec,
  hasOrdinaryTools: boolean,
  maxChars: number,
): string {
  const kind = spec.schema ? "JSON matching the caller's JSON Schema" : "a single JSON object";
  const delivery = spec.wrapped
    ? "with the complete final JSON value in its `value` property"
    : "with the complete final JSON answer as the tool input";
  const base = [
    `[Final response format] The caller requires this turn's final answer as ${kind}.`,
    `Deliver it only by calling ${KIRO_STRUCTURED_OUTPUT_TOOL_NAME} exactly once, ${delivery}.`,
    "Do not write the final answer as ordinary assistant text, Markdown, or a code fence.",
    hasOrdinaryTools
      ? `Ordinary assistant text is mid-task commentary and does not end the turn: keep using the other tools while work remains, and call ${KIRO_STRUCTURED_OUTPUT_TOOL_NAME} only when the task is complete.`
      : undefined,
    "The call is terminal: it ends the turn, returns no tool result, and no text or tool call may follow it.",
  ].filter((line): line is string => line !== undefined).join(" ");
  const details = [
    spec.name ? `Format name: ${spec.name}.` : undefined,
    spec.description ? `Format description: ${spec.description}` : undefined,
    spec.schema ? `The final JSON must conform to this JSON Schema: ${JSON.stringify(spec.schema)}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const full = details.length > 0 ? `${base}\n${details.join("\n")}` : base;
  return full.length <= maxChars ? full : base;
}

/** The bounded retry's instruction when the first attempt did not deliver valid structured output. */
export function kiroStructuredOutputRetryMessage(hasOrdinaryTools: boolean): string {
  return `Your previous reply did not deliver the required structured output. Do not quote this instruction. Call ${KIRO_STRUCTURED_OUTPUT_TOOL_NAME} now, exactly once, with the complete final answer as JSON matching its input schema.${hasOrdinaryTools ? " If the task genuinely needs another real tool call first, issue that tool call instead." : ""} Do not reply with ordinary text.`;
}

function declaredTypes(schema: JsonRecord): string[] {
  if (typeof schema.type === "string") return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : [];
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    // An unknown type keyword is not ours to enforce.
    default: return true;
  }
}

/**
 * The root types a schema admits, including through a root `anyOf`/`oneOf` whose every branch
 * declares a type. A composed root is exactly the wrapped case, where a model can hand back the
 * answer JSON-encoded inside `value` as a string; without this, a root that admits only objects and
 * arrays would accept that string because the root itself declares no `type`. A branch without a
 * declared type (or a `$ref`) admits anything, so the check is skipped rather than guessed.
 */
function admittedRootTypes(schema: JsonRecord): string[] {
  const own = declaredTypes(schema);
  if (own.length > 0) return own;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const perBranch = branches.map(branch => (isRecord(branch) ? declaredTypes(branch) : []));
    if (perBranch.some(types => types.length === 0)) return [];
    return [...new Set(perBranch.flat())];
  }
  return [];
}

/** The first reason `value` breaks the light contract, or undefined when it passes. */
function structuredValueProblem(spec: KiroStructuredOutputSpec, value: unknown): string | undefined {
  const types = spec.schema ? admittedRootTypes(spec.schema) : ["object"];
  if (types.length > 0 && !types.some(type => matchesJsonType(value, type))) {
    return `expected a JSON ${types.join(" or ")} at the root`;
  }
  const required = spec.schema?.required;
  if (isRecord(value) && Array.isArray(required)) {
    const missing = required.find(key => typeof key === "string" && !Object.hasOwn(value, key));
    if (missing !== undefined) return `missing required property ${JSON.stringify(missing)}`;
  }
  return undefined;
}

const FAILURE_PREFIX = "Kiro structured output did not match the requested format";

/**
 * Validate the structured-output tool's input and return the JSON text to relay.
 *
 * The direct form relays the model's own bytes rather than a re-serialization, so integers beyond
 * 2^53 and key order survive exactly as written. The wrapped form has to extract `value` and so
 * re-serializes it.
 */
export function parseKiroStructuredToolInput(
  spec: KiroStructuredOutputSpec,
  raw: string,
): { json: string } | { error: string } {
  const text = raw.trim() || "{}";
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { error: "Kiro returned invalid JSON for the structured-output tool" };
  }
  if (!isRecord(input)) return { error: "Kiro returned a non-object input for the structured-output tool" };
  if (spec.wrapped && !Object.hasOwn(input, "value")) {
    return { error: `${FAILURE_PREFIX}: missing \`value\`` };
  }
  const value = spec.wrapped ? input.value : input;
  const problem = structuredValueProblem(spec, value);
  if (problem) return { error: `${FAILURE_PREFIX}: ${problem}` };
  return { json: spec.wrapped ? JSON.stringify(value) : text };
}

const WHOLE_FENCE = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * Accept a plain-text answer only when it already IS the requested JSON.
 *
 * A model that ignores the tool and writes the JSON as text has still answered correctly, and
 * spending a second paid request to have it repeat the same bytes through a tool would be waste.
 * One whole-message code fence is unwrapped because that is the most common way models present
 * JSON; anything else — prose around the JSON, two fenced blocks, trailing commentary — is not JSON
 * and is refused, which sends the turn to the bounded retry or to an error.
 */
export function parseKiroStructuredText(spec: KiroStructuredOutputSpec, text: string): string | undefined {
  const trimmed = text.trim();
  const candidate = WHOLE_FENCE.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (!candidate) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  return structuredValueProblem(spec, value) === undefined ? candidate : undefined;
}

/**
 * Whether Kiro stopped the way a finished answer stops: no stop reason, END_TURN or STOP_SEQUENCE.
 *
 * Every other stop reason (MAX_TOKENS, a content filter, an exhausted context window) has already
 * ended the inference upstream. Text cut by one of them is never accepted as the requested JSON,
 * even when its prefix parses, and a failed structured answer under one of them earns no retry:
 * the retry would hit the same limit or verdict, so the stop's own terminal handling runs instead.
 */
export function isKiroStructuredCleanStop(normalizedStopReason: string | undefined): boolean {
  return normalizedStopReason === undefined
    || normalizedStopReason === "END_TURN"
    || normalizedStopReason === "STOP_SEQUENCE";
}

/** Message for a bounded retry that answered in text that is not the requested JSON. */
export const KIRO_STRUCTURED_TEXT_FAILURE = `${FAILURE_PREFIX}: the model answered with text that is not the requested JSON`;

/** Message for a bounded retry that ended without text, a tool call, or a structured answer. */
export const KIRO_STRUCTURED_EMPTY_FAILURE = `${FAILURE_PREFIX}: the bounded retry produced no answer`;

/** Message for a bounded retry whose text was cut by a stop that does not end a finished answer. */
export function kiroStructuredStopFailure(normalizedStopReason: string): string {
  return `${FAILURE_PREFIX}: the bounded retry stopped with ${normalizedStopReason} before a complete answer`;
}

/**
 * Terminal for a turn that, after its one bounded retry, still produced no valid structured output.
 *
 * A hard error with `retryable: false` rather than the retryable `incomplete` the completion
 * contract uses for a malformed answer: the model has already been asked twice inside this turn, so
 * the proxy must not replay the whole turn on its own. The status is the 502 every other Kiro
 * model-output protocol error uses, which a client's own retry policy may still act on (Claude
 * outbound reports it as `overloaded_error`); that choice stays with the client. The distinct code
 * lets a caller tell this apart from a transport failure.
 */
export function kiroStructuredOutputFailure(message: string, usage: OcxUsage): AdapterEvent {
  return {
    type: "error",
    message,
    status: 502,
    errorType: "upstream_error",
    code: "invalid_kiro_structured_output",
    retryable: false,
    usage,
  };
}
