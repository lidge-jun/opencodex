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
 * Returns `node` itself when nothing was dropped. Uses an explicit stack for caller-controlled
 * nesting depth; the separate Responses-only encrypted-marker normalization is unchanged.
 */
export function stripUnicodePropertyPatterns(node: unknown, inNameBag = false): unknown {
  type Assign = (value: unknown) => void;
  interface Frame { node: unknown; inNameBag: boolean; assign: Assign }

  let result: unknown;
  let dropped = 0;
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
        // Inside a name bag every key is a caller-chosen name, so `pattern` here is a property
        // name; its value is still a schema and is walked as one.
        stack.push({ node: value, inNameBag: false, assign: v => { out[key] = v; } });
        continue;
      }
      if (PRESERVED_PATTERN_SUBTREES.has(key)) {
        out[key] = value;
        continue;
      }
      if (key === "pattern" && typeof value === "string" && usesUnicodePropertyEscape(value)) {
        dropped++;
        continue;
      }
      if (SCHEMA_LITERAL_VALUE_KEYS.has(key)) {
        // Literal payloads are values, not schemas: a `pattern` key inside them is data.
        out[key] = value;
        continue;
      }
      stack.push({
        node: value,
        inNameBag: SCHEMA_NAME_BAG_KEYS.has(key),
        assign: v => { out[key] = v; },
      });
    }
  }

  return dropped === 0 ? node : result;
}
