import { createHash } from "node:crypto";
import type { IncomingMeta, ProviderAdapter } from "./base";
import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig, type OcxUsage, type TierDecision } from "../types";
import { catalogModelSupportsReasoningSummaries } from "../codex/catalog";
import { COMPACT_PROMPT, compactionItemToText, decodeCompactionSummary, isCompactionItemType } from "../responses/compaction";
import { collectResponsesToolGroups } from "../responses/tool-groups";
import { isHostedToolUnsupportedForModel } from "../responses/hosted-tool-policy";
import { decodeServerSentEvents } from "../lib/sse-decoder";
import {
  CODEX_FORWARD_BASE_URL,
  destinationDecodesNativeCompactionBlob,
  isCanonicalOpenAiForwardProvider,
  isOpenAiOperatedResponsesDestination,
} from "../providers/openai-tiers";
import { OCX_REASONING_PREFIX } from "../responses/reasoning-envelope";
import { modelRecordValue } from "../reasoning-effort";
import type { TranslatorBudget } from "../lib/translator-budget";
import { rewriteRoutedCustomToolsForUpstream } from "../responses/custom-tool-compat";
import { rewriteRoutedToolSearchForUpstream } from "../responses/tool-search-compat";
import { rewriteRoutedNamespaceToolsForUpstream } from "../responses/namespace-tool-compat";
import { openaiResponsesUrl } from "./openai-responses-url";
import { normalizeXaiResponsesWebSearch } from "./xai-web-search";
import {
  createAdapterTierMetadata,
} from "../providers/fastwire";

// Headers relayed verbatim from the caller in OAuth-passthrough ("forward") mode.
// Exported so the web-search sidecar reuses the exact same forwarded-auth set for its ChatGPT call.
export const FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
];

export function sanitizeReasoningInputContent(
  body: unknown,
  opts?: {
    preserveRawReasoningContent?: boolean;
    dropNullContentChannel?: boolean;
    stripEncryptedContent?: boolean;
  },
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.input)) return body;

  let changed = false;
  const input = raw.input.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const rec = item as Record<string, unknown>;
    if (rec.type !== "reasoning") return item;
    const hasRawContent = Array.isArray(rec.content) && rec.content.length > 0;
    // ocxr1 envelopes are proxy-minted (Anthropic signatures), not OpenAI encryption — the native
    // backend cannot decrypt them and would reject the request. Strip regardless of content shape.
    const hasOcxEnvelope = typeof rec.encrypted_content === "string" && rec.encrypted_content.startsWith(OCX_REASONING_PREFIX);
    const hasOutputStatus = Object.prototype.hasOwnProperty.call(rec, "status");
    const hasEncryptedContent = Object.prototype.hasOwnProperty.call(rec, "encrypted_content");
    const stripEncryptedContent = hasOcxEnvelope
      || (opts?.stripEncryptedContent === true && hasEncryptedContent);
    // Codex serializes an absent reasoning content channel as `"content": null`. The field is
    // optional and null carries nothing, but a strict gateway rejects the item on its declared type
    // — xAI answers `Could not decode the compaction blob`, naming the sibling `encrypted_content`
    // rather than the field it actually refused, which is why this reads as a blob failure. Drop the
    // key so the item matches the shape the upstream issued.
    //
    // Gated to routed destinations. An OpenAI-operated backend binds the blob to the item's exact
    // shape, so deleting a field there invalidates it (`The encrypted content ... could not be
    // verified`); the two requirements are exactly opposed, and a live regression proved it. That
    // gate is also why this drop may touch an item that keeps its blob: xAI demonstrably accepts its
    // own blob without the null channel, and the destinations that bind blobs to item shape never
    // reach this branch. This is independent of the output-only status removal below.
    const dropNullContentChannel = opts?.dropNullContentChannel === true
      && "content" in rec && !Array.isArray(rec.content);
    // `status` is output-only. Measured OpenAI reasoning items never contain it, and Grok accepts
    // its own encrypted_content with status removed. Keeping a foreign status beside a retained
    // blob makes OpenAI reject the field before blob validation, starving the provenance recovery
    // of the opaque-blob error it needs. Content blanking remains the separate pre-existing rule.
    const stripOutputStatus = hasOutputStatus;
    const blankContent = !dropNullContentChannel
      && !opts?.preserveRawReasoningContent
      && (hasRawContent || hasOcxEnvelope);
    if (!blankContent && !stripOutputStatus && !stripEncryptedContent && !dropNullContentChannel) {
      return item;
    }
    changed = true;
    const next: Record<string, unknown> = { ...rec };
    if (dropNullContentChannel) delete next.content;
    if (stripOutputStatus) delete next.status;
    if (stripEncryptedContent) delete next.encrypted_content;
    // Routed models can produce raw `reasoning_text` output items. Codex echoes those in later
    // native GPT requests, but ChatGPT's Responses backend accepts reasoning input only with empty
    // `content`; keep summaries/ids and drop the raw content so native passthrough does not 400.
    // DeepSeek's Responses API instead ACCEPTS plaintext reasoning replay (its compatibility
    // guide merges reasoning items into the adjacent assistant message), so providers flagged
    // `preserveResponsesReasoningContent` keep it — deleting valid replay content there breaks
    // continuations after tool calls (issue #875 family).
    if (blankContent) next.content = [];
    return next;
  });

  return changed ? { ...raw, input } : body;
}

function stripUnsupportedReasoningSummaryDelivery(body: unknown, modelId: string): unknown {
  if (catalogModelSupportsReasoningSummaries(modelId) !== false) return body;
  if (!isPlainObject(body) || !isPlainObject(body.stream_options)) return body;
  if (!("reasoning_summary_delivery" in body.stream_options)) return body;

  const streamOptions = { ...body.stream_options };
  delete streamOptions.reasoning_summary_delivery;
  const next = { ...body };
  if (Object.keys(streamOptions).length > 0) next.stream_options = streamOptions;
  else delete next.stream_options;
  return next;
}

function stripInvalidItemIds(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  const validPrefixes: Record<string, string> = {
    message: "msg_",
    agent_message: "amsg_",
    reasoning: "rs_",
    function_call: "fc_",
    custom_tool_call: "ctc_",
    tool_search_call: "tsc_",
    web_search_call: "ws_",
  };
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || typeof item.type !== "string") return item;
    const validPrefix = validPrefixes[item.type];
    if (!validPrefix) return item;
    if (typeof item.id === "string" && item.id.startsWith(validPrefix)) return item;
    if (!("id" in item)) return item;
    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });

  return changed ? { ...body, input } : body;
}

/**
 * Codex-private tool fields that only the ChatGPT backend understands.
 *
 * A third-party Responses gateway validates its schema and rejects the whole request before
 * inference — xAI answers `Argument not supported: external_web_access` — so these are removed at
 * the noncanonical boundary while the tool and every public option stay.
 *
 * Keep this a table. Each private bit Codex attaches has so far arrived as its own bespoke strip
 * with its own traversal, and the traversals disagreed about which containers they covered; a new
 * one should be a row here instead. `toolTypes` omitted means the field is private on any tool.
 */
const CANONICAL_ONLY_TOOL_FIELDS: readonly { field: string; toolTypes?: ReadonlySet<string>; capabilityGated?: boolean }[] = [
  // ChatGPT's browsing policy bit. The public hosted tool is enabled by its presence alone.
  // OWNERSHIP: official OpenAI API-key traffic and unclassified gateways ACCEPT this field, so
  // it is only stripped when the provider capability denies it (supportsOpenAiWebSearchToolFields
  // === false), matching stripOpenAiOnlyWebSearchFields; see
  // tests/responses-routed-web-search-fields.test.ts.
  { field: "external_web_access", toolTypes: new Set(["web_search", "web_search_preview"]), capabilityGated: true },
  // Deferred-discovery marker. `activateDeferredTool` clears it only for tools a `tool_search_output`
  // already loaded, so a still-deferred declaration — including one promoted out of a namespace
  // group — otherwise reaches the wire carrying it.
  { field: "defer_loading" },
];

function stripCanonicalOnlyToolFields(body: unknown, includeCapabilityGated: boolean): unknown {
  if (!isPlainObject(body)) return body;

  const rewriteTools = (tools: unknown[]): unknown[] => {
    let changed = false;
    const rewritten = tools.map(tool => {
      if (!isPlainObject(tool)) return tool;
      let next = tool;
      for (const { field, toolTypes, capabilityGated } of CANONICAL_ONLY_TOOL_FIELDS) {
        if (capabilityGated && !includeCapabilityGated) continue;
        if (!Object.hasOwn(next, field)) continue;
        if (toolTypes && (typeof next.type !== "string" || !toolTypes.has(next.type))) continue;
        const { [field]: _private, ...rest } = next;
        next = rest;
      }
      if (next === tool) return tool;
      changed = true;
      return next;
    });
    return changed ? rewritten : tools;
  };

  let rewrittenBody = body;
  if (Array.isArray(body.tools)) {
    const tools = rewriteTools(body.tools);
    if (tools !== body.tools) rewrittenBody = { ...rewrittenBody, tools };
  }
  if (!Array.isArray(body.input)) return rewrittenBody;

  let input: unknown[] | undefined;
  for (let index = 0; index < body.input.length; index += 1) {
    const item = body.input[index];
    if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) continue;
    const tools = rewriteTools(item.tools);
    if (tools === item.tools) continue;
    input ??= [...body.input];
    input[index] = { ...item, tools };
  }
  return input ? { ...rewrittenBody, input } : rewrittenBody;
}

