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
  OcxReasoningReplayScopeRef,
} from "../types";
import { createToolChoiceResolver, namespacedToolName } from "../types";
import { responsesRequestSchema } from "./schema";
import { providerMetadataFromResponsesFunctionCall } from "./provider-opaque-metadata";
import { lookupReplayThoughtSignature } from "./thought-signature-replay";
import { compactionItemToText, isCompactionItemType } from "./compaction";
import { previousResponseReplayPrefixLength } from "./state";
import { decodeReasoningEnvelope } from "./reasoning-envelope";
import { extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "../web-search/synthetic-tool";
import { extractHostedImageGeneration, IMAGE_GEN_TOOL_NAME } from "../images/synthetic-tool";
import { toolSearchDescription, toolSearchParameters } from "./tool-search-compat";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Wrap a remembered proxy-side signature as provider metadata for a replayed tool call.
 *
 * The scope is REQUIRED for a hit. `parseRequest` runs before the route and account are
 * chosen, so a caller that has not yet bound a replay scope gets nothing rather than a
 * signature belonging to some other thread that happened to reuse the same `call_id`.
 */
function replayThoughtSignatureMetadata(
  callId: string,
  scope: OcxReasoningReplayScopeRef | undefined,
): { google: { thoughtSignature: string } } | undefined {
  const signature = lookupReplayThoughtSignature(callId, scope);
  return signature ? { google: { thoughtSignature: signature } } : undefined;
}

type InputBlock =
  | { type: "input_text"; text: string }
  | { type: "text"; text: string }
  | { type: "input_image"; image_url?: string; file_id?: string; detail?: string }
  | { type: "input_video"; video_url?: string }
  | { type: "input_file"; file_id?: string; filename?: string; file_data?: string };

/** A usable reference string, or undefined. Empty strings and non-strings are not references. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function inputContentParts(blocks: unknown): string | OcxContentPart[] {
  if (typeof blocks === "string") return blocks;
  // The catch-all can also hand back a non-array `content` (an object, a number), which would
  // throw at the loop below before any per-block guard runs.
  if (!Array.isArray(blocks)) return [];
  const parts: OcxContentPart[] = [];
  for (const raw of blocks) {
    // A malformed message item fails its strict schema and falls through to inputItemSchema's
    // permissive catch-all, so blocks reaching here are NOT guaranteed to match the declared
    // shape. Validate each field before use, as outputToToolResultContent already does.
    if (!isObj(raw)) continue;
    const block = raw as InputBlock;
    if (block.type === "input_text" || block.type === "text") {
      if (typeof raw.text === "string") parts.push({ type: "text", text: raw.text });
    } else if (block.type === "input_image") {
      const b = block as { image_url?: string; file_id?: string; detail?: string };
      const imageUrl = nonEmptyString(b.image_url);
      const fileId = nonEmptyString(b.file_id);
      const detail = nonEmptyString(b.detail);
      if (imageUrl) {
        // Preserve the image as a structured part — adapters send it as a native image block.
        // NEVER inline the (often base64 data-URL) image_url as text: that explodes the token count.
        parts.push({ type: "image", imageUrl, ...(detail ? { detail: normalizeImageDetail(detail) } : {}) });
      } else if (fileId) {
        parts.push({ type: "text", text: `[image: ${fileId}]` }); // file_id ref → no inline data
      }
      // No usable reference: omit the block. A "[image: ?]" marker would claim an attachment
      // the request never carried, which is worse than dropping malformed input.
    } else if (block.type === "input_video") {
      const videoUrl = nonEmptyString(block.video_url);
      if (videoUrl) parts.push({ type: "video", videoUrl });
    } else if (block.type === "input_file") {
      const b = block as { file_id?: string; filename?: string; file_data?: string };
      const fileId = nonEmptyString(b.file_id);
      const fileData = nonEmptyString(b.file_data);
      const filename = nonEmptyString(b.filename);
      if (fileId) {
        parts.push({ type: "text", text: `[file: ${fileId}]` });
      } else if (fileData) {
        // Inline file_data is often large base64. Preserve only its presence and name, never bytes.
        parts.push({ type: "text", text: filename ? `[file: ${filename}]` : "[file: inline data]" });
      }
      // A bare filename is not a file resource in the Responses schema, so omit it rather than
      // fabricating a "[file: ...]" marker for an attachment that was never sent.
    }
  }
  // Collapse to a plain string only for a single TEXT part; images must stay structured.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

type OutputBlock = { type: "output_text"; text: string } | { type: "text"; text: string } | { type: "refusal"; refusal: string };

function outputTextOf(blocks: unknown): OcxTextContent[] {
  if (typeof blocks === "string") return blocks.length > 0 ? [{ type: "text", text: blocks }] : [];
  if (!Array.isArray(blocks)) return [];
  const out: OcxTextContent[] = [];
  for (const raw of blocks) {
    // Same catch-all caveat as inputContentParts: validate before use.
    if (!isObj(raw)) continue;
    const b = raw as OutputBlock;
    if (b.type === "output_text" || b.type === "text") {
      if (typeof raw.text === "string") out.push({ type: "text", text: raw.text });
    } else if (b.type === "refusal") {
      if (typeof raw.refusal === "string") out.push({ type: "text", text: `[refusal: ${raw.refusal}]` });
    }
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
    // Hosted image tool types (with or without a name) map to the synthetic image_gen wire name.
    if (t === "image_generation" || t === "image_gen") {
      return { name: IMAGE_GEN_TOOL_NAME };
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
  if (tool.type === "image_generation" || tool.type === "image_gen") return IMAGE_GEN_TOOL_NAME;
  if (tool.type === "tool_search") return "tool_search";
  return undefined;
}

function buildTools(tools: unknown[] | undefined): OcxTool[] | undefined {
  if (!tools) return undefined;
  const out: OcxTool[] = [];
  const normalizeParameters = (raw: unknown): Record<string, unknown> => {
    if (isObj(raw) && raw.type === "object") return raw;
    return { ...(isObj(raw) ? raw : {}), type: "object" };
  };
  const pushFn = (t: Record<string, unknown>, namespace?: string) => {
    const tool: OcxTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: normalizeParameters(t.parameters),
    };
    if (t.strict !== undefined) tool.strict = t.strict as boolean;
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  const pushCustom = (t: Record<string, unknown>, namespace?: string) => {
    // Freeform custom tools are lowered to a single string `input` because chat models cannot
    // emit Responses grammar payloads directly. Keep tool-specific input guidance scoped to the
    // tool that owns it: leaking apply_patch syntax into `exec` or another freeform tool teaches
    // routed models that the nested helper name is itself a callable top-level tool.
    const inputDescription = t.name === "apply_patch"
      ? "Raw tool input. For apply_patch, begin exactly with `*** Begin Patch` (no trailing `***`), then use its standard patch envelope."
      : "Raw freeform input for this tool.";
    const tool: OcxTool = {
      name: t.name as string,
      description: (t.description as string) ?? "",
      parameters: { type: "object", properties: { input: { type: "string", description: inputDescription } }, required: ["input"] },
      freeform: true,
    };
    if (namespace) tool.namespace = namespace;
    out.push(tool);
  };
  for (const t of tools) {
    if (!isObj(t)) continue;
    if (t.type === "function" && isObj(t.function) && typeof t.function.name === "string" && t.function.name.length > 0) {
      pushFn(t.function as Record<string, unknown>);
      continue;
    }
    if (t.type === "function" && typeof t.name === "string") {
      pushFn(t);
    } else if (t.type === "namespace" && Array.isArray(t.tools)) {
      // Codex 0.147 groups its ordinary client tools under the reserved `functions` namespace,
      // including freeform custom tools such as code-mode `exec`. Those children are still
      // top-level Responses tools, so flatten them without a namespace. Other namespace groups
      // are MCP-style and keep their namespace for round-trip routing.
      const builtinFunctions = t.name === "functions";
      const ns = typeof t.name === "string" && !builtinFunctions ? t.name : undefined;
      for (const inner of t.tools as unknown[]) {
        if (isObj(inner) && inner.type === "function" && typeof inner.name === "string") pushFn(inner, ns);
        else if (isObj(inner) && inner.type === "custom" && typeof inner.name === "string") pushCustom(inner, ns);
      }
    }
    else if (t.type === "custom" && typeof t.name === "string") {
      pushCustom(t);
    }
    else if (t.type === "tool_search") {
      // Client-executed tool discovery — the gateway to deferred tools (subagents, extra MCP tools).
      // Expose as a function so chat models can call it; the bridge relays it as a tool_search_call.
      out.push({
        name: "tool_search",
        description: toolSearchDescription(t),
        parameters: normalizeParameters(toolSearchParameters(t)),
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

function toolOutputContainsEncryptedContent(output: string | unknown[] | undefined): boolean {
  return Array.isArray(output) && output.some(raw => isObj(raw) && raw.type === "encrypted_content");
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

/**
 * Attach pending reasoning to the assistant turn that owns the given call id.
 * Reconstructed histories (resume/retry/synthetic) can order a `reasoning`
 * item AFTER the `function_call` it belongs to; without this, the pending
 * buffer is cleared at the tool output and the turn serializes without
 * `reasoning_content`, which DeepSeek thinking mode rejects with HTTP 400
 * (issue #950).
 */
function attachPendingReasoningToCallOwner(
  messages: OcxMessage[],
  callId: string,
  pendingReasoning: Array<{ part: OcxThinkingContent; envelopeSigned: boolean }>,
): void {
  if (pendingReasoning.length === 0 || !callId) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type === "toolCall" && part.id === callId) {
        // Prepend so thinking still precedes tool_use for adapters that require
        // that ordering (Anthropic-style replay).
        m.content = [...pendingReasoning.map(entry => entry.part), ...m.content];
        return;
      }
    }
  }
}

