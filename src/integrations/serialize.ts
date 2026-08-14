/**
 * Text serializers for client config documents.
 *
 * Bun 1.3.14 gives us JSON and JSON5 stringify natively, but the two formats a
 * client config actually needs beyond JSON are hand-rendered here:
 *
 * - **TOML** has no `Bun.TOML.stringify` at all.
 * - **YAML** has `Bun.YAML.stringify`, but it emits flow style with no trailing
 *   newline (`{a: 1,b: {c: d}}`). That is valid YAML and completely wrong for a
 *   file a user opens, so we render block style ourselves.
 *
 * The renderers originally covered only the shallow shapes our builders emit.
 * That was fine while they only ever saw generated documents — but the
 * integration writer parses the USER's whole config and re-serializes it, so a
 * legitimate `null` or a numeric array in a file we never wrote threw straight
 * out of the writer and surfaced as a 500. They now cover the value domains
 * their formats actually allow.
 *
 * What they still refuse is genuinely unrenderable: a function, a symbol, a
 * non-finite number. Those must fail loudly rather than produce bytes a client
 * might misread — and the writer turns the failure into a structured refusal
 * rather than an exception.
 *
 * Design of record: devlog/_fin/260802_client_toggle_api/011_wp1_builders.md.
 */

export type ConfigFormat = "json" | "yaml" | "toml" | "json5";

/** Thrown when a document holds a value its format cannot represent. */
export class UnserializableValueError extends Error {}

export const FORMAT_MEDIA_TYPE: Record<ConfigFormat, string> = {
  json: "application/json",
  yaml: "application/yaml",
  toml: "application/toml",
  json5: "application/json5",
};

/**
 * Type guard, not a boolean check — the renderers walk `unknown`, so without
 * the predicate every narrowed branch stays `unknown`.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isYamlScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * Keep only unambiguous, single-token strings plain. Everything else uses a
 * JSON-compatible double-quoted scalar, which gives deterministic escaping —
 * JSON string escaping is valid YAML 1.2 string escaping.
 */
function yamlString(value: string): string {
  const plainSafe = value.length > 0
    && value.trim() === value
    && /^[A-Za-z_./][A-Za-z0-9_./-]*$/u.test(value)
    && !/^(?:null|true|false|yes|no|on|off|~|\.nan|[-+]?\.inf)$/iu.test(value);
  return plainSafe ? value : JSON.stringify(value);
}

function yamlScalar(value: string | number | boolean | null): string {
  // `null` renders as the explicit `null` token rather than an empty value:
  // a bare `key:` is also null in YAML, but round-tripping it through other
  // parsers is less predictable than saying so.
  if (value === null) return "null";
  if (typeof value === "string") return yamlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Number.isFinite(value)) return String(value);
  throw new UnserializableValueError(`YAML cannot represent the number ${String(value)}`);
}

function yamlEmptyCollection(value: unknown): "[]" | "{}" | undefined {
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (isPlainRecord(value) && Object.keys(value).length === 0) return "{}";
  return undefined;
}

function yamlMapEntryLines(key: string, value: unknown, indent: number): string[] {
  const padding = " ".repeat(indent);
  const renderedKey = yamlString(key);
  if (isYamlScalar(value)) return [`${padding}${renderedKey}: ${yamlScalar(value)}`];
  const empty = yamlEmptyCollection(value);
  if (empty !== undefined) return [`${padding}${renderedKey}: ${empty}`];
  if (Array.isArray(value) || isPlainRecord(value)) {
    return [`${padding}${renderedKey}:`, ...yamlLines(value, indent + 2)];
  }
  throw new UnserializableValueError(`YAML cannot represent the value at key ${JSON.stringify(key)}: ${describeValue(value)}`);
}

