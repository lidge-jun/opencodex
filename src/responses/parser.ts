import type {
  OcxAssistantMessage,
  OcxContentPart,
  OcxContext,
  OcxMessage,
  OcxParsedRequest,
  OcxRequestOptions,
  OcxTextContent,
  OcxThinkingContent,
  OcxTool,
  OcxToolCall,
} from "../types";
import { namespacedToolName } from "../types";
import { responsesRequestSchema } from "./schema";
import { compactionItemToText } from "./compaction";
import { decodeReasoningEnvelope } from "./reasoning-envelope";
import { extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "../web-search/synthetic-tool";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type InputBlock =
  | { type: "input_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
  | { type: "input_file"; file_id?: string; filename?: string };

function inputContentParts(blocks: unknown[] | string | undefined): string | OcxContentPart[] {
  if (typeof blocks === "string") return blocks;
  if (!blocks) return [];
  const parts: OcxContentPart[] = [];
  for (const raw of blocks) {
    const block = raw as InputBlock;
    if (block.type === "input_text" || block.type === "text") {
      parts.push({ type: "text", text: (block as { text: string }).text });
    } else if (block.type === "input_image") {
      const b = block as { image_url?: string; file_id?: string; detail?: string };
      if (b.image_url) {
        // Preserve the image as a structured part — adapters send it as a native image block.
        // NEVER inline the (often base64 data-URL) image_url as text: that explodes the token count.
        parts.push({ type: "image", imageUrl: b.image_url, ...(b.detail ? { detail: normalizeImageDetail(b.detail) } : {}) });
      } else {
        parts.push({ type: "text", text: `[image: ${b.file_id ?? "?"}]` }); // file_id ref → no inline data
      }
    } else if (block.type === "input_file") {
      const ref = (block as { file_id?: string; filename?: string }).file_id ?? (block as { filename?: string }).filename ?? "?";
      parts.push({ type: "text", text: `[file: ${ref}]` });
    }
  }
  // Collapse to a plain string only for a single TEXT part; images must stay structured.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

type OutputBlock = { type: "output_text"; text: string } | { type: "text"; text: string } | { type: "refusal"; refusal: string };

function outputTextOf(blocks: unknown[] | string | undefined): OcxTextContent[] {
  if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
  if (!blocks) return [];
  const out: OcxTextContent[] = [];
  for (const raw of blocks) {
    const b = raw as OutputBlock;
    if (b.type === "output_text" || b.type === "text") out.push({ type: "text", text: (b as { text: string }).text });
    else if (b.type === "refusal") out.push({ type: "text", text: `[refusal: ${(b as { refusal: string }).refusal}]` });
  }
  return out;
}

function mapToolChoice(value: unknown): OcxRequestOptions["toolChoice"] {
  if (value === undefined || value === null) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isObj(value) && "type" in value) {
    const t = (value as { type: string }).type;
    if ((t === "function" || t === "custom") && "name" in value) {
      return { name: (value as { name: string }).name };
    }
    if (t === "allowed_tools" && Array.isArray(value.tools)) {
      const names = value.tools
        .map(allowedToolName)
        .filter((name): name is string => Boolean(name));
      return names.length > 0
        ? { allowedTools: [...new Set(names)], mode: value.mode === "required" ? "required" : "auto" }
        : "none";
    }
    return "auto";
  }
  return undefined;
}

function allowedToolName(tool: unknown): string | undefined {
  if (!isObj(tool)) return undefined;
  if (typeof tool.name === "string" && tool.name.length > 0) return tool.name;
  if (tool.type === "web_search" || tool.type === "web_search_preview") return WEB_SEARCH_TOOL_NAME;
  if (tool.type === "tool_search") return "tool_search";
  return undefined;
}

function buildTools(tools: unknown[] | undefined): OcxTool[] | undefined {
  if (!tools) return undefined;
  const out: OcxTool[] = [];
  const pushFn = (t: Record<string, unknown>, namespace?: string) => {
    const tool: OcxTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: (t.parameters ?? {}) as Record<string, unknown>,
    };
    if (t.strict !== undefined) tool.strict = t.strict as boolean;
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (t.type === "function" && typeof t.name === "string") {
      pushFn(t);
    } else if (t.type === "namespace" && Array.isArray(t.tools)) {
      // MCP tools arrive grouped under a namespace tool; flatten the inner function tools so
      // chat-completions models receive them (round-trip restores the namespace in the bridge).
      const ns = typeof t.name === "string" ? t.name : undefined;
      for (const inner of t.tools as unknown[]) {
        if (isObj(inner) && inner.type === "function" && typeof inner.name === "string") pushFn(inner, ns);
      }
    }
    else if (t.type === "custom" && typeof t.name === "string") {
      // Freeform custom tool (e.g. apply_patch). Chat models can't emit a lark grammar, so expose a
      // function with a single string `input` carrying the raw tool body; the bridge relays the model's
      // call back as a custom_tool_call (Codex's freeform handler rejects a function_call → fatal abort).
      out.push({
        name: t.name,
        description: (t.description as string) ?? "",
        parameters: { type: "object", properties: { input: { type: "string", description: "Raw tool input (verbatim body, e.g. the apply_patch envelope)." } }, required: ["input"] },
        freeform: true,
      });
    }
    else if (t.type === "tool_search") {
      // Client-executed tool discovery — the gateway to deferred tools (subagents, extra MCP tools).
      // Expose as a function so chat models can call it; the bridge relays it as a tool_search_call.
      out.push({
        name: "tool_search",
        description: (t.description as string) ?? "Search for additional tools to load for the next turn.",
        parameters: (isObj(t.parameters) ? t.parameters : {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query for tools to load." },
            limit: { type: "number", description: "Maximum number of tools to return." },
          },
          required: ["query"],
        }) as Record<string, unknown>,
        toolSearch: true,
      });
    }
    else if (typeof t.name === "string" && t.type !== "web_search" && t.type !== "image_generation") {
      // Any OTHER named tool (e.g. a native/computer-use tool type opencodex doesn't explicitly
      // model) is client-executed — pass it through as a function so the routed model can read and
      // call it naturally; the bridge relays its call as a function_call. Previously such tools were
      // silently dropped, so the model never saw them.
      pushFn(t);
    }
    // Only the OpenAI-hosted server-side tools (web_search, image_generation) are intentionally
    // dropped — they're executed by OpenAI and can't be relayed to a routed chat model.
  }
  return out.length > 0 ? out : undefined;
}

