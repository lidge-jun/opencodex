import { isNativeOpenAIChatTarget } from "./wire";
import { createOpenAIChatToolNameRegistry, type OpenAIChatToolNameRegistry } from "./tool-name-registry";
import { isXaiSchemaTarget, lookupLocalJsonPointer, normalizeXaiToolParameters } from "../xai-tool-schema";
import { stripResponsesOnlyEncryptedMarker, stripUnicodePropertyPatterns } from "../responses-tool-schema";
import { isAllowedToolChoice, resolveToolChoiceWireName, toolChoiceToolPredicate } from "../../types";
import type { OcxParsedRequest, OcxProviderConfig } from "../../types";

const ZEN_SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);
const ZEN_DROPPED_SCHEMA_KEYS = new Set(["encrypted"]);

function sanitizeZenSchemaMap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return sanitizeZenToolParameters(value);
  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    out[name] = sanitizeZenToolParameters(child);
  }
  return out;
}

function sanitizeZenToolParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeZenToolParameters);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (ZEN_DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "required" && Array.isArray(child) && child.length === 0) continue;
    if (key === "type" && Array.isArray(child)) {
      const nonNull = child.filter(entry => entry !== "null");
      if (child.includes("null")) out.nullable = true;
      if (nonNull.length > 0) out.type = nonNull[0];
      continue;
    }
    out[key] = ZEN_SCHEMA_MAP_KEYS.has(key) ? sanitizeZenSchemaMap(child) : sanitizeZenToolParameters(child);
  }
  return out;
}

function ensureZenRootObjectSchema(schema: unknown): Record<string, unknown> {
  const obj = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {};
  const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
  const hasComposition = compositionKeys.some(key => Array.isArray(obj[key]));
  const rootType = obj.type;
  const rootObjectType = rootType === "object" || (Array.isArray(rootType) && rootType.includes("object"));
  if (!hasComposition) {
    const base = sanitizeZenToolParameters(obj) as Record<string, unknown>;
    return rootObjectType && base.type === "object" ? base : { ...base, type: "object" };
  }

  const props: Record<string, unknown> = {};
  const required = new Set<string>();
  if (obj.properties && typeof obj.properties === "object") {
    Object.assign(props, sanitizeZenSchemaMap(obj.properties) as Record<string, unknown>);
  }
  if (Array.isArray(obj.required)) {
    for (const entry of obj.required) if (typeof entry === "string") required.add(entry);
  }
  for (const key of compositionKeys) {
    const variants = obj[key];
    if (!Array.isArray(variants)) continue;
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const rec = variant as Record<string, unknown>;
      if (rec.properties && typeof rec.properties === "object") {
        Object.assign(props, sanitizeZenSchemaMap(rec.properties) as Record<string, unknown>);
      }
      if (mergeRequired && Array.isArray(rec.required)) {
        for (const entry of rec.required) if (typeof entry === "string") required.add(entry);
      }
    }
  }

  const merged = sanitizeZenToolParameters(obj) as Record<string, unknown>;
  delete merged.oneOf;
  delete merged.anyOf;
  delete merged.allOf;
  merged.type = "object";
  if (Object.keys(props).length > 0) merged.properties = props;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function shouldSanitizeZenToolParameters(provider: OcxProviderConfig): boolean {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  return baseUrl === "https://opencode.ai/zen/v1"
    || baseUrl === "https://opencode.ai/zen/go/v1";
}

/** Azure Model Router (and Gemini-in-the-pool) 400s Codex MCP schemas whose root is a union. */
const AZURE_CHAT_FORBIDDEN_ROOT_KEYS = ["oneOf", "anyOf", "allOf", "enum", "const", "not"] as const;

function isAzureOpenAiChatTarget(provider: OcxProviderConfig): boolean {
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return host.endsWith(".openai.azure.com")
      || host.endsWith(".cognitiveservices.azure.com")
      || host.endsWith(".services.ai.azure.com")
      || host.endsWith(".ai.azure.com");
  } catch {
    return false;
  }
}

