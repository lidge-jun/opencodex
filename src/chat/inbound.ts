/**
 * Chat Completions inbound: OpenAI-compatible request -> internal /v1/responses body.
 *
 * Used by GitHub Copilot App (and other OpenAI-compatible clients) via POST /v1/chat/completions.
 * Same translate-and-replay pattern as Claude Messages: the produced body must pass
 * responsesRequestSchema so routing/OAuth/pool/sidecars are inherited unchanged.
 */
import { chatImageUrlFromPart } from "./image-parts";
import { untranslatedChatInputMedia, untranslatedInputMediaMessage } from "../responses/input-media";

export class ChatCompletionsRequestError extends Error {}

type Rec = Record<string, unknown>;
type ChatCompletionsRoutingBody = Rec & { model: string; messages: unknown[] };

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Validate only the fields needed before Chat routing, without projecting the body. */
export function assertChatCompletionsRoutingBody(raw: unknown): asserts raw is ChatCompletionsRoutingBody {
  if (!isRec(raw)) throw new ChatCompletionsRequestError("request body must be a JSON object");
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    throw new ChatCompletionsRequestError("model is required");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new ChatCompletionsRequestError("messages must be a non-empty array");
  }
}

// "none" is the runtime's disable sentinel, not an unknown value: src/reasoning-effort.ts
// accepts it and maps it to "omit the reasoning parameter", and the Pi client export maps
// Pi's "off" thinking level onto it (src/clients/config-export.ts). Dropping it here let a
// provider default re-enable thinking the caller had explicitly turned off — and for the
// Anthropic families that think by default, omission is not the same as disabled.
const OUTPUT_CONFIG_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const OUTPUT_CONFIG_SUMMARIES = new Set(["auto", "concise", "detailed", "none"]);

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push(raw);
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "input_text" || raw.type === "output_text") && typeof raw.text === "string") {
      parts.push(raw.text);
    }
  }
  return parts.join("\n");
}

// Recognition moved to src/chat/image-parts.ts so the native fast path's
// route-eligibility predicate and this translator cannot drift apart again.
const imageUrlFromPart = chatImageUrlFromPart;

function videoUrlFromPart(part: Rec): string | null {
  if (part.type !== "video_url") return null;
  const videoUrl = part.video_url;
  if (typeof videoUrl === "string" && videoUrl.length > 0) return videoUrl;
  if (isRec(videoUrl) && typeof videoUrl.url === "string" && videoUrl.url.length > 0) return videoUrl.url;
  return null;
}

function userContentToBlocks(content: unknown): Rec[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Rec[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "input_text", text: raw });
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "input_text" || raw.type === "output_text") && typeof raw.text === "string") {
      blocks.push({ type: "input_text", text: raw.text });
      continue;
    }
    const imageUrl = imageUrlFromPart(raw);
    if (imageUrl) {
      const detail = isRec(raw.image_url) ? raw.image_url.detail : raw.detail;
      blocks.push({
        type: "input_image",
        image_url: imageUrl,
        ...(detail === "auto" || detail === "low" || detail === "high" ? { detail } : {}),
      });
      continue;
    }
    const videoUrl = videoUrlFromPart(raw);
    if (videoUrl) {
      blocks.push({ type: "input_video", video_url: videoUrl });
      continue;
    }
    const file = fileFromPart(raw);
    if (file) blocks.push(file);
  }
  return blocks;
}

/**
 * A Chat Completions `file` part carrying inline bytes, as the Responses `input_file` block.
 *
 * Nothing here recognized the shape, so the part reached the end of the loop with no branch and
 * was dropped in silence (#5212). A part with no inline bytes is still not translatable and is
 * left to the untranslated-media refusal, which runs before this loop.
 */
function fileFromPart(part: Rec): Rec | null {
  if (part.type !== "file" && part.type !== "input_file") return null;
  const file = isRec(part.file) ? part.file : part;
  const fileData = file.file_data;
  if (typeof fileData !== "string" || fileData.length === 0) return null;
  const filename = typeof file.filename === "string" && file.filename.length > 0 ? file.filename : undefined;
  return { type: "input_file", file_data: fileData, ...(filename ? { filename } : {}) };
}

/**
 * The assistant's prior thinking, as plaintext, from either Chat spelling.
 *
 * The outbound direction already reconstructs these for providers listed in
 * `preserveReasoningContentModels` (src/adapters/openai-chat.ts), so a client
 * replaying a turn sends them back. Dropping them here made the round trip lossy and
 * left interleaved-thinking providers seeing a bare continuation.
 *
 * Only representable plaintext is read. No signature, encrypted payload or
 * provider-issued item id is reconstructed — see the reasoning item built below.
 */
