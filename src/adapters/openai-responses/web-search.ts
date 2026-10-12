import { isPlainObject } from "./internal";

/**
 * OpenAI hosted web_search config fields that a capability-classified Responses
 * upstream may reject wholesale. xAI's /v1/responses 400s the entire request on
 * `external_web_access` and `search_context_size` ("Argument not supported"),
 * which killed every routed Grok turn whose client (Codex) attaches its
 * default web_search tool config (probe 2026-08-21: both fields 400
 * individually; `user_location` and `filters` are accepted and kept).
 * The caller decides whether to apply this compatibility transform from explicit
 * provider capability metadata; an unclassified upstream keeps the fields.
 */
const OPENAI_ONLY_WEB_SEARCH_FIELDS = ["external_web_access", "search_context_size"] as const;

function stripOpenAiOnlyWebSearchFieldsFromTools(tools: unknown[]): {
  tools: unknown[];
  changed: boolean;
} {
  let changed = false;
  const stripped = tools.map(tool => {
    if (!isPlainObject(tool) || (tool.type !== "web_search" && tool.type !== "web_search_preview")) {
      return tool;
    }
    if (!OPENAI_ONLY_WEB_SEARCH_FIELDS.some(field => Object.hasOwn(tool, field))) return tool;
    const { external_web_access: _access, search_context_size: _size, ...rest } = tool;
    changed = true;
    return rest;
  });
  return { tools: changed ? stripped : tools, changed };
}

export function stripOpenAiOnlyWebSearchFields(body: unknown): unknown {
  if (!isPlainObject(body)) return body;

  let next: Record<string, unknown> = body;
  let changed = false;
  if (Array.isArray(body.tools)) {
    const stripped = stripOpenAiOnlyWebSearchFieldsFromTools(body.tools);
    if (stripped.changed) {
      next = { ...next, tools: stripped.tools };
      changed = true;
    }
  }

  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const input = body.input.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) {
        return item;
      }
      const stripped = stripOpenAiOnlyWebSearchFieldsFromTools(item.tools);
      if (!stripped.changed) return item;
      inputChanged = true;
      return { ...item, tools: stripped.tools };
    });
    if (inputChanged) {
      next = { ...next, input };
      changed = true;
    }
  }

  return changed ? next : body;
}

/**
 * Muse Spark ids whose Responses gateway refuses provider-specific fields on a plain
 * `web_search` tool. Membership, not equality: 1.3 shipped 2026-09-02 as the
 * same-shaped successor to 1.2 on the same Zen wire, and an equality check would
 * have let a Codex-emitted `web_search` body reach the
 * gateway and come back 400 for every request the moment 1.3 was selected.
 *
 * This list gates the two Zen destinations only. Zen serves nothing but the Contributor
 * tiers there, so the id is a proxy for "this gateway"; the direct Meta host below serves
 * a non-Contributor default and is gated by destination instead.
 */
const MUSE_SPARK_WEB_SEARCH_STRICT_MODELS = new Set([
  "muse-spark-1.3-contributor",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor",
  "muse-spark-1.2-contributor-free",
]);

/**
 * Direct Meta Muse / Meta Model Responses. Its refusal is a gateway schema rule applied
 * before inference, so it holds for every Muse model Meta serves — including the default
 * `muse-spark-1.3`, which no Contributor-shaped list contains. Gating that host on model
 * membership sent `search_content_types` through on every Codex `web_search` turn and 400ed
 * the whole request. Same reading as the 64-char tool-name rewrite in
 * `src/responses/muse-tool-name-alias.ts`, which is host-scoped and deliberately not
 * model-gated for this reason.
 */
const MUSE_SPARK_STRICT_ANY_MODEL_DESTINATION = "https://api.meta.ai/v1/responses";

const MUSE_SPARK_WEB_SEARCH_STRICT_RESPONSE_URLS = new Set([
  "https://opencode.ai/zen/v1/responses",
  "https://opencode.ai/zen/go/v1/responses",
  MUSE_SPARK_STRICT_ANY_MODEL_DESTINATION,
]);

const MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS = [
  "search_content_types",
  "indexed_web_access",
] as const;

/**
 * OpenCode Zen / Go and the direct Meta Muse Spark Responses gateways refuse a
 * short list of Codex `web_search` fields. `web_search_preview` keeps its accepted
 * shape, and Luna remains untouched. Match the exact effective request URL;
 * malformed, credentialed, or parameterized destinations keep their original body
 * instead of assuming this gateway contract. Keep the rejected names together so a
 * newly identified field is a one-line compatibility update rather than another
 * bespoke rewrite. The destination is the whole predicate on direct Meta; the Zen
 * wires additionally require a known Contributor id.
 */
export function stripMuseSparkUnsupportedWebSearchFields(
  body: unknown,
  modelId: unknown,
  responseUrl: string,
): unknown {
  if (!isPlainObject(body)) return body;
  let destination: string;
  try {
    const url = new URL(responseUrl);
    if (url.username || url.password || url.search || url.hash) return body;
    destination = `${url.origin.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return body;
  }
  if (!MUSE_SPARK_WEB_SEARCH_STRICT_RESPONSE_URLS.has(destination)) return body;
  if (
    destination !== MUSE_SPARK_STRICT_ANY_MODEL_DESTINATION
    && (typeof modelId !== "string" || !MUSE_SPARK_WEB_SEARCH_STRICT_MODELS.has(modelId.trim().toLowerCase()))
  ) return body;

  const rewriteTools = (tools: unknown[]): { tools: unknown[]; changed: boolean } => {
    let changed = false;
    const rewritten = tools.map(tool => {
      if (!isPlainObject(tool) || tool.type !== "web_search") return tool;
      if (!MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS.some(field => Object.hasOwn(tool, field))) {
        return tool;
      }
      const rest = { ...tool };
      for (const field of MUSE_SPARK_UNSUPPORTED_WEB_SEARCH_FIELDS) delete rest[field];
      changed = true;
      return rest;
    });
    return { tools: changed ? rewritten : tools, changed };
  };

  let next: Record<string, unknown> = body;
  let changed = false;
  if (Array.isArray(body.tools)) {
    const rewritten = rewriteTools(body.tools);
    if (rewritten.changed) {
      next = { ...next, tools: rewritten.tools };
      changed = true;
    }
  }
  if (Array.isArray(next.input)) {
    let inputChanged = false;
    const input = next.input.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const rewritten = rewriteTools(item.tools);
      if (!rewritten.changed) return item;
      inputChanged = true;
      return { ...item, tools: rewritten.tools };
    });
    if (inputChanged) {
      next = { ...next, input };
      changed = true;
    }
  }
  return changed ? next : body;
}
