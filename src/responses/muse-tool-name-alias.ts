import { createHash } from "node:crypto";
import { wireToolInnerName } from "./tool-name-aliases";

const MUSE_TOOL_NAME_MAX = 64;
const MUSE_TOOL_NAME_PREFIX = 55;
const MUSE_TOOL_NAME_HASH_LEN = 8;
const MUSE_SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

export type MuseToolNameAliases = ReadonlyMap<string, string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Direct Meta Muse / Meta Model Responses host. Path, port, and model id do not matter. */
export function isMetaAiResponsesDestination(responseUrl: string): boolean {
  try {
    return new URL(responseUrl).hostname.toLowerCase() === "api.meta.ai";
  } catch {
    return false;
  }
}

function sanitizeMuseToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isPassThroughMuseToolName(name: string): boolean {
  return name.length >= 1
    && name.length <= MUSE_TOOL_NAME_MAX
    && MUSE_SAFE_NAME.test(name)
    && sanitizeMuseToolName(name) === name;
}

function hashSuffix(originalName: string, salt: number): string {
  const hashInput = salt === 0 ? originalName : originalName + "#" + salt;
  return createHash("sha256").update(hashInput).digest("hex").slice(0, MUSE_TOOL_NAME_HASH_LEN);
}

/**
 * Collision-safe wire name for one original tool identity. Pass-through when the name is
 * already `^[a-zA-Z0-9_-]{1,64}$` and unclaimed; otherwise a 55-char sanitized prefix plus
 * an 8-hex sha256 of the ORIGINAL name, salted with `original#N` until unique.
 */
export function museWireToolName(originalName: string, used?: Set<string>): string {
  if (isPassThroughMuseToolName(originalName) && !(used?.has(originalName))) {
    used?.add(originalName);
    return originalName;
  }
  const base = sanitizeMuseToolName(originalName).slice(0, MUSE_TOOL_NAME_PREFIX) || "tool";
  for (let salt = 0; ; salt++) {
    const candidate = base + "_" + hashSuffix(originalName, salt);
    if (!(used?.has(candidate))) {
      used?.add(candidate);
      return candidate;
    }
  }
}

/**
 * Two-phase claim over a declaration-order name list: conforming <=64 names occupy the
 * collision domain first, then long or charset-unsafe names alias in that same order.
 * `aliases` is wireName -> originalName for identities that actually changed.
 */
export function buildMuseToolNameAliasPlan(originalNames: readonly string[]): {
  wireByOriginal: Map<string, string>;
  aliases: Map<string, string>;
} {
  const used = new Set<string>();
  const wireByOriginal = new Map<string, string>();
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const name of originalNames) {
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    unique.push(name);
  }
  for (const name of unique) {
    if (!isPassThroughMuseToolName(name)) continue;
    used.add(name);
    wireByOriginal.set(name, name);
  }
  for (const name of unique) {
    if (wireByOriginal.has(name)) continue;
    wireByOriginal.set(name, museWireToolName(name, used));
  }
  const aliases = new Map<string, string>();
  for (const [original, wire] of wireByOriginal) {
    if (wire !== original) aliases.set(wire, original);
  }
  return { wireByOriginal, aliases };
}

function addCollectedName(names: string[], seen: Set<string>, name: string | undefined): void {
  if (!name || seen.has(name)) return;
  seen.add(name);
  names.push(name);
}

function collectDeclaredToolName(tool: unknown, names: string[], seen: Set<string>): void {
  addCollectedName(names, seen, wireToolInnerName(tool));
}

function collectToolChoiceNames(choice: unknown, names: string[], seen: Set<string>): void {
  if (!isPlainObject(choice)) return;
  if ((choice.type === "function" || choice.type === "custom") && typeof choice.name === "string") {
    addCollectedName(names, seen, choice.name);
    return;
  }
  if (choice.type !== "allowed_tools" || !Array.isArray(choice.tools)) return;
  for (const tool of choice.tools) {
    if (!isPlainObject(tool)) continue;
    if (tool.type !== "function" && tool.type !== "custom") continue;
    if (typeof tool.name === "string") addCollectedName(names, seen, tool.name);
  }
}

