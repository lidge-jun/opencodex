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
import type { MuseToolNameAliases } from "../responses/muse-tool-name-alias";
import { museWireNameForOriginal } from "../responses/muse-tool-name-alias";
import type {
  RoutedNamespaceToolAliases,
  RoutedNamespaceToolIdentity,
} from "../responses/namespace-tool-compat";
import {
  CLIENT_EXECUTED_CALL_TYPES,
  collectDeclaredWireToolNames,
  hasExplicitWireToolCatalog,
} from "./responses-undeclared-tool-guard";
import { isPlainObject } from "./responses-snapshot-codec";

type ToolKind = "function" | "custom";
const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

type ToolIdentity = Readonly<{
  kind: ToolKind;
  name: string;
  namespace?: string;
}>;

export type RequestToolScopeCorrespondence = Readonly<{
  clientToolAuthorizationBody?: unknown;
  routedNamespaceToolAliases?: RoutedNamespaceToolAliases;
  routedMuseToolNameAliases?: MuseToolNameAliases;
  convertedRoutedCustomToolNames?: ReadonlySet<string>;
}>;

function identityKey(identity: ToolIdentity): string {
  return JSON.stringify([identity.kind, identity.namespace ?? null, identity.name]);
}

function clientNamespace(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value !== BUILTIN_FUNCTIONS_NAMESPACE
    ? value
    : undefined;
}

function selectorIdentity(selector: unknown): ToolIdentity | undefined {
  if (!isPlainObject(selector)) return undefined;
  if (selector.type !== "function" && selector.type !== "custom") return undefined;
  if (typeof selector.name !== "string" || selector.name.length === 0) return undefined;
  if ("namespace" in selector && typeof selector.namespace !== "string") return undefined;
  const namespace = clientNamespace(selector.namespace);
  return { kind: selector.type, name: selector.name, ...(namespace ? { namespace } : {}) };
}

function callIdentity(item: Record<string, unknown>): ToolIdentity | undefined {
  const kind = item.type === "function_call"
    ? "function"
    : item.type === "custom_tool_call"
      ? "custom"
      : undefined;
  if (!kind || typeof item.name !== "string" || item.name.length === 0) return undefined;
  const namespace = clientNamespace(item.namespace);
  return { kind, name: item.name, ...(namespace ? { namespace } : {}) };
}

function sameRestoredIdentity(left: ToolIdentity, right: RoutedNamespaceToolIdentity): boolean {
  return left.namespace === right.namespace
    && left.name === right.name
    && left.kind === right.kind;
}

/**
 * Exact identities this restored call could have used on the final outbound wire.
 *
 * Namespace spellings come only from namespace-tool-compat's request-scoped, ambiguity-checked
 * aliases. Muse aliases then compose over those wire names. A kind change is admitted only when
 * the request recorded that exact custom identity as converted to a function.
 */
function outboundCallIdentities(
  item: Record<string, unknown>,
  correspondence: RequestToolScopeCorrespondence,
): ReadonlySet<string> {
  const restored = callIdentity(item);
  if (!restored) return new Set();
  const keys = new Set<string>([identityKey(restored)]);
  const museAliases = correspondence.routedMuseToolNameAliases ?? new Map();
  const convertedCustom = correspondence.convertedRoutedCustomToolNames ?? new Set();
  const originalSelection = isPlainObject(correspondence.clientToolAuthorizationBody)
    ? toolSelection(correspondence.clientToolAuthorizationBody)
    : UNRESTRICTED;
  const originalSelectionAllowsRestored = originalSelection.kind === "allow"
    && originalSelection.identities.has(identityKey(restored));

  const addWireIdentity = (
    preMuseName: string,
    clientKind: ToolKind,
    conversionIdentityVerified: boolean,
  ): void => {
    const name = museWireNameForOriginal(preMuseName, museAliases);
    if (name === undefined) return;
    const kind = clientKind === "custom"
      && convertedCustom.has(preMuseName)
      && conversionIdentityVerified
      ? "function"
      : clientKind;
    keys.add(identityKey({ kind, name }));
  };

  if (restored.namespace === undefined) {
    addWireIdentity(restored.name, restored.kind, originalSelectionAllowsRestored);
  }
  for (const [wireName, identity] of correspondence.routedNamespaceToolAliases ?? new Map()) {
    // namespace-tool-compat emits only aliases authorized under the outbound selector's kind,
    // then restores `custom` provenance from the request's conversion set. That exact alias edge is
    // already the proof that this custom-to-function transition belongs to this identity.
    if (sameRestoredIdentity(restored, identity)) addWireIdentity(wireName, identity.kind, true);
  }
  return keys;
}

type ToolSelection =
  | { readonly kind: "unrestricted" }
  | { readonly kind: "deny_all" }
  | { readonly kind: "allow"; readonly identities: ReadonlySet<string> };

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
    const identities = new Set<string>();
    if (!Array.isArray(choice.tools)) return { kind: "allow", identities };
    for (const entry of choice.tools) {
      const identity = selectorIdentity(entry);
      if (identity) identities.add(identityKey(identity));
    }
    // An allow-list carrying no client tool — emptied by normalization, or hosted entries only —
    // still bounds this turn: it allows no client call.
    return { kind: "allow", identities };
  }
  if (choice.type === "function" || choice.type === "custom") {
    const identity = selectorIdentity(choice);
    return {
      kind: "allow",
      identities: new Set(identity ? [identityKey(identity)] : []),
    };
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
export function requestToolScope(
  body: unknown,
  correspondence: RequestToolScopeCorrespondence = {},
): RequestToolScope | undefined {
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
      const restored = callIdentity(item);
      const reported = restored?.name;
      if (reported === undefined) return undefined;
      if (catalogDeniesClientCalls || selection.kind === "deny_all") return reported;
      if (selection.kind === "allow") {
        const candidates = outboundCallIdentities(item, correspondence);
        return [...candidates].some(candidate => selection.identities.has(candidate))
          ? undefined
          : reported;
      }
      return undefined;
    },
  };
}
