import { collectAmbiguousDottedAliases, dottedAliasIsUnambiguous, wireToolInnerName } from "../responses/tool-name-aliases";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  dottedToolName,
  namespacedToolName,
  normalizeDeclaredToolName,
} from "../types";
import { replaceSseDataPayload, sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

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

function addWireToolName(
  names: Set<string>,
  tool: unknown,
  namespace?: string,
  ambiguousDottedAliases?: ReadonlySet<string>,
): void {
  if (!isPlainObject(tool)) return;
  const name = wireToolInnerName(tool);
  if (!name) return;
  // Codex routes MCP calls by an explicit `namespace` field, so the same tool is reachable
  // as a bare inner name or as the flattened form; accept both rather than guess which
  // coordinate system this provider echoes back.
  if (!namespace || namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
    names.add(name);
    return;
  }
  names.add(namespacedToolName(namespace, name));
  // Some routed providers echo the flattened wire name with a dot (`ns.name`, observed with
  // muse-spark via opencode-go) instead of `ns__name`. It is the same tool identity, so register
  // the dotted spelling too, mirroring `toolChoiceAliases` (#3402) -- but only while that
  // spelling names exactly one declared tool. Dots are legal inside both a namespace and a
  // name, so two distinct identities can flatten onto one dotted alias; accepting it then would
  // authorize a call the caller never declared under that identity. Ambiguous aliases fall back
  // to the unambiguous `ns__name` form.
  const dotted = dottedToolName(namespace, name);
  if (dottedAliasIsUnambiguous(namespace, name) && !ambiguousDottedAliases?.has(dotted)) {
    names.add(dotted);
  }
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

function addWireToolSpecs(
  names: Set<string>,
  specs: unknown,
  ambiguousDottedAliases?: ReadonlySet<string>,
): void {
  if (!Array.isArray(specs)) return;
  for (const spec of specs) {
    if (!isPlainObject(spec)) continue;
    if (spec.type === "namespace" && Array.isArray(spec.tools)) {
      const namespace = typeof spec.name === "string" ? spec.name : undefined;
      for (const inner of spec.tools) addWireToolName(names, inner, namespace, ambiguousDottedAliases);
      continue;
    }
    addWireToolName(names, spec, undefined, ambiguousDottedAliases);
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
  const specGroups: unknown[] = [body.tools];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) specGroups.push(item.tools);
    }
  }
  const ambiguousDottedAliases = collectAmbiguousDottedAliases(specGroups);
  for (const specs of specGroups) addWireToolSpecs(names, specs, ambiguousDottedAliases);
  return names;
}

/**
 * Collects explicitly declared bare wire tool names from a Responses request body.
 *
 * Bare wire tools are top-level declarations (or grouped under the builtin `functions`
 * namespace) that are not namespaced and do not carry a flattened namespace delimiter (`__`)
 * or dotted namespace alias (`.`).
 *
 * @param body - The outbound or inbound request body.
 * @returns A set of declared bare tool names.
 */
export function collectDeclaredBareWireToolNames(body: unknown): Set<string> {
  const names = new Set<string>();
  if (!isPlainObject(body)) return names;
  const specGroups: unknown[] = [body.tools];
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (
        isPlainObject(item)
        && (item.type === "additional_tools" || item.type === "tool_search_output")
      ) specGroups.push(item.tools);
    }
  }
  for (const specs of specGroups) {
    if (!Array.isArray(specs)) continue;
    for (const spec of specs) {
      if (!isPlainObject(spec)) continue;
      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        if (spec.name === BUILTIN_FUNCTIONS_NAMESPACE) {
          for (const inner of spec.tools) {
            if (!isPlainObject(inner)) continue;
            const name = wireToolInnerName(inner);
            if (name && !name.includes("__") && !name.includes(".")) names.add(name);
          }
        }
        continue;
      }
      const name = wireToolInnerName(spec);
      if (name && !name.includes("__") && !name.includes(".")) names.add(name);
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

/**
 * Evaluates whether an individual output item represents an undeclared tool call.
 *
 * @param item - The item to check.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns The undeclared tool call name if unauthorized, or undefined if permitted.
 */
function undeclaredNameInItem(
  item: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string>,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
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
    // Both flattened spellings (`ns__name` and the dotted `ns.name` some providers echo,
    // #3402) name the same tool identity.
    if (declared.has(namespacedToolName(item.namespace, name))) return undefined;
    // Only consult the dotted spelling when it cannot double as another identity's canonical
    // name; otherwise a stranger's `ns__name` would authorize this call.
    if (
      dottedAliasIsUnambiguous(item.namespace, name)
      && declared.has(dottedToolName(item.namespace, name))
    ) return undefined;
    const bareDeclared = declaredBare ?? declared;
    const bare = name.startsWith("default.") ? name.slice("default.".length) : name;
    if (
      item.namespace === "default"
      && bare.length > 0
      && bareDeclared.has(bare)
      && !declared.has(namespacedToolName(item.namespace, bare))
      && !declared.has(dottedToolName(item.namespace, bare))
    ) return undefined;
    return name;
  }
  const effectiveName = normalizeDeclaredToolName(name, declared, declaredBare);
  if (declared.has(effectiveName)) return undefined;
  return name;
}

