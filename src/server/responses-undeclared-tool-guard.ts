import { namespacedToolName } from "../types";
import { sseDataPayload, type SseBlockRewrite } from "./sse-payload-rewrite";

/**
 * Item types the CLIENT executes by name. Hosted calls (`web_search_call`,
 * `image_generation_call`, `local_shell_call`, `tool_search_call`, …) are run upstream or
 * carry no tool name, so they are never matched against the request catalog.
 */
const CLIENT_EXECUTED_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);

/** An upstream-supplied name reaches the error message; keep it bounded. */
const MAX_REPORTED_NAME_CHARS = 100;

export const UNDECLARED_TOOL_CALL_ERROR_CODE = "undeclared_tool_call";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function addWireToolName(names: Set<string>, tool: unknown, namespace?: string): void {
  if (!isPlainObject(tool) || typeof tool.name !== "string" || tool.name.length === 0) return;
  names.add(tool.name);
  // Codex routes MCP calls by an explicit `namespace` field, so the same tool is reachable
  // as a bare inner name or as the flattened form; accept both rather than guess which
  // coordinate system this provider echoes back.
  if (namespace) names.add(namespacedToolName(namespace, tool.name));
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
      if (isPlainObject(item) && item.type === "additional_tools") addWireToolSpecs(names, item.tools);
    }
  }
  return names;
}

function undeclaredNameInItem(item: unknown, declared: ReadonlySet<string>): string | undefined {
  if (!isPlainObject(item)) return undefined;
  if (typeof item.type !== "string" || !CLIENT_EXECUTED_CALL_TYPES.has(item.type)) return undefined;
  const name = item.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  if (declared.has(name)) return undefined;
  if (typeof item.namespace === "string" && declared.has(namespacedToolName(item.namespace, name))) {
    return undefined;
  }
  return name;
}

/** First undeclared client tool named by a Responses SSE payload, or undefined. */
export function undeclaredToolCallName(
  payload: unknown,
  declared: ReadonlySet<string>,
): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  if (payload.type === "response.output_item.added" || payload.type === "response.output_item.done") {
    return undeclaredNameInItem(payload.item, declared);
  }
  // Sparse gateways skip incremental items and only ever ship the terminal snapshot.
  if (payload.type === "response.completed" || payload.type === "response.incomplete") {
    return undeclaredToolCallNameInResponse(payload.response, declared);
  }
  return undefined;
}

/** First undeclared client tool in a Responses object's `output` array, or undefined. */
export function undeclaredToolCallNameInResponse(
  response: unknown,
  declared: ReadonlySet<string>,
): string | undefined {
  if (!isPlainObject(response) || !Array.isArray(response.output)) return undefined;
  for (const item of response.output) {
    const name = undeclaredNameInItem(item, declared);
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
    const name = undeclaredToolCallName(parsed, declared);
    if (name === undefined) return [block];
    tripped = true;
    return failedBlocks(name, block.includes("\r\n") ? "\r\n" : "\n");
  };
}