function collectMuseToolNames(body: unknown): string[] {
  if (!isPlainObject(body)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) collectDeclaredToolName(tool, names, seen);
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isPlainObject(item)) continue;
      if (item.type === "additional_tools" && Array.isArray(item.tools)) {
        for (const tool of item.tools) collectDeclaredToolName(tool, names, seen);
        continue;
      }
      if (
        (item.type === "function_call" || item.type === "custom_tool_call")
        && typeof item.name === "string"
      ) addCollectedName(names, seen, item.name);
    }
  }
  collectToolChoiceNames(body.tool_choice, names, seen);
  return names;
}

function rewriteDeclaredTool(tool: unknown, wireByOriginal: ReadonlyMap<string, string>): unknown {
  if (!isPlainObject(tool)) return tool;
  const original = wireToolInnerName(tool);
  if (!original) return tool;
  const wire = wireByOriginal.get(original);
  if (wire === undefined || wire === original) return tool;
  let next: Record<string, unknown> = tool;
  if (typeof tool.name === "string" && tool.name === original) {
    next = { ...next, name: wire };
  }
  if (
    tool.type === "function"
    && isPlainObject(tool.function)
    && typeof tool.function.name === "string"
    && tool.function.name === original
  ) {
    next = { ...next, function: { ...tool.function, name: wire } };
  }
  return next;
}

function rewriteToolChoice(choice: unknown, wireByOriginal: ReadonlyMap<string, string>): unknown {
  if (!isPlainObject(choice)) return choice;
  if ((choice.type === "function" || choice.type === "custom") && typeof choice.name === "string") {
    const wire = wireByOriginal.get(choice.name);
    return wire === undefined || wire === choice.name ? choice : { ...choice, name: wire };
  }
  if (choice.type !== "allowed_tools" || !Array.isArray(choice.tools)) return choice;
  let changed = false;
  const tools = choice.tools.map(tool => {
    if (!isPlainObject(tool) || (tool.type !== "function" && tool.type !== "custom")) return tool;
    if (typeof tool.name !== "string") return tool;
    const wire = wireByOriginal.get(tool.name);
    if (wire === undefined || wire === tool.name) return tool;
    changed = true;
    return { ...tool, name: wire };
  });
  return changed ? { ...choice, tools } : choice;
}

function rewriteInputItem(item: unknown, wireByOriginal: ReadonlyMap<string, string>): unknown {
  if (!isPlainObject(item)) return item;
  if (item.type === "additional_tools" && Array.isArray(item.tools)) {
    let changed = false;
    const tools = item.tools.map(tool => {
      const next = rewriteDeclaredTool(tool, wireByOriginal);
      changed ||= next !== tool;
      return next;
    });
    return changed ? { ...item, tools } : item;
  }
  if (
    (item.type === "function_call" || item.type === "custom_tool_call")
    && typeof item.name === "string"
  ) {
    const wire = wireByOriginal.get(item.name);
    return wire === undefined || wire === item.name ? item : { ...item, name: wire };
  }
  return item;
}

/**
 * Keep restoration inside the caller's per-turn authorization boundary, matching
 * `authorizedAliases` in namespace-tool-compat. Upstream sees every declaration even when
 * `tool_choice` narrows what it may call, so a wire name appearing in that catalog is not
 * on its own evidence that restoring it into an executable client name is permitted.
 * The selector is already rewritten to wire names here, so it compares against alias keys.
 */
function authorizedMuseAliases(
  aliases: Map<string, string>,
  toolChoice: unknown,
): Map<string, string> {
  if (toolChoice === undefined || toolChoice === "auto" || toolChoice === "required") return aliases;
  if (toolChoice === "none" || !isPlainObject(toolChoice)) return new Map();

  const authorized = new Set<string>();
  if (
    (toolChoice.type === "function" || toolChoice.type === "custom")
    && typeof toolChoice.name === "string"
  ) {
    authorized.add(toolChoice.name);
  } else if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    for (const tool of toolChoice.tools) {
      if (!isPlainObject(tool)) continue;
      if (tool.type !== "function" && tool.type !== "custom") continue;
      if (typeof tool.name === "string") authorized.add(tool.name);
    }
  } else {
    // An explicit selector for another tool kind authorizes no function/custom call.
    return new Map();
  }

  const kept = new Map<string, string>();
  for (const [wire, original] of aliases) {
    if (authorized.has(wire)) kept.set(wire, original);
  }
  return kept;
}

