export interface OcxTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  /**
   * Anthropic `tools[*].allowed_callers`: which callers may invoke this tool. Carried rather
   * than diagnosed, because rebuilding the declaration without it hands the model a tool the
   * caller had restricted and returns a normal response (#5210).
   */
  allowedCallers?: string[];
  /** MCP namespace (e.g. "mcp__context7") for tools flattened out of a Responses "namespace" tool. */
  namespace?: string;
  /** Freeform/custom tool (e.g. apply_patch): the model's call must be relayed as a custom_tool_call. */
  freeform?: boolean;
  /** Client-executed tool discovery (tool_search): the model's call must be relayed as a tool_search_call. */
  toolSearch?: boolean;
  /** Tool definition restored from a prior tool_search output; transports may prioritize it when catalogs are bounded. */
  loadedFromToolSearch?: boolean;
  /** Cursor-only synthetic exact-match edit tool; never inferred from the wire name. */
  cursorStructuredEdit?: true;
  /** Synthetic web_search tool: the model's call is executed by the gpt-5.6-luna sidecar, not relayed to Codex. */
  webSearch?: boolean;
  /** Synthetic image_gen tool: the model's call is executed by the xAI image bridge sidecar, not relayed to Codex. */
  imageGeneration?: boolean;
  /** Synthetic video_gen tool: executed by the xAI video bridge sidecar. */
  videoGeneration?: boolean;
}

/**
 * Wire name a chat model sees for a tool. Namespaced (MCP) tools are flattened to
 * "<namespace>__<name>" so they survive the chat-completions function-tool format;
 * the proxy maps this back to {namespace, name} on the return trip (Codex routes MCP
 * calls by an explicit `namespace` field, not by parsing the name).
 */
export function namespacedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

/**
 * Whether a declaration actually narrows who may call the tool.
 *
 * `["direct"]` is the state every unrestricted tool is already in, so treating it as a
 * restriction would refuse ordinary traffic. Mirrors the `caller_mode` predicate in
 * src/claude/compatibility.ts, which draws the same line.
 */
export function toolRestrictsCallers(tool: Pick<OcxTool, "allowedCallers">): boolean {
  const callers = tool.allowedCallers;
  if (callers === undefined) return false;
  return !(callers.length === 1 && callers[0] === "direct");
}

/**
 * Dotted alias of a namespaced tool's wire name. Some routed providers (observed: muse-spark
 * via opencode-go) echo a namespaced tool call as "<namespace>.<name>" instead of the flattened
 * "<namespace>__<name>" form. It names the same tool identity+�u���T never a new grant"��y��y� so the
 * undeclared-tool guard and the tool bridge maps accept it wherever the wire name is accepted
 * (mirroring the second entry of `toolChoiceAliases`). See #3402.
 */