/**
 * Azure Foundry Model Router validates every function schema against the strictest model in
 * the pool (Gemini-shaped): root must be {type:"object"} with no oneOf/anyOf/allOf/enum/
 * const/not. Codex App MCP tools such as mcp__codex_app__automation_update ship a root
 * union, which 400s the whole turn. Flatten like Zen, then strip leftover forbidden keys.
 */
function sanitizeAzureChatToolParameters(parameters: unknown): Record<string, unknown> {
  const root = ensureZenRootObjectSchema(parameters);
  for (const key of AZURE_CHAT_FORBIDDEN_ROOT_KEYS) delete root[key];
  root.type = "object";
  if (!root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) {
    root.properties = {};
  }
  return root;
}

// Moonshot validates function schemas against a draft-07 reading of `$ref`, where the
// keyword stands alone and siblings are ignored. It rejects the whole request rather
// than ignoring them: "not a valid moonshot flavored json schema ... when using $ref,
// type should be defined in the referenced schema instead of the parent schema".
const MOONSHOT_SCHEMA_HOSTNAMES = new Set([
  "api.kimi.com",
  "api.moonshot.ai",
  "api.moonshot.cn",
]);

function isMoonshotSchemaTarget(provider: OcxProviderConfig): boolean {
  try {
    return MOONSHOT_SCHEMA_HOSTNAMES.has(new URL(provider.baseUrl).hostname);
  } catch {
    return false;
  }
}

const VOLCENGINE_ARK_HOSTNAMES = new Set([
  "ark.cn-beijing.volces.com",
  "ark.ap-southeast.volces.com",
]);

export function isVolcengineArkPaygChatTarget(provider: OcxProviderConfig): boolean {
  try {
    const url = new URL(provider.baseUrl);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return VOLCENGINE_ARK_HOSTNAMES.has(url.hostname) && pathname === "/api/v3";
  } catch {
    return false;
  }
}

function ensureRootObjectType(parameters: unknown): Record<string, unknown> {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return { type: "object", properties: {} };
  }
  const obj = parameters as Record<string, unknown>;
  if (obj.type === "object") return obj;
  return { ...obj, type: "object" };
}

function isXaiObjectSchema(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * JSON Schema 2020-12 makes `$ref` an in-place applicator: siblings stay in force and are
 * combined with the referenced schema. Moonshot enforces the older draft-07 reading where
 * `$ref` must stand alone, and 400s the entire request when a node carries both. Codex's own
 * deferred tool catalog emits exactly that shape (zod-to-json-schema deduplicates into
 * `$defs.__schema*` nodes that keep `type`/`minLength`/`format` beside the `$ref`), so the
 * schema is not something a user can fix from configuration — see issue #2673.
 *
 * Inline the referenced schema underneath the node's own keywords, which is what 2020-12 says
 * the node means, then drop `$ref`. Constraints reach the model instead of being stripped.
 * The `$defs` bag is preserved: a bare `$ref` (no siblings) is already legal for Moonshot and
 * is left pointing at its definition rather than expanded, which keeps recursive schemas finite.
 */
function moonshotRefTargetKeys(node: Record<string, unknown>): string[] {
  return Object.keys(node).filter(key => key !== "$ref");
}

/**
 * Inlining duplicates the target, so a schema referencing one large definition from many
 * sibling-carrying nodes can multiply. Bound the total expansions and fall back to a bare
 * `$ref` once the budget is spent: still valid for Moonshot, just without the node's own
 * narrowing keywords. Mirrors the node budget in google-tool-schema.ts.
 */
const MOONSHOT_MAX_REF_EXPANSIONS = 512;

/**
 * Expansion count alone does not bound the walk: a deeply nested ref-free schema, or one
 * large definition repeated across many nodes, still recurses to exhaustion or amplifies the
 * emitted output. Depth and node budgets close both, and mirror google-tool-schema.ts.
 */
const MOONSHOT_MAX_SCHEMA_DEPTH = 64;
const MOONSHOT_MAX_SCHEMA_NODES = 4_096;
const MOONSHOT_MAX_INLINED_SCHEMA_BYTES = 1024 * 1024;

/**
 * Measure only as far as the caller's remaining allowance. Keeping this iterative avoids
 * reintroducing the deep-schema stack exhaustion that the normalizer's depth limit prevents.
 */
function serializedJsonBytesUpTo(value: unknown, limit: number): number {
  const encoder = new TextEncoder();
  const pending: unknown[] = [value];
  let bytes = 0;
  while (pending.length > 0 && bytes <= limit) {
    const item = pending.pop();
    if (Array.isArray(item)) {
      bytes += 2 + Math.max(0, item.length - 1);
      for (const child of item) pending.push(child);
      continue;
    }
    if (isXaiObjectSchema(item)) {
      const entries = Object.entries(item);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, child] of entries) {
        bytes += encoder.encode(JSON.stringify(key)).byteLength + 1;
        pending.push(child);
      }
      continue;
    }
    const encoded = JSON.stringify(item);
    bytes += encoder.encode(encoded === undefined ? "null" : encoded).byteLength;
  }
  return bytes;
}

