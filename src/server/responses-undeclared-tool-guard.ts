import {
  CODE_MODE_EXEC_TOOL_NAME,
  namespacedToolName,
  normalizeDeclaredToolName,
} from "../types";
import { sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

/** Item types the client executes through a request-declared wire name. */
const CLIENT_EXECUTED_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
/** Codex groups ordinary top-level tools here; unlike an MCP namespace, it has no wire prefix. */
const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

/**
 * Hosted declarations whose response items the PROVIDER executes, keyed by the request
 * declaration type. These need no client answer, so their names are deliberately absent from
 * the request catalog and must not be read as an undeclared client tool.
 *
 * xAI surfaces hosted `x_search` as `custom_tool_call`. Probed 2026-08-23 against the OAuth CLI
 * destination: its hosted calls use an `xs_call-` call-id prefix. Observed call names were
 * `x_keyword_search`, `x_semantic_search`, and `x_user_search` — three literals for one tool,
 * which is why authorization keys on the declaration, item type, and call-id prefix, never on
 * the name.
 */
export type ProviderExecutedCallType = Readonly<{
  itemType: string;
  callIdPrefix: string;
}>;

type ProviderExecutedCallTypes = ReadonlySet<ProviderExecutedCallType>;

export const PROVIDER_EXECUTED_DECLARATION_CALL_TYPES = new Map<string, ProviderExecutedCallType>([
  ["x_search", { itemType: "custom_tool_call", callIdPrefix: "xs_call-" }],
]);

/** Nameless declaration kinds whose response items still require client execution. */
const NAMELESS_CLIENT_DECLARATION_CALL_TYPES = new Map([
  ["local_shell", "local_shell_call"],
  ["tool_search", "tool_search_call"],
  ["computer_use_preview", "computer_call"],
  ["computer_use", "computer_call"],
]);

const NAMELESS_CLIENT_CALL_DISPLAY_NAMES = new Map([
  ["local_shell_call", "local_shell"],
  ["tool_search_call", "tool_search"],
  ["computer_call", "computer_use"],
]);

const EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES: ReadonlySet<string> = new Set();
const EMPTY_PROVIDER_EXECUTED_CALL_TYPES: ReadonlySet<ProviderExecutedCallType> = new Set();

/** Supported hosted/private declarations that carry no client-executable wire name. */
const NAMELESS_TOOL_SPEC_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "computer_use_preview",
  "computer_use",
  "code_interpreter",
  "image_generation",
  "image_gen",
  "mcp",
  "tool_search",
  "local_shell",
  "x_search",
]);

/** An upstream-supplied name reaches the error message; keep it bounded. */
const MAX_REPORTED_NAME_CHARS = 100;

export const UNDECLARED_TOOL_CALL_ERROR_CODE = "undeclared_tool_call";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function addWireToolName(names: Set<string>, tool: unknown, namespace?: string): void {
  if (!isPlainObject(tool)) return;
  const nestedFunction = tool.type === "function" && isPlainObject(tool.function)
    ? tool.function
    : undefined;
  const name = typeof tool.name === "string" && tool.name.length > 0
    ? tool.name
    : typeof nestedFunction?.name === "string" && nestedFunction.name.length > 0
      ? nestedFunction.name
      : undefined;
  if (!name) return;
  // Codex routes MCP calls by an explicit `namespace` field, so the same tool is reachable
  // as a bare inner name or as the flattened form; accept both rather than guess which
  // coordinate system this provider echoes back.
  if (!namespace || namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
    names.add(name);
    return;
  }
  names.add(namespacedToolName(namespace, name));
  // `exec` is the one name that also switches on nested-helper normalization, so a bare alias
  // for a namespaced MCP tool would silently authorize `exec_command`/`shell_command`/
  // `apply_patch` the request never declared. Every other inner name keeps the bare alias.
  if (name !== CODE_MODE_EXEC_TOOL_NAME) names.add(name);
}

/**
 * Catalog view owned by the current Responses turn.
 *
 * `previous_response_id` expansion prepends stored input items, including historical
 * `additional_tools` declarations. Those items remain conversation history but cannot grant
 * execution authority to this turn. Top-level `tools` always belongs to the current request;
 * only input catalogs at or after the replay boundary are current.
 */