const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Namespace a custom tool was declared under, by its bare name.
 *
 * A `custom_tool_call` echoed back by the client carries only the bare name — the bridge
 * emits `{"type":"custom_tool_call","name":"exec"}` even when the tool was declared as
 * `mcp__functions__exec`. Without this lookup the namespace is lost on the return trip,
 * and the adapters replay history through `namespacedToolName(namespace, name)`, which
 * then produces a bare `exec` the provider may not have. Ordinary `function_call` items
 * do not need this: they carry `namespace` on the wire.
 */
function customToolNamespaces(tools: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(tools)) return out;
  for (const spec of tools) {
    if (!isObj(spec) || spec.type !== "namespace" || !Array.isArray(spec.tools)) continue;
    const namespace = typeof spec.name === "string" ? spec.name : undefined;
    // Codex 0.147 groups ordinary client tools under the reserved `functions` namespace and
    // buildTools deliberately flattens those without a namespace. Mirror that here, or the
    // reconstruction would invent a namespace the request never advertised.
    if (!namespace || namespace === "functions") continue;
    for (const inner of spec.tools) {
      if (!isObj(inner) || inner.type !== "custom" || typeof inner.name !== "string") continue;
      // Ambiguous bare names are already rejected upstream, so first declaration wins.
      if (!out.has(inner.name)) out.set(inner.name, namespace);
    }
  }
  return out;
}

