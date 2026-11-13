import { isPlainObject } from "../responses-snapshot-codec";

/** Parse the physical outbound request without accepting arrays or primitive JSON. */
export function parseOutboundRequestBody(bodyText: string): Record<string, unknown> | undefined {
  try {
    const body: unknown = JSON.parse(bodyText);
    return isPlainObject(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

/** Input item types that declare tools; the tool scope keeps these and drops every other input item. */
const TOOL_SCOPE_INPUT_TYPES = new Set(["additional_tools", "tool_search_output"]);

/**
 * The part of the outbound body its response readers need (#8601): the tool catalog, the tool selection, the parallel
 * flag and the input items that declare tools. Snapshot repair and the Grok tool scope read only these, so a turn keeps
 * this while it streams instead of a parsed copy of the whole request.
 */
export function outboundToolScope(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const scope: Record<string, unknown> = {};
  for (const key of ["tools", "tool_choice", "parallel_tool_calls"]) if (Object.hasOwn(body, key)) scope[key] = body[key];
  if (Array.isArray(body.input)) {
    scope.input = body.input.filter(item => isPlainObject(item) && typeof item.type === "string" && TOOL_SCOPE_INPUT_TYPES.has(item.type));
  }
  return scope;
}