export function currentTurnWireToolCatalogBody(
  body: unknown,
  replayPrefixLength: number | undefined,
): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  if (typeof replayPrefixLength !== "number" || !Number.isFinite(replayPrefixLength)) return body;
  const start = Math.min(body.input.length, Math.max(0, Math.trunc(replayPrefixLength)));
  if (start === 0) return body;
  return { ...body, input: body.input.slice(start) };
}

function addWireToolSpecs(names: Set<string>, specs: unknown): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec)) continue;
    if (spec.type === "namespace" && Array.isArray(spec.tools)) {
      const namespace = typeof spec.name === "string" ? spec.name : undefined;
      for (const inner of spec.tools) addWireToolName(names, inner, namespace);
      continue;
    }
    addWireToolName(names, spec);
  }
}

/**
 * Tool names the OUTBOUND Responses body actually declared.
 *
 * This reads the body that goes upstream rather than the parsed internal tool list: the
 * passthrough forwards wire shapes (namespaced MCP groups, `additional_tools` items carried
 * inside `input`, routed custom-tool rewrites) that the internal list flattens or renames, and
 * only the wire names can be compared against what the provider echoes back.
 */
export function collectDeclaredWireToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(body)) return names;
  addWireToolSpecs(names, body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) addWireToolSpecs(names, item.tools);
    }
  }
  return names;
}

function addNamelessClientCallTypes(callTypes: Set<string>, specs: unknown): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec) || typeof spec.type !== "string") continue;
    const callType = NAMELESS_CLIENT_DECLARATION_CALL_TYPES.get(spec.type);
    if (callType) callTypes.add(callType);
  }
}

function addProviderExecutedCallTypes(
  callTypes: Set<ProviderExecutedCallType>,
  specs: unknown,
): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec) || typeof spec.type !== "string") continue;
    const callType = PROVIDER_EXECUTED_DECLARATION_CALL_TYPES.get(spec.type);
    if (callType) callTypes.add(callType);
  }
}

/**
 * Item types this turn's hosted declarations authorize the PROVIDER to emit unnamed.
 *
 * Caller must gate this on the destination actually being that provider; a declaration alone
 * is not authority, or any upstream could claim a hosted shape it never serves.
 */
export function collectProviderExecutedCallTypes(body: unknown): Set<ProviderExecutedCallType> {
  const callTypes = new Set<ProviderExecutedCallType>();
  if (!isPlainObject(body)) return callTypes;
  addProviderExecutedCallTypes(callTypes, body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) addProviderExecutedCallTypes(callTypes, item.tools);
    }
  }
  return callTypes;
}

function isAuthorizedProviderExecutedCall(
  item: Record<string, unknown>,
  callTypes: ProviderExecutedCallTypes,
): boolean {
  if (typeof item.call_id !== "string") return false;
  for (const callType of callTypes) {
    if (
      item.type === callType.itemType
      && item.call_id.startsWith(callType.callIdPrefix)
    ) return true;
  }
  return false;
}

/** Nameless client-call item types authorized by supported request tool declarations. */
export function collectDeclaredNamelessClientCallTypes(body: unknown): Set<string> {
  const callTypes = new Set<string>();
  if (!isPlainObject(body)) return callTypes;
  addNamelessClientCallTypes(callTypes, body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) {
        addNamelessClientCallTypes(callTypes, item.tools);
      }
    }
  }
  return callTypes;
}

function isReadableWireToolSpec(spec: unknown): boolean {
  if (!isPlainObject(spec) || typeof spec.type !== "string" || spec.type.length === 0) return false;
  if (spec.type === "function") {
    return (typeof spec.name === "string" && spec.name.length > 0)
      || (isPlainObject(spec.function)
        && typeof spec.function.name === "string"
        && spec.function.name.length > 0);
  }
  if (spec.type === "custom") return typeof spec.name === "string" && spec.name.length > 0;
  if (spec.type === "namespace") {
    return typeof spec.name === "string"
      && spec.name.length > 0
      && Array.isArray(spec.tools)
      && (spec.tools.length === 0 || spec.tools.some(inner =>
        isPlainObject(inner)
        && (inner.type === "function" || inner.type === "custom")
        && typeof inner.name === "string"
        && inner.name.length > 0
      ));
  }
  if (NAMELESS_TOOL_SPEC_TYPES.has(spec.type)) return true;
  return typeof spec.name === "string" && spec.name.length > 0;
}

function isReadableWireToolCatalog(value: unknown): boolean {
  return Array.isArray(value)
    && (value.length === 0 || value.some(isReadableWireToolSpec));
}