/**
 * When `store` is false, the upstream API does not persist response items. Any item ID
 * forwarded in `input` is then interpreted as a reference to a stored item that does not
 * exist, producing a 404. Strip all item IDs in this case — `call_id` pairing is unaffected.
 * Matches codex-rs behavior (core/src/client.rs:918-925).
 */
function stripItemIdsWhenUnstored(body: unknown): unknown {
  if (!isPlainObject(body) || body.store !== false) return body;
  if (!Array.isArray(body.input)) return body;

  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || !("id" in item)) return item;
    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });

  return changed ? { ...body, input } : body;
}

/**
 * Normalize replayed compaction items for the destination backend.
 *
 * A compaction item carries an `encrypted_content` blob the client replays verbatim on every later
 * turn, and only the backend that minted it can decode it. Proxy-minted `ocx1:` envelopes are
 * transparent base64 rather than encryption, so no upstream can read them and they always become
 * plain user messages. Native blobs have multiple possible minters, so a destination's ability to
 * decode its own blobs does not make a blob from a previous serving identity portable. On a known
 * identity mismatch the blob degrades to the same note the bridged parser uses, even when the
 * destination normally accepts native blobs. Without a known mismatch, the destination capability
 * keeps the existing behavior.
 *
 * A bare `context_compaction` marker carries no blob and is forwarded untouched.
 */
function scrubOcxCompactionItems(
  body: unknown,
  destinationDecodesNativeBlob: boolean,
  threadServingIdentityChanged: boolean,
): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || !isCompactionItemType(item.type)) return item;
    const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
    if (encrypted === undefined) return item;
    if (
      decodeCompactionSummary(encrypted) === null
      && destinationDecodesNativeBlob
      && !threadServingIdentityChanged
    ) return item;
    changed = true;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: compactionItemToText(encrypted) }],
    };
  });

  return changed ? { ...body, input } : body;
}

/**
 * Strip unsupported `reasoning` sub-parameters for native slugs that reject them (e.g. Spark).
 * codex-rs injects `reasoning.context` and `reasoning.summary` based on catalog flags; Spark's
 * backend rejects both. The catalog fix prevents `use_responses_lite` from being set, but this
 * is a defense-in-depth guard so stale on-disk catalogs don't break until the user runs `ocx sync`.
 */
function stripUnsupportedReasoningParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const model = typeof body.model === "string" ? body.model : "";
  if (!model.includes("codex-spark")) return body;
  if (!isPlainObject(body.reasoning)) return body;
  const reasoning = body.reasoning as Record<string, unknown>;
  // Spark supports reasoning.effort but rejects context, summary, and generate_summary.
  const { context: _ctx, summary: _sum, generate_summary: _gs, ...rest } = reasoning;
  if (_ctx === undefined && _sum === undefined && _gs === undefined) return body;
  return { ...body, reasoning: Object.keys(rest).length > 0 ? rest : undefined };
}

/**
 * GPT-5.6 replaced the legacy 24-hour retention field with `prompt_cache_options.ttl`, and the
 * ChatGPT backend 400s the whole request when the retired field is present (issue #2092).
 *
 * The retired field is NOT translated to the replacement: 5.6 carries a different TTL contract,
 * and implicit caching still applies when the caller sent no replacement options. Inventing a
 * value here would silently change a caching decision the caller never made.
 *
 * Deliberately narrow on both axes, because a wider strip is a behavior change rather than a fix:
 * only the gpt-5.6 family (an older model may still honor the field), and only on the canonical
 * ChatGPT backend, which is the deployment that rejects it. Matching is exact-or-dashed-prefix so
 * a future `gpt-5.60` is not swept up by a bare `startsWith`.
 */
function stripDeprecatedPromptCacheRetention(body: unknown, modelId: unknown): unknown {
  if (!isPlainObject(body)) return body;
  if (typeof modelId !== "string") return body;
  if (modelId !== "gpt-5.6" && !modelId.startsWith("gpt-5.6-")) return body;
  if (!Object.hasOwn(body, "prompt_cache_retention")) return body;
  const { prompt_cache_retention: _retention, ...rest } = body;
  return rest;
}

/**
 * A false model capability prevents Codex from emitting summary fields after the catalog refresh.
 * Strip them here as well so an already-running client with a stale catalog cannot keep sending an
 * upstream-rejected `reasoning_summary_delivery` value (issue #323).
 */
function stripDisabledReasoningSummaries(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): unknown {
  if (modelRecordValue(provider.modelSupportsReasoningSummaries, modelId) !== false || !isPlainObject(body)) {
    return body;
  }

  let changed = false;
  let streamOptions = body.stream_options;
  if (isPlainObject(streamOptions) && Object.hasOwn(streamOptions, "reasoning_summary_delivery")) {
    const { reasoning_summary_delivery: _delivery, ...rest } = streamOptions;
    streamOptions = rest;
    changed = true;
  }

  let reasoning = body.reasoning;
  if (isPlainObject(reasoning)) {
    const { summary: _summary, generate_summary: _generateSummary, ...rest } = reasoning;
    if (_summary !== undefined || _generateSummary !== undefined) {
      reasoning = rest;
      changed = true;
    }
  }

  if (!changed) return body;
  return {
    ...body,
    ...(isPlainObject(streamOptions) && Object.keys(streamOptions).length > 0
      ? { stream_options: streamOptions }
      : { stream_options: undefined }),
    ...(isPlainObject(reasoning) && Object.keys(reasoning).length > 0
      ? { reasoning }
      : { reasoning: undefined }),
  };
}

/**
 * Normalize only the delivery enum Codex already emitted. Do not inject a field into callers that
 * did not request summaries, and leave every unconfigured provider/model byte-for-byte unchanged.
 */
function normalizeConfiguredReasoningSummaryDelivery(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): unknown {
  const delivery = modelRecordValue(provider.modelReasoningSummaryDelivery, modelId);
  if (delivery === undefined || !isPlainObject(body) || !isPlainObject(body.stream_options)) return body;
  if (!Object.hasOwn(body.stream_options, "reasoning_summary_delivery")) return body;
  if (body.stream_options.reasoning_summary_delivery === delivery) return body;
  return {
    ...body,
    stream_options: {
      ...body.stream_options,
      reasoning_summary_delivery: delivery,
    },
  };
}

/**
 * Comprehensive Spark compatibility layer. codex-rs emits five tool types (function,
 * namespace, tool_search, web_search, custom) plus extensions (defer_loading,
 * parallel_tool_calls, tool_search_call/output items). Spark's serving path only
 * supports flat function tools and hosted web_search. This function:
 * - Flattens namespace tools → promotes inner functions to top level
 * - Drops unsupported tool types (tool_search, custom)
 * - Strips defer_loading from function tools
 * - Strips namespace from input items
 * - Drops tool_search_call/tool_search_output input items
 * - Sets parallel_tool_calls to false
 */
function stripSparkCompatibility(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const model = typeof body.model === "string" ? body.model : "";
  if (!model.includes("codex-spark")) return body;

  let changed = false;

  const SPARK_SAFE_TOOL_TYPES = new Set(["function", "web_search", "web_search_preview"]);

  let tools = body.tools;
  if (Array.isArray(tools)) {
    const flattened: unknown[] = [];
    for (const t of tools) {
      if (isPlainObject(t) && t.type === "namespace") {
        changed = true;
        if (Array.isArray(t.tools)) {
          for (const inner of t.tools) flattened.push(inner);
        }
      } else if (isPlainObject(t) && typeof t.type === "string" && !SPARK_SAFE_TOOL_TYPES.has(t.type)) {
        changed = true;
      } else {
        flattened.push(t);
      }
    }
    // Strip defer_loading from promoted/remaining function tools.
    tools = flattened.map(t => {
      if (isPlainObject(t) && t.type === "function" && "defer_loading" in t) {
        const { defer_loading: _, ...rest } = t;
        changed = true;
        return rest;
      }
      return t;
    });
  }

  // Clean input items: strip namespace, drop tool_search_call/tool_search_output.
  const SPARK_UNSUPPORTED_INPUT_TYPES = new Set([
    "tool_search_call", "tool_search_output",
    "custom_tool_call", "custom_tool_call_output",
  ]);
  let input = body.input;
  if (Array.isArray(input)) {
    const cleaned: unknown[] = [];
    for (const item of input) {
      if (isPlainObject(item) && typeof item.type === "string" && SPARK_UNSUPPORTED_INPUT_TYPES.has(item.type)) {
        changed = true;
        continue;
      }
      // Process additional_tools items: filter their inner tools array the same way.
      if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        const innerTools = item.tools as unknown[];
        const filteredInner: unknown[] = [];
        for (const t of innerTools) {
          if (isPlainObject(t) && t.type === "namespace") {
            changed = true;
            if (Array.isArray(t.tools)) {
              for (const fn of t.tools) filteredInner.push(fn);
            }
          } else if (isPlainObject(t) && typeof t.type === "string" && !SPARK_SAFE_TOOL_TYPES.has(t.type)) {
            changed = true; // drop custom, tool_search, etc.
          } else {
            filteredInner.push(t);
          }
        }
        // Strip defer_loading from remaining function tools.
        const cleanedInner = filteredInner.map(t => {
          if (isPlainObject(t) && t.type === "function" && "defer_loading" in t) {
            const { defer_loading: _, ...rest } = t;
            changed = true;
            return rest;
          }
          return t;
        });
        cleaned.push({ ...item, tools: cleanedInner });
        continue;
      }
      if (isPlainObject(item) && "namespace" in item) {
        const { namespace: _, ...rest } = item;
        changed = true;
        cleaned.push(rest);
      } else {
        cleaned.push(item);
      }
    }
    if (changed) input = cleaned;
  }

  // Force parallel_tool_calls off for Spark.
  const extraOverrides: Record<string, unknown> = {};
  if (body.parallel_tool_calls === true) { extraOverrides.parallel_tool_calls = false; changed = true; }

  return changed
    ? { ...body, ...(tools !== body.tools ? { tools } : {}), ...(input !== body.input ? { input } : {}), ...extraOverrides }
    : body;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeFunctionToolSchema(tool: unknown): unknown {
  if (!isPlainObject(tool) || tool.type !== "function") return tool;
  if (isPlainObject(tool.parameters) && tool.parameters.type === "object") return tool;
  return {
    ...tool,
    parameters: { ...(isPlainObject(tool.parameters) ? tool.parameters : {}), type: "object" },
  };
}

