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

export function stripResponsesOnlyEncryptedMarker(node: unknown, inNameBag = false): unknown {
  if (Array.isArray(node)) return node.map(item => stripResponsesOnlyEncryptedMarker(item));
  if (!node || typeof node !== "object") return node;

  // A schema name may be `__proto__`; a null-prototype record keeps it as data.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (inNameBag) {
      out[key] = stripResponsesOnlyEncryptedMarker(value);
    } else if (key !== "encrypted") {
      out[key] = ENCRYPTED_MARKER_LITERAL_VALUE_KEYS.has(key)
        ? value
        : stripResponsesOnlyEncryptedMarker(value, ENCRYPTED_MARKER_NAME_BAG_KEYS.has(key));
    }
  }

  return out;
}