/** A map inside a sequence: the first key rides the dash, the rest indent under it. */
function yamlArrayMapLines(value: Record<string, unknown>, indent: number): string[] {
  const entries = Object.entries(value);
  const padding = " ".repeat(indent);
  if (entries.length === 0) return [`${padding}- {}`];

  const [first, ...rest] = entries;
  const [firstKey, firstValue] = first!;
  const renderedFirstKey = yamlString(firstKey);
  const firstEmpty = yamlEmptyCollection(firstValue);
  const lines: string[] = [];
  if (isYamlScalar(firstValue)) {
    lines.push(`${padding}- ${renderedFirstKey}: ${yamlScalar(firstValue)}`);
  } else if (firstEmpty !== undefined) {
    lines.push(`${padding}- ${renderedFirstKey}: ${firstEmpty}`);
  } else if (Array.isArray(firstValue) || isPlainRecord(firstValue)) {
    lines.push(`${padding}- ${renderedFirstKey}:`);
    lines.push(...yamlLines(firstValue, indent + 4));
  } else {
    throw new UnserializableValueError(`YAML cannot represent the value at key ${JSON.stringify(firstKey)}: ${describeValue(firstValue)}`);
  }
  for (const [key, child] of rest) lines.push(...yamlMapEntryLines(key, child, indent + 2));
  return lines;
}