function assistantReasoningText(msg: Rec): string | undefined {
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    return msg.reasoning_content;
  }
  if (Array.isArray(msg.reasoning_details)) {
    const segments: string[] = [];
    for (const raw of msg.reasoning_details) {
      if (isRec(raw) && typeof raw.text === "string" && raw.text.length > 0) segments.push(raw.text);
    }
    if (segments.length > 0) return segments.join("");
  }
  return undefined;
}

function assistantContentToBlocks(content: unknown): Rec[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "output_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Rec[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "output_text", text: raw });
      continue;
    }
    if (!isRec(raw)) continue;
    if ((raw.type === "text" || raw.type === "output_text") && typeof raw.text === "string") {
      blocks.push({ type: "output_text", text: raw.text });
    }
  }
  return blocks;
}

function pushSystemText(parts: string[], content: unknown): void {
  const text = contentToText(content).trim();
  if (text) parts.push(text);
}

/**
 * A mid-conversation instruction, as the input item the rest of the pipeline already reads.
 *
 * The role is `developer` rather than `system` for two reasons that both bite. The native
 * ChatGPT backend refuses a `role:"system"` item inside `input`, and canonical forwarding
 * folds every message-shaped `system` item back onto `instructions`
 * (src/adapters/openai-responses/canonical-forward.ts), which would undo the placement one hop
 * later. `developer` is first-class in responsesRequestSchema, survives parseRequest as a
 * chronological conversation message, and is exactly what src/claude/inbound.ts already emits
 * for the same shape.
 */
function developerInstructionItem(text: string): Rec {
  return { type: "message", role: "developer", content: [{ type: "input_text", text }] };
}

function toolCallsToItems(
  toolCalls: unknown,
  input: Rec[],
  knownNameByCallId: Map<string, string>,
  awaitingToolResult: Set<string>,
): void {
  if (!Array.isArray(toolCalls)) return;
  for (const raw of toolCalls) {
    if (!isRec(raw)) continue;
    const fn = isRec(raw.function) ? raw.function : null;
    let name = typeof fn?.name === "string" ? fn.name : typeof raw.name === "string" ? raw.name : "";
    const args = typeof fn?.arguments === "string"
      ? fn.arguments
      : typeof raw.arguments === "string"
        ? raw.arguments
        : JSON.stringify(fn?.arguments ?? raw.arguments ?? {});
    const callId = typeof raw.id === "string" && raw.id.length > 0
      ? raw.id
      : typeof raw.call_id === "string" && raw.call_id.length > 0
        ? raw.call_id
        : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    if (!name) name = knownNameByCallId.get(callId) ?? "";
    if (!name) throw new ChatCompletionsRequestError("tool_calls entries require function.name");
    knownNameByCallId.set(callId, name);
    input.push({ type: "function_call", call_id: callId, name, arguments: args });
    awaitingToolResult.add(callId);
  }
}

function toolsToResponses(tools: unknown): Rec[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRec(raw)) continue;
    if (raw.type === "function" && typeof raw.name === "string" && raw.name.length > 0) {
      out.push({
        type: "function",
        name: raw.name,
        ...(typeof raw.description === "string" ? { description: raw.description } : {}),
        ...(isRec(raw.parameters) ? { parameters: raw.parameters } : {}),
        ...(typeof raw.strict === "boolean" ? { strict: raw.strict } : {}),
      });
      continue;
    }
    if (raw.type === "function" && isRec(raw.function) && typeof raw.function.name === "string" && raw.function.name.length > 0) {
      out.push({
        type: "function",
        name: raw.function.name,
        ...(typeof raw.function.description === "string" ? { description: raw.function.description } : {}),
        ...(isRec(raw.function.parameters) ? { parameters: raw.function.parameters } : {}),
        ...(typeof raw.function.strict === "boolean" ? { strict: raw.function.strict } : {}),
      });
      continue;
    }
    if (raw.type === "web_search" || raw.type === "web_search_preview") {
      out.push({ type: "web_search" });
    }
  }
  return out.length > 0 ? out : undefined;
}

