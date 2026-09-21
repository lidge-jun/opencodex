/**
 * The tool selection a Responses request actually authorized, read from the final outbound body.
 *
 * The undeclared-tool guard answers whether a NAME was declared. This answers a different
 * question: whether this request still permits a client tool call at all, and which names it
 * permits. `tool_choice: "none"`, a forced selector and an `allowed_tools` allow-list each narrow
 * the catalog without removing a declaration, so a name can be declared and forbidden at the same
 * time — and a repair that rebuilds a terminal from collected items would otherwise hand the
 * client a call the caller ruled out.
 *
 * The scope is read from the OUTBOUND body, after every removal, rename and translation, because
 * that is the request the destination answered. A catalog that ends up empty there authorizes no
 * client call whatever the selector still says.
 */
import { dottedToolName, namespacedToolName } from "../types";
import {
  CLIENT_EXECUTED_CALL_TYPES,
  collectDeclaredWireToolNames,
  hasExplicitWireToolCatalog,
} from "./responses-undeclared-tool-guard";
import { isPlainObject } from "./responses-snapshot-codec";

/** Every spelling one call item can be named by, so a selector match is not defeated by flattening. */
function callNameSpellings(item: Record<string, unknown>): readonly string[] {
  const name = typeof item.name === "string" ? item.name : "";
  if (name.length === 0) return [];
  const namespace = typeof item.namespace === "string" && item.namespace.length > 0
    ? item.namespace
    : undefined;
  if (!namespace) return [name];
  return [name, namespacedToolName(namespace, name), dottedToolName(namespace, name)];
}

/** The names one `tool_choice` entry selects; empty when the entry names no client tool. */
function selectorNameSpellings(selector: unknown): readonly string[] {
  if (!isPlainObject(selector)) return [];
  const name = typeof selector.name === "string" ? selector.name : "";
  if (name.length === 0) return [];
  const namespace = typeof selector.namespace === "string" && selector.namespace.length > 0
    ? selector.namespace
    : undefined;
  if (!namespace) return [name];
  return [name, namespacedToolName(namespace, name), dottedToolName(namespace, name)];
}

type ToolSelection =
  | { readonly kind: "unrestricted" }
  | { readonly kind: "deny_all" }
  | { readonly kind: "allow"; readonly names: ReadonlySet<string> };

const UNRESTRICTED: ToolSelection = { kind: "unrestricted" };

/**
 * Read the selector only where it states a client-call boundary.
 *
 * `auto`, `required` and an absent selector restrict nothing. A hosted selector
 * (`{ type: "web_search" }`) forces a tool the PROVIDER runs and does not describe the client
 * calls this turn may contain, so it is left alone rather than read as a deny-all: a false
 * refusal would drop a call the caller could have executed.
 */
function toolSelection(body: Record<string, unknown>): ToolSelection {
  const choice = body.tool_choice;
  if (choice === "none") return { kind: "deny_all" };
  if (!isPlainObject(choice)) return UNRESTRICTED;
  if (choice.type === "allowed_tools") {
    if (!Array.isArray(choice.tools)) return UNRESTRICTED;
    const names = new Set<string>();
    for (const entry of choice.tools) {
      for (const spelling of selectorNameSpellings(entry)) names.add(spelling);
    }
    // An allow-list carrying no client tool — emptied by normalization, or hosted entries only —
    // still bounds this turn: it allows no client call.
    return { kind: "allow", names };
  }
  if (choice.type === "function" || choice.type === "custom") {
    const names = new Set(selectorNameSpellings(choice));
    return names.size > 0 ? { kind: "allow", names } : UNRESTRICTED;
  }
  return UNRESTRICTED;
}

export type RequestToolScope = {
  /**
   * The name a client call is refused under, or undefined when this request permits it.
   * A nameless call type is not answered here: only the declaration guard knows those.
   */
  forbiddenClientToolCallName(item: Record<string, unknown>): string | undefined;
};

/**
 * The client-call boundary this request states, or undefined when it states none.
 *
 * Returning undefined for an unrestricted request keeps every ordinary turn on the path it
 * already had: a caller that selected nothing gets no new refusal.
 */
export function requestToolScope(body: unknown): RequestToolScope | undefined {
  if (!isPlainObject(body)) return undefined;
  const selection = toolSelection(body);
  // A readable catalog that declares no client-executable name is authoritative, exactly as it is
  // for the declaration guard: an explicit empty list denies every client call. An absent catalog
  // says nothing — a passthrough request may omit `tools` and still receive a call the client
  // understands.
  const catalogDeniesClientCalls = hasExplicitWireToolCatalog(body)
    && collectDeclaredWireToolNames(body).size === 0;
  if (selection.kind === "unrestricted" && !catalogDeniesClientCalls) return undefined;
  return {
    forbiddenClientToolCallName(item: Record<string, unknown>): string | undefined {
      if (typeof item.type !== "string" || !CLIENT_EXECUTED_CALL_TYPES.has(item.type)) {
        return undefined;
      }
      const spellings = callNameSpellings(item);
      const reported = spellings[0];
      if (reported === undefined) return undefined;
      if (catalogDeniesClientCalls || selection.kind === "deny_all") return reported;
      if (selection.kind === "allow") {
        return spellings.some(spelling => selection.names.has(spelling)) ? undefined : reported;
      }
      return undefined;
    },
  };
}
