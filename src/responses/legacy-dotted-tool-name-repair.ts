import { collectResponsesToolGroups } from "./tool-groups";
import { isSchemaValidResponsesToolName, wireToolInnerName } from "./tool-name-aliases";
import { CODE_MODE_HELPER_WIRE_NAMES, dottedToolName, namespacedToolName } from "../types";

/**
 * The one invented namespace this proxy is known to have emitted. Routed providers flatten a
 * namespaced call as `ns.name`, and a provider that invents the grouping picks `default`; #3402,
 * #4176 and #4412 all repaired that spelling on the way IN, each on its own path.
 *
 * This is deliberately one literal prefix rather than a rule. "Strip everything before the first
 * dot" would silently rewrite a legitimate tool name that happens to contain a dot in some other
 * provider's vocabulary, and a replayed history item is the worst possible place to guess: it names
 * a call that already happened.
 */
const LEGACY_INVENTED_NAMESPACE_PREFIX = "default.";

/** Item types whose `name` the upstream validates against the tool-name pattern. */
const NAMED_CALL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type DeclarationView = {
  /** Wire spellings the caller's own catalog declares, including flattened namespace forms. */
  readonly spellings: ReadonlySet<string>;
  /** How many declared identities answer to a given inner name. */
  readonly ownersByInnerName: ReadonlyMap<string, number>;
};

/**
 * Read the request's own catalog. Namespace children contribute their inner name and both
 * flattened spellings, which is what makes a declared `default` namespace distinguishable from an
 * invented one.
 */
function readDeclarations(body: unknown): DeclarationView {
  const spellings = new Set<string>();
  const owners = new Map<string, number>();
  const identities = new Map<string, Set<string>>();
  const claim = (innerName: string, identity: string): void => {
    const seen = identities.get(innerName);
    if (seen === undefined) identities.set(innerName, new Set([identity]));
    else seen.add(identity);
  };
  for (const group of collectResponsesToolGroups(body)) {
    for (const spec of group) {
      if (!isPlainObject(spec)) continue;
      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        const namespace = typeof spec.name === "string" ? spec.name : undefined;
        if (namespace === undefined) continue;
        for (const child of spec.tools) {
          const inner = wireToolInnerName(child);
          if (!inner) continue;
          spellings.add(namespacedToolName(namespace, inner));
          spellings.add(dottedToolName(namespace, inner));
          claim(inner, JSON.stringify([namespace, inner]));
        }
        continue;
      }
      const name = wireToolInnerName(spec);
      if (!name) continue;
      spellings.add(name);
      claim(name, JSON.stringify([null, name]));
    }
  }
  for (const [inner, owning] of identities) owners.set(inner, owning.size);
  return { spellings, ownersByInnerName: owners };
}

/**
 * Canonical name a legacy dotted alias should be replayed under, or undefined to leave it alone.
 *
 * Fail-closed in both directions that matter. A dotted spelling the caller's catalog actually
 * declares is a real tool identity, so it is never stripped — rewriting it would change which tool
 * the history says was called. A suffix claimed by two declared identities is ambiguous and is
 * left as it is. Only two things resolve: a suffix that names exactly one declared tool, and the
 * bounded set of code-mode helper spellings, which a code-mode catalog never declares because they
 * exist only as nested `tools.*` helpers inside `exec`.
 */
function repairedCallName(name: string, declarations: DeclarationView): string | undefined {
  if (isSchemaValidResponsesToolName(name)) return undefined;
  if (!name.startsWith(LEGACY_INVENTED_NAMESPACE_PREFIX)) return undefined;
  if (declarations.spellings.has(name)) return undefined;
  const suffix = name.slice(LEGACY_INVENTED_NAMESPACE_PREFIX.length);
  if (!isSchemaValidResponsesToolName(suffix)) return undefined;
  const owners = declarations.ownersByInnerName.get(suffix);
  if (owners === 1) return suffix;
  if (owners !== undefined) return undefined;
  return CODE_MODE_HELPER_WIRE_NAMES.has(suffix) ? suffix : undefined;
}

function repairedItem(item: unknown, declarations: DeclarationView): unknown {
  if (!isPlainObject(item)) return item;
  if (typeof item.type !== "string" || !NAMED_CALL_ITEM_TYPES.has(item.type)) return item;
  // An item carrying an explicit namespace is a namespaced identity whose `name` is the inner
  // name; it is not the flattened shape this repairs, and its own field is the authority.
  if (item.namespace !== undefined) return item;
  if (typeof item.name !== "string") return item;
  const repaired = repairedCallName(item.name, declarations);
  return repaired === undefined ? item : { ...item, name: repaired };
}

/**
 * Make an already-damaged conversation replayable.
 *
 * A `function_call` whose name violates `^[a-zA-Z0-9_-]+$` is not a one-turn failure: Codex stores
 * the item, and the upstream then refuses EVERY later request that replays it
 * (`Invalid 'input[N].name': ...`) — including the automatic compaction a long task or a side chat
 * triggers. The emit-side fix stops new items from being created; without this the conversations
 * that already contain one stay permanently unusable, which is the part of #5095 that actually
 * hurts.
 *
 * Only replayed input items are touched. The caller's tool catalog is never rewritten, and a body
 * with nothing to repair is returned by reference.
 */
export function repairLegacyDottedToolCallNames(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  if (!body.input.some(item =>
    isPlainObject(item)
    && typeof item.type === "string"
    && NAMED_CALL_ITEM_TYPES.has(item.type)
    && typeof item.name === "string"
    && item.name.startsWith(LEGACY_INVENTED_NAMESPACE_PREFIX)
  )) return body;

  const declarations = readDeclarations(body);
  let changed = false;
  const input = body.input.map(item => {
    const repaired = repairedItem(item, declarations);
    if (repaired !== item) changed = true;
    return repaired;
  });
  return changed ? { ...body, input } : body;
}
