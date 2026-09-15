// Keys whose *children's names* are caller-chosen rather than schema keywords, and keys whose
// values are literal payloads rather than schemas. Shared by both strippers below: each one has
// to tell "the keyword `x`" apart from "a property someone named `x`".
const SCHEMA_NAME_BAG_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
]);
const SCHEMA_LITERAL_VALUE_KEYS = new Set(["const", "default", "enum", "examples"]);

// These subtrees depend on property evaluation, polarity, branch selection or references.
// Preserve their complete argument contract rather than guessing whether a local relaxation
// remains a relaxation in the containing schema. The destination reports unsupported regexes.
const PRESERVED_PATTERN_SUBTREES = new Set([
  "patternProperties", "not", "oneOf", "if", "contains", "$defs", "definitions",
]);

/**
 * Codex multi-agent v2 stamps a Responses-only `encrypted: true` marker on collaboration tool
 * schemas (openai/codex 5f4d06ef; issue #85). It is an annotation for the ChatGPT backend only,
 * so translated provider schemas must drop it without removing properties or definitions
 * literally named `encrypted`.
 *
 * The schema is caller-supplied, so its nesting depth is attacker-influenced. Native recursion
 * would turn a deep schema into a stack overflow that takes down the request path, so this walks
 * an explicit stack instead: depth costs heap, which is bounded and recoverable.
 */
export function stripResponsesOnlyEncryptedMarker(node: unknown, inNameBag = false): unknown {
  type Assign = (value: unknown) => void;
  interface Frame { node: unknown; inNameBag: boolean; assign: Assign }

  let result: unknown;
  const stack: Frame[] = [{ node, inNameBag, assign: value => { result = value; } }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.node;

    if (Array.isArray(current)) {
      const out: unknown[] = new Array(current.length);
      frame.assign(out);
      // Array items are schemas in their own right, never a name bag.
      for (let i = current.length - 1; i >= 0; i--) {
        stack.push({ node: current[i], inNameBag: false, assign: value => { out[i] = value; } });
      }
      continue;
    }
    if (!current || typeof current !== "object") {
      frame.assign(current);
      continue;
    }

    // A schema name may be `__proto__`; a null-prototype record keeps it as data.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    frame.assign(out);

    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (frame.inNameBag) {
        // Inside a name bag every key is a caller-chosen name, so `encrypted` here is data.
        stack.push({ node: value, inNameBag: false, assign: v => { out[key] = v; } });
      } else if (key !== "encrypted") {
        if (SCHEMA_LITERAL_VALUE_KEYS.has(key)) {
          // Literal payloads are values, not schemas: an `encrypted` key inside them is data.
          out[key] = value;
        } else {
          const childInNameBag = SCHEMA_NAME_BAG_KEYS.has(key);
          stack.push({ node: value, inNameBag: childInNameBag, assign: v => { out[key] = v; } });
        }
      }
    }
  }

  return result;
}

/**
 * `\p{…}` is an escape only when the backslash introducing it is itself unescaped: in `\\p{2}`
 * the pair is a literal backslash and the `p{2}` that follows is an ordinary quantified `p`,
 * which Python compiles fine. Scanning for the raw substring would misread that as a property
 * escape and discard a working pattern.
 */
function usesUnicodePropertyEscape(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "\\") continue;
    const next = pattern[i + 1];
    if (next === "\\") {
      i++;
      continue;
    }
    if ((next === "p" || next === "P") && pattern[i + 2] === "{") return true;
  }
  return false;
}

/**
 * Remove unsupported Unicode property escapes from scalar `pattern` constraints in ordinary
 * positive schema positions. This keeps built-in Artifact tools usable on Python-re backends;
 * the omitted constraint is not enforced by this proxy and tools must validate their inputs.
 *
 * Regex-keyed objects are preserved. Removing a matcher can lose evaluated-property annotations
 * needed by an ancestor's unevaluatedProperties, even when the local object appears open.
 * Negation, exclusive alternatives, conditions, contains and reusable definitions are also
 * preserved: loosening a nested constraint can instead reject an input in those contexts.
 * Unsupported patterns there remain the destination's validation responsibility.
 *
 * Returns `node` itself when nothing was dropped. Traversal keeps only the active path and clones
 * only ancestors of a removed constraint, so a broad no-op schema does not create an output tree
 * or one pending closure per sibling. The explicit stack still handles caller-controlled nesting
 * depth; the separate Responses-only encrypted-marker normalization is unchanged.
 */
export function stripUnicodePropertyPatterns(node: unknown, inNameBag = false): unknown {
  interface Frame {
    node: unknown[] | Record<string, unknown>;
    inNameBag: boolean;
    parent?: Frame;
    parentKey?: string | number;
    output?: unknown[] | Record<string, unknown>;
    index?: number;
    entries?: IterableIterator<[string, unknown]>;
  }

  function * ownEntries(value: Record<string, unknown>): IterableIterator<[string, unknown]> {
    // Unlike Object.entries(), this does not materialize every key/value pair before traversal.
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) yield [key, value[key]];
    }
  }

  function cloneContainer(frame: Frame): unknown[] | Record<string, unknown> {
    if (frame.output) return frame.output;
    if (Array.isArray(frame.node)) {
      frame.output = frame.node.slice();
      return frame.output;
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key in frame.node) {
      if (Object.prototype.hasOwnProperty.call(frame.node, key)) output[key] = frame.node[key];
    }
    frame.output = output;
    return output;
  }

  function finish(frame: Frame): void {
    if (!frame.output || !frame.parent) return;
    const parent = cloneContainer(frame.parent);
    if (Array.isArray(parent)) parent[frame.parentKey as number] = frame.output;
    else parent[frame.parentKey as string] = frame.output;
  }

  if (!node || typeof node !== "object") return node;
  const root: Frame = { node: node as unknown[] | Record<string, unknown>, inNameBag };
  const stack: Frame[] = [root];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;

    if (Array.isArray(frame.node)) {
      const index = frame.index ?? 0;
      if (index >= frame.node.length) {
        stack.pop();
        finish(frame);
        continue;
      }
      frame.index = index + 1;
      const child = frame.node[index];
      if (child && typeof child === "object") {
        stack.push({ node: child as unknown[] | Record<string, unknown>, inNameBag: false, parent: frame, parentKey: index });
      }
      continue;
    }

    frame.entries ??= ownEntries(frame.node);
    const next = frame.entries.next();
    if (next.done) {
      stack.pop();
      finish(frame);
      continue;
    }
    const [key, value] = next.value;
    if (!frame.inNameBag && key === "pattern" && typeof value === "string" && usesUnicodePropertyEscape(value)) {
      delete (cloneContainer(frame) as Record<string, unknown>)[key];
      continue;
    }
    if (!frame.inNameBag && (PRESERVED_PATTERN_SUBTREES.has(key) || SCHEMA_LITERAL_VALUE_KEYS.has(key))) {
      continue;
    }
    if (value && typeof value === "object") {
      stack.push({
        node: value as unknown[] | Record<string, unknown>,
        inNameBag: !frame.inNameBag && SCHEMA_NAME_BAG_KEYS.has(key),
        parent: frame,
        parentKey: key,
      });
    }
  }

  return root.output ?? node;
}