function normalizeToolSchemas(body: unknown): unknown {
  if (!isPlainObject(body)) return body;

  const normalizeTools = (tools: unknown[]): unknown[] => {
    let changed = false;
    const normalized = tools.map((tool) => {
      const fixed = normalizeFunctionToolSchema(tool);
      if (fixed !== tool) changed = true;
      return fixed;
    });
    return changed ? normalized : tools;
  };

  let normalizedBody = body;
  if (Array.isArray(body.tools)) {
    const tools = normalizeTools(body.tools);
    if (tools !== body.tools) normalizedBody = { ...normalizedBody, tools };
  }
  if (Array.isArray(normalizedBody.input)) {
    let inputChanged = false;
    const input = normalizedBody.input.map((item) => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const tools = normalizeTools(item.tools);
      if (tools === item.tools) return item;
      inputChanged = true;
      return { ...item, tools };
    });
    if (inputChanged) normalizedBody = { ...normalizedBody, input };
  }
  return normalizedBody;
}

function activateDeferredTool(tool: Record<string, unknown>): Record<string, unknown> {
  const { defer_loading: _, ...activeTool } = tool;
  if (tool.type !== "namespace" || !Array.isArray(tool.tools)) return activeTool;
  return {
    ...activeTool,
    tools: tool.tools.map(inner => isPlainObject(inner) ? activateDeferredTool(inner) : inner),
  };
}

function mergeLoadedTools(declaredTools: unknown[], loadedTools: unknown[]): unknown[] {
  const merged = [...declaredTools];
  let changed = false;

  for (const candidate of loadedTools) {
    if (!isPlainObject(candidate) || typeof candidate.name !== "string") continue;
    const loaded = activateDeferredTool(candidate);
    if (loaded.type === "namespace" && Array.isArray(loaded.tools)) {
      const namespaceIndex = merged.findIndex(tool =>
        isPlainObject(tool) && tool.type === "namespace" && tool.name === loaded.name
      );
      if (namespaceIndex < 0) {
        merged.push(loaded);
        changed = true;
        continue;
      }

      const namespace = merged[namespaceIndex];
      if (!isPlainObject(namespace)) continue;
      const namespaceTools = Array.isArray(namespace.tools) ? namespace.tools : [];
      const nextNamespaceTools = [...namespaceTools];
      let namespaceChanged = "defer_loading" in namespace;
      for (const tool of loaded.tools) {
        if (!isPlainObject(tool) || typeof tool.name !== "string") continue;
        const declaredIndex = nextNamespaceTools.findIndex(declared =>
          isPlainObject(declared) && declared.name === tool.name
        );
        if (declaredIndex < 0) {
          nextNamespaceTools.push(tool);
          namespaceChanged = true;
          continue;
        }
        const declared = nextNamespaceTools[declaredIndex];
        if (isPlainObject(declared) && "defer_loading" in declared) {
          nextNamespaceTools[declaredIndex] = activateDeferredTool(declared);
          namespaceChanged = true;
        }
      }
      if (!namespaceChanged) continue;
      const { defer_loading: _, ...activeNamespace } = namespace;
      merged[namespaceIndex] = { ...activeNamespace, tools: nextNamespaceTools };
      changed = true;
      continue;
    }

    const declaredIndex = merged.findIndex(tool =>
      isPlainObject(tool) && tool.type !== "namespace" && tool.name === loaded.name
    );
    if (declaredIndex < 0) {
      merged.push(loaded);
      changed = true;
    } else {
      const declared = merged[declaredIndex];
      if (isPlainObject(declared) && "defer_loading" in declared) {
        merged[declaredIndex] = activateDeferredTool(declared);
        changed = true;
      }
    }
  }

  return changed ? merged : declaredTools;
}

/**
 * Client-executed tool search only changes Codex's parsed tool context. Routed passthrough keeps
 * serializing the raw request, so activate those returned definitions for upstreams that do not
 * implement the native deferred-loading handshake themselves.
 */
function promoteClientLoadedTools(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  const loadedTools = body.input.flatMap(item =>
    isPlainObject(item) && item.type === "tool_search_output" && Array.isArray(item.tools)
      ? item.tools
      : []
  );
  if (loadedTools.length === 0) return body;

  if (Array.isArray(body.tools)) {
    const tools = mergeLoadedTools(body.tools, loadedTools);
    return tools === body.tools ? body : { ...body, tools };
  }

  const additionalToolsIndex = body.input.findIndex(item =>
    isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)
  );
  if (additionalToolsIndex < 0) return { ...body, tools: mergeLoadedTools([], loadedTools) };

  const additionalTools = body.input[additionalToolsIndex];
  if (!isPlainObject(additionalTools) || !Array.isArray(additionalTools.tools)) return body;
  const tools = mergeLoadedTools(additionalTools.tools, loadedTools);
  if (tools === additionalTools.tools) return body;
  const input = [...body.input];
  input[additionalToolsIndex] = { ...additionalTools, tools };
  return { ...body, input };
}

const MAX_RESPONSES_CALL_ID_LENGTH = 64;
const REPAIRED_CALL_ID_PREFIX = "call_ocx_";
const REPAIRED_CALL_ID_DIGEST_LENGTH = MAX_RESPONSES_CALL_ID_LENGTH - REPAIRED_CALL_ID_PREFIX.length;

/**
 * The ChatGPT Responses backend rejects input `call_id` values longer than 64 characters. Codex
 * sidechat/fork replay can namespace call ids from routed providers past that limit. Forward mode
 * already sends explicit replay input without `previous_response_id`, so it is safe to replace each
 * oversized id and every matching call/output occurrence with one deterministic request-local alias.
 * Raw API-key continuations are intentionally excluded because an output-only continuation may
 * reference a call stored upstream under the original id. Proxy-expanded API-key replays are
 * explicit and stateless here, so they are safe to repair too.
 */
function repairOversizedReplayCallIds(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  const occupied = new Set<string>();
  for (const item of body.input) {
    if (!isPlainObject(item) || typeof item.call_id !== "string") continue;
    if (item.call_id.length <= MAX_RESPONSES_CALL_ID_LENGTH) occupied.add(item.call_id);
  }

  const aliases = new Map<string, string>();
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || typeof item.call_id !== "string") return item;
    const original = item.call_id;
    if (original.length <= MAX_RESPONSES_CALL_ID_LENGTH) return item;

    let alias = aliases.get(original);
    if (!alias) {
      let salt = 0;
      do {
        const hashInput = salt === 0 ? original : `${original}\0${salt}`;
        const digest = createHash("sha256").update(hashInput).digest("hex");
        alias = `${REPAIRED_CALL_ID_PREFIX}${digest.slice(0, REPAIRED_CALL_ID_DIGEST_LENGTH)}`;
        salt += 1;
      } while (occupied.has(alias));
      aliases.set(original, alias);
      occupied.add(alias);
    }

    changed = true;
    return { ...item, call_id: alias };
  });

  return changed ? { ...body, input } : body;
}

/** Flatten a Responses tool-output `output` value (string or content-part array) to plain text. */
function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? "");
  return output.map(part => {
    if (!isPlainObject(part)) return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "refusal" && typeof part.refusal === "string") return `[refusal] ${part.refusal}`;
    return "";
  }).filter(Boolean).join("\n");
}

/**
 * Repair a forward-mode input array whose continuation context was lost. When the replay
 * expansion misses (proxy restart, unrecorded prior turn), previous_response_id is stripped
 * (the ChatGPT backend rejects it), so the delta may carry items that reference now-absent
 * prior items and 400 upstream:
 * - `function_call`/`local_shell_call`/`custom_tool_call` without their paired output item
 *   ("No tool output found for tool call <call_id>"). A stateless upstream cannot resolve
 *   the pair from its own storage, so a placeholder output is synthesized to keep the
 *   turn continuable without pretending the result was real. Synthetic outputs are
 *   emitted after the complete parallel call batch, in call order alongside any real
 *   outputs, so the adjacency normalizer can still recognize the batch as one
 *   reasoning-bearing assistant turn (#1477). Gated on
 *   `synthesizeMissingCallOutputs` (stateless AND non-forward wires); forward replay keeps
 *   fail-closed behavior.
 * - `function_call_output`/`custom_tool_call_output` without their paired call item
 *   ("No tool call found for function call output with call_id ..."). Converted to user
 *   messages so the result text survives. `function_call_output` also pairs with
 *   `local_shell_call` (codex-rs emits shell outputs as function_call_output).
 * - `reasoning` items ("Item 'rs_*' ... was provided without its required following item").
 *   Dropped, but only when `dropReasoning` (unexpanded miss): on a replay hit the prior
 *   reasoning chain is intact and must be preserved.
 * Runs on every forward request; with intact pairs it returns the original reference.
 */