/**
 * Assertion keywords whose meaning under a `$ref` is CONJUNCTION, not replacement. A node
 * carrying `required: ["b"]` beside a target requiring `["a"]` means both are required;
 * letting the sibling win emitted a schema that no longer described the tool.
 */
function unionRequired(target: unknown, sibling: unknown): unknown {
  if (!Array.isArray(target) || !Array.isArray(sibling)) return sibling;
  const seen = new Set<unknown>();
  const out: unknown[] = [];
  for (const name of [...target, ...sibling]) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Keywords whose values are DATA, not schemas.
 *
 * Recursing into them rewrote user data: an `enum` listing a literal object that happens
 * to carry a `"$ref"` string had that key stripped as if it were a schema reference, so a
 * value the tool declared as legal silently changed shape. These are copied through.
 */
const MOONSHOT_DATA_VALUED_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

/**
 * Numeric assertions whose intersection is a bound, and which direction tightens.
 *
 * `$ref` under 2020-12 is an in-place applicator: the node and its target BOTH apply, so
 * the emitted schema must be their INTERSECTION. The previous code overwrote the target
 * with the node and called that "the narrower reading", which holds only when the node
 * happens to be narrower. A node declaring `minLength: 1` beside a target declaring
 * `minLength: 5` shipped `minLength: 1` - a contract weaker than either side asked for,
 * emitted silently, which is the same failure mode the `required` composition fixed for
 * set-valued keywords.
 *
 * "max" means the surviving value is the larger of the two (lower bounds), "min" the
 * smaller (upper bounds). A keyword absent from this table keeps the overwrite: for
 * `type`, `format`, `description` and friends there is no ordering to intersect along,
 * and the node is the more specific statement.
 */
const MOONSHOT_BOUND_KEYWORDS: Record<string, "max" | "min"> = {
  minLength: "max",
  minItems: "max",
  minProperties: "max",
  minimum: "max",
  exclusiveMinimum: "max",
  maxLength: "min",
  maxItems: "min",
  maxProperties: "min",
  maximum: "min",
  exclusiveMaximum: "min",
};

/**
 * Intersect one numeric bound. Either side being absent or non-finite yields the other,
 * because an unstated bound constrains nothing - returning `undefined` there would drop
 * a constraint the remaining side genuinely made.
 */
function intersectBound(target: unknown, sibling: unknown, direction: "max" | "min"): unknown {
  const a = typeof target === "number" && Number.isFinite(target) ? target : null;
  const b = typeof sibling === "number" && Number.isFinite(sibling) ? sibling : null;
  if (a === null) return b === null ? sibling : sibling;
  if (b === null) return target;
  return direction === "max" ? Math.max(a, b) : Math.min(a, b);
}

/**
 * Compose two `properties` maps. A property named in BOTH the referenced target and the
 * node is the same conjunction problem `required` had: letting the sibling win discards
 * the target's constraints for that member. Merge the two member schemas so neither side
 * loses its keywords. Shared member bounds are the same conjunction one level down,
 * and nested object members recurse through this helper instead of replacing the target.
 */
function composeProperties(
  target: Record<string, unknown>,
  sibling: Record<string, unknown>,
): Record<string, unknown> {
  const combined: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, sub] of Object.entries(target)) combined[name] = sub;
  for (const [name, sub] of Object.entries(sibling)) {
    const existing = combined[name];
    if (isXaiObjectSchema(existing) && isXaiObjectSchema(sub)) {
      const member: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(existing)) member[k] = v;
      for (const [k, v] of Object.entries(sub)) {
        if (k === "required") {
          member[k] = unionRequired(member[k], v);
          continue;
        }
        if (k === "properties" && isXaiObjectSchema(member[k]) && isXaiObjectSchema(v)) {
          member[k] = composeProperties(member[k] as Record<string, unknown>, v);
          continue;
        }
        const boundDirection = MOONSHOT_BOUND_KEYWORDS[k];
        if (boundDirection && k in member) {
          member[k] = intersectBound(member[k], v, boundDirection);
          continue;
        }
        member[k] = v;
      }
      combined[name] = member;
      continue;
    }
    combined[name] = sub;
  }
  return combined;
}