export function parseRequest(
  body: unknown,
  parseOptions?: { replayCacheScope?: OcxReasoningReplayScopeRef },
): OcxParsedRequest {
  const replayCacheScope = parseOptions?.replayCacheScope;
  const replayedInputPrefixLength = previousResponseReplayPrefixLength(body);
  const parsed = responsesRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`responses parse error: ${parsed.error.message}`);
  }
  const data = parsed.data;
  const now = Date.now();
  const messages: OcxMessage[] = [];
  // Built before the item loop: a custom_tool_call echoed back in `input` needs the
  // namespace from the request's own tool catalog to survive the round trip.
  const customToolNamespacesByName = customToolNamespaces(data.tools);
  const systemPrompt: string[] = [];
  // Responses reasoning siblings belong to the following assistant, including across call items.
  // Keep them off the message list until that assistant arrives; turn boundaries clear the array.
  const pendingReasoning: Array<{ part: OcxThinkingContent; envelopeSigned: boolean }> = [];
  // Assistant placeholder that first folds any pending reasoning into the same turn (official
  // grok-build preserves reasoning across call items; Anthropic replay requires thinking to
  // precede tool_use inside one assistant message).
  const assistantHolderWithReasoning = (): OcxAssistantMessage => {
    const holder = ensureAssistantPlaceholder(messages, data.model, now);
    if (pendingReasoning.length > 0) {
      holder.content.push(...pendingReasoning.map(entry => entry.part));
      pendingReasoning.length = 0;
    }
    return holder;
  };
  // Tool specs surfaced by a prior tool_search (deferred tools, e.g. subagents). Codex does not
  // re-list these in `tools`, but chat models can only call listed tools — so we re-inject them.
  const loadedToolSpecs: unknown[] = [];
  // Remote compaction v2: the input tail carries `{type:"compaction_trigger"}` and Codex expects a
  // synthetic `{type:"compaction"}` output item (src/responses/compaction.ts). Flagged for the server.
  let compactionRequest = false;
  let contextCompactionBoundary = false;
  let continuationConversationMessageIndex: number | undefined;

  if (typeof data.instructions === "string" && data.instructions.length > 0) {
    systemPrompt.push(data.instructions);
  }

  if (typeof data.input === "string") {
    if (data.previous_response_id) continuationConversationMessageIndex = messages.length;
    messages.push({ role: "user", content: data.input, timestamp: now });
  } else if (data.input) {
    for (let inputIndex = 0; inputIndex < data.input.length; inputIndex++) {
      const item = data.input[inputIndex];
      const effectiveType = (item as { type?: string }).type ?? ("role" in item ? "message" : undefined);
      const itemRole = (item as { role?: string }).role;
      // Raw protocol items do not map one-to-one onto context messages. Capture the boundary while
      // both representations are available so later metadata can stay before conversation in both.
      if (
        data.previous_response_id
        && inputIndex >= replayedInputPrefixLength
        && continuationConversationMessageIndex === undefined
        && (
          effectiveType === "agent_message"
          || (effectiveType === "message" && (itemRole === "user" || itemRole === "assistant"))
        )
      ) {
        continuationConversationMessageIndex = messages.length;
      }

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

      if (isCompactionItemType(effectiveType)) {
        // A stored summary from a previous compaction. Decode our ocx1 envelope into plain text so
        // the routed model keeps the compacted context; real OpenAI-encrypted blobs degrade to a note.
        // `context_compaction` (encrypted_content optional) is codex-rs's local-compaction marker;
        // with no payload it is a pure marker (the summary follows as its own user message), so it
        // is dropped silently. It must NOT flag _compactionRequest. Only a marker newly appended in
        // this request starts a provider-private context epoch; markers inside the prefix restored by
        // previous_response_id were already acknowledged on the turn that introduced them.
        if (inputIndex >= replayedInputPrefixLength) contextCompactionBoundary = true;
        const encrypted = (item as { encrypted_content?: unknown }).encrypted_content;
        if (effectiveType === "context_compaction" && typeof encrypted !== "string") continue;
        pendingReasoning.length = 0;
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

        const content = inputContentParts(agentMessage.content);

        const hasContent =
          typeof content === "string"
            ? content.trim().length > 0
            : content.length > 0;

        // An agent_message is external input delivered to the parent agent.
        // Preserve it as a user-role turn so signed Anthropic thinking blocks
        // on either side are never merged into one modified assistant response.
        pendingReasoning.length = 0;
        messages.push({
          role: "user",
          content: hasContent ? content : "(sub-agent message received)",
          timestamp: now,
        });

        continue;
      }

      if (effectiveType === "message") {
        const msg = item as { role?: string; content?: unknown; phase?: "commentary" | "final_answer" };
        switch (msg.role) {
          case "system": {
            pendingReasoning.length = 0;
            const text = inputContentParts(msg.content);
            const flat = typeof text === "string" ? text : text.map(p => (p.type === "text" ? p.text : "")).join("");
            if (flat.length > 0) systemPrompt.push(flat);
            break;
          }
          case "user":
          case "developer": {
            pendingReasoning.length = 0;
            const content = inputContentParts(msg.content);
            messages.push({ role: msg.role, content, timestamp: now });
            break;
          }
          case "assistant": {
            const parts = outputTextOf(msg.content);
            messages.push({
              role: "assistant",
              content: pendingReasoning.length > 0
                ? [...pendingReasoning.map(entry => entry.part), ...parts]
                : parts,
              ...(msg.phase ? { phase: msg.phase } : {}),
              model: data.model,
              timestamp: now,
            });
            pendingReasoning.length = 0;
            break;
          }
        }
        continue;
      }

      if (effectiveType === "reasoning") {
        const reasoning = item as { id?: string; summary?: { text: string }[]; content?: { text: string }[]; encrypted_content?: string };
        const fromSummary = (reasoning.summary ?? []).map(c => c.text).join("");
        const text = fromSummary || (reasoning.content ?? []).map(c => c.text).join("");
        const envelope = typeof reasoning.encrypted_content === "string"
          ? decodeReasoningEnvelope(reasoning.encrypted_content)
          : null;
        const thinkingText = envelope?.txt || text;

        // Kiro reasoning round-trip: a krc-only item carries nothing renderable — it is provider
        // state for the assistant turn that ALREADY closed, because Kiro emits its
        // reasoningContentEvent at the END of a turn (after content AND tool calls, verified
        // against kiro-cli 2.14.1/2.16.0). Folding it into the FOLLOWING turn like ordinary
        // reasoning would attach turn N's blob to turn N+1, so attach it backwards instead. With
        // no assistant turn to own it the blob is dropped rather than mis-paired.
        if (envelope?.krc && thinkingText.length === 0) {
          const previous = messages[messages.length - 1];
          if (previous?.role === "assistant") previous.kiroRedactedReasoning = envelope.krc;
          continue;
        }

        // Native/non-ocxr1 encrypted-only reasoning is opaque here. Do not create a detached
        // assistant turn or invent replayable plaintext/signatures from the encrypted payload.
        if (thinkingText.length > 0) {
          const part: OcxThinkingContent = {
            type: "thinking",
            thinking: thinkingText,
            signature: envelope?.sig ?? JSON.stringify(reasoning),
            ...(envelope?.red ? { redacted: envelope.red } : {}),
            ...(reasoning.id ? { itemId: reasoning.id } : {}),
          };
          const envelopeSigned = typeof envelope?.sig === "string";
          const previous = pendingReasoning[pendingReasoning.length - 1];

          if (!envelopeSigned && previous && !previous.envelopeSigned) {
            previous.part = {
              ...part,
              thinking: `${previous.part.thinking}\n${part.thinking}`,
            };
          } else {
            pendingReasoning.push({ part, envelopeSigned });
          }
        }
        continue;
      }

      if (effectiveType === "function_call") {
        const call = item as { id?: string; call_id: string; name: string; arguments?: string; namespace?: string; extra_content?: unknown };
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
        // Do NOT map Responses item `id` (fc_/ctc_/…) onto `thoughtSignature`. That field is
        // reserved for Gemini/Antigravity opaque thought tokens; forwarding item ids as
        // thoughtSignature 400s Antigravity (Base64 / TYPE_BYTES). Continuity for CCA comes from
        // the in-process replay cache (and any already-real signature stored on the tool call).
        const toolCall: OcxToolCall = {
          type: "toolCall", id: call.call_id, name: call.name, arguments: args,
          ...(call.namespace ? { namespace: call.namespace } : {}),
        };
        // Provider-opaque metadata (e.g. a Gemini thought signature) travels with the call so a
        // history-replayed or previous_response_id turn rebuilds the same signed part instead of
        // depending on the same-process replay cache (issue #1735). Real clients do not echo
        // extra_content on replay, so fall back to the proxy-side store keyed by call_id.
        const providerMetadata = providerMetadataFromResponsesFunctionCall(call)
          ?? (typeof call.call_id === "string"
            ? replayThoughtSignatureMetadata(call.call_id, replayCacheScope)
            : undefined);
        if (providerMetadata) toolCall.providerMetadata = providerMetadata;
        assistantHolderWithReasoning().content.push(toolCall);
        continue;
      }

      if (effectiveType === "custom_tool_call") {
        const call = item as { id?: string; call_id: string; name: string; input: string };
        const remembered = typeof call.call_id === "string" ? replayThoughtSignatureMetadata(call.call_id, replayCacheScope) : undefined;
        // Reconstruct the namespace the request declared this tool under. The wire item
        // carries only the bare name, so without this the round trip loses it and adapters
        // replay the call as an unnamespaced tool the provider may not expose.
        const customNamespace = customToolNamespacesByName.get(call.name);
        const toolCall: OcxToolCall = {
          type: "toolCall", id: call.call_id, name: call.name,
          arguments: { input: call.input ?? "" },
          customWireName: call.name,
          ...(customNamespace ? { namespace: customNamespace } : {}),
          ...(remembered ? { providerMetadata: remembered } : {}),
        };
        assistantHolderWithReasoning().content.push(toolCall);
        continue;
      }

      if (effectiveType === "local_shell_call") {
        // codex-rs LocalShellCall replay: pair it as an assistant toolCall so the subsequent
        // function_call_output (same call_id) doesn't become an orphaned tool result.
        const call = item as { id?: string; call_id?: string; action?: { type?: string; command?: string[] } };
        const callId = call.call_id ?? call.id;
        if (callId) {
          const command = Array.isArray(call.action?.command) ? call.action.command : [];
          const remembered = replayThoughtSignatureMetadata(callId, replayCacheScope);
          assistantHolderWithReasoning().content.push({
            type: "toolCall", id: callId, name: "shell",
            arguments: command.length > 0 ? { command } : {},
            ...(remembered ? { providerMetadata: remembered } : {}),
          });
        }
        continue;
      }

      if (effectiveType === "web_search_call") {
        // Replayed hosted web-search evidence has no paired result payload that routed providers can
        // consume. Keep it out of assistant-visible text: the old marker was useful as an internal
        // loop hint, but when no sidecar is available the model can echo it as a fake answer.
        pendingReasoning.length = 0;
        continue;
      }

      if (effectiveType === "tool_search_call") {
        // Preserve the model's prior tool_search call as an assistant tool call so multi-turn
        // history stays complete (otherwise the model re-issues tool_search forever).
        const call = item as { id?: string; call_id?: string; arguments?: unknown };
        const callId = call.call_id ?? call.id ?? "";
        const remembered = callId ? replayThoughtSignatureMetadata(callId, replayCacheScope) : undefined;
        assistantHolderWithReasoning().content.push({
          type: "toolCall", id: callId, name: "tool_search",
          arguments: isObj(call.arguments) ? call.arguments : {},
          ...(remembered ? { providerMetadata: remembered } : {}),
        });
        continue;
      }

      if (effectiveType === "tool_search_output") {
        pendingReasoning.length = 0;
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
        attachPendingReasoningToCallOwner(messages, output.call_id, pendingReasoning);
        pendingReasoning.length = 0;
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          content: outputToToolResultContent(output.output), isError: false, timestamp: now,
          ...(toolOutputContainsEncryptedContent(output.output) ? { containsEncryptedContent: true } : {}),
        });
        continue;
      }

      if (effectiveType === "custom_tool_call_output") {
        const output = item as { call_id: string; output: string | unknown[] };
        attachPendingReasoningToCallOwner(messages, output.call_id, pendingReasoning);
        pendingReasoning.length = 0;
        const toolInfo = findToolById(messages, output.call_id);
        messages.push({
          role: "toolResult", toolCallId: output.call_id,
          toolName: toolInfo.name, toolNamespace: toolInfo.namespace,
          // Same payload shape as function_call_output (codex-rs FunctionCallOutputPayload):
          // string or content items — normalize arrays instead of leaking raw wire blocks.
          content: outputToToolResultContent(output.output), isError: false, timestamp: now,
          ...(toolOutputContainsEncryptedContent(output.output) ? { containsEncryptedContent: true } : {}),
        });
      }
    }
  }
  if (data.previous_response_id && continuationConversationMessageIndex === undefined) {
    continuationConversationMessageIndex = messages.length;
  }

  const declaredTools = buildTools(data.tools as unknown[] | undefined) ?? [];
  const loadedTools = buildTools(loadedToolSpecs) ?? [];
  const loadedToolNames = new Set(loadedTools.map(t => namespacedToolName(t.namespace, t.name)));
  const wireOwners = new Map<string, OcxTool>();
  for (const tool of [...declaredTools, ...loadedTools]) {
    const wireName = namespacedToolName(tool.namespace, tool.name);
    const previous = wireOwners.get(wireName);
    if (previous && (previous.namespace !== tool.namespace || previous.name !== tool.name || previous.freeform !== tool.freeform || previous.toolSearch !== tool.toolSearch)) {
      throw new Error(`ambiguous tool catalog: multiple logical tools map to wire name ${wireName}`);
    }
    wireOwners.set(wireName, tool);
  }
  const seenTools = new Set<string>();
  const mergedTools = [...declaredTools, ...loadedTools]
    .filter(t => {
      const k = namespacedToolName(t.namespace, t.name);
      if (seenTools.has(k)) return false;
      seenTools.add(k);
      return true;
    })
    .map(t => loadedToolNames.has(namespacedToolName(t.namespace, t.name))
      ? { ...t, loadedFromToolSearch: true }
      : t);
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
  if (tc && typeof tc === "object") {
    const selectors = "allowedTools" in tc ? tc.allowedTools : [tc.name];
    const resolver = createToolChoiceResolver(mergedTools);
    for (const selector of selectors) {
      if (resolver.candidateCount(selector) > 1) {
        throw new Error(`ambiguous tool_choice name: ${selector}`);
      }
    }
  }
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
  const imageGen = extractHostedImageGeneration([
    ...(data.tools as unknown[] ?? []),
    ...loadedToolSpecs,
  ]);
  // Capture structured-output mode (Responses `text.format`): the format object rides
  // options.textFormat for adapters whose wire has an equivalent (openai-chat response_format),
  // while the `_structuredOutput` flag keeps the web-search sidecar rendering its tool_result
  // as JSON rather than prose that could corrupt the model's schema-constrained answer.
  const textFormat = parseTextFormat(data.text);
  if (textFormat) options.textFormat = textFormat;

  return {
    modelId: data.model,
    ...(data.previous_response_id ? { previousResponseId: data.previous_response_id } : {}),
    context,
    stream: data.stream === true,
    options,
    _rawBody: body,
    ...(replayedInputPrefixLength > 0 ? { _replayPrefixLen: replayedInputPrefixLength } : {}),
    ...(continuationConversationMessageIndex !== undefined
      ? { _continuationConversationMessageIndex: continuationConversationMessageIndex }
      : {}),
    ...(webSearch ? { _webSearch: webSearch } : {}),
    ...(imageGen ? { _imageGeneration: imageGen } : {}),
    ...(textFormat ? { _structuredOutput: true } : {}),
    ...(compactionRequest ? { _compactionRequest: true } : {}),
    ...(contextCompactionBoundary ? { _contextCompactionBoundary: true } : {}),
  };
}

/**
 * The Responses `text.format` object when it requests structured output (json_schema or
 * json_object), undefined otherwise. Acceptance is identical to the boolean detector this
 * replaces; unknown or malformed formats are ignored, never rejected, so the native
 * passthrough keeps forwarding whatever the caller sent via `_rawBody`.
 */
function parseTextFormat(text: unknown): OcxRequestOptions["textFormat"] {
  if (!isObj(text)) return undefined;
  const format = (text as { format?: unknown }).format;
  if (!isObj(format)) return undefined;
  const f = format as { type?: unknown; name?: unknown; description?: unknown; schema?: unknown; strict?: unknown };
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type !== "json_schema") return undefined;
  return {
    type: "json_schema",
    ...(typeof f.name === "string" ? { name: f.name } : {}),
    ...(typeof f.description === "string" ? { description: f.description } : {}),
    ...(isObj(f.schema) ? { schema: f.schema as Record<string, unknown> } : {}),
    ...(typeof f.strict === "boolean" ? { strict: f.strict } : {}),
  };
}