/**
 * Backfill `queries` on a replayed single-query `web_search_call`.
 *
 * `webSearchAction()` in the bridge now emits both keys, but that only helps items
 * created after the fix. A conversation that already recorded
 * `{type:"search", query:"..."}` replays that stored item on every subsequent turn, and
 * DeepSeek's native Responses parser requires `queries` — so upgrading alone leaves
 * those threads permanently 400ing with `missing field 'queries'` (#930).
 *
 * Runs on every Responses request, on both `input` items and the `action` nested inside
 * them. Returns the original reference when nothing needs repair, so the common path
 * allocates nothing.
 */
function backfillWebSearchQueries(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || item.type !== "web_search_call") return item;
    const action = item.action;
    if (!isPlainObject(action) || action.type !== "search") return item;
    if (typeof action.query !== "string" || Array.isArray(action.queries)) return item;
    changed = true;
    return { ...item, action: { ...action, queries: [action.query] } };
  });
  return changed ? { ...body, input } : body;
}

function repairOrphanedInputItems(body: unknown, dropReasoning: boolean, synthesizeMissingCallOutputs = false): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const input = body.input;

  const functionCallIds = new Set<string>();
  const customCallIds = new Set<string>();
  const functionOutputIds = new Set<string>();
  const customOutputIds = new Set<string>();
  for (const item of input) {
    if (!isPlainObject(item) || typeof item.call_id !== "string") continue;
    if (item.type === "function_call" || item.type === "local_shell_call") functionCallIds.add(item.call_id);
    else if (item.type === "custom_tool_call") customCallIds.add(item.call_id);
    else if (item.type === "function_call_output") functionOutputIds.add(item.call_id);
    else if (item.type === "custom_tool_call_output") customOutputIds.add(item.call_id);
  }

  let changed = false;
  const repaired: unknown[] = [];
  const syntheticKeys = new Set<string>();
  const pendingSyntheticOutputs: unknown[] = [];
  const flushPendingSyntheticOutputs = (): void => {
    if (pendingSyntheticOutputs.length === 0) return;
    repaired.push(...pendingSyntheticOutputs);
    pendingSyntheticOutputs.length = 0;
  };
  for (const item of input) {
    if (!isPlainObject(item)) { flushPendingSyntheticOutputs(); repaired.push(item); continue; }
    if (dropReasoning && item.type === "reasoning") { changed = true; continue; }
    const isFnOutput = item.type === "function_call_output";
    const isCustomOutput = item.type === "custom_tool_call_output";
    if (isFnOutput || isCustomOutput) {
      flushPendingSyntheticOutputs();
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const paired = isFnOutput ? functionCallIds.has(callId) : customCallIds.has(callId);
      if (!paired) {
        changed = true;
        repaired.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `[tool output for ${callId || "unknown call"}]\n${toolOutputText(item.output)}` }],
        });
        continue;
      }
    }
    const isFnCall = item.type === "function_call" || item.type === "local_shell_call";
    const isCustomCall = item.type === "custom_tool_call";
    if (isFnCall || isCustomCall) {
      repaired.push(item);
      if (synthesizeMissingCallOutputs) {
        const callId = typeof item.call_id === "string" ? item.call_id : "";
        const hasOutput = isFnCall ? functionOutputIds.has(callId) : customOutputIds.has(callId);
        if (!hasOutput && callId) {
          changed = true;
          const name = typeof item.name === "string" && item.name.length > 0 ? item.name : callId;
          const text = `[ocx] no tool result was recorded for "${name}"; execution status unknown — do not treat this as success, failure, or user-provided input.`;
          syntheticKeys.add(`${isFnCall ? "function" : "custom"}:${callId}`);
          pendingSyntheticOutputs.push(isFnCall
            ? { type: "function_call_output", call_id: callId, output: text }
            : { type: "custom_tool_call_output", call_id: callId, output: text });
        }
      }
      continue;
    }
    flushPendingSyntheticOutputs();
    repaired.push(item);
  }
  flushPendingSyntheticOutputs();

  const callKeyOf = (item: unknown): string | null => {
    if (!isPlainObject(item) || typeof item.call_id !== "string") return null;
    if (item.type === "function_call" || item.type === "local_shell_call") return `function:${item.call_id}`;
    if (item.type === "custom_tool_call") return `custom:${item.call_id}`;
    return null;
  };
  const outputKeyOf = (item: unknown): string | null => {
    if (!isPlainObject(item) || typeof item.call_id !== "string") return null;
    if (item.type === "function_call_output") return `function:${item.call_id}`;
    if (item.type === "custom_tool_call_output") return `custom:${item.call_id}`;
    return null;
  };
  const reorderBatchOutputs = (items: unknown[]): unknown[] => {
    const ordered: unknown[] = [];
    const claimedOutputIndexes = new Set<number>();
    const outputIndexesByKey = new Map<string, { indexes: number[]; offset: number }>();
    for (let outputIndex = 0; outputIndex < items.length; outputIndex += 1) {
      const outputKey = outputKeyOf(items[outputIndex]);
      if (outputKey === null) continue;
      const bucket = outputIndexesByKey.get(outputKey);
      if (bucket) bucket.indexes.push(outputIndex);
      else outputIndexesByKey.set(outputKey, { indexes: [outputIndex], offset: 0 });
    }
    let index = 0;
    while (index < items.length) {
      if (claimedOutputIndexes.has(index)) { index += 1; continue; }
      const key = callKeyOf(items[index]);
      if (key === null) { ordered.push(items[index]); index += 1; continue; }
      const batch: unknown[] = [];
      const batchKeys: string[] = [];
      let cursor = index;
      while (cursor < items.length) {
        const nextKey = callKeyOf(items[cursor]);
        if (nextKey === null) break;
        batch.push(items[cursor]);
        batchKeys.push(nextKey);
        cursor += 1;
      }
      const hasSynthetic = batchKeys.some(batchKey => syntheticKeys.has(batchKey));
      if (!hasSynthetic) {
        ordered.push(...batch);
        index = cursor;
        continue;
      }
      const batchOutputs: unknown[] = [];
      for (const batchKey of batchKeys) {
        const bucket = outputIndexesByKey.get(batchKey);
        if (!bucket) continue;
        while (bucket.offset < bucket.indexes.length && bucket.indexes[bucket.offset]! < cursor) {
          bucket.offset += 1;
        }
        while (bucket.offset < bucket.indexes.length) {
          const outputIndex = bucket.indexes[bucket.offset]!;
          bucket.offset += 1;
          if (claimedOutputIndexes.has(outputIndex)) continue;
          claimedOutputIndexes.add(outputIndex);
          batchOutputs.push(items[outputIndex]);
          break;
        }
      }
      ordered.push(...batch, ...batchOutputs);
      index = cursor;
    }
    return ordered;
  };

  return changed ? { ...body, input: reorderBatchOutputs(repaired) } : body;
}

/**
 * Make unambiguous Responses tool batches contiguous for upstream parsers that require it.
 *
 * [Decision Log]
 * - 목적과 의도: Keep Codex hook-injected developer context without splitting a parallel tool-call turn away from its reasoning or making a strict upstream reject matching results.
 * - 기존 구현 및 제약 조건: The orphan repair verifies only pair presence, while the original pair-by-pair reorder turned `reasoning, call A, call B, output A, output B` into two assistant turns and made DeepSeek reject call B for missing reasoning (#1477).
 * - 검토한 주요 대안: Disable parallel calls (DeepSeek always enables them); duplicate reasoning per call; reorder each pair; or normalize the complete unambiguous call batch.
 * - 선택한 방식: Treat calls emitted before the first matched result as one batch, emit all calls followed by their matched outputs, and preserve intervening non-tool items immediately after the batch.
 * - 다른 대안 대신 이 방식을 선택한 이유: Batch normalization matches the Responses parallel-call shape without fabricating reasoning, while the provider gate and unique-pair requirement keep the blast radius narrow.
 * - 장점, 단점 및 영향: DeepSeek keeps one reasoning-bearing assistant turn for parallel calls and still accepts hook-interleaved single calls; tolerant providers stay byte/order equivalent, and duplicate, missing, or backwards call/result pairs are not guessed.
 */