/**
 * Rewrite function/custom tool identities for the Meta Muse 64-char wire limit.
 * Arguments, user text, and schema property names stay untouched.
 */
export function rewriteMuseToolNamesForUpstream(body: unknown): {
  body: unknown;
  aliases: Map<string, string>;
} {
  if (!isPlainObject(body)) return { body, aliases: new Map() };
  const { wireByOriginal, aliases } = buildMuseToolNameAliasPlan(collectMuseToolNames(body));
  if (aliases.size === 0) return { body, aliases };

  let tools = body.tools;
  if (Array.isArray(body.tools)) {
    let changed = false;
    const rewritten = body.tools.map(tool => {
      const next = rewriteDeclaredTool(tool, wireByOriginal);
      changed ||= next !== tool;
      return next;
    });
    if (changed) tools = rewritten;
  }

  let input = body.input;
  if (Array.isArray(body.input)) {
    let changed = false;
    const rewritten = body.input.map(item => {
      const next = rewriteInputItem(item, wireByOriginal);
      changed ||= next !== item;
      return next;
    });
    if (changed) input = rewritten;
  }

  const toolChoice = rewriteToolChoice(body.tool_choice, wireByOriginal);
  // Upstream still receives the whole aliased catalog; only what may be restored narrows.
  const restorable = authorizedMuseAliases(aliases, toolChoice);
  if (tools === body.tools && input === body.input && toolChoice === body.tool_choice) {
    return { body, aliases: restorable };
  }
  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}),
    },
    aliases: restorable,
  };
}

/**
 * Payload shapes whose `name` is a tool identity the client (and the undeclared-tool guard)
 * reads. `response.function_call_arguments.done` carries the name outside any `function_call`
 * item, so a hashed alias there would still reach the guard as an undeclared tool.
 */
function isMuseToolIdentityType(type: unknown): boolean {
  return type === "function_call"
    || type === "custom_tool_call"
    || type === "function"
    || type === "custom"
    || type === "response.function_call_arguments.done"
    || type === "response.function_call_arguments.delta";
}

function restoreNamedIdentity(
  value: Record<string, unknown>,
  aliases: MuseToolNameAliases,
): { value: Record<string, unknown>; changed: boolean } {
  let restored = value;
  let changed = false;
  if (isMuseToolIdentityType(value.type) && typeof restored.name === "string") {
    const original = aliases.get(restored.name);
    if (original && original !== restored.name) {
      restored = { ...restored, name: original };
      changed = true;
    }
  }
  const fn = restored.function;
  if (
    restored.type === "function"
    && isPlainObject(fn)
    && typeof fn.name === "string"
  ) {
    const original = aliases.get(fn.name);
    if (original && original !== fn.name) {
      restored = { ...restored, function: { ...fn, name: original } };
      changed = true;
    }
  }
  return { value: restored, changed };
}

export function restoreMuseToolNames(
  value: unknown,
  aliases: MuseToolNameAliases,
): { value: unknown; changed: boolean } {
  if (aliases.size === 0) return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map(entry => {
      const result = restoreMuseToolNames(entry, aliases);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreMuseToolNames(entry, aliases);
    restored[key] = result.value;
    changed ||= result.changed;
  }
  const node = changed ? restored : value;
  const identity = restoreNamedIdentity(node, aliases);
  if (identity.changed) return { value: identity.value, changed: true };
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function restoreMuseToolNamesInJson(text: string, aliases: MuseToolNameAliases): string {
  if (aliases.size === 0) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoreMuseToolNames(payload, aliases);
  return restored.changed ? JSON.stringify(restored.value) : text;
}

export function createMuseToolNameRestoreRewrite(
  aliases: MuseToolNameAliases,
): (payload: string) => string {
  return payload => restoreMuseToolNamesInJson(payload, aliases);
}