/**
 * The inline-byte allowance for one request. Sharing it across tools matters: a per-tool
 * budget would let a large catalog multiply the cap by its tool count, reintroducing the
 * request amplification this bound exists to prevent.
 */
interface MoonshotInlineByteBudget {
  remaining: number;
}

interface MoonshotNormalizeState {
  activeRefs: Set<string>;
  inlineSizeCache: WeakMap<Record<string, unknown>, number>;
  inlineByteBudget: MoonshotInlineByteBudget;
  remainingExpansions: number;
  remainingNodes: number;
}

function normalizeMoonshotSchemaNode(
  node: unknown,
  root: Record<string, unknown>,
  state: MoonshotNormalizeState,
  depth = 0,
): unknown {
  if (Array.isArray(node)) {
    if (depth >= MOONSHOT_MAX_SCHEMA_DEPTH) return [];
    return node.map(item => normalizeMoonshotSchemaNode(item, root, state, depth + 1));
  }
  if (!isXaiObjectSchema(node)) return node;

  // Fail closed for this node rather than emitting a partially weakened schema: an empty
  // object is the one shape that asserts nothing it cannot back up.
  if (depth >= MOONSHOT_MAX_SCHEMA_DEPTH || state.remainingNodes <= 0) return {};
  state.remainingNodes -= 1;

  const ref = node.$ref;
  const hasSiblings = moonshotRefTargetKeys(node).length > 0;

  if (typeof ref === "string" && hasSiblings) {
    // A cycle cannot be inlined. Keeping the bare `$ref` is the lossy-but-valid fallback:
    // Moonshot accepts it, and the alternative (dropping the ref) would erase the recursion.
    if (state.activeRefs.has(ref) || state.remainingExpansions <= 0) return { $ref: ref };

    const target = lookupLocalJsonPointer(root, ref);
    if (isXaiObjectSchema(target)) {
      // Charge the referenced value before copying it. Object/node counts do not cover large
      // maps of boolean schemas, which otherwise allow a small input to create hundreds of
      // full copies before the final request is serialized.
      let inlineBytes = state.inlineSizeCache.get(target);
      if (inlineBytes === undefined) {
        inlineBytes = serializedJsonBytesUpTo(target, MOONSHOT_MAX_INLINED_SCHEMA_BYTES);
        state.inlineSizeCache.set(target, inlineBytes);
      }
      if (inlineBytes > state.inlineByteBudget.remaining) return { $ref: ref };
      const bytesBefore = state.inlineByteBudget.remaining;
      const expansionsBefore = state.remainingExpansions;
      const nodesBefore = state.remainingNodes;
      state.inlineByteBudget.remaining -= inlineBytes;
      state.remainingExpansions -= 1;
      state.activeRefs.add(ref);
      const resolvedTarget = normalizeMoonshotSchemaNode(target, root, state, depth + 1);
      state.activeRefs.delete(ref);
      // Nested copies have already spent from the shared allowance. Charge only
      // growth that their own charges do not cover.
      const nestedCharges = bytesBefore - inlineBytes - state.inlineByteBudget.remaining;
      const normalizedBytes = serializedJsonBytesUpTo(
        resolvedTarget, bytesBefore,
      );
      const growthBytes = Math.max(0, normalizedBytes - inlineBytes - nestedCharges);
      if (growthBytes > state.inlineByteBudget.remaining) {
        state.inlineByteBudget.remaining = bytesBefore;
        state.remainingExpansions = expansionsBefore;
        state.remainingNodes = nodesBefore;
        return { $ref: ref };
      }
      state.inlineByteBudget.remaining -= growthBytes;
      const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      if (isXaiObjectSchema(resolvedTarget)) {
        for (const [key, value] of Object.entries(resolvedTarget)) merged[key] = value;
      }
      // "Alongside the target" is conjunction, not replacement. For most keywords the node
      // narrows the target and overwriting is the narrower reading, but `required` and
      // `properties` are set-valued: letting the sibling win DROPPED the target's own
      // members, so a tool requiring `a` beside a node requiring `b` shipped requiring only
      // `b`. Those two compose; everything else keeps the narrowing overwrite.
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref") continue;
        if (MOONSHOT_DATA_VALUED_KEYWORDS.has(key)) {
          merged[key] = value;
          continue;
        }
        const normalized = normalizeMoonshotSchemaNode(value, root, state, depth + 1);
        if (key === "required") {
          merged[key] = unionRequired(merged[key], normalized);
          continue;
        }
        if (key === "properties" && isXaiObjectSchema(merged[key]) && isXaiObjectSchema(normalized)) {
          merged[key] = composeProperties(merged[key] as Record<string, unknown>, normalized);
          continue;
        }
        // Numeric bounds intersect rather than overwrite: both the node and its target
        // apply, so the surviving bound is the stricter of the two in whichever direction
        // that keyword tightens.
        const boundDirection = MOONSHOT_BOUND_KEYWORDS[key];
        if (boundDirection && key in merged) {
          merged[key] = intersectBound(merged[key], normalized, boundDirection);
          continue;
        }
        merged[key] = normalized;
      }

      // Re-normalize only composed properties that retain a $ref alongside sibling keywords
      if (isXaiObjectSchema(merged.properties)) {
        for (const [propName, propVal] of Object.entries(merged.properties as Record<string, unknown>)) {
          if (isXaiObjectSchema(propVal) && typeof propVal.$ref === "string" && moonshotRefTargetKeys(propVal).length > 0) {
            (merged.properties as Record<string, unknown>)[propName] = normalizeMoonshotSchemaNode(
              propVal,
              root,
              state,
              depth + 1,
            );
          }
        }
      }
      return merged;
    }

    // Unresolvable pointer: a remote ref, a malformed path, or a non-object target. Dropping
    // the ref and keeping the siblings silently discards whatever the reference constrained,
    // which is the one outcome we cannot detect downstream. A bare `$ref` is lossy in the
    // other direction - it loses the node's own keywords - but it preserves the identity of
    // what was asked for, and Moonshot accepts it.
    return { $ref: ref };
  }

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === "$ref" || MOONSHOT_DATA_VALUED_KEYWORDS.has(key)
      ? value
      : normalizeMoonshotSchemaNode(value, root, state, depth + 1);
  }

  // Moonshot MFJS requirements:
  // 1. Stamp "object" if properties are present, or if allOf defines object properties/variants,
  //    so Moonshot's validator recognizes the schema as a valid termination condition.
  // 2. Infer scalar types for bare const and enum keywords.
  if (out.type === undefined) {
    const isObjectAllOf = Array.isArray(out.allOf) && out.allOf.some(
      variant => isXaiObjectSchema(variant) && (
        variant.type === "object" ||
        variant.properties !== undefined ||
        variant.additionalProperties !== undefined
      ),
    );
    if (out.properties !== undefined || out.additionalProperties !== undefined || isObjectAllOf) {
      out.type = "object";
    } else if (out.const !== undefined) {
      const t = typeof out.const;
      if (t === "string" || t === "number" || t === "boolean") {
        out.type = t;
      }
    } else if (Array.isArray(out.enum) && out.enum.length > 0) {
      if (out.enum.every(x => typeof x === "string")) {
        out.type = "string";
      } else if (out.enum.every(x => typeof x === "number")) {
        out.type = "number";
      } else if (out.enum.every(x => typeof x === "boolean")) {
        out.type = "boolean";
      }
    }
  }

  return out;
}