function normalizeResponsesToolResultAdjacency(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const input = body.input;
  const calls = new Map<string, number[]>();
  const outputs = new Map<string, number[]>();

  const appendIndex = (map: Map<string, number[]>, key: string, index: number): void => {
    const existing = map.get(key);
    if (existing) existing.push(index);
    else map.set(key, [index]);
  };

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!isPlainObject(item) || typeof item.call_id !== "string" || item.call_id.length === 0) continue;
    if (item.type === "function_call" || item.type === "local_shell_call") {
      appendIndex(calls, `function:${item.call_id}`, index);
    } else if (item.type === "custom_tool_call") {
      appendIndex(calls, `custom:${item.call_id}`, index);
    } else if (item.type === "function_call_output") {
      appendIndex(outputs, `function:${item.call_id}`, index);
    } else if (item.type === "custom_tool_call_output") {
      appendIndex(outputs, `custom:${item.call_id}`, index);
    }
  }

  const pairs: Array<{ callIndex: number; outputIndex: number }> = [];
  for (const [key, callIndices] of calls) {
    const outputIndices = outputs.get(key);
    if (!outputIndices) return body;
    if (callIndices.length !== 1 || outputIndices.length !== 1) return body;
    const callIndex = callIndices[0]!;
    const outputIndex = outputIndices[0]!;
    if (outputIndex <= callIndex) return body;
    pairs.push({ callIndex, outputIndex });
  }
  // Reject any collected output that lacks exactly one matching call. A lone or
  // duplicated output is ambiguous, and normalizing on top of it could sever a
  // result from the reasoning-bearing call turn it belongs to.
  for (const [key, outputIndices] of outputs) {
    const callIndices = calls.get(key);
    if (!callIndices || callIndices.length !== 1 || outputIndices.length !== 1) return body;
  }
  pairs.sort((left, right) => left.callIndex - right.callIndex);

  const movedIndices = new Set<number>();
  const batchAt = new Map<number, unknown[]>();
  for (let cursor = 0; cursor < pairs.length;) {
    const group = [pairs[cursor]!];
    let firstOutputIndex = pairs[cursor]!.outputIndex;
    let next = cursor + 1;
    while (next < pairs.length && pairs[next]!.callIndex < firstOutputIndex) {
      group.push(pairs[next]!);
      firstOutputIndex = Math.min(firstOutputIndex, pairs[next]!.outputIndex);
      next += 1;
    }

    // Within one reasoning turn the outputs must appear in the same order as their
    // calls. If they are reversed, normalizing would fabricate a new output order;
    // leave the ambiguous history untouched instead.
    for (let groupIndex = 1; groupIndex < group.length; groupIndex += 1) {
      if (group[groupIndex]!.outputIndex < group[groupIndex - 1]!.outputIndex) return body;
    }

    const batch = [
      ...group.map(pair => input[pair.callIndex]),
      ...group.map(pair => input[pair.outputIndex]),
    ];
    const anchor = group[0]!.callIndex;
    const alreadyContiguous = batch.every((item, offset) => input[anchor + offset] === item);
    if (!alreadyContiguous) {
      batchAt.set(anchor, batch);
      for (const pair of group) {
        movedIndices.add(pair.callIndex);
        movedIndices.add(pair.outputIndex);
      }
    }
    cursor = next;
  }
  if (batchAt.size === 0) return body;

  const normalized: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const batch = batchAt.get(index);
    if (batch) normalized.push(...batch);
    if (!movedIndices.has(index)) normalized.push(input[index]);
  }
  return { ...body, input: normalized };
}

/**
 * Remove `previous_response_id` before forwarding. Two triggers:
 * - the proxy expanded the request into a full input replay (the id is now redundant), or
 * - the target is the ChatGPT backend (`authMode: "forward"`), whose Codex REST endpoint
 *   categorically rejects the parameter with `{"detail":"Unsupported parameter:
 *   previous_response_id"}` (strict allowlist; it also rejects `metadata` and
 *   `max_output_tokens`). Codex only sends the id on WS turns, and ocx converts those to
 *   internal HTTP requests, so forwarding it upstream is a guaranteed 400 — stripping is
 *   strictly better even when the local replay state missed. API-key mode keeps the field on
 *   unexpanded requests: the platform `/v1/responses` supports real server-side storage.
 */
function stripPreviousResponseId(body: unknown, strip: boolean): unknown {
  if (!strip || !isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, "previous_response_id")) return body;
  const { previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

/** Apply the settled tier only to a fresh outbound object; `_rawBody` remains caller-owned. */
function applyTierDecisionToResponsesBody(body: unknown, decision: TierDecision | undefined): unknown {
  if (!decision || decision.kind === "forward-caller" || !isPlainObject(body)) return body;
  const next: Record<string, unknown> = { ...body };
  if (decision.kind === "set") next.service_tier = decision.value;
  else delete next.service_tier;
  return next;
}

/**
 * Drop request parameters a stateless Responses upstream cannot implement, and pin
 * `store` false.
 *
 * `previous_response_id` is listed here as well as in `stripPreviousResponseId`
 * because that helper's strip is conditional on replay expansion, and it keeps the
 * field for API-key providers on the premise that the platform offers real
 * server-side storage. DeepSeek documents the opposite: "the API is stateless:
 * responses and conversations are not stored on the server", so the field can never
 * be honoured regardless of expansion state.
 *
 * `prompt` is a reference to a server-stored prompt template — the most stateful
 * field in the accepted schema.
 *
 * `service_tier` is deliberately NOT dropped: the final TierDecision is applied to a
 * detached outbound body before this sanitizer chain, and silently deleting a configured knob is
 * worse than forwarding a parameter the upstream ignores.
 *
 * MUST run before the composed sanitize chain below: `stripItemIdsWhenUnstored` keys
 * off `store === false`, and a stateless upstream cannot resolve a stored item id.
 * Returns a copy, so `parsed._rawBody` keeps the client's original `store` value and
 * the local replay cache still records the turn.
 */
function stripStatefulResponsesParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const drop = ["previous_response_id", "conversation", "background", "metadata", "prompt"] as const;
  const present = drop.some(key => Object.prototype.hasOwnProperty.call(body, key));
  if (!present && body.store === false) return body;
  const next: Record<string, unknown> = { ...body };
  for (const key of drop) delete next[key];
  next.store = false;
  return next;
}

/**
 * Remove top-level parameters the ChatGPT backend (`authMode: "forward"`) rejects
 * with `{"detail":"Unsupported parameter: …"}` (strict allowlist). Codex CLI never
 * sends these — it controls output length via `reasoning.effort` — but third-party
 * Responses API clients (GJC, SDK wrappers) include `max_output_tokens` per the
 * public spec. `metadata` is likewise absent from the allowlist. No-op when the
 * body carries neither field, keeping the common Codex path allocation-free.
 */
function stripUnsupportedForwardParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const hasMot = Object.prototype.hasOwnProperty.call(body, "max_output_tokens");
  const hasMeta = Object.prototype.hasOwnProperty.call(body, "metadata");
  if (!hasMot && !hasMeta) return body;
  const { max_output_tokens: _mot, metadata: _meta, ...rest } = body;
  return rest;
}

const IMAGE_GEN_NAMESPACE = "image_gen";
const HOSTED_IMAGE_GENERATION_TOOL = "image_generation";
const IMAGE_GEN_DOTTED_PREFIX = `${IMAGE_GEN_NAMESPACE}.`;
const IMAGE_GEN_WIRE_PREFIX = `${IMAGE_GEN_NAMESPACE}__`;

/** Remove a supported client prefix before constructing the canonical image-gen wire alias. */
function imageGenLocalName(name: string): string {
  if (name.startsWith(IMAGE_GEN_DOTTED_PREFIX)) return name.slice(IMAGE_GEN_DOTTED_PREFIX.length);
  if (name.startsWith(IMAGE_GEN_WIRE_PREFIX)) return name.slice(IMAGE_GEN_WIRE_PREFIX.length);
  return name;
}

/** Build the flat public-Responses name used only on the upstream wire. */
function imageGenWireName(name: string): string {
  return namespacedToolName(IMAGE_GEN_NAMESPACE, imageGenLocalName(name));
}

/** Match client image-gen declarations across namespace, legacy dotted, and canonical wire forms. */
function isImageGenClientName(name: string): boolean {
  return name === IMAGE_GEN_NAMESPACE
    || name.startsWith(IMAGE_GEN_DOTTED_PREFIX)
    || name.startsWith(IMAGE_GEN_WIRE_PREFIX);
}

/** Identify declarations that should activate image-gen request normalization. */
function declaresImageGenClientTool(tool: unknown): boolean {
  if (!isPlainObject(tool) || typeof tool.name !== "string") return false;
  if (tool.type === "namespace") return tool.name === IMAGE_GEN_NAMESPACE;
  return isImageGenClientName(tool.name);
}

/** Rewrite client image-gen selectors to the hosted tool without widening caller restrictions. */
function preferHostedImageGenToolChoice(toolChoice: unknown): unknown {
  if (!isPlainObject(toolChoice)) return toolChoice;
  if ((toolChoice.type === "function" || toolChoice.type === "custom") && typeof toolChoice.name === "string") {
    return isImageGenClientName(toolChoice.name) ? { type: HOSTED_IMAGE_GENERATION_TOOL } : toolChoice;
  }
  if (toolChoice.type !== "allowed_tools" || !Array.isArray(toolChoice.tools)) return toolChoice;
  const hasHostedImageTool = toolChoice.tools.some(tool => isPlainObject(tool) && tool.type === HOSTED_IMAGE_GENERATION_TOOL);
  let changed = false;
  let addedHostedImageTool = false;
  const tools: unknown[] = [];
  for (const tool of toolChoice.tools) {
    const isClientImageTool = isPlainObject(tool)
      && (tool.type === "function" || tool.type === "custom")
      && typeof tool.name === "string"
      && isImageGenClientName(tool.name);
    if (!isClientImageTool) {
      tools.push(tool);
      continue;
    }
    changed = true;
    if (!hasHostedImageTool && !addedHostedImageTool) {
      tools.push({ type: HOSTED_IMAGE_GENERATION_TOOL });
      addedHostedImageTool = true;
    }
  }
  return changed ? { ...toolChoice, tools } : toolChoice;
}

/**
 * Some Responses-compatible gateways reserve the hosted image namespace even when the request
 * does not explicitly declare `image_generation`. For an explicitly configured model, remove only
 * colliding client declarations so the gateway's hosted tool can take precedence.
 */