function ensureAssistantPlaceholder(messages: OcxMessage[], modelId: string, now: number): OcxAssistantMessage {
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") return last;
  const placeholder: OcxAssistantMessage = { role: "assistant", content: [], model: modelId, timestamp: now };
  messages.push(placeholder);
  return placeholder;
}

/**
 * Tool-call output content. Preserves images (e.g. Codex `view_image` returns
 * `input_image` items): returns content parts when any image is present, else a plain joined string.
 * Never inlines an image_url as text (that would explode the token count).
 */
function outputToToolResultContent(output: string | unknown[] | undefined): string | OcxContentPart[] {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  const parts: OcxContentPart[] = [];
  let hasImage = false;
  for (const raw of output) {
    if (!isObj(raw)) continue;
    if (raw.type === "output_text" || raw.type === "text" || raw.type === "input_text") {
      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
    } else if (raw.type === "refusal" && typeof raw.refusal === "string") {
      parts.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
    } else if (raw.type === "input_image" && typeof raw.image_url === "string") {
      parts.push({ type: "image", imageUrl: raw.image_url, ...(typeof raw.detail === "string" ? { detail: normalizeImageDetail(raw.detail) } : {}) });
      hasImage = true;
    } else if (raw.type === "encrypted_content") {
      // codex-rs FunctionCallOutputContentItem::EncryptedContent — opaque to routed models.
      parts.push({ type: "text", text: "[encrypted content omitted]" });
    }
  }
  if (!hasImage) return parts.map(p => (p.type === "text" ? p.text : "")).join("");
  return parts;
}

/**
 * codex-rs ImageDetail allows "original", but chat-completions providers only accept
 * auto|low|high on image_url.detail — degrade "original" to "high" (the codex default).
 */
function normalizeImageDetail(detail: string): string {
  return detail === "original" ? "high" : detail;
}