export function dottedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}.${name}` : name;
}

/**
 * Codex unified-exec name normalization.
 *
 * Codex's code-mode shell tool is declared as `exec` (a freeform custom tool whose own
 * description mentions the nested `await tools.exec_command(...)` helper). Some routed providers
 * echo that helper name as the tool-call name, emitting `exec_command`, `write_stdin`,
 * `apply_patch`, `view_image`, or one of the goal helpers (`create_goal`, `get_goal`,
 * `update_goal`, #5495) instead of the declared `exec`. Accept these nested helper names only
 * when the request catalog actually declares `exec` and does not itself declare the emitted name
 * (an MCP server may legitimately advertise one under its own namespace). The list is closed: an
 * unlisted name is never admitted through `exec`.
 */
const LEGACY_SHELL_BRIDGE_TOOL_NAMES = ["exec_command", "shell_command"] as const;
const CODE_MODE_HELPER_TOOL_NAMES = [
  ...LEGACY_SHELL_BRIDGE_TOOL_NAMES,
  "write_stdin",
  "apply_patch",
  "view_image",
  "create_goal",
  "get_goal",
  "update_goal",
] as const;

/**
 * The one declared name that turns nested-helper normalization on. Declaring it is not just a
 * name: it also decides whether an emitted helper name is accepted as that shell tool, so callers
 * that build declared-name sets must add it only for a genuine bare declaration.
 */
export const CODE_MODE_EXEC_TOOL_NAME = "exec";

/**
 * The nested-helper spellings, as a membership view of the same list.
 *
 * A code-mode catalog never DECLARES any of them — they exist only as `tools.<helper>(...)` inside
 * `exec` — so a recorded call under one of these names can only have come from a provider echoing
 * the helper, which is what makes the set usable as a bounded recovery vocabulary for stored
 * history (#5095). Kept beside the tuple it is built from so the two can never drift; this is a
 * different question from `NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES` below, which also covers `exec`
 * itself because declaring THAT name is what turns normalization on.
 */
export const CODE_MODE_HELPER_WIRE_NAMES: ReadonlySet<string> = new Set<string>(
  CODE_MODE_HELPER_TOOL_NAMES,
);

/**
 * Spellings that may never be MANUFACTURED as a bare alias for a namespaced tool.
 *
 * A bare alias is an ordinary compatibility affordance -- providers echo a namespaced tool
 * without its prefix, and restoring the identity needs the bare spelling registered. For these
 * names it is also an authorization decision, because a declared-name set is what
 * `normalizeDeclaredToolName` and `declaresCodeModeExec` read: bare `exec` turns nested-helper
 * normalization on for a catalog that never declared the shell, bare `exec_command` or
 * `shell_command` turns it off for one that did, and the rest are accepted as declared calls the
 * caller only ever authorized under a namespace.
 *
 * This is a property of the SPELLING, not of the namespace that declared it and not of the reason
 * the alias was being added. It lives here, beside the names it protects, because every site that
 * builds a declared-name set has to apply the same list -- the two that kept their own copies each
 * drifted, once to a single namespace and once to a single name.
 *
 * A genuine namespace-free declaration is NOT covered: that is the caller declaring the tool, not
 * a namespace being discarded to synthesize a bare name.
 */
export const NAMESPACED_BARE_ALIAS_EXCLUDED_NAMES: ReadonlySet<string> = new Set<string>([
  CODE_MODE_EXEC_TOOL_NAME,
  ...CODE_MODE_HELPER_TOOL_NAMES,
]);

/**
 * Normalizes provider-emitted tool names against declared tool catalogs.
 *
 * Rewrites invented `default.<name>` prefixes back to a declared bare tool when that bare tool
 * is declared and neither `default.<name>` nor `default__<name>` was explicitly declared (#4176).
 * The same wrapper may surround an already-flattened namespace identity; accept that exact
 * declared suffix without treating its child name as a bare declaration.
 * Also normalizes nested helper names (`exec_command`, `shell_command`, `write_stdin`,
 * `apply_patch`, `view_image`, `create_goal`, `get_goal`, `update_goal`) to
 * `exec` when code-mode `exec` is declared in the request catalog.
 *
 * @param name - The tool name emitted on the wire by the provider.
 * @param declared - All wire tool names declared in the request catalog, including aliases.
 * @param declaredBare - Explicitly declared bare tool names without namespace provenance.
 *                       When omitted, falls back to `declared`.
 * @returns The normalized tool name to expose downstream.
 */
export function normalizeDeclaredToolName(
  name: string,
  declared: ReadonlySet<string> | undefined,
  declaredBare?: ReadonlySet<string>,
): string {
  if (!declared) return name;
  if (declared.has(name)) return name;
  let candidate = name;
  if (name.startsWith("default.")) {
    const bare = name.slice("default.".length);
    const bareDeclared = declaredBare ?? declared;
    if (
      bare.length > 0
      && (
        bareDeclared.has(bare)
        // Muse can wrap the complete `namespace__tool` identity in `default.`. Requiring the
        // exact flattened identity to be declared preserves the #4176 provenance boundary:
        // `default.tool` still cannot borrow a namespaced tool's manufactured bare alias.
        || (bare.includes("__") && declared.has(bare))
      )
      && !declared.has("default." + bare)
      && !declared.has("default__" + bare)
    ) {
      candidate = bare;
    } else if (
      // Code mode never declares bare helper names; a provider that invents `default.`
      // for one still means the nested helper. Strip the prefix so the helper list
      // below can rewrite it to `exec` (#4412).
      bare.length > 0
      && declared.has(CODE_MODE_EXEC_TOOL_NAME)
      && (CODE_MODE_HELPER_TOOL_NAMES as readonly string[]).includes(bare)
      && !declared.has("default." + bare)
      && !declared.has("default__" + bare)
    ) {
      candidate = bare;
    }
  }
  if (!declared.has(CODE_MODE_EXEC_TOOL_NAME)) return candidate;
  if (declared.has(candidate)) return candidate;
  if (candidate === "apply_patch") return CODE_MODE_EXEC_TOOL_NAME;
  // When the catalog explicitly declares any legacy shell bridge name, the environment
  // genuinely exposes that tool — turn normalization off so a call is never mis-routed
  // to `exec`.
  if ((LEGACY_SHELL_BRIDGE_TOOL_NAMES as readonly string[]).some(legacy => declared.has(legacy))) {
    return candidate;
  }
  return (CODE_MODE_HELPER_TOOL_NAMES as readonly string[]).includes(candidate)
    ? CODE_MODE_EXEC_TOOL_NAME
    : candidate;
}

/**
 * True when a declared catalog is the genuine Codex code-mode shape.
 *
 * `exec` is a name, not a guarantee. A catalog that lists `exec` NEXT TO a bare
 * `exec_command` or `shell_command` is the flat-bridge shape: there `exec` may be an
 * ordinary caller-defined tool, and nested `tools.*` helpers are not what it runs.
 * `normalizeDeclaredToolName` already refuses to reinterpret helper names in that shape,
 * and anything inferring code mode from the bare name owes the same check.
 */
export function declaresCodeModeExec(declared: ReadonlySet<string> | undefined): boolean {
  if (!declared || !declared.has(CODE_MODE_EXEC_TOOL_NAME)) return false;
  return !(LEGACY_SHELL_BRIDGE_TOOL_NAMES as readonly string[]).some(legacy => declared.has(legacy));
}

export function toolChoiceAliases(tool: Pick<OcxTool, "namespace" | "name">): string[] {
  const wireName = namespacedToolName(tool.namespace, tool.name);
  return tool.namespace ? [wireName, dottedToolName(tool.namespace, tool.name)] : [wireName];
}

function sameToolIdentity(
  left: Pick<OcxTool, "namespace" | "name">,
  right: Pick<OcxTool, "namespace" | "name">,
): boolean {
  return left.namespace === right.namespace && left.name === right.name;
}

type ToolIdentity = Readonly<Pick<OcxTool, "namespace" | "name">>;

function snapshotToolIdentity(tool: Pick<OcxTool, "namespace" | "name">): ToolIdentity {
  return Object.freeze({
    name: tool.name,
    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
  });
}

function buildToolChoiceCatalog(
  tools: readonly ToolIdentity[],
): {
  candidatesByName: ReadonlyMap<string, readonly ToolIdentity[]>;
  sourceCandidatesByName: ReadonlyMap<string, readonly ToolIdentity[]>;
  identitiesByTool: WeakMap<object, ToolIdentity>;
} {
  const index = new Map<string, ToolIdentity[]>();
  const sourceIndex = new Map<string, ToolIdentity[]>();
  const identities = new Map<string, Set<string>>();
  const identitiesByTool = new WeakMap<object, ToolIdentity>();
  for (const tool of tools) {
    const snapshot = snapshotToolIdentity(tool);
    identitiesByTool.set(tool, snapshot);
    const identity = JSON.stringify([snapshot.namespace ?? null, snapshot.name]);
    for (const selector of [...toolChoiceAliases(snapshot), snapshot.name]) {
      const candidates = index.get(selector);
      if (!candidates) {
        index.set(selector, [snapshot]);
        sourceIndex.set(selector, [tool]);
        identities.set(selector, new Set([identity]));
      } else if (!identities.get(selector)!.has(identity)) {
        candidates.push(snapshot);
        sourceIndex.get(selector)!.push(tool);
        identities.get(selector)!.add(identity);
      }
    }
  }
  return { candidatesByName: index, sourceCandidatesByName: sourceIndex, identitiesByTool };
}

/** Compile one immutable view of a request's tool catalog for repeated policy checks. */
export function createToolChoiceResolver(tools: readonly ToolIdentity[] | undefined) {
  const compiled = tools ? buildToolChoiceCatalog(tools) : undefined;
  const candidatesByName = compiled?.candidatesByName;
  const snapshotFor = (tool: ToolIdentity): ToolIdentity | undefined => {
    const snapshot = compiled?.identitiesByTool.get(tool);
    return snapshot && sameToolIdentity(snapshot, tool) ? snapshot : undefined;
  };
  return {
    candidates(name: string): ToolIdentity[] {
      return (candidatesByName?.get(name) ?? []).map(candidate => ({ ...candidate }));
    },
    candidateCount(name: string): number {
      return candidatesByName?.get(name)?.length ?? 0;
    },
    allows(tool: ToolIdentity, allowedTools: ReadonlySet<string>): boolean {
      if (!candidatesByName) return toolChoiceAliases(tool).some(name => allowedTools.has(name));
      const snapshot = snapshotFor(tool);
      return snapshot ? toolAllowedByChoiceFromIndex(snapshot, allowedTools, candidatesByName) : false;
    },
    selects(tool: ToolIdentity, name: string): boolean {
      const snapshot = snapshotFor(tool);
      const candidates = candidatesByName?.get(name);
      return !!snapshot && candidates?.length === 1 && sameToolIdentity(candidates[0], snapshot);
    },
  };
}

/**
 * All tools that could be selected by one client-facing name. Bare logical names are included
 * here because they are a compatibility selector for namespaced tools, while wire and dotted
 * aliases come from `toolChoiceAliases`. A selector with more than one candidate is invalid.
 */
export function toolChoiceCandidates(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  name: string,
): Pick<OcxTool, "namespace" | "name">[] {
  if (!tools) return [];
  return [...(buildToolChoiceCatalog(tools).sourceCandidatesByName.get(name) ?? [])];
}

/**
 * Newer Codex clients can select a tool nested in a namespace by its bare name. Resolve that
 * shorthand only when the request contains one tool with the logical name, so an ambiguous name
 * cannot authorize a tool from an unintended namespace.
 */
export function toolAllowedByChoice(
  tool: Pick<OcxTool, "namespace" | "name">,
  allowedTools: ReadonlySet<string>,
  tools?: readonly Pick<OcxTool, "namespace" | "name">[],
): boolean {
  if (!tools) return toolChoiceAliases(tool).some(name => allowedTools.has(name));
  return toolAllowedByChoiceFromIndex(
    snapshotToolIdentity(tool),
    allowedTools,
    buildToolChoiceCatalog(tools).candidatesByName,
  );
}

function toolAllowedByChoiceFromIndex(
  tool: ToolIdentity,
  allowedTools: ReadonlySet<string>,
  candidatesByName: ReadonlyMap<string, readonly ToolIdentity[]>,
): boolean {
  for (const name of [...toolChoiceAliases(tool), tool.name]) {
    if (!allowedTools.has(name)) continue;
    const candidates = candidatesByName.get(name);
    if (candidates?.length === 1 && sameToolIdentity(candidates[0], tool)) return true;
  }
  return false;
}

export function resolveToolChoiceWireName(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined, name: string): string {
  const candidates = toolChoiceCandidates(tools, name);
  if (candidates.length === 1) {
    const match = candidates[0];
    return namespacedToolName(match.namespace, match.name);
  }
  // Keep unknown/ambiguous names unchanged for callers that only serialize a selector. The
  // catalog-aware predicate rejects them, and parseRequest rejects ambiguous request selectors.
  return name;
}

/**
 * Whether `modelId` is in a per-provider classification list (e.g. `noVisionModels`). Matches the full
 * id, OR — for Ollama-style ids — the family before the ":size" tag, so a `gpt-oss` entry covers
 * `gpt-oss:120b`/`gpt-oss:20b`. Colon-less ids (e.g. `grok-build-0.1`) still match exactly only.
 */
export function modelInList(list: string[] | undefined, modelId: string): boolean {
  if (!list || list.length === 0) return false;
  if (list.includes(modelId)) return true;
  const colon = modelId.indexOf(":");
  return colon > 0 && list.includes(modelId.slice(0, colon));
}

export type OcxToolChoice =
  | "auto"
  | "none"
  | "required"
  | { name: string }
  | { allowedTools: string[]; mode: "auto" | "required" };

export function isAllowedToolChoice(value: OcxToolChoice | undefined): value is { allowedTools: string[]; mode: "auto" | "required" } {
  return typeof value === "object" && value !== null && "allowedTools" in value;
}

/** Compile the request's tool-choice policy into a reusable advertisement/restoration predicate. */
export function toolChoiceToolPredicate(
  choice: OcxToolChoice | undefined,
  tools?: readonly Pick<OcxTool, "namespace" | "name">[],
): (tool: Pick<OcxTool, "namespace" | "name">) => boolean {
  if (!choice || choice === "auto" || choice === "required") return () => true;
  if (choice === "none") return () => false;
  if (isAllowedToolChoice(choice)) {
    const allowed = new Set(choice.allowedTools);
    const resolver = createToolChoiceResolver(tools);
    return tool => resolver.allows(tool, allowed);
  }
  if (!tools) return tool => toolChoiceAliases(tool).includes(choice.name);
  const resolver = createToolChoiceResolver(tools);
  return tool => resolver.selects(tool, choice.name);
}