function preferConfiguredHostedTools(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
  selectedModelId?: string,
): unknown {
  // A virtual model's advertised id takes precedence over its resolved wire-model id.
  // Read own properties only: a routed model id of `constructor`/`toString` would
  // otherwise resolve to an inherited Object.prototype function and throw on the
  // membership test below, failing the request before it is dispatched.
  const preferenceMap = provider.modelPreferHostedTools;
  const ownPreference = (key: string | undefined): string[] | undefined => {
    if (!key || !preferenceMap || !Object.prototype.hasOwnProperty.call(preferenceMap, key)) return undefined;
    const entry = preferenceMap[key];
    return Array.isArray(entry) ? entry : undefined;
  };
  const preferredTools = ownPreference(selectedModelId) ?? ownPreference(modelId);
  if (!preferredTools?.includes(HOSTED_IMAGE_GENERATION_TOOL) || !isPlainObject(body)) return body;

  const stripGroup = (tools: unknown[]): unknown[] => {
    const filtered = tools.filter(tool => !declaresImageGenClientTool(tool));
    return filtered.length === tools.length ? tools : filtered;
  };

  let changed = false;
  let tools = body.tools;
  let strippedTopLevelImageGenTool = false;
  if (Array.isArray(body.tools)) {
    tools = stripGroup(body.tools);
    strippedTopLevelImageGenTool = tools !== body.tools;
    changed ||= strippedTopLevelImageGenTool;
  }

  let input = body.input;
  const strippedAdditionalToolsIndices = new Set<number>();
  if (Array.isArray(body.input)) {
    let nestedChanged = false;
    const mappedInput = body.input.map((item, index) => {
      if (!isPlainObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const nestedTools = stripGroup(item.tools);
      if (nestedTools === item.tools) return item;
      strippedAdditionalToolsIndices.add(index);
      nestedChanged = true;
      return { ...item, tools: nestedTools };
    });
    if (nestedChanged) {
      input = mappedInput;
      changed = true;
    }
  }

  const hasToolChoice = Object.hasOwn(body, "tool_choice");
  const toolChoice = hasToolChoice ? preferHostedImageGenToolChoice(body.tool_choice) : body.tool_choice;
  const toolChoiceChanged = hasToolChoice && toolChoice !== body.tool_choice;
  const hasHostedImageGenTool = (toolGroup: unknown): boolean => Array.isArray(toolGroup)
    && toolGroup.some(tool => isPlainObject(tool) && tool.type === HOSTED_IMAGE_GENERATION_TOOL);
  const hasHostedImageGenDeclaration = hasHostedImageGenTool(tools)
    || (Array.isArray(input) && input.some(item => isPlainObject(item)
      && item.type === "additional_tools"
      && hasHostedImageGenTool(item.tools)));
  if ((strippedTopLevelImageGenTool || strippedAdditionalToolsIndices.size > 0) && !hasHostedImageGenDeclaration) {
    if (strippedTopLevelImageGenTool && Array.isArray(tools)) {
      tools = [...tools, { type: HOSTED_IMAGE_GENERATION_TOOL }];
    } else if (strippedAdditionalToolsIndices.size > 0 && Array.isArray(input)) {
      // Restore into the FIRST stripped container only. Tool declarations are
      // request-scoped, not container-scoped — the containers are separate carriers for
      // one tool set, so a single hosted declaration covers the request. An earlier
      // revision restored into every stripped container and put `image_generation` on
      // the wire twice; review caught it.
      const firstStripped = Math.min(...strippedAdditionalToolsIndices);
      input = input.map((item, index) => index === firstStripped
        && isPlainObject(item)
        && Array.isArray(item.tools)
        ? { ...item, tools: [...item.tools, { type: HOSTED_IMAGE_GENERATION_TOOL }] }
        : item);
    }
  }
  changed ||= toolChoiceChanged;
  if (!changed) return body;
  const next: Record<string, unknown> = {
    ...body,
    ...(Array.isArray(body.tools) ? { tools } : {}),
    ...(Array.isArray(body.input) ? { input } : {}),
  };
  if (toolChoiceChanged) next.tool_choice = toolChoice;
  return next;
}

/**
 * Lower one complete Codex image-gen namespace to public Responses function tools.
 *
 * The public API reserves the `image_gen` namespace and restricts function names to a flat safe
 * alphabet. `image_gen__<tool>` is therefore an upstream-only alias; client-facing responses are
 * restored to explicit `{ namespace: "image_gen", name: "<tool>" }` calls by the server. Only a
 * non-empty namespace containing named function tools is safe to lower. Malformed, empty, and
 * future namespace shapes stay untouched instead of silently losing client capabilities.
 */
function flattenImageGenNamespace(tool: unknown): Record<string, unknown>[] | undefined {
  if (
    !isPlainObject(tool)
    || tool.type !== "namespace"
    || tool.name !== IMAGE_GEN_NAMESPACE
    || !Array.isArray(tool.tools)
    || tool.tools.length === 0
  ) return undefined;

  for (const innerTool of tool.tools) {
    if (
      !isPlainObject(innerTool)
      || innerTool.type !== "function"
      || typeof innerTool.name !== "string"
      || innerTool.name.length === 0
    ) return undefined;
  }

  return tool.tools.map(innerTool => {
    const functionTool = innerTool as Record<string, unknown> & { name: string };
    return {
      ...functionTool,
      name: imageGenWireName(functionTool.name),
    };
  });
}

/** Convert a legacy dotted function declaration while preserving all other function metadata. */
function normalizeFlatImageGenFunction(tool: unknown): unknown {
  if (
    !isPlainObject(tool)
    || tool.type !== "function"
    || typeof tool.name !== "string"
    || !tool.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)
  ) return tool;
  return { ...tool, name: imageGenWireName(tool.name) };
}

/** Return the image-gen function name used for stable cross-container deduplication. */
function imageGenFunctionName(tool: unknown): string | undefined {
  if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
    return undefined;
  }
  return isImageGenClientName(tool.name) ? tool.name : undefined;
}

/** True only when a declaration can yield a callable upstream-safe image-gen function alias. */
function declaresUsableImageGenAlias(tool: unknown): boolean {
  if (flattenImageGenNamespace(tool)) return true;
  if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
    return false;
  }
  if (tool.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)) {
    return tool.name.length > IMAGE_GEN_DOTTED_PREFIX.length;
  }
  return tool.name.startsWith(IMAGE_GEN_WIRE_PREFIX)
    && tool.name.length > IMAGE_GEN_WIRE_PREFIX.length;
}

/** Collect client tool-choice names and the exact upstream aliases declared for them. */
function imageGenToolChoiceAliases(toolGroups: unknown[][]): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const group of toolGroups) {
    for (const tool of group) {
      const flattened = flattenImageGenNamespace(tool);
      if (flattened) {
        for (const candidate of flattened) {
          const wireName = candidate.name as string;
          aliases.set(`${IMAGE_GEN_DOTTED_PREFIX}${imageGenLocalName(wireName)}`, wireName);
          aliases.set(wireName, wireName);
        }
        continue;
      }
      if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
        continue;
      }
      if (
        tool.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)
        && tool.name.length > IMAGE_GEN_DOTTED_PREFIX.length
      ) {
        aliases.set(tool.name, imageGenWireName(tool.name));
      } else if (
        tool.name.startsWith(IMAGE_GEN_WIRE_PREFIX)
        && tool.name.length > IMAGE_GEN_WIRE_PREFIX.length
      ) {
        aliases.set(tool.name, tool.name);
      }
    }
  }

  return aliases;
}

/** Rewrite function selectors only when their corresponding declaration receives a wire alias. */
function normalizeImageGenToolChoice(
  toolChoice: unknown,
  aliases: ReadonlyMap<string, string>,
): unknown {
  if (!isPlainObject(toolChoice)) return toolChoice;

  if (toolChoice.type === "function" && typeof toolChoice.name === "string") {
    const alias = aliases.get(toolChoice.name);
    return alias && alias !== toolChoice.name ? { ...toolChoice, name: alias } : toolChoice;
  }

  if (toolChoice.type !== "allowed_tools" || !Array.isArray(toolChoice.tools)) return toolChoice;
  let changed = false;
  const tools = toolChoice.tools.map(tool => {
    if (!isPlainObject(tool) || tool.type !== "function" || typeof tool.name !== "string") {
      return tool;
    }
    const alias = aliases.get(tool.name);
    if (!alias || alias === tool.name) return tool;
    changed = true;
    return { ...tool, name: alias };
  });
  return changed ? { ...toolChoice, tools } : toolChoice;
}

/** Identify replayed image-gen calls that require upstream wire encoding. */
function declaresImageGenFunctionCall(item: unknown): boolean {
  if (!isPlainObject(item) || item.type !== "function_call" || typeof item.name !== "string") {
    return false;
  }
  return item.namespace === IMAGE_GEN_NAMESPACE || isImageGenClientName(item.name);
}

/** Encode native or legacy replay calls to the same flat name used by tool declarations. */
function normalizeImageGenFunctionCall(item: unknown): unknown {
  if (!declaresImageGenFunctionCall(item) || !isPlainObject(item) || typeof item.name !== "string") {
    return item;
  }
  if (item.namespace === IMAGE_GEN_NAMESPACE) {
    const { namespace: _namespace, ...rest } = item;
    return { ...rest, name: imageGenWireName(item.name) };
  }
  if (item.name.startsWith(IMAGE_GEN_DOTTED_PREFIX)) {
    return { ...item, name: imageGenWireName(item.name) };
  }
  return item;
}