function findToolById(messages: OcxMessage[], callId: string): { name: string; namespace?: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type === "toolCall" && part.id === callId) return { name: part.name, namespace: part.namespace };
    }
  }
  return { name: "" };
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function parseRequest(body: unknown): OcxParsedRequest {
  const parsed = responsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`responses parse error: ${parsed.error.message}`);
  }
  const data = parsed.data;
  const now = Date.now();
  const messages: OcxMessage[] = [];
  const systemPrompt: string[] = [];
  // Tool specs surfaced by a prior tool_search (deferred tools, e.g. subagents). Codex does not
  // re-list these in `tools`, but chat models can only call listed tools — so we re-inject them.
  const loadedToolSpecs: unknown[] = [];
  // Remote compaction v2: the input tail carries `{type:"compaction_trigger"}` and Codex expects a
  // synthetic `{type:"compaction"}` output item (src/responses/compaction.ts). Flagged for the server.
  let compactionRequest = false;

  if (typeof data.instructions === "string" && data.instructions.length > 0) {
    systemPrompt.push(data.instructions);
  }

  if (typeof data.input === "string") {
    messages.push({ role: "user", content: data.input, timestamp: now });
  } else if (data.input) {
    for (const item of data.input) {
      const effectiveType = (item as { type?: string }).type ?? ("role" in item ? "message" : undefined);

      if (effectiveType === "compaction_trigger") {
        compactionRequest = true;
        continue;
      }

      if (effectiveType === "additional_tools") {
        // Codex Desktop responses_lite WS path: tools ride INSIDE input as an
        // `additional_tools` item ({type, role, tools:[...]}) instead of body.tools.
        // Same spec wire shapes (function/namespace/custom/tool_search) — collect and
        // merge through the exact buildTools path so surface detection (collabSurface)
        // and chat-model tool listing see them. The item itself never becomes a message;
        // the native passthrough keeps it verbatim in _rawBody.
        const at = item as { tools?: unknown[] };
        if (Array.isArray(at.tools)) loadedToolSpecs.push(...at.tools);
        continue;
      }

      if (effectiveType === "compaction" || effectiveType === "compaction_summary" || effectiveType === "context_compaction") {
        // A stored summary from a previous compaction. Decode our ocx1 envelope into plain text so
        // the routed model keeps the compacted context; real OpenAI-encrypted blobs degrade to a note.
        // `context_compaction` (encrypted_content optional) is codex-rs's local-compaction marker;
        // with no payload it is a pure marker (the summary follows as its own user message), so it
        // is dropped silently. It must NOT flag _compactionRequest.
        const encrypted = (item as { encrypted_content?: unknown }).encrypted_content;
        if (effectiveType === "context_compaction" && typeof encrypted !== "string") continue;
        messages.push({
          role: "user",
          content: compactionItemToText(typeof encrypted === "string" ? encrypted : undefined),
          timestamp: now,
        });
        continue;
      }

      if (effectiveType === "agent_message") {
        const agentMessage = item as {
          author?: string;
          recipient?: string;
          content?: unknown;
        };

        const content = inputContentParts(
          agentMessage.content as unknown[] | string | undefined,
        );

        const hasContent =
          typeof content === "string"
            ? content.trim().length > 0
            : content.length > 0;

        // An agent_message is external input delivered to the parent agent.
        // Preserve it as a user-role turn so signed Anthropic thinking blocks
        // on either side are never merged into one modified assistant response.
        messages.push({
          role: "user",
          content: hasContent ? content : "(sub-agent message received)",
          timestamp: now,
        });

        continue;
      }

      if (effectiveType === "message") {
        const msg = item as { role?: string; content?: unknown };
        switch (msg.role) {
          case "system": {
            const text = inputContentParts(msg.content as unknown[] | string | undefined);
            const flat = typeof text === "string" ? text : text.map(p => (p.type === "text" ? p.text : "")).join("");
            if (flat.length > 0) systemPrompt.push(flat);
            break;
          }
          case "user":
          case "developer": {
            const content = inputContentParts(msg.content as unknown[] | string | undefined);
            messages.push({ role: msg.role, content, timestamp: now });
            break;
          }
          case "assistant": {
            const parts = outputTextOf(msg.content as unknown[] | string | undefined);
            messages.push({ role: "assistant", content: parts, model: data.model, timestamp: now });
            break;
          }
        }
        continue;
      }

      if (effectiveType === "reasoning") {
        const reasoning = item as { id?: string; summary?: { text: string }[]; content?: { text: string }[]; encrypted_content?: string };
        const fromSummary = (reasoning.summary ?? []).map(c => c.text).join("");
        const text = fromSummary || (reasoning.content ?? []).map(c => c.text).join("");
        // ocxr1 envelope: the REAL Anthropic signature (+ redacted blocks, + hidden signed text)
        // captured by the bridge. Native OpenAI-encrypted blobs decode to null and keep today's
        // placeholder signature (which the anthropic adapter correctly rejects on replay).
        const envelope = typeof reasoning.encrypted_content === "string"
          ? decodeReasoningEnvelope(reasoning.encrypted_content)
          : null;
        const thinking: OcxThinkingContent = {
          type: "thinking",
          thinking: envelope?.txt || text,
          signature: envelope?.sig ?? JSON.stringify(reasoning),
          ...(envelope?.red ? { redacted: envelope.red } : {}),
          ...(reasoning.id ? { itemId: reasoning.id } : {}),
        };
        ensureAssistantPlaceholder(messages, data.model, now).content.push(thinking);
        continue;
      }

      if (effectiveType === "function_call") {
        const call = item as { id?: string; call_id: string; name: string; arguments?: string; namespace?: string };
        // Tolerate empty/non-JSON arguments (e.g. a no-arg tool call serialized as "") instead of
        // throwing — a single poisoned history item would otherwise 400 every subsequent turn.
        let args: Record<string, unknown> = {};
        const rawArgs = call.arguments?.trim();
        if (rawArgs) {
          try {
            const parsed: unknown = JSON.parse(rawArgs);
            if (isObj(parsed)) args = parsed;
          } catch {
            console.warn(`[parser] function_call ${call.call_id} has non-JSON arguments; defaulting to {}`);
          }
        }
        const toolCall: OcxToolCall = {
          type: "toolCall", id: call.call_id, name: call.name, arguments: args,
          ...(call.id ? { thoughtSignature: call.id } : {}),
          ...(call.namespace ? { namespace: call.namespace } : {}),
        };
        ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
        continue;
      }

      if (effectiveType === "custom_tool_call") {
        const call = item as { id?: string; call_id: string; name: string; input: string };
        const toolCall: OcxToolCall = {
          type: "toolCall", id: call.call_id, name: call.name,
          arguments: { input: call.input ?? "" },
          customWireName: call.name,
          ...(call.id ? { thoughtSignature: call.id } : {}),
        };
        ensureAssistantPlaceholder(messages, data.model, now).content.push(toolCall);
        continue;
      }

      if (effectiveType === "local_shell_call") {
        // codex-rs LocalShellCall replay: pair it as an assistant toolCall so the subsequent
        // function_call_output (same call_id) doesn't become an orphaned tool result.
        const call = item as { id?: string; call_id?: string; action?: { type?: string; command?: string[] } };
        const callId = call.call_id ?? call.id;
        if (callId) {
          const command = Array.isArray(call.action?.command) ? call.action.command : [];
          ensureAssistantPlaceholder(messages, data.model, now).content.push({
            type: "toolCall", id: callId, name: "shell",
            arguments: command.length > 0 ? { command } : {},
          });
        }
        continue;
      }

      if (effectiveType === "web_search_call") {
        // Replayed hosted web-search evidence. Textify it into assistant history so the model
        // knows the search already ran (prevents re-search loops); there is no output to pair.
        const call = item as { action?: { type?: string; query?: string } };
        const query = typeof call.action?.query === "string" ? call.action.query : "";
        ensureAssistantPlaceholder(messages, data.model, now).content.push({
          type: "text", text: query ? `[web search performed: ${query}]` : "[web search performed]",
        });
        continue;
      }

      if (effectiveType === "tool_search_call") {
        // Preserve the model's prior tool_search call as an assistant tool call so multi-turn
        // history stays complete (otherwise the model re-issues tool_search forever).
        const call = item as { id?: string; call_id?: string; arguments?: unknown };
        const callId = call.call_id ?? call.id ?? "";
        ensureAssistantPlaceholder(messages, data.model, now).content.push({
          type: "toolCall", id: callId, name: "tool_search",
          arguments: isObj(call.arguments) ? call.arguments : {},
        });
        continue;
      }

      if (effectiveType === "tool_search_output") {
        // Pair the tool_search call with its result so the model sees what was loaded.
        const out = item as { call_id?: string; status?: string; tools?: unknown[] };
        const specs = Array.isArray(out.tools) ? (out.tools as Record<string, unknown>[]) : [];
        loadedToolSpecs.push(...specs);
        // List the EXACT wire names the model must call (flattened for namespaced specs), matching
        // how buildTools exposes them — otherwise the model guesses wrong names (e.g. the bare namespace).
        const wireNames: string[] = [];
        for (const spec of specs) {
          if (spec.type === "namespace" && Array.isArray(spec.tools)) {
            for (const inner of spec.tools as Record<string, unknown>[]) {
              if (typeof inner.name === "string") wireNames.push(namespacedToolName(spec.name as string, inner.name));
            }
          } else if (typeof spec.name === "string") {
            wireNames.push(spec.name);
          }
        }
        const failed = typeof out.status === "string" && out.status !== "completed" && out.status !== "success";
        messages.push({
          role: "toolResult", toolCallId: out.call_id ?? "", toolName: "tool_search",
          content: failed && wireNames.length === 0
            ? `Tool search failed (status: ${out.status}).`
            : wireNames.length
              ? `Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: ${wireNames.join(", ")}.`
              : "Tool search returned no tools.",
          isError: failed && wireNames.length === 0, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "function_call_output") {
        const output = item as { call_id: string; output?: string | unknown[] };
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          content: outputToToolResultContent(output.output), isError: false, timestamp: now,
        });
        continue;
      }

      if (effectiveType === "custom_tool_call_output") {
        const output = item as { call_id: string; output: string | unknown[] };
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          // Same payload shape as function_call_output (codex-rs FunctionCallOutputPayload):
          // string or content items — normalize arrays instead of leaking raw wire blocks.
          content: outputToToolResultContent(output.output), isError: false, timestamp: now,
        });
      }
    }
  }

  const declaredTools = buildTools(data.tools as unknown[] | undefined) ?? [];
  const loadedTools = buildTools(loadedToolSpecs) ?? [];
  const seenTools = new Set<string>();
  const mergedTools = [...declaredTools, ...loadedTools].filter(t => {
    const k = namespacedToolName(t.namespace, t.name);
    if (seenTools.has(k)) return false;
    seenTools.add(k);
    return true;
  });
  const context: OcxContext = {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    messages,
    ...(mergedTools.length > 0 ? { tools: mergedTools } : {}),
  };

  const options: OcxRequestOptions = {};
  if (data.max_output_tokens !== undefined) options.maxOutputTokens = data.max_output_tokens;
  if (data.temperature !== undefined) options.temperature = data.temperature;
  if (data.top_p !== undefined) options.topP = data.top_p;
  if (data.stop !== undefined && data.stop !== null) {
    options.stopSequences = typeof data.stop === "string" ? [data.stop] : data.stop;
  }
  const tc = mapToolChoice(data.tool_choice);
  if (tc !== undefined) options.toolChoice = tc;
  if (data.parallel_tool_calls !== undefined) options.parallelToolCalls = data.parallel_tool_calls;
  // Upstream codex-rs converts "ultra" to "max" at the inference boundary (core/src/client.rs
  // `reasoning_effort_for_request`), so current clients never send it — but a catalog that
  // advertises ultra plus an older/direct caller can. Degrade it to max like upstream instead of
  // silently dropping reasoning altogether.
  const requestedEffort = data.reasoning?.effort === "ultra" ? "max" : data.reasoning?.effort;
  if (requestedEffort && REASONING_EFFORTS.has(requestedEffort)) {
    options.reasoning = requestedEffort;
  }
  const summaryMode = data.reasoning?.summary;
  if (!summaryMode || summaryMode === "none") options.hideThinkingSummary = true;
  if (data.presence_penalty !== undefined) options.presencePenalty = data.presence_penalty;
  if (data.frequency_penalty !== undefined) options.frequencyPenalty = data.frequency_penalty;
  if (data.service_tier !== undefined) options.serviceTier = data.service_tier;
  if (data.prompt_cache_key !== undefined) options.promptCacheKey = data.prompt_cache_key;

  // Stash the hosted web_search config (if Codex enabled it) so the proxy can run searches via the
  // gpt-mini sidecar for routed providers. buildTools still drops the hosted tool; the sidecar path
  // re-injects a synthetic function tool only when it will actually handle the call.
  const webSearch = extractHostedWebSearch(data.tools as unknown[] | undefined);
  // Detect structured-output mode (Responses `text.format`) so the web-search sidecar can render its
  // tool_result as JSON rather than prose that could corrupt the model's schema-constrained answer.
  const structuredOutput = detectStructuredOutput(data.text);

  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(webSearch ? { _webSearch: webSearch } : {}),
    ...(structuredOutput ? { _structuredOutput: true } : {}),
    ...(compactionRequest ? { _compactionRequest: true } : {}),
  };
}

/** True when the Responses `text.format` requests structured output (json_schema or json_object). */
function detectStructuredOutput(text: unknown): boolean {
  if (!isObj(text)) return false;
  const format = (text as { format?: unknown }).format;
  if (!isObj(format)) return false;
  const t = (format as { type?: unknown }).type;
  return t === "json_schema" || t === "json_object";
}