function toolChoiceToResponses(choice: unknown, body: Rec): void {
  if (choice === undefined || choice === null) return;
  if (choice === "auto" || choice === "none" || choice === "required") {
    body.tool_choice = choice;
    return;
  }
  if (!isRec(choice)) return;
  if (choice.type === "function") {
    const name = typeof choice.name === "string"
      ? choice.name
      : isRec(choice.function) && typeof choice.function.name === "string"
        ? choice.function.name
        : "";
    if (!name) throw new ChatCompletionsRequestError("tool_choice.function requires a name");
    body.tool_choice = { type: "function", name };
    return;
  }
  if (choice.type === "allowed_tools") {
    body.tool_choice = allowedToolsChoiceToResponses(choice);
    return;
  }
  if (isRec(choice.function) && typeof choice.function.name === "string") {
    body.tool_choice = { type: "function", name: choice.function.name };
  }
}

/**
 * Chat Completions nests the subset under `allowed_tools`, Responses carries `mode`/`tools`
 * on the choice itself, and each entry names its tool under a member keyed by its own type
 * (`{"type":"function","function":{"name"}}`) rather than a flat `name`. Neither level lines up
 * with `mapToolChoice`, so an unflattened choice fell past every branch and the caller's subset
 * was dropped while the full catalogue was still advertised (#5211).
 *
 * An entry nobody can name is refused rather than skipped: dropping one widens the very subset
 * the caller sent this field to narrow.
 */
function allowedToolsChoiceToResponses(choice: Rec): Rec {
  const spec = isRec(choice.allowed_tools) ? choice.allowed_tools : choice;
  if (!Array.isArray(spec.tools) || spec.tools.length === 0) {
    throw new ChatCompletionsRequestError("tool_choice.allowed_tools requires a non-empty tools array");
  }
  return {
    type: "allowed_tools",
    mode: spec.mode === "required" ? "required" : "auto",
    tools: spec.tools.map(allowedToolEntryToResponses),
  };
}

/** Hosted entries are named by their type alone; a function or custom entry must carry a name. */
const HOSTED_ALLOWED_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "image_generation",
  "image_gen",
  "tool_search",
]);
const NAMED_ALLOWED_TOOL_TYPES = new Set(["function", "custom"]);

function allowedToolEntryToResponses(raw: unknown): Rec {
  if (!isRec(raw)) {
    throw new ChatCompletionsRequestError("tool_choice.allowed_tools.tools entries must be objects");
  }
  const type = typeof raw.type === "string" && raw.type.length > 0 ? raw.type : "function";
  if (!NAMED_ALLOWED_TOOL_TYPES.has(type) && !HOSTED_ALLOWED_TOOL_TYPES.has(type)) {
    // An unknown selector kind is not a narrower subset, it is a subset nobody can evaluate.
    throw new ChatCompletionsRequestError(`unsupported tool_choice.allowed_tools.tools entry type: ${type}`);
  }
  const nested = isRec(raw[type]) ? raw[type] as Rec : undefined;
  const name = typeof raw.name === "string" && raw.name.length > 0
    ? raw.name
    : nested !== undefined && typeof nested.name === "string" && nested.name.length > 0
      ? nested.name
      : undefined;
  if (name !== undefined) return { type, name };
  if (HOSTED_ALLOWED_TOOL_TYPES.has(type)) return { type };
  throw new ChatCompletionsRequestError("tool_choice.allowed_tools.tools entries require a name");
}

function responseFormatToText(format: unknown): Rec | undefined {
  if (format === undefined) return undefined;
  if (!isRec(format)) throw new ChatCompletionsRequestError("response_format must be an object");
  if (format.type === "json_object") return { format: { type: "json_object" } };
  if (format.type === "json_schema") {
    if (!isRec(format.json_schema)) {
      throw new ChatCompletionsRequestError("response_format.json_schema is required for type json_schema");
    }
    const schema = format.json_schema;
    return {
      format: {
        type: "json_schema",
        name: typeof schema.name === "string" ? schema.name : "response",
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
        ...(schema.schema !== undefined ? { schema: schema.schema } : {}),
        ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
      },
    };
  }
  if (format.type === "text") return undefined;
  throw new ChatCompletionsRequestError(`unsupported response_format.type: ${String(format.type)}`);
}

function resolveReasoningEffort(raw: Rec): string | undefined {
  if (typeof raw.reasoning_effort === "string" && OUTPUT_CONFIG_EFFORTS.has(raw.reasoning_effort)) {
    return raw.reasoning_effort;
  }
  if (isRec(raw.reasoning) && typeof raw.reasoning.effort === "string" && OUTPUT_CONFIG_EFFORTS.has(raw.reasoning.effort)) {
    return raw.reasoning.effort;
  }
  return undefined;
}

