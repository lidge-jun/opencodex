// Codex multi-agent v2 stamps a Responses-only `encrypted: true` marker on
// collaboration tool schemas (openai/codex 5f4d06ef; issue #85). It is an
// annotation for the ChatGPT backend only, so translated provider schemas must
// drop it without removing properties or definitions literally named `encrypted`.
const ENCRYPTED_MARKER_NAME_BAG_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "dependentRequired",
]);
const ENCRYPTED_MARKER_LITERAL_VALUE_KEYS = new Set(["const", "default", "enum", "examples"]);

/**
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
        if (ENCRYPTED_MARKER_LITERAL_VALUE_KEYS.has(key)) {
          // Literal payloads are values, not schemas: an `encrypted` key inside them is data.
          out[key] = value;
        } else {
          const childInNameBag = ENCRYPTED_MARKER_NAME_BAG_KEYS.has(key);
          stack.push({ node: value, inNameBag: childInNameBag, assign: v => { out[key] = v; } });
        }
      }
    }
  }

  return result;
}
