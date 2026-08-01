import { createHash } from "node:crypto";
import type { IncomingMeta, ProviderAdapter } from "./base";
import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig, type OcxUsage } from "../types";
import { catalogModelSupportsReasoningSummaries } from "../codex/catalog";
import { COMPACT_PROMPT, decodeCompactionSummary, SUMMARY_PREFIX } from "../responses/compaction";
import { collectResponsesToolGroups } from "../responses/tool-groups";
import { decodeServerSentEvents } from "../lib/sse-decoder";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { OCX_REASONING_PREFIX } from "../responses/reasoning-envelope";
import { modelRecordValue } from "../reasoning-effort";
import type { TranslatorBudget } from "../lib/translator-budget";

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

export function sanitizeReasoningInputContent(body: unknown): unknown {
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
    if (!hasRawContent && !hasOcxEnvelope) return item;
    changed = true;
    // Routed models can produce raw `reasoning_text` output items. Codex echoes those in later
    // native GPT requests, but ChatGPT's Responses backend accepts reasoning input only with empty
    // `content`; keep summaries/ids and drop the raw content so native passthrough does not 400.
    const next: Record<string, unknown> = { ...rec, content: [] };
    if (hasOcxEnvelope) delete next.encrypted_content;
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
 * Replace proxy-minted compaction items (`encrypted_content` starting with `ocx1:`) with plain
 * user messages before forwarding to the ChatGPT backend. Our envelope is transparent base64, not
 * OpenAI encryption — the native backend cannot decrypt it and would reject the request. Real
 * OpenAI-encrypted compaction items are forwarded untouched.
 */
function scrubOcxCompactionItems(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item)) return item;
    if (item.type !== "compaction" && item.type !== "compaction_summary" && item.type !== "context_compaction") return item;
    const decoded = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    if (decoded === null) return item;
    changed = true;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${decoded}` }],
    };
  });

  return changed ? { ...body, input } : body;
}

/**
 * Hosted (OpenAI-executed) tool types that specific native slugs reject at request time. Codex
 * attaches these for app skills (e.g. `image_generation` for imagegen) regardless of the target
 * model, and the passthrough path forwards the raw body untouched — so a slug that doesn't support
 * the tool 400s (`Tool 'image_generation' is not supported with gpt-5.3-codex-spark.`). Each entry
 * maps a model-slug matcher to the hosted tool types that must be stripped before forwarding.
 * Extend this when another native slug rejects a hosted tool (e.g. `code_interpreter`).
 */
const UNSUPPORTED_HOSTED_TOOLS: ReadonlyArray<{ match: (model: string) => boolean; tools: ReadonlySet<string> }> = [
  { match: model => model.includes("codex-spark"), tools: new Set(["image_generation", "tool_search"]) },
];

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
 * - `function_call_output`/`custom_tool_call_output` without their paired call item
 *   ("No tool call found for function call output with call_id ..."). Converted to user
 *   messages so the result text survives. `function_call_output` also pairs with
 *   `local_shell_call` (codex-rs emits shell outputs as function_call_output).
 * - `reasoning` items ("Item 'rs_*' ... was provided without its required following item").
 *   Dropped, but only when `dropReasoning` (unexpanded miss): on a replay hit the prior
 *   reasoning chain is intact and must be preserved.
 * Runs on every forward request; with intact pairs it returns the original reference.
 */
function repairOrphanedInputItems(body: unknown, dropReasoning: boolean): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const input = body.input;

  const functionCallIds = new Set<string>();
  const customCallIds = new Set<string>();
  for (const item of input) {
    if (!isPlainObject(item) || typeof item.call_id !== "string") continue;
    if (item.type === "function_call" || item.type === "local_shell_call") functionCallIds.add(item.call_id);
    else if (item.type === "custom_tool_call") customCallIds.add(item.call_id);
  }

  let changed = false;
  const repaired: unknown[] = [];
  for (const item of input) {
    if (!isPlainObject(item)) { repaired.push(item); continue; }
    if (dropReasoning && item.type === "reasoning") { changed = true; continue; }
    const isFnOutput = item.type === "function_call_output";
    const isCustomOutput = item.type === "custom_tool_call_output";
    if (isFnOutput || isCustomOutput) {
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
    repaired.push(item);
  }

  return changed ? { ...body, input: repaired } : body;
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
 * `service_tier` is deliberately NOT dropped: the server writes it for fast mode
 * (`responses/core.ts`), and silently deleting a configured knob inside an adapter is
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
  const unsupported = UNSUPPORTED_HOSTED_TOOLS.filter(e => e.match(model));
  if (unsupported.length === 0) return body;

  const tools = body.tools.filter(t => {
    const type = isPlainObject(t) && typeof t.type === "string" ? t.type : undefined;
    if (!type) return true;
    return !unsupported.some(e => e.tools.has(type));
  });
  return tools.length === body.tools.length ? body : { ...body, tools };
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
  const { tools: _tools, tool_choice: _toolChoice, parallel_tool_calls: _parallel, ...rest } = body;
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
        // OAuth passthrough: ChatGPT backend path is `${baseUrl}/responses` (no /v1).
        url = `${provider.baseUrl}/responses`;
        if (provider.headers) Object.assign(headers, provider.headers); // static headers first…
        const runtimeProvider = provider as {
          _codexAccountOverride?: { accessToken: string; chatgptAccountId: string };
          _codexAccountRequired?: boolean;
        };
        if (runtimeProvider._codexAccountRequired && !runtimeProvider._codexAccountOverride) {
          throw new Error("Codex pool account auth is required but unavailable");
        }
        for (const h of FORWARD_HEADERS) {
          const v = incoming?.headers.get(h);
          if (v) headers[h] = v;                                        // …so forwarded auth always wins.
        }
        const override = runtimeProvider._codexAccountOverride;
        if (override) {
          headers["authorization"] = `Bearer ${override.accessToken}`;
          headers["chatgpt-account-id"] = override.chatgptAccountId;
        }
      } else {
        if (provider.responsesPath === undefined) {
          const base = provider.baseUrl.replace(/\/v1\/?$/, "");
          url = `${base}/v1/responses`;
        } else {
          const base = provider.baseUrl.replace(/\/$/, "");
          url = `${base}${provider.responsesPath}`;
        }
        if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
        if (provider.headers) Object.assign(headers, provider.headers);
      }

      const forward = provider.authMode === "forward";
      const unexpandedMiss = !!parsed.previousResponseId && parsed._previousResponseInputExpanded !== true;
      let outBody = stripPreviousResponseId(
        parsed._rawBody,
        forward || parsed._previousResponseInputExpanded === true,
      );
      const stateless = provider.statelessResponses === true;
      if (stateless) outBody = stripStatefulResponsesParams(outBody);
      // A replay miss can leave a function_call_output whose paired function_call sat
      // in the prefix that was never expanded. A stateless upstream cannot resolve the
      // pair from its own storage either, so it needs the same repair the forward
      // backend gets — dropping previous_response_id is not much use if the body that
      // reaches the wire is unparseable.
      if (forward || stateless) {
        outBody = repairOrphanedInputItems(outBody, unexpandedMiss);
      }
      if (forward) {
        outBody = stripUnsupportedForwardParams(outBody);
      }
      else outBody = normalizeImageGenClientTools(outBody);
      if (forward || parsed._previousResponseInputExpanded === true) {
        outBody = repairOversizedReplayCallIds(outBody);
      }
      outBody = stripUnsupportedReasoningSummaryDelivery(outBody, parsed.modelId);
      // Same predicate as the routedCompaction gate in handleResponses(): an
      // authMode check would let a noncanonical custom forward provider skip this
      // rewrite while the server still routes it as a summarizer turn (#422).
      if (parsed._compactionRequest === true && !isCanonicalOpenAiForwardProvider(provider)) {
        outBody = buildRoutedCompactionBody(outBody);
      }
      const sanitizedBody = normalizeToolSchemas(stripSparkCompatibility(stripUnsupportedReasoningParams(stripItemIdsWhenUnstored(stripInvalidItemIds(stripUnsupportedHostedTools(sanitizeReasoningInputContent(scrubOcxCompactionItems(outBody))))))));
      const body = JSON.stringify(stripDisabledReasoningSummaries(
        normalizeConfiguredReasoningSummaryDelivery(sanitizedBody, provider, parsed.modelId),
        provider,
        parsed.modelId,
      ));
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