/**
 * Normalize Codex's private image-gen tool declaration for API-key Responses providers.
 *
 * A complete `image_gen` namespace is flattened to safe `image_gen__<tool>` aliases even when it is
 * the only image tool in the request. Replayed client calls are encoded to the same alias, including
 * legacy dotted calls from older compatibility attempts. When a usable alias replaces a client
 * image-gen declaration, the duplicate hosted `image_generation` entry is removed. Duplicate aliases
 * are resolved in stable container order: top-level tools first, then Responses Lite
 * `additional_tools` entries.
 *
 * This function is called only on the API-key path. ChatGPT forward mode understands the private
 * namespace and must keep it. Copy-on-write preserves the original request reference when no
 * namespace is flattened, hosted tool removed, or duplicate function discarded.
 */
function normalizeImageGenClientTools(body: unknown): unknown {
  if (!isPlainObject(body)) return body;

  const toolGroups = collectResponsesToolGroups(body);
  const hasImageGenClientTool = toolGroups.some(group => group.some(declaresImageGenClientTool))
    || (Array.isArray(body.input) && body.input.some(declaresImageGenFunctionCall));
  if (!hasImageGenClientTool) return body;
  const hasUsableImageGenAlias = toolGroups.some(group => group.some(declaresUsableImageGenAlias));
  const toolChoiceAliases = imageGenToolChoiceAliases(toolGroups);

  const seenFunctionNames = new Set<string>();
  const normalizeGroup = (tools: unknown[]): unknown[] => {
    const normalized: unknown[] = [];
    let groupChanged = false;

    for (const tool of tools) {
      if (
        hasUsableImageGenAlias
        && isPlainObject(tool)
        && tool.type === HOSTED_IMAGE_GENERATION_TOOL
      ) {
        groupChanged = true;
        continue;
      }

      const flattened = flattenImageGenNamespace(tool);
      const candidates = flattened ?? [tool];
      if (flattened) groupChanged = true;

      for (const candidate of candidates) {
        const normalizedCandidate = normalizeFlatImageGenFunction(candidate);
        if (normalizedCandidate !== candidate) groupChanged = true;
        const functionName = imageGenFunctionName(normalizedCandidate);
        if (functionName && seenFunctionNames.has(functionName)) {
          groupChanged = true;
          continue;
        }
        if (functionName) seenFunctionNames.add(functionName);
        normalized.push(normalizedCandidate);
      }
    }

    return groupChanged ? normalized : tools;
  };

  let changed = false;
  let tools = body.tools;
  if (Array.isArray(body.tools)) {
    tools = normalizeGroup(body.tools);
    changed ||= tools !== body.tools;
  }

  let input = body.input;
  if (Array.isArray(body.input)) {
    let nestedChanged = false;
    const mappedInput = body.input.map(item => {
      if (isPlainObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        const nestedTools = normalizeGroup(item.tools);
        if (nestedTools === item.tools) return item;
        nestedChanged = true;
        return { ...item, tools: nestedTools };
      }
      const normalizedCall = normalizeImageGenFunctionCall(item);
      if (normalizedCall !== item) nestedChanged = true;
      return normalizedCall;
    });
    if (nestedChanged) {
      input = mappedInput;
      changed = true;
    }
  }

  const toolChoice = normalizeImageGenToolChoice(body.tool_choice, toolChoiceAliases);
  changed ||= toolChoice !== body.tool_choice;

  if (!changed) return body;
  return {
    ...body,
    ...(Array.isArray(body.tools) ? { tools } : {}),
    ...(Array.isArray(body.input) ? { input } : {}),
    ...(Object.prototype.hasOwnProperty.call(body, "tool_choice") ? { tool_choice: toolChoice } : {}),
  };
}

/**
 * Remove hosted tool entries the target native slug rejects, so the OAuth-passthrough body never
 * carries a tool the upstream model 400s on. No-op (returns the original reference) when nothing
 * matches, keeping the common path allocation-free.
 */
function stripUnsupportedHostedTools(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.tools)) return body;
  const model = typeof body.model === "string" ? body.model : "";
  const tools = body.tools.filter(t => {
    const type = isPlainObject(t) && typeof t.type === "string" ? t.type : undefined;
    return !type || !isHostedToolUnsupportedForModel(model, type);
  });
  return tools.length === body.tools.length ? body : { ...body, tools };
}

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

/** Replace every `input_image` part under a routed-compaction body with a short marker. */
function stripInputImagesDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInputImagesDeep);
  if (!isPlainObject(value)) return value;
  if (value.type === "input_image") {
    return { type: "input_text", text: "[image omitted for compaction]" };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = stripInputImagesDeep(entry);
  return out;
}

/**
 * Rewrite a compaction turn for an upstream that does not speak Codex's private
 * `compaction_trigger` item: drop the trigger and the whole tool surface, and ask
 * for the handoff summary in plain terms instead (#422).
 *
 * The adapter builds from `parsed._rawBody`, so the summarizer prompt that
 * handleResponses() pushed onto `parsed.context` never reaches the wire — it has to
 * be applied here. Images go too: a summary needs no pixels, and a text-only
 * gateway would reject them.
 */
function buildRoutedCompactionBody(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  // `text` goes with the tool fields: the summary must be prose, not schema-constrained JSON.
  const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallel, text: _text, ...rest } = body;
  const input = Array.isArray(body.input) ? body.input : [];
  const kept = input.filter(item => !isPlainObject(item)
    // `additional_tools` is how Codex Desktop's responses-lite shape carries tools;
    // leaving it in would break the no-tools invariant even with `tools` removed.
    || (item.type !== "compaction_trigger" && item.type !== "additional_tools"));
  return {
    ...rest,
    input: [
      ...(stripInputImagesDeep(kept) as unknown[]),
      { type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] },
    ],
  };
}

/** Read the Responses `usage` block, if the gateway sent one. */
function usageFromResponsesPayload(payload: unknown): OcxUsage | undefined {
  if (!isPlainObject(payload) || !isPlainObject(payload.usage)) return undefined;
  const usage = payload.usage;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  if (inputTokens === 0 && outputTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
  };
}

function responsesPayloadText(response: unknown): string {
  if (!isPlainObject(response) || !Array.isArray(response.output)) return "";
  return response.output
    .filter(item => isPlainObject(item) && item.type === "message")
    .flatMap(item => (Array.isArray((item as Record<string, unknown>).content)
      ? (item as { content: unknown[] }).content
      : []))
    .filter(part => isPlainObject(part) && part.type === "output_text")
    .map(part => String((part as { text?: unknown }).text ?? ""))
    .join("");
}

function responsesErrorMessage(payload: unknown): string {
  if (!isPlainObject(payload)) return "upstream compaction failed";
  const err = payload.error;
  if (typeof err === "string") return err;
  if (isPlainObject(err) && typeof err.message === "string") return err.message;
  const incomplete = payload.incomplete_details;
  if (isPlainObject(incomplete) && typeof incomplete.reason === "string") return incomplete.reason;
  return "upstream compaction failed";
}

