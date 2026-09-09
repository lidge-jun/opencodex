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

/**
 * `patternProperties` is the one name bag whose keys are not just names: each key is itself a
 * regex the destination compiles. So the Unicode-property problem applies to the key as well as
 * to a `pattern` value, and a bag copied verbatim would still fail the whole schema.
 */
const PATTERN_KEYED_BAG_KEY = "patternProperties";

/**
 * Whether dropping a `patternProperties` entry from this object only ever widens what it admits.
 *
 * Removing a matcher moves the keys it covered to whatever `additionalProperties` says. When the
 * object is open — the keyword absent, or `true` — those keys become unconstrained, so every
 * argument the original accepted is still accepted and the drop is a pure loss of validation.
 *
 * When the object is closed the same drop narrows it instead. With `additionalProperties: false`
 * the covered keys become forbidden outright, and an object whose only matcher was regex-keyed
 * then admits nothing at all once `minProperties` is 1 — a dictionary tool silently becomes an
 * empty-object-only tool. A schema for `additionalProperties` is refused for the same reason:
 * the covered keys would have to satisfy it instead of their own value schema.
 * `unevaluatedProperties` closes an object the same way, so it is treated the same.
 */
function patternPropertyDropOnlyWidens(node: Record<string, unknown>): boolean {
  const open = (value: unknown): boolean => value === undefined || value === true;
  return open(node.additionalProperties) && open(node.unevaluatedProperties);
}

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
 * ECMA-262 regexes may use Unicode property escapes (`\p{Cc}`, `\P{L}`); Python's `re` cannot
 * compile them. OpenAI-family upstreams validate a function tool's JSON Schema `pattern` by
 * compiling it with `re`, so a schema authored in JavaScript is refused whole, before routing:
 *
 *   Invalid schema for function 'Artifact':
 *   '^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$' is not a 'regex'.
 *
 * A client that ships such a pattern on a built-in tool therefore loses every request, not just
 * the calls to that tool — Claude Code 2.1.265 does exactly this on its `Artifact` tool.
 * Dropping only the patterns the destination cannot compile keeps the tool's shape while letting
 * the request through, the same trade the Kiro adapter makes for the validation keywords Bedrock
 * rejects. What is given up is bounded: an upstream that enforces `pattern` does so under strict
 * Structured Outputs, and a pattern this function drops is one that upstream could not have
 * compiled in the first place — it refuses the whole schema before any argument is generated. So
 * the choice is a dropped constraint versus no request at all, not a silently weakened one that
 * would otherwise have been enforced.
 *
 * Returns `node` itself when nothing was dropped, so callers can use identity to tell whether
 * the schema changed. Walks an explicit stack for the same reason as the stripper above.
 *
 * Two shapes carry an uncompilable regex: a `pattern` value, and a `patternProperties` key. The
 * key case matters because the destination compiles those keys too, so preserving one would fail
 * the schema exactly as a `pattern` value would.
 *
 * The two are not equally safe to drop, so "keeps the tool's shape" holds only where the drop
 * widens. A `pattern` value is a constraint on a value that is admitted either way. A
 * `patternProperties` key decides which keys exist at all, so removing it from a closed object
 * narrows the object instead of relaxing it, and a dictionary tool whose only matcher was
 * regex-keyed would become an empty-object-only tool. Those objects are therefore left exactly
 * as the caller wrote them: a destination that compiles ECMA regexes still accepts them, and one
 * that does not reports the uncompilable regex itself, which is the honest outcome. See
 * {@link patternPropertyDropOnlyWidens}.
 */
export function stripUnicodePropertyPatterns(node: unknown, inNameBag = false): unknown {
  type Assign = (value: unknown) => void;
  interface Frame { node: unknown; inNameBag: boolean; dropUncompilableKeys?: boolean; assign: Assign }

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
        if (frame.dropUncompilableKeys && usesUnicodePropertyEscape(key)) {
          // The key is the matcher here, so an uncompilable key takes its schema with it.
          // Keeping the entry would fail the whole schema exactly as a pattern value does.
          // Only reached when the enclosing object is open, so this cannot narrow it.
          dropped++;
          continue;
        }
        // Inside a name bag every key is a caller-chosen name, so `pattern` here is a property
        // name; its value is still a schema and is walked as one.
        stack.push({ node: value, inNameBag: false, assign: v => { out[key] = v; } });
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
        dropUncompilableKeys: key === PATTERN_KEYED_BAG_KEY
          && patternPropertyDropOnlyWidens(current as Record<string, unknown>),
        assign: v => { out[key] = v; },
      });
    }
  }

  return dropped === 0 ? node : result;
}