function normalizeMoonshotToolParameters(
  parameters: unknown,
  inlineByteBudget: MoonshotInlineByteBudget,
): Record<string, unknown> {
  const rooted = ensureRootObjectType(parameters);
  const normalized = normalizeMoonshotSchemaNode(rooted, rooted, {
    activeRefs: new Set<string>(),
    inlineSizeCache: new WeakMap<Record<string, unknown>, number>(),
    inlineByteBudget,
    remainingExpansions: MOONSHOT_MAX_REF_EXPANSIONS,
    remainingNodes: MOONSHOT_MAX_SCHEMA_NODES,
  });
  return isXaiObjectSchema(normalized) ? normalized : rooted;
}

export function toolsToChatFormat(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  registry: OpenAIChatToolNameRegistry = createOpenAIChatToolNameRegistry(parsed.context.tools),
): unknown[] | undefined {
  if (!parsed.context.tools || parsed.context.tools.length === 0) return undefined;
  const tools = parsed.context.tools.filter(toolChoiceToolPredicate(parsed.options.toolChoice, parsed.context.tools));
  if (tools.length === 0) return undefined;
  const xaiTarget = isXaiSchemaTarget(provider);
  const moonshotTarget = !xaiTarget && isMoonshotSchemaTarget(provider);
  const moonshotInlineByteBudget: MoonshotInlineByteBudget = {
    remaining: MOONSHOT_MAX_INLINED_SCHEMA_BYTES,
  };
  const formatted = tools.flatMap(t => {
    const normalized = xaiTarget
      ? normalizeXaiToolParameters(t.parameters)
      : moonshotTarget
        ? normalizeMoonshotToolParameters(t.parameters, moonshotInlineByteBudget)
        : ensureRootObjectType(t.parameters);
    const parameters = stripUnicodePropertyPatterns(stripResponsesOnlyEncryptedMarker(normalized));

    if (parameters === undefined) return [];
    return [{
      type: "function",
      function: {
        name: registry.alias(t),
        ...(t.description ? { description: t.description } : {}),
        parameters,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }];
  });
  return formatted.length > 0 ? formatted : undefined;
}

export function toolsToChatFormatForProvider(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  registry: OpenAIChatToolNameRegistry = createOpenAIChatToolNameRegistry(parsed.context.tools),
): unknown[] | undefined {
  const base = toolsToChatFormat(parsed, provider, registry);
  const azureChat = isAzureOpenAiChatTarget(provider);
  const zenChat = shouldSanitizeZenToolParameters(provider);
  if (!base || (!zenChat && !azureChat)) return base;
  return base.map(tool => {
    if (!tool || typeof tool !== "object") return tool;
    const functionDef = (tool as { function?: Record<string, unknown> }).function;
    if (!functionDef || typeof functionDef !== "object") return tool;
    const parameters = azureChat
      ? sanitizeAzureChatToolParameters(functionDef.parameters ?? {})
      : ensureZenRootObjectSchema(functionDef.parameters ?? {});
    const nextFunction: Record<string, unknown> = { ...functionDef, parameters };
    // strict: true plus a flattened schema is rejected by Gemini-in-the-pool routers.
    if (azureChat) delete nextFunction.strict;
    return {
      ...tool,
      function: nextFunction,
    };
  });
}

export function toolChoiceToChatFormat(
  tc: OcxParsedRequest["options"]["toolChoice"],
  tools: OcxParsedRequest["context"]["tools"],
  provider: OcxProviderConfig,
  registry: OpenAIChatToolNameRegistry = createOpenAIChatToolNameRegistry(tools),
): unknown {
  if (!tc) return undefined;
  if (isAllowedToolChoice(tc)) {
    if (tc.mode === "required" && tc.allowedTools.length === 1 && isNativeOpenAIChatTarget(provider)) {
      return {
        type: "function",
        function: { name: registry.aliasWireName(resolveToolChoiceWireName(tools, tc.allowedTools[0])) },
      };
    }
    return tc.mode === "required" ? "required" : "auto";
  }
  if (tc === "auto" || tc === "none" || tc === "required") return tc;
  if ("name" in tc) {
    return {
      type: "function",
      function: { name: registry.aliasWireName(resolveToolChoiceWireName(tools, tc.name)) },
    };
  }
  return undefined;
}