/** Whether a request contains a supported catalog, including an explicit empty deny-all array. */
export function hasExplicitWireToolCatalog(body: unknown): boolean {
  if (!isPlainObject(body)) return false;
  if (isReadableWireToolCatalog(body.tools)) return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.some(item =>
    isPlainObject(item)
    && item.type === "additional_tools"
    && isReadableWireToolCatalog(item.tools)
  );
}

function undeclaredNameInItem(
  item: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string>,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
): string | undefined {
  if (!isPlainObject(item)) return undefined;
  if (typeof item.type !== "string") return undefined;
  // The provider executes this exact measured shape itself, so there is no client name to
  // authorize. The caller supplies these signatures only for the matching destination and
  // declarations; the item must additionally carry the hosted call-id prefix.
  if (isAuthorizedProviderExecutedCall(item, providerExecutedCallTypes)) return undefined;
  const namelessDisplayName = NAMELESS_CLIENT_CALL_DISPLAY_NAMES.get(item.type);
  if (namelessDisplayName !== undefined) {
    // Only Codex's explicit `execution: "client"` form delegates tool search to the client.
    if (item.type === "tool_search_call" && item.execution !== "client") return undefined;
    return declaredNamelessClientCallTypes.has(item.type) ? undefined : namelessDisplayName;
  }
  if (!CLIENT_EXECUTED_CALL_TYPES.has(item.type)) return undefined;
  const name = item.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (typeof item.namespace === "string") {
    // Namespaced calls are matched by their full wire name only — never legacy-normalize
    // them, or an undeclared namespaced `exec_command` could slip through as bare `exec`.
    if (declared.has(namespacedToolName(item.namespace, name))) return undefined;
    return name;
  }
  const effectiveName = normalizeDeclaredToolName(name, declared);
  if (declared.has(effectiveName)) return undefined;
  return name;
}

/** First undeclared client tool named by a Responses SSE payload, or undefined. */
export function undeclaredToolCallName(
  payload: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
    return undeclaredNameInItem(payload.item, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes);
  }
  // Sparse gateways skip incremental items and only ever ship the terminal snapshot.
  if (payload.type === "response.completed" || payload.type === "response.incomplete") {
    return undeclaredToolCallNameInResponse(payload.response, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes);
  }
  return undefined;
}

/** First undeclared client tool in a Responses object's `output` array, or undefined. */
export function undeclaredToolCallNameInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
): string | undefined {
  if (!isPlainObject(response) || !Array.isArray(response.output)) return undefined;
  for (const item of response.output) {
    const name = undeclaredNameInItem(item, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes);
    if (name !== undefined) return name;
  }
  return undefined;
}

export function undeclaredToolCallMessage(name: string): string {
  const reported = name.slice(0, MAX_REPORTED_NAME_CHARS);
  return `routed provider emitted undeclared client tool "${reported}"; only request-declared tools may be called`;
}

function failedBlocks(name: string, newline: string): readonly string[] {
  const failure = {
    type: "upstream_error",
    code: UNDECLARED_TOOL_CALL_ERROR_CODE,
    message: undeclaredToolCallMessage(name),
  };
  const payload = JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error: failure, last_error: failure },
  });
  return [`event: response.failed${newline}data: ${payload}`, "data: [DONE]"];
}

/**
 * Fail closed when a routed provider calls a tool the request never declared (#1700).
 *
 * The bridged paths already refuse such a call (`declaredToolNames` in src/bridge.ts), but the
 * native Responses passthrough relayed it verbatim: Codex received a `function_call` for a tool
 * it has no top-level handler for — `apply_patch`, which under code mode exists only as a nested
 * `tools.apply_patch(...)` helper inside `exec` — and the turn surfaced as a bare `aborted` with
 * no output and no explanation. Replacing the offending event with an explicit `response.failed`
 * turns that silent dead end into a compatibility error naming the tool.
 *
 * Everything after the trip is dropped so a later `response.completed` cannot contradict the
 * terminal already sent. Non-JSON and non-item blocks pass through untouched.
 */
export function createUndeclaredToolCallGuardBlockRewrite(
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
): SseBlockRewrite {
  let tripped = false;
  return (block: string) => {
    if (tripped) return [];
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return [block];
    }
    const name = undeclaredToolCallName(parsed, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes);
    if (name === undefined) return [block];
    tripped = true;
    return failedBlocks(name, block.includes("\r\n") ? "\r\n" : "\n");
  };
}