/**
 * Chat Completions clients (Grok Build, Copilot, OpenAI-compatible SDKs) expect
 * `delta.reasoning_content` whenever the model thinks. The internal Responses
 * parser hides thinking unless `reasoning.summary` is set and is not `"none"`.
 * Map the common Chat Completions knobs onto that field. When the client only
 * sent an effort, default the summary to `"auto"` so traces are not swallowed.
 */
function resolveReasoningSummary(raw: Rec): string | undefined {
  if (isRec(raw.reasoning) && typeof raw.reasoning.summary === "string" && OUTPUT_CONFIG_SUMMARIES.has(raw.reasoning.summary)) {
    return raw.reasoning.summary;
  }
  if (raw.include_reasoning === false) return "none";
  if (raw.include_reasoning === true) return "auto";
  return undefined;
}

/**
 * Translate an OpenAI Chat Completions request body into a /v1/responses request body.
 * Throws ChatCompletionsRequestError (-> 400) on malformed input.
 */
export function chatCompletionsToResponsesBody(raw: unknown): Rec {
  assertChatCompletionsRoutingBody(raw);
  // Only the translated path reaches this function. Native Chat can retain its
  // provider-specific file/audio blocks; projecting them here would discard them.
  const unsupportedMedia = untranslatedChatInputMedia(raw);
  if (unsupportedMedia) {
    throw new ChatCompletionsRequestError(untranslatedInputMediaMessage(unsupportedMedia));
  }


  const systemParts: string[] = [];
  const input: Rec[] = [];
  // Recover replace-style tool calls incrementally instead of rebuilding the
  // call-id index from the entire translated transcript for every message.
  const knownNameByCallId = new Map<string, string>();
  // Tool calls whose result has not arrived yet. Several adapters need a call and its output
  // to stay adjacent — Kiro refuses an interrupted pair (src/adapters/kiro/payload.ts) and the
  // Anthropic and Google mappers synthesize a missing result — so an instruction that arrives
  // inside an open batch waits for the batch to drain instead of splitting it.
  const awaitingToolResult = new Set<string>();
  const heldInstructions: string[] = [];
  const releaseHeldInstructions = (): void => {
    if (heldInstructions.length === 0) return;
    input.push(developerInstructionItem(heldInstructions.join("\n\n")));
    heldInstructions.length = 0;
  };
  // A user or assistant turn ends any open tool batch, so held text rejoins the timeline
  // before that turn rather than drifting past it.
  const beginConversationTurn = (): void => {
    releaseHeldInstructions();
    awaitingToolResult.clear();
  };

  for (const msg of raw.messages) {
    if (!isRec(msg)) continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    switch (role) {
      case "system":
      case "developer": {
        // A leading block is this request's instructions and keeps that treatment: it is the
        // prompt head, and hoisting it is what the upstream prefix cache wants.
        if (input.length === 0) {
          pushSystemText(systemParts, msg.content);
          break;
        }
        // Past the first turn the slot carries meaning. `U1 -> A1 -> D2 -> U2` says D2 applies
        // to U2 and not to U1, and folding it into `instructions` moved it ahead of both while
        // rewriting the prompt head on every turn that carried one. The outbound adapter has
        // preserved this slot since #4161; the position was already gone by the time it ran.
        const text = contentToText(msg.content).trim();
        if (!text) break;
        if (awaitingToolResult.size > 0) heldInstructions.push(text);
        else input.push(developerInstructionItem(text));
        break;
      }
      case "user": {
        beginConversationTurn();
        const blocks = userContentToBlocks(msg.content);
        if (blocks.length > 0) input.push({ type: "message", role: "user", content: blocks });
        break;
      }
      case "assistant": {
        beginConversationTurn();
        // A reasoning item precedes the assistant message it belongs to: the
        // Responses assistant item schema admits only output content blocks, so there
        // is no attachment point on the message itself, and the parser buffers a
        // reasoning item and prepends it to the NEXT assistant message. Emitting it
        // here keeps that adjacency intact.
        const reasoningText = assistantReasoningText(msg);
        if (reasoningText !== undefined) {
          // `summary` is required on a reasoning input item by the OpenAI Responses API, and our
          // own responsesRequestSchema marks it optional, so a summary-less item validated locally
          // and was refused upstream with `Missing required parameter: 'input[N].summary'`. It also
          // has to carry the text, not just satisfy the field: sanitizeReasoningInputContent blanks
          // `content` for every destination except a `preserveResponsesReasoningContent` provider,
          // so summary is the only channel that survives to a native backend. This mirrors the
          // Claude ingress (src/claude/inbound.ts), which has always minted both.
          input.push({
            type: "reasoning",
            summary: [{ type: "summary_text", text: reasoningText }],
            content: [{ type: "reasoning_text", text: reasoningText }],
          });
        }
        const blocks = assistantContentToBlocks(msg.content);
        if (blocks.length > 0) input.push({ type: "message", role: "assistant", content: blocks });
        if (msg.tool_calls !== undefined) {
          toolCallsToItems(msg.tool_calls, input, knownNameByCallId, awaitingToolResult);
        }
        break;
      }
      case "function": {
        // Native eligibility diverts legacy image results too, but this translator
        // has no legacy function_call/name pairing. Never silently discard them.
        if (Array.isArray(msg.content) && msg.content.some(part => isRec(part) && imageUrlFromPart(part))) {
          throw new ChatCompletionsRequestError(
            "Legacy function-result image translation is not implemented. Use tool_calls and role:tool with tool_call_id.",
          );
        }
        break;
      }
      case "tool": {
        const callId = typeof msg.tool_call_id === "string" ? msg.tool_call_id
          : typeof msg.tool_use_id === "string" ? msg.tool_use_id
          : "";
        if (!callId) throw new ChatCompletionsRequestError("tool messages require tool_call_id");
        const blocks = userContentToBlocks(msg.content);
        const output = blocks.some(part => part.type === "input_image")
          ? blocks.filter(part => part.type === "input_text" || part.type === "input_image")
          : contentToText(msg.content);
        input.push({ type: "function_call_output", call_id: callId, output });
        awaitingToolResult.delete(callId);
        if (awaitingToolResult.size === 0) releaseHeldInstructions();
        break;
      }
      default:
        break;
    }
  }
  releaseHeldInstructions();

  if (input.length === 0 && systemParts.length === 0) {
    throw new ChatCompletionsRequestError("messages must include at least one user/assistant/tool turn");
  }

  const body: Rec = {
    model: raw.model,
    input,
    stream: raw.stream === true,
    store: false,
  };

  if (systemParts.length > 0) body.instructions = systemParts.join("\n\n");

  const tools = toolsToResponses(raw.tools);
  if (tools) body.tools = tools;
  toolChoiceToResponses(raw.tool_choice, body);

  const maxTokens = typeof raw.max_completion_tokens === "number"
    ? raw.max_completion_tokens
    : typeof raw.max_tokens === "number"
      ? raw.max_tokens
      : undefined;
  if (typeof maxTokens === "number") body.max_output_tokens = maxTokens;
  if (typeof raw.temperature === "number") body.temperature = raw.temperature;
  if (typeof raw.top_p === "number") body.top_p = raw.top_p;
  // responsesRequestSchema accepts both, parser.ts reads them into
  // options.presencePenalty/frequencyPenalty, and the openai-chat adapter writes them
  // back to the wire. Only this first link was missing, so a Chat caller's penalties
  // never reached a provider that supports them. Per-model noPenaltyModels opt-outs
  // still apply at the adapter.
  if (typeof raw.presence_penalty === "number") body.presence_penalty = raw.presence_penalty;
  if (typeof raw.frequency_penalty === "number") body.frequency_penalty = raw.frequency_penalty;
  if (raw.stop !== undefined) body.stop = raw.stop;
  if (typeof raw.user === "string") body.user = raw.user;
  if (typeof raw.parallel_tool_calls === "boolean") body.parallel_tool_calls = raw.parallel_tool_calls;
  if (typeof raw.service_tier === "string") body.service_tier = raw.service_tier;
  if (typeof raw.prompt_cache_key === "string") body.prompt_cache_key = raw.prompt_cache_key;
  if (raw.metadata !== undefined) body.metadata = raw.metadata;

  const effort = resolveReasoningEffort(raw);
  const summary = resolveReasoningSummary(raw);
  if (effort || summary !== undefined) {
    body.reasoning = {
      ...(effort ? { effort } : {}),
      summary: summary ?? "auto",
    };
  }

  const text = responseFormatToText(raw.response_format);
  if (text) body.text = text;

  return body;
}