export function createResponsesPassthroughAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  return {
    name: "openai-responses",
    passthrough: true as const,

    buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      const translatorBudget = incoming.translatorBudget;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let url: string;

      if (provider.authMode === "forward") {
        const mayForwardCallerCredentials = isCanonicalOpenAiForwardProvider(provider);
        // OAuth passthrough: ChatGPT backend path is `${baseUrl}/responses` (no /v1).
        const baseUrl = mayForwardCallerCredentials
          ? CODEX_FORWARD_BASE_URL
          : provider.baseUrl.replace(/\/+$/, "");
        url = `${baseUrl}/responses`;
        if (provider.headers) Object.assign(headers, provider.headers); // static headers first…
        const runtimeProvider = provider as {
          _codexAccountOverride?: { accessToken: string; chatgptAccountId: string };
          _codexAccountRequired?: boolean;
        };
        if (
          mayForwardCallerCredentials
          && runtimeProvider._codexAccountRequired
          && !runtimeProvider._codexAccountOverride
        ) {
          throw new Error("Codex pool account auth is required but unavailable");
        }
        if (mayForwardCallerCredentials) {
          for (const h of FORWARD_HEADERS) {
            const v = incoming?.headers.get(h);
            if (v) headers[h] = v;                                      // …so forwarded auth always wins.
          }
        }
        const override = runtimeProvider._codexAccountOverride;
        if (override && mayForwardCallerCredentials) {
          headers["authorization"] = `Bearer ${override.accessToken}`;
          headers["chatgpt-account-id"] = override.chatgptAccountId;
        }
      } else {
        if (provider.responsesPath === undefined) {
          url = openaiResponsesUrl(provider.baseUrl);
        } else {
          const base = provider.baseUrl.replace(/\/$/, "");
          url = `${base}${provider.responsesPath}`;
        }
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }

      const forward = provider.authMode === "forward";
      let convertedRoutedCustomToolNames: Set<string> | undefined;
      let convertedRoutedToolSearchNames: Set<string> | undefined;
      let convertedRoutedNamespaceToolAliases: Map<string, { namespace: string; name: string }> | undefined;
      const unexpandedMiss = !!parsed.previousResponseId && parsed._previousResponseInputExpanded !== true;
      let outBody = stripPreviousResponseId(
        parsed._rawBody,
        forward || parsed._previousResponseInputExpanded === true,
      );
      // stripPreviousResponseId() intentionally returns its input on a no-op. Detach before the
      // tier write so a force-fast/default decision can never mutate parsed._rawBody.
      outBody = applyTierDecisionToResponsesBody(outBody, parsed.options?.tierDecision);
      const stateless = provider.statelessResponses === true;
      if (stateless) outBody = stripStatefulResponsesParams(outBody);
      // A replay miss can leave a function_call_output whose paired function_call sat
      // in the prefix that was never expanded. A stateless upstream cannot resolve the
      // pair from its own storage either, so it needs the same repair the forward
      // backend gets — dropping previous_response_id is not much use if the body that
      // reaches the wire is unparseable.
      if (forward || stateless) {
        outBody = repairOrphanedInputItems(outBody, unexpandedMiss, stateless && !forward);
      }
      if (provider.requiresAdjacentResponsesToolResults === true) {
        outBody = normalizeResponsesToolResultAdjacency(outBody);
      }
      if (forward) {
        outBody = stripUnsupportedForwardParams(outBody);
        // Only the canonical ChatGPT backend rejects the retired field; a self-hosted or
        // third-party forward gateway may still accept it, so this must not be widened.
        if (isCanonicalOpenAiForwardProvider(provider)) {
          outBody = stripDeprecatedPromptCacheRetention(outBody, parsed.modelId);
        }
      } else {
        outBody = preferConfiguredHostedTools(
          outBody,
          provider,
          parsed.modelId,
          parsed._openAiVirtualSelectedModelId,
        );
        outBody = normalizeImageGenClientTools(outBody);
      }
      if (forward || parsed._previousResponseInputExpanded === true) {
        outBody = repairOversizedReplayCallIds(outBody);
      }
      outBody = stripUnsupportedReasoningSummaryDelivery(outBody, parsed.modelId);
      // Repair stored history from before the bridge emitted both keys: a conversation
      // that already recorded a single-query web_search_call replays it every turn, and
      // a strict parser rejects the whole request over it (#930).
      outBody = backfillWebSearchQueries(outBody);
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        outBody = promoteClientLoadedTools(outBody);
      }
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        const rewritten = rewriteRoutedCustomToolsForUpstream(
          outBody,
          provider.supportsResponsesCustomTools,
        );
        outBody = rewritten.body;
        convertedRoutedCustomToolNames = rewritten.names;
      }
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        // Run after custom-tool lowering so the search compatibility layer can choose a
        // collision-free public function name against the final routed function catalog.
        const rewritten = rewriteRoutedToolSearchForUpstream(outBody);
        outBody = rewritten.body;
        convertedRoutedToolSearchNames = rewritten.names;
      }
      if (!isCanonicalOpenAiForwardProvider(provider)) {
        // Codex 0.147 emits private namespace tool groups, while public/third-party Responses
        // gateways accept only flat tool variants. Run after custom/tool-search lowering so
        // namespace children already carry their final public kind before they are promoted.
        const rewritten = rewriteRoutedNamespaceToolsForUpstream(outBody);
        outBody = rewritten.body;
        convertedRoutedNamespaceToolAliases = rewritten.aliases;
        // Preserve xAI's cached-only fail-closed semantics and image-search mapping before the
        // generic capability fallback removes the private OpenAI fields.
        outBody = normalizeXaiResponsesWebSearch(outBody, provider);
        // xAI and explicitly classified compatible gateways reject these OpenAI web_search
        // extensions. Keep them for OpenAI API-key traffic and unclassified gateways.
        if (provider.supportsOpenAiWebSearchToolFields === false) {
          outBody = stripOpenAiOnlyWebSearchFields(outBody);
        }
        // Last, so promoted namespace children are also cleared of Codex-private fields.
        outBody = stripCanonicalOnlyToolFields(outBody, provider.supportsOpenAiWebSearchToolFields === false);
      }
      // Same predicate as the routedCompaction gate in handleResponses(): an authMode check would
      // let a noncanonical custom forward provider skip this rewrite while the server still routes
      // it as a summarizer turn (#422). The compaction body build removes the tool surface and must
      // therefore be the last routed transform: anything before it may depend on the declarations;
      // anything after it cannot.
      if (parsed._compactionRequest === true && !isCanonicalOpenAiForwardProvider(provider)) {
        outBody = buildRoutedCompactionBody(outBody);
      }
      const threadServingIdentityChanged = parsed._stripReasoningEncryptedContent === true;
      const sanitizedBody = normalizeToolSchemas(stripSparkCompatibility(stripUnsupportedReasoningParams(stripItemIdsWhenUnstored(stripInvalidItemIds(stripUnsupportedHostedTools(sanitizeReasoningInputContent(scrubOcxCompactionItems(
        outBody,
        destinationDecodesNativeCompactionBlob(provider),
        threadServingIdentityChanged,
      ), {
        preserveRawReasoningContent: provider.preserveResponsesReasoningContent === true,
        dropNullContentChannel: !isOpenAiOperatedResponsesDestination(provider),
        stripEncryptedContent: threadServingIdentityChanged,
      })))))));
      const finalBody = stripDisabledReasoningSummaries(
        normalizeConfiguredReasoningSummaryDelivery(sanitizedBody, provider, parsed.modelId),
        provider,
        parsed.modelId,
      );
      const actualServiceTier = isPlainObject(finalBody) && typeof finalBody.service_tier === "string"
        ? finalBody.service_tier
        : null;
      const tierLog = createAdapterTierMetadata(
        parsed.options?.tierObservation,
        parsed.options?.tierDecision,
        actualServiceTier === null ? null : "service-tier",
        actualServiceTier,
      );
      const body = JSON.stringify(finalBody);
      const releaseBodyObservation = translatorBudget.observeExternallyCapped(
        "passthrough_serialization",
        new TextEncoder().encode(body).byteLength,
      );
      return {
        url,
        method: "POST",
        headers,
        body,
        releaseBodyObservation,
        ...(convertedRoutedCustomToolNames ? { convertedRoutedCustomToolNames } : {}),
        ...(convertedRoutedToolSearchNames ? { convertedRoutedToolSearchNames } : {}),
        ...(convertedRoutedNamespaceToolAliases ? { convertedRoutedNamespaceToolAliases } : {}),
        ...(tierLog ? { tierLog } : {}),
      };
    },

    // The passthrough normally relays the upstream stream verbatim and never parses.
    // The exception is a routed compaction turn: the server drives this adapter like
    // an ordinary one so the bridge can build the single compaction item (#422).
    async *parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "passthrough adapter received no response body" };
        return;
      }
      const budgetEncoder = new TextEncoder();
      let deltas = "";
      let doneText = "";
      let snapshot = "";
      let usage: OcxUsage | undefined;
      for await (const event of decodeServerSentEvents(response.body, { translatorBudget: budget })) {
        let payload: unknown;
        try { payload = JSON.parse(event.data); } catch { continue; }
        if (!isPlainObject(payload)) continue;
        switch (payload.type) {
          case "response.output_text.delta":
            if (typeof payload.delta === "string") {
              const next = deltas + payload.delta;
              const previousBytes = budgetEncoder.encode(deltas).byteLength;
              const reservation = budget.reserveTransient(budgetEncoder.encode(next).byteLength, { kind: "retained_collectors" });
              deltas = next;
              reservation.commitRetained();
              budget.releaseRetained(previousBytes, { kind: "retained_collectors" });
            }
            break;
          case "response.output_text.done":
            if (typeof payload.text === "string") {
              const next = doneText + payload.text;
              const previousBytes = budgetEncoder.encode(doneText).byteLength;
              const reservation = budget.reserveTransient(budgetEncoder.encode(next).byteLength, { kind: "retained_collectors" });
              doneText = next;
              reservation.commitRetained();
              budget.releaseRetained(previousBytes, { kind: "retained_collectors" });
            }
            break;
          case "response.failed":
          case "error":
            yield { type: "error", message: responsesErrorMessage(payload.response ?? payload) };
            return;
          case "response.incomplete":
            yield { type: "incomplete", reason: responsesErrorMessage(payload.response ?? payload) };
            return;
          case "response.completed":
            {
              const next = responsesPayloadText(payload.response);
              const previousBytes = budgetEncoder.encode(snapshot).byteLength;
              const reservation = budget.reserveTransient(budgetEncoder.encode(next).byteLength, { kind: "retained_collectors" });
              snapshot = next;
              reservation.commitRetained();
              budget.releaseRetained(previousBytes, { kind: "retained_collectors" });
            }
            usage = usageFromResponsesPayload(payload.response);
            break;
        }
      }
      // Gateways differ in which of these they emit; prefer the authoritative
      // completed snapshot so text is never double-counted.
      const text = snapshot || doneText || deltas;
      if (text) yield { type: "text_delta", text };
      budget.releaseRetained(budgetEncoder.encode(deltas).byteLength + budgetEncoder.encode(doneText).byteLength + budgetEncoder.encode(snapshot).byteLength, { kind: "retained_collectors" });
      yield { type: "done", ...(usage ? { usage } : {}) };
    },

    async parseResponse(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]> {
      let payload: unknown;
      try { payload = await response.json(); } catch {
        return [{ type: "error", message: "malformed upstream compaction response" }];
      }
      budget.chargeRetained(new TextEncoder().encode(JSON.stringify(payload)).byteLength, { kind: "retained_collectors" });
      if (!isPlainObject(payload)) {
        return [{ type: "error", message: "malformed upstream compaction response" }];
      }
      if (payload.error || payload.status === "failed") {
        return [{ type: "error", message: responsesErrorMessage(payload) }];
      }
      if (payload.status === "incomplete") {
        return [{ type: "incomplete", reason: responsesErrorMessage(payload) }];
      }
      const text = responsesPayloadText(payload);
      if (!text) {
        // A completed turn with no usable text cannot become a summary; saying so is
        // better than installing an empty compaction as replacement history.
        return [{ type: "error", message: "upstream compaction returned no summary text" }];
      }
      const usage = usageFromResponsesPayload(payload);
      return [{ type: "text_delta", text }, { type: "done", ...(usage ? { usage } : {}) }];
    },
  };
}
