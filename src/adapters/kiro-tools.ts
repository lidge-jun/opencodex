import type { OcxParsedRequest } from "../types";
import { namespacedToolName } from "../types";
import { normalizeKiroModelId } from "../providers/kiro-models";
import { createKiroToolNameRegistry, type KiroToolNameRegistry } from "./kiro-wire";

const MAX_KIRO_TOOL_DESCRIPTION_UNVERIFIED = 1024;
const MAX_KIRO_TOOL_DESCRIPTION_GPT_56_SOL = 9_216;

// JSON Schema validation/annotation keywords that Kiro's runtimeservice tool-spec validator
// rejects ("ValidationException: Invalid tool use format."). Codex's built-in tools omit these,
// but the `memories__*` tools (add_ad_hoc_note/read/search/list) emit pattern/length/range
// constraints via schemars, which trip the validator. Strip them everywhere in the schema tree;
// the constraints are advisory for the model, so dropping them does not change tool behavior.
const KIRO_REJECTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
  "$schema",
  // Validation-only composition/applicator keywords that Bedrock/Kiro do not support. Unlike
  // `properties`/`$defs`, these are not plain property->schema maps the model needs, so they are
  // dropped outright rather than recursed into.
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "contains",
  "unevaluatedProperties",
  "unevaluatedItems",
  // Codex's Responses-only `encrypted: true` marker (openai/codex 5f4d06ef) stamped on v2
  // collaboration tool schemas. Kiro/Bedrock validators reject a narrower, undocumented schema
  // subset (issue #85 class); the marker is a ChatGPT-backend annotation with no meaning here.
  "encrypted",
]);

// Keys whose values are maps of *property/definition name -> schema* (not schema keywords). Their
// child keys must never be treated as schema keywords, or a legitimate property named e.g.
// "format"/"pattern" would be deleted. We recurse into the value schemas but keep every name intact.
const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);

function sanitizeSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return sanitizeKiroSchema(value);
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    out[name] = sanitizeKiroSchema(child);
  }
  return out;
}

function sanitizeKiroSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeKiroSchema);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (KIRO_REJECTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    out[key] = SCHEMA_MAP_KEYS.has(key) ? sanitizeSchemaMap(child) : sanitizeKiroSchema(child);
  }
  return out;
}

function ensureRootObjectType(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {};
  // Bedrock rejects oneOf/allOf/anyOf at the root ("input_schema does not support oneOf, allOf, or
  // anyOf at the top level") and requires the root type to be "object". Flatten every root
  // composition into the object schema while preserving the root's own properties/required and any
  // other sibling keys. allOf merges required (AND); anyOf/oneOf drop required so a single valid
  // branch still passes. Nested (non-root) composition is left intact — only the root is illegal.
  const COMPOSITION_KEYS = ["oneOf", "anyOf", "allOf"] as const;
  const hasComposition = COMPOSITION_KEYS.some(k => Array.isArray(obj[k]));
  const t = obj.type;
  const rootObjectType = t === "object" || (Array.isArray(t) && t.includes("object"));
  if (!hasComposition) {
    if (rootObjectType && t === "object") return obj;
    return { ...obj, type: "object" };
  }

  const props: Record<string, unknown> = {};
  const required = new Set<string>();
  // Seed with the root's own properties/required so a schema like
  // { type:"object", properties:{path}, required:["path"], oneOf:[...] } keeps them.
  if (obj.properties && typeof obj.properties === "object") {
    Object.assign(props, sanitizeKiroSchema(obj.properties) as Record<string, unknown>);
  }
  if (Array.isArray(obj.required)) {
    for (const r of obj.required) if (typeof r === "string") required.add(r);
  }
  for (const key of COMPOSITION_KEYS) {
    const variants = obj[key];
    if (!Array.isArray(variants)) continue;
    // allOf is conjunction: its required fields always apply. oneOf/anyOf are disjunction, so
    // promoting their required would over-constrain a valid single-branch call.
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const v = variant as Record<string, unknown>;
      if (v.properties && typeof v.properties === "object") {
        Object.assign(props, sanitizeKiroSchema(v.properties) as Record<string, unknown>);
      }
      if (mergeRequired && Array.isArray(v.required)) {
        for (const r of v.required) if (typeof r === "string") required.add(r);
      }
    }
  }

  // Keep all non-composition sibling keys (description, $defs, definitions, etc.); replace
  // type/properties/required with the flattened object form.
  const merged: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(obj)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") continue;
    if (key === "type" || key === "properties" || key === "required") continue;
    merged[key] = child;
  }
  merged.type = "object";
  if (Object.keys(props).length > 0) merged.properties = props;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function toolDescriptionLimit(modelId: string): number {
  return normalizeKiroModelId(modelId) === "gpt-5.6-sol"
    ? MAX_KIRO_TOOL_DESCRIPTION_GPT_56_SOL
    : MAX_KIRO_TOOL_DESCRIPTION_UNVERIFIED;
}

function truncateDescription(description: string, limit: number): string {
  if (description.length <= limit) return description;
  if (limit <= 1) return description.slice(0, limit);
  return `${description.slice(0, limit - 1)}…`;
}

export function convertKiroToolContext(
  parsed: OcxParsedRequest,
  registry: KiroToolNameRegistry = createKiroToolNameRegistry(),
): { tools: unknown[]; systemAdditions: string[]; nameMap: Map<string, string>; registry: KiroToolNameRegistry } {
  const tools = parsed.context.tools ?? [];
  const descriptionLimit = toolDescriptionLimit(parsed.modelId);
  // Validate every listed name even when tool_choice:none emulates a tool-free turn.
  for (const tool of tools) registry.alias(namespacedToolName(tool.namespace, tool.name));
  const effectiveTools = parsed.options.toolChoice === "none" ? [] : tools;
  return {
    tools: effectiveTools.map(t => {
      const description = t.description || `Tool: ${t.name}`;
      // Send the full namespaced wire name (e.g. mcp__chrome-devtools__navigate_page) so Kiro echoes
      // it back; the bridge's toolNsMap is keyed by this name and restores the MCP namespace Codex
      // routes by. Kiro's runtimeservice rejects names with spaces or >64 chars, so normalize to a
      // safe form and remember the mapping; the response parser restores the original wire name.
      const wireName = namespacedToolName(t.namespace, t.name);
      const toolName = registry.alias(wireName);
      return {
        toolSpecification: {
          name: toolName,
          description: truncateDescription(description, descriptionLimit),
          inputSchema: { json: ensureRootObjectType(sanitizeKiroSchema(t.parameters ?? {})) },
        },
      };
    }),
    systemAdditions: [],
    nameMap: registry.nameMap,
    registry,
  };
}

export function convertKiroTools(parsed: OcxParsedRequest): unknown[] {
  return convertKiroToolContext(parsed).tools;
}
