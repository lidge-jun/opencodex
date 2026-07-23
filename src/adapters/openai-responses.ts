import type { IncomingMeta, ProviderAdapter } from "./base";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../types";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../responses/compaction";
import { OCX_REASONING_PREFIX } from "../responses/reasoning-envelope";

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
 * Hosted tool types whose server-side function names collide with the client tools Codex
 * declares for the matching app skill. Codex sends BOTH (e.g. hosted `image_generation` plus a
 * declared `image_gen.imagegen` function/namespace tool for the imagegen skill). The ChatGPT
 * backend tolerates the pair, but the platform `/v1/responses` rejects it:
 * `Invalid Value: 'tools'. Function 'image_gen.imagegen' conflicts with a hosted tool in the
 * same request.` Keyed hosted-type → conflicting client tool-name prefix; the hosted entry is
 * dropped (the declared tool wins — Codex executes the skill client-side either way).
 */
const HOSTED_TOOL_NAME_CONFLICTS: ReadonlyArray<{ hostedType: string; namePrefix: string }> = [
  { hostedType: "image_generation", namePrefix: "image_gen" },
];

/**
 * Drop hosted tools whose names collide with declared function/namespace tools (see
 * HOSTED_TOOL_NAME_CONFLICTS). Only applies on the API-key platform path: the ChatGPT backend
 * ("forward" mode) accepts the pair, and stripping there would disable native imagegen. No-op
 * (returns the original reference) when nothing matches.
 */
function stripConflictingHostedTools(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.tools)) return body;
  const allTools = body.tools;

  const conflicting = HOSTED_TOOL_NAME_CONFLICTS.filter(c =>
    allTools.some(t => {
      if (!isPlainObject(t) || typeof t.name !== "string") return false;
      if (t.type === "namespace") return t.name === c.namePrefix;
      return t.name === c.namePrefix || t.name.startsWith(`${c.namePrefix}.`);
    }),
  );
  if (conflicting.length === 0) return body;

  const tools = allTools.filter(t => {
    const type = isPlainObject(t) && typeof t.type === "string" ? t.type : undefined;
    if (!type) return true;
    return !conflicting.some(c => c.hostedType === type);
  });
  return tools.length === allTools.length ? body : { ...body, tools };
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

export function createResponsesPassthroughAdapter(provider: OcxProviderConfig): ProviderAdapter & { passthrough: true } {
  return {
    name: "openai-responses",
    passthrough: true as const,

    buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta) {
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
      if (forward) outBody = repairOrphanedInputItems(outBody, unexpandedMiss);
      else outBody = stripConflictingHostedTools(outBody);
      return {
        url,
        method: "POST",
        headers,
        body: JSON.stringify(stripSparkCompatibility(stripUnsupportedReasoningParams(stripItemIdsWhenUnstored(stripInvalidItemIds(stripUnsupportedHostedTools(sanitizeReasoningInputContent(scrubOcxCompactionItems(outBody)))))))),
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "passthrough adapter should not parse stream" };
    },
  };
}
