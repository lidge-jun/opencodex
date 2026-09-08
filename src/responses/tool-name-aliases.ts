import { dottedToolName, namespacedToolName } from "../types";

const BUILTIN_FUNCTIONS_NAMESPACE = "functions";
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A dotted spelling is a safe alias only when it cannot ALSO be read as some other identity's
 * canonical `ns__name`.
 *
 * `{namespace: "x__y", name: "z"}` produces the dotted spelling "x__y.z", which is exactly the
 * canonical wire name of `{namespace: "x", name: "y.z"}`. If only the latter is declared, an
 * echoed call for the former would still find "x__y.z" in the declared set and be authorized as
 * a tool the caller never granted. Requiring both halves to be free of the `__` separator keeps
 * a dotted alias from ever impersonating a canonical name.
 */
export function dottedAliasIsUnambiguous(namespace: string, name: string): boolean {
  return !namespace.includes("__") && !name.includes("__");
}

export function wireToolInnerName(tool: unknown): string | undefined {
  if (!isPlainObject(tool)) return undefined;
  const nestedFunction = tool.type === "function" && isPlainObject(tool.function)
    ? tool.function
    : undefined;
  return typeof tool.name === "string" && tool.name.length > 0
    ? tool.name
    : typeof nestedFunction?.name === "string" && nestedFunction.name.length > 0
      ? nestedFunction.name
      : undefined;
}

/**
 * Dotted aliases that more than one declared identity would claim, plus dotted aliases that
 * collide with a canonical or bare declared name.
 *
 * Resolved over the WHOLE catalog before any name is registered, so which identity "wins" can
 * never depend on declaration order -- an order the caller controls.
 */
export function collectAmbiguousDottedAliases(specGroups: readonly unknown[]): Set<string> {
  const owners = new Map<string, string | null>();
  const claim = (alias: string, identity: string): void => {
    const owner = owners.get(alias);
    if (owner === undefined) owners.set(alias, identity);
    else if (owner !== identity) owners.set(alias, null);
  };
  for (const specs of specGroups) {
    if (!Array.isArray(specs)) continue;
    for (const spec of specs) {
      if (!isPlainObject(spec)) continue;
      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        const namespace = typeof spec.name === "string" ? spec.name : undefined;
        if (!namespace) continue;
        for (const inner of spec.tools) {
          const name = wireToolInnerName(inner);
          if (!name) continue;
          if (namespace === BUILTIN_FUNCTIONS_NAMESPACE) {
            claim(name, JSON.stringify([undefined, name]));
            continue;
          }
          const identity = JSON.stringify([namespace, name]);
          claim(dottedToolName(namespace, name), identity);
          // A canonical or bare name already owned by a different identity poisons the dotted
          // alias that would shadow it.
          claim(namespacedToolName(namespace, name), identity);
          claim(name, identity);
        }
        continue;
      }
      const name = wireToolInnerName(spec);
      if (name) claim(name, JSON.stringify([undefined, name]));
    }
  }
  const ambiguous = new Set<string>();
  for (const [alias, owner] of owners) if (owner === null) ambiguous.add(alias);
  return ambiguous;
}