/**
 * First undeclared client tool named by a Responses SSE payload, or undefined.
 *
 * @param payload - The parsed SSE event payload.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns The name of the first undeclared tool call, or undefined.
 */
export function undeclaredToolCallName(
  payload: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
    return undeclaredNameInItem(payload.item, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare);
  }
  if (payload.type === "response.function_call_arguments.done" && typeof payload.name === "string") {
    const fakeItem = { type: "function_call", name: payload.name, namespace: payload.namespace };
    return undeclaredNameInItem(fakeItem, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare);
  }
  // Sparse gateways skip incremental items and only ever ship the terminal snapshot.
  if (payload.type === "response.completed" || payload.type === "response.incomplete") {
    return undeclaredToolCallNameInResponse(payload.response, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare);
  }
  return undefined;
}

/**
 * First undeclared client tool in a Responses object's `output` array, or undefined.
 *
 * @param response - The Responses result object containing `output`.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns The name of the first undeclared tool call, or undefined.
 */
export function undeclaredToolCallNameInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
): string | undefined {
  if (!isPlainObject(response) || !Array.isArray(response.output)) return undefined;
  for (const item of response.output) {
    const name = undeclaredNameInItem(item, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare);
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * Formats an error message indicating that a routed provider emitted an undeclared tool call.
 *
 * @param name - The undeclared tool name emitted by the provider.
 * @returns A formatted error message string.
 */
export function undeclaredToolCallMessage(name: string): string {
  const reported = name.slice(0, MAX_REPORTED_NAME_CHARS);
  return `routed provider emitted undeclared client tool "${reported}"; only request-declared tools may be called`;
}

/**
 * Normalizes a single output item's default-namespaced tool call back to declared bare tool.
 *
 * Strips invented `default.` prefixes or `namespace: "default"` from tool calls when the bare
 * tool name was declared and neither dotted nor flattened namespaced forms were declared (#4176).
 *
 * @param item - The output item to normalize.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns An object with the normalized value and a boolean indicating if changes occurred.
 */
export function normalizeDefaultNamespaceInItem(
  item: unknown,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (!isPlainObject(item)) return { value: item, changed: false };
  if (!CLIENT_EXECUTED_CALL_TYPES.has(item.type as string)) {
    return { value: item, changed: false };
  }
  const name = item.name;
  if (typeof name !== "string" || name.length === 0) {
    return { value: item, changed: false };
  }
  const bareDeclared = declaredBare ?? declared;
  if (item.namespace === "default") {
    const bare = name.startsWith("default.") ? name.slice("default.".length) : name;
    if (
      bare.length > 0
      && bareDeclared.has(bare)
      && !declared.has(namespacedToolName("default", bare))
      && !declared.has(dottedToolName("default", bare))
    ) {
      const next: Record<string, unknown> = { ...(item as Record<string, unknown>), name: bare };
      delete next.namespace;
      return { value: next, changed: true };
    }
    return { value: item, changed: false };
  }
  if (item.namespace === undefined || item.namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
    if (name.startsWith("default.")) {
      const bare = name.slice("default.".length);
      if (
        bare.length > 0
        && bareDeclared.has(bare)
        && !declared.has("default." + bare)
        && !declared.has("default__" + bare)
      ) {
        return { value: { ...item, name: bare }, changed: true };
      }
    }
  }
  return { value: item, changed: false };
}

/**
 * Normalizes default-namespaced tool calls in a Responses object's `output` array.
 *
 * @param response - The Responses result object containing `output`.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns An object with the normalized response and a boolean indicating if changes occurred.
 */
export function normalizeDefaultNamespaceInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (!isPlainObject(response) || !Array.isArray(response.output)) {
    return { value: response, changed: false };
  }
  let changed = false;
  const newOutput = response.output.map(item => {
    const res = normalizeDefaultNamespaceInItem(item, declared, declaredBare);
    if (res.changed) changed = true;
    return res.value;
  });
  if (!changed) return { value: response, changed: false };
  return { value: { ...response, output: newOutput }, changed: true };
}

/**
 * Normalizes default-namespaced tool calls in a Responses SSE payload object.
 *
 * @param payload - The parsed SSE event payload.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns An object with the normalized payload and a boolean indicating if changes occurred.
 */
export function normalizeDefaultNamespaceInPayload(
  payload: unknown,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (!isPlainObject(payload)) return { value: payload, changed: false };
  if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
    const res = normalizeDefaultNamespaceInItem(payload.item, declared, declaredBare);
    if (!res.changed) return { value: payload, changed: false };
    return { value: { ...payload, item: res.value }, changed: true };
  }
  if (payload.type === "response.function_call_arguments.done" && typeof payload.name === "string") {
    const fakeItem = { type: "function_call", name: payload.name, namespace: payload.namespace };
    const res = normalizeDefaultNamespaceInItem(fakeItem, declared, declaredBare);
    if (res.changed) {
      const normalizedItem = res.value as Record<string, unknown>;
      const next: Record<string, unknown> = { ...payload, name: normalizedItem.name };
      if ("namespace" in next && !("namespace" in normalizedItem)) {
        delete next.namespace;
      }
      return { value: next, changed: true };
    }
  }
  if (payload.type === "response.completed" || payload.type === "response.incomplete") {
    const res = normalizeDefaultNamespaceInResponse(payload.response, declared, declaredBare);
    if (!res.changed) return { value: payload, changed: false };
    return { value: { ...payload, response: res.value }, changed: true };
  }
  return { value: payload, changed: false };
}