function yamlLines(value: unknown, indent: number): string[] {
  const padding = " ".repeat(indent);
  if (isYamlScalar(value)) return [`${padding}${yamlScalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${padding}[]`];
    return value.flatMap(item => {
      if (isYamlScalar(item)) return [`${padding}- ${yamlScalar(item)}`];
      if (isPlainRecord(item)) return yamlArrayMapLines(item, indent);
      /*
       * A nested sequence is ordinary YAML (`matrix: [[1,2],[3,4]]`). This
       * used to throw a plain Error carrying `String(item)` — untyped, so the
       * writer could not turn it into a refusal and it surfaced as a 500, and
       * carrying the value's CONTENTS into the message, which a config may
       * not want repeated.
       */
      if (Array.isArray(item)) {
        if (item.length === 0) return [`${padding}- []`];
        return [`${padding}-`, ...yamlLines(item, indent + 2)];
      }
      throw new UnserializableValueError(
        `YAML cannot represent this sequence item: ${describeValue(item)}`,
      );
    });
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${padding}{}`];
    return entries.flatMap(([key, child]) => yamlMapEntryLines(key, child, indent));
  }
  throw new UnserializableValueError(`YAML cannot represent this value: ${describeValue(value)}`);
}

/** Block-style YAML for the shallow shapes we emit. Throws on anything else. */
export function renderYaml(value: unknown, indent = 0): string {
  if (!Number.isInteger(indent) || indent < 0) {
    throw new Error(`YAML indent must be a non-negative integer: ${String(indent)}`);
  }
  return `${yamlLines(value, indent).join("\n")}\n`;
}

/** A short, safe description for an error message — never the value's contents. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}

/** TOML basic-string escape. Mirrors `tomlString` in src/grok/inject.ts. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Bare key when safe, basic-string key otherwise (TOML 1.0 §Keys). */
export function quoteTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlScalar(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  /*
   * Arrays of ANY scalar, not just strings. The string-only check was written
   * against our own builder output; a user's config legitimately holds
   * `ports = [1, 2]`, and refusing it threw out of the writer as a 500.
   * TOML permits mixed-type arrays since 1.0, so the elements are rendered
   * individually rather than required to share a type.
   */
  if (Array.isArray(value)) {
    return `[${value.map(item => tomlScalar(item)).join(", ")}]`;
  }
  /*
   * An inline table is valid TOML (`items = [{ x = 1 }]`), and rendering one
   * inline is straightforward — but only where the whole array can be
   * rendered, so this stays a scalar-position renderer rather than silently
   * flattening a table into a string.
   */
  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    return `{ ${entries.map(([k, v]) => `${quoteTomlKey(k)} = ${tomlScalar(v)}`).join(", ")} }`;
  }
  throw new UnserializableValueError(`TOML cannot represent this value: ${describeValue(value)}`);
}

/**
 * Render `{ [table]: { key: scalar } }` as TOML. Scalars come first, then
 * tables in insertion order, so two calls with the same document produce
 * identical bytes — the stability guarantee `normalizeExportModels` exists to
 * protect.
 */
export function renderToml(document: Record<string, unknown>, prefix = ""): string {
  const scalars: string[] = [];
  const tables: string[] = [];
  for (const [key, value] of Object.entries(document)) {
    const path = prefix ? `${prefix}.${quoteTomlKey(key)}` : quoteTomlKey(key);
    if (isPlainRecord(value)) {
      tables.push(`[${path}]\n${renderToml(value, path)}`.trimEnd());
    } else {
      scalars.push(`${quoteTomlKey(key)} = ${tomlScalar(value)}`);
    }
  }
  return `${[scalars.join("\n"), tables.join("\n\n")].filter(Boolean).join("\n\n")}\n`;
}

/**
 * Ceiling on container nesting for json documents, shared by the parse-time
 * scanner (config-io.ts) and the serializer walk below. One constant on
 * purpose: the walk must accept every document the scanner admits, or a file
 * the classifier reported as recoverable would refuse at rewrite time. Real
 * configs nest a handful of levels.
 */
export const MAX_JSON_NESTING = 1000;

/** Error messages carry the path to the offending value; keep them readable. */
function clampPath(path: string): string {
  return path.length > 200 ? `${path.slice(0, 100)}…${path.slice(-100)}` : path;
}

/**
 * JSON.stringify writes a non-finite number as `null` and -0 as `0`; any
 * other finite double round-trips value-exactly (literal-level rounding is
 * the parse-time scanner's concern), so those two are exactly what this walk
 * refuses — refusing more turned a state the classifier had promised as
 * recoverable into a permanent refusal. Documents read from disk are already
 * guarded at parse time, and the writer's merge layer JSON-clones documents —
 * normalizing these values — before serializing, so on the apply/disable path
 * this walk is unreachable for them: it guards the direct serializers
 * (preview/export builders), same posture as the YAML and TOML renderers
 * above, and enforces the nesting ceiling for every json caller before the
 * recursive JSON.stringify can turn depth into a RangeError.
 *
 * Iterative frames instead of recursion or a node stack: depth AND size of
 * the document are inputs under the writer of the config file. Recursion made
 * a deep file a RangeError-500; materializing every node with its path made a
 * wide file allocate a large multiple of its size. Frames keep memory
 * proportional to nesting depth, and path strings exist only for the
 * containers on the current path plus the failing value itself.
 */
function assertJsonNumbersRoundTrip(document: unknown, rootPath: string): void {
  const refuse = (value: number, path: string): never => {
    throw new UnserializableValueError(Object.is(value, -0)
      ? `JSON cannot rewrite -0 at ${clampPath(path)} without changing it to 0`
      : `JSON cannot rewrite the number at ${clampPath(path)} without changing it to null`);
  };
  if (typeof document === "number" && (!Number.isFinite(document) || Object.is(document, -0))) {
    refuse(document, rootPath);
  }
  type Frame = { container: unknown; keys: string[] | null; index: number; prefix: string };
  const frames: Frame[] = [];
  const pushContainer = (value: unknown, prefix: string) => {
    if (Array.isArray(value)) frames.push({ container: value, keys: null, index: 0, prefix });
    else if (isPlainRecord(value)) frames.push({ container: value, keys: Object.keys(value), index: 0, prefix });
  };
  pushContainer(document, rootPath);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const length = frame.keys ? frame.keys.length : (frame.container as unknown[]).length;
    if (frame.index >= length) { frames.pop(); continue; }
    const i = frame.index;
    frame.index += 1;
    const child = frame.keys
      ? (frame.container as Record<string, unknown>)[frame.keys[i]!]
      : (frame.container as unknown[])[i];
    const childPath = () => frame.keys
      ? (frame.prefix === "$" ? frame.keys[i]! : `${frame.prefix}.${frame.keys[i]!}`)
      : `${frame.prefix}[${i}]`;
    if (typeof child === "number") {
      if (!Number.isFinite(child) || Object.is(child, -0)) refuse(child, childPath());
      continue;
    }
    if (typeof child === "object" && child !== null) {
      if (frames.length >= MAX_JSON_NESTING) {
        throw new UnserializableValueError(
          `the document nests deeper than ${MAX_JSON_NESTING} levels at ${clampPath(childPath())}, which JSON serialization cannot rewrite safely`);
      }
      pushContainer(child, childPath());
    }
  }
}

/** Every serializer returns text ending in exactly one newline. */
export function serializeDocument(document: unknown, format: ConfigFormat): string {
  switch (format) {
    case "json": {
      assertJsonNumbersRoundTrip(document, "$");
      return `${JSON.stringify(document, null, 2)}\n`;
    }
    case "json5": return `${Bun.JSON5.stringify(document, null, 2)}\n`;
    case "yaml": return renderYaml(document);
    case "toml": {
      if (!isPlainRecord(document)) throw new Error("TOML root must be a table");
      return renderToml(document);
    }
  }
}
