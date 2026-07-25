/**
 * Schema-aware argument key normalization for Cursor tool calls.
 *
 * Cursor-trained models sometimes emit argument keys that differ from the tool's declared schema
 * (e.g. `filepath` instead of `path`, `cmd` instead of `command`). This module maps common aliases
 * to the canonical key name ONLY when the tool schema declares that canonical key. Keys already
 * matching the schema are never touched.
 *
 * Derived from opencode-cursor reference (src/provider/tool-schema-compat.ts).
 */

const KEY_ALIASES = new Map<string, string>([
  ["filepath", "path"],
  ["filename", "path"],
  ["file", "path"],
  ["targetpath", "path"],
  ["directorypath", "path"],
  ["dir", "path"],
  ["folder", "path"],
  ["directory", "path"],
  ["targetdirectory", "path"],
  ["targetfile", "path"],
  ["globpattern", "pattern"],
  ["filepattern", "pattern"],
  ["searchpattern", "pattern"],
  ["includepattern", "include"],
  ["workingdirectory", "cwd"],
  ["workdir", "cwd"],
  ["currentdirectory", "cwd"],
  ["cmd", "command"],
  ["script", "command"],
  ["shellcommand", "command"],
  ["terminalcommand", "command"],
  ["contents", "content"],
  ["text", "content"],
  ["body", "content"],
  ["data", "content"],
  ["payload", "content"],
  ["streamcontent", "content"],
  ["oldstring", "old_string"],
  ["newstring", "new_string"],
  ["oldtext", "old_string"],
  ["newtext", "new_string"],
  ["oldcontent", "old_string"],
  ["newcontent", "new_string"],
  ["recursive", "force"],
]);

/**
 * Extract the set of declared property names from a JSON Schema parameters object.
 * Handles the common `{ type: "object", properties: { ... } }` shape.
 */
function schemaPropertyNames(schema: unknown): Set<string> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const obj = schema as Record<string, unknown>;
  const props = obj.properties;
  if (!props || typeof props !== "object") return undefined;
  return new Set(Object.keys(props as Record<string, unknown>));
}

/**
 * Normalize argument keys against the tool's declared schema. Keys not in the schema that have a
 * known alias pointing to a schema-declared key are renamed. Explicitly supplied canonical keys
 * always win over aliases, regardless of object property insertion order — conflicting aliases
 * are discarded rather than left beside the canonical key.
 *
 * Returns the original object reference if no changes were needed (cheap identity check for callers).
 */
export function normalizeArgKeys(args: Record<string, unknown>, toolSchema: unknown): Record<string, unknown> {
  const declared = schemaPropertyNames(toolSchema);
  if (!declared || declared.size === 0) return args;

  const suppliedCanonical = new Set<string>();
  for (const key of Object.keys(args)) {
    if (declared.has(key)) suppliedCanonical.add(key);
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (declared.has(key)) {
      result[key] = value;
      continue;
    }
    const canonical = KEY_ALIASES.get(key.toLowerCase());
    if (canonical && declared.has(canonical)) {
      // Canonical was explicitly supplied (any order) — drop the alias entirely.
      if (suppliedCanonical.has(canonical)) {
        changed = true;
        continue;
      }
      // First alias fills the canonical slot; later aliases for the same key are discarded.
      if (!(canonical in result)) {
        result[canonical] = value;
        changed = true;
      } else {
        changed = true;
      }
      continue;
    }
    result[key] = value;
  }
  return changed ? result : args;
}