/**
 * Normalizes default-namespaced tool calls in a raw Responses JSON string.
 *
 * @param jsonText - Raw JSON string representing a Responses object.
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns The normalized JSON string, or original text if unchanged or invalid JSON.
 */
export function normalizeDefaultNamespaceInJson(
  jsonText: string,
  declared: ReadonlySet<string>,
  declaredBare?: ReadonlySet<string>,
): string {
  try {
    const parsed = JSON.parse(jsonText);
    const normalized = normalizeDefaultNamespaceInResponse(parsed, declared, declaredBare);
    return normalized.changed ? JSON.stringify(normalized.value) : jsonText;
  } catch {
    return jsonText;
  }
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
 * Fail closed when a routed provider calls a tool the request never declared (#1700),
 * and normalize provider-invented default namespaces back to declared bare tools (#4176).
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
 *
 * @param declared - All wire tool names declared in the request catalog.
 * @param declaredNamelessClientCallTypes - Nameless client call types declared by the request.
 * @param providerExecutedCallTypes - Call types executed by the provider.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 * @returns An SSE block rewrite function.
 */
export function createUndeclaredToolCallGuardBlockRewrite(
  declared: ReadonlySet<string>,
  declaredNamelessClientCallTypes: ReadonlySet<string> = EMPTY_DECLARED_NAMELESS_CLIENT_CALL_TYPES,
  providerExecutedCallTypes: ProviderExecutedCallTypes = EMPTY_PROVIDER_EXECUTED_CALL_TYPES,
  declaredBare?: ReadonlySet<string>,
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
    const name = undeclaredToolCallName(parsed, declared, declaredNamelessClientCallTypes, providerExecutedCallTypes, declaredBare);
    if (name !== undefined) {
      tripped = true;
      return failedBlocks(name, block.includes("\r\n") ? "\r\n" : "\n");
    }
    const normalized = normalizeDefaultNamespaceInPayload(parsed, declared, declaredBare);
    if (normalized.changed) {
      return [replaceSseDataPayload(block, JSON.stringify(normalized.value))];
    }
    return [block];
  };
}
