import { expandRetainedCompactionInput } from "../../responses/retained-compaction";
import { createHash } from "node:crypto";
import { COMPACT_PROMPT, appendCheckpointContinuationNote, compactionItemToText, decodeCompactionSummary, isCompactionItemType } from "../../responses/compaction";
import { debugProviderDiagnostic } from "../../lib/debug";
import { modelInList } from "../../types";
import { isPlainObject } from "./internal";
import { activateDeferredTool } from "./tool-schema";
import { stripOpenAiOnlyWebSearchFields } from "./web-search";

/**
 * Provider-opaque replay metadata is client history, not an OpenAI input-item field (#7111).
 * The caller gates this on OpenAI-operated destinations; arbitrary gateways may accept it.
 * Strip only the known extension, never an item-field allowlist that can erase newer wire fields
 * or nested tool data. Copy on write so a later Google route can still replay its signature.
 */
export function stripProviderInputItemMetadata(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let input: unknown[] | undefined;
  for (let index = 0; index < body.input.length; index += 1) {
    const item = body.input[index];
    if (!isPlainObject(item) || !Object.hasOwn(item, "extra_content")) continue;
    const next = { ...item };
    delete next.extra_content;
    input ??= [...body.input];
    input[index] = next;
  }
  return input ? { ...body, input } : body;
}

function isUrlCitationIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Coerce a replayed citation index to a non-negative safe integer, falling back to 0. */
function repairUrlCitationIndex(value: unknown): number {
  if (isUrlCitationIndex(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const index = Number(value);
    if (isUrlCitationIndex(index)) return index;
  }
  return 0;
}

/**
 * OpenAI Responses requires `title` (string) and integer `start_index`/`end_index` on every
 * `url_citation` annotation of a replayed `output_text` part. History written by an older bridge
 * (title omitted when the search source had none) or a lossy client otherwise fails every later
 * request carrying it, most visibly remote compaction, with a deterministic HTTP 400
 * (`Missing required parameter: input[N].content[M].annotations[K].title`).
 * Repair only those fields on `url_citation` annotations of assistant message content; other
 * annotation types, unknown keys and every other item are untouched. Copy on write: an already
 * valid body is returned by reference.
 */
export function repairUrlCitationAnnotations(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let input: unknown[] | undefined;
  for (let itemIndex = 0; itemIndex < body.input.length; itemIndex += 1) {
    const item = body.input[itemIndex];
    if (!isPlainObject(item) || !Array.isArray(item.content)) continue;
    let content: unknown[] | undefined;
    for (let partIndex = 0; partIndex < item.content.length; partIndex += 1) {
      const part = item.content[partIndex];
      if (!isPlainObject(part) || part.type !== "output_text" || !Array.isArray(part.annotations)) continue;
      let annotations: unknown[] | undefined;
      for (let annIndex = 0; annIndex < part.annotations.length; annIndex += 1) {
        const ann = part.annotations[annIndex];
        if (!isPlainObject(ann) || ann.type !== "url_citation") continue;
        const titleOk = typeof ann.title === "string";
        const startOk = isUrlCitationIndex(ann.start_index);
        const endOk = isUrlCitationIndex(ann.end_index);
        if (titleOk && startOk && endOk) continue;
        const next: Record<string, unknown> = { ...ann };
        if (!titleOk) next.title = typeof ann.url === "string" ? ann.url : "";
        if (!startOk) next.start_index = repairUrlCitationIndex(ann.start_index);
        if (!endOk) next.end_index = repairUrlCitationIndex(ann.end_index);
        annotations ??= [...part.annotations];
        annotations[annIndex] = next;
      }
      if (!annotations) continue;
      content ??= [...item.content];
      content[partIndex] = { ...part, annotations };
    }
    if (!content) continue;
    input ??= [...body.input];
    input[itemIndex] = { ...item, content };
  }
  return input ? { ...body, input } : body;
}

export function stripInvalidItemIds(body: unknown): unknown {
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
  // tests/responses/responses-routed-web-search-fields.test.ts.
  { field: "external_web_access", toolTypes: new Set(["web_search", "web_search_preview"]), capabilityGated: true },
  // Deferred-discovery marker. `activateDeferredTool` clears it only for tools a `tool_search_output`
  // already loaded, so a still-deferred declaration — including one promoted out of a namespace
  // group — otherwise reaches the wire carrying it.
  { field: "defer_loading" },
];

export function stripCanonicalOnlyToolFields(body: unknown, includeCapabilityGated: boolean): unknown {
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
 * Codex keeps this ChatGPT-internal item metadata when its configured provider name is `openai`.
 * Loopback OpenCodex injection intentionally retains that provider identity for history continuity,
 * even when the proxy ultimately routes the request to a public Responses destination. Those
 * destinations reject the private field as an unknown `input[*]` parameter, so remove it at the
 * noncanonical boundary without mutating the caller-owned raw body.
 */
export function stripInternalChatMessageMetadataPassthrough(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item) || !Object.hasOwn(item, "internal_chat_message_metadata_passthrough")) {
      return item;
    }
    changed = true;
    const next = { ...item };
    delete next.internal_chat_message_metadata_passthrough;
    return next;
  });

  return changed ? { ...body, input } : body;
}

/**
 * OpenAI-private TOP-LEVEL request keys, the sibling of `CANONICAL_ONLY_TOOL_FIELDS` one level up.
 *
 * Codex attaches these on the request body itself rather than on a tool or an input item, and gates
 * them on its own auth rather than on the destination URL. Loopback injection keeps Codex pointed at
 * its built-in `openai` provider, so the client still believes it is addressing the canonical
 * ChatGPT backend and keeps the key no matter where this proxy routes the turn. A Responses gateway
 * that validates its top-level schema then rejects the whole request before inference.
 *
 * Keep this a table, and keep it to keys a client is OBSERVED to send. It is not an unknown-field
 * sanitizer: a top-level key nobody has traced to a client is forwarded untouched, because deleting
 * it would silently drop a parameter some other caller means.
 */
const CANONICAL_ONLY_TOP_LEVEL_FIELDS: readonly string[] = [
  // Cyber access program selector, new in Codex 0.155. codex-rs mints it from
  // `cyber_access_program::for_auth`, which filters on ChatGPT auth alone and never on the
  // destination base URL, and serializes it on the Responses request, the compaction input and the
  // WebSocket `response.create` envelope. No public specification defines it, so a strict
  // third-party gateway answers with an unknown-parameter error naming it, and every turn of that
  // thread fails (#4853).
  //
  // `codex_output_schema` is deliberately NOT here. In codex-rs it is the `name` of the JSON-schema
  // `text.format` object, not a top-level key, so listing it would delete a field this client never
  // sends and discard it for any client that does send it meaningfully.
  "access_programs",
];

/**
 * Remove the OpenAI-private top-level keys.
 *
 * The caller decides the boundary; see the call site in `passthrough.ts`, which applies this only
 * to a destination OpenCodex does not operate. Returns the input unchanged when no listed key is
 * present, so the common path allocates nothing and the caller-owned raw body is never mutated.
 */
export function stripCanonicalOnlyTopLevelFields(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  if (!CANONICAL_ONLY_TOP_LEVEL_FIELDS.some(field => Object.hasOwn(body, field))) return body;

  const next = { ...body };
  for (const field of CANONICAL_ONLY_TOP_LEVEL_FIELDS) delete next[field];
  return next;
}

/**
 * OpenAI-private input item TYPES, the item-level sibling of the two tables above.
 *
 * Each one is a positional control the OpenAI Responses backend interprets where it sits in
 * history, never a turn of the conversation, so dropping it leaves every message, call and output
 * in place. Codex gates sending one on its own `is_openai` provider check, which loopback
 * injection always satisfies, so a gateway this proxy does not operate can still receive one and
 * reject the whole body as an unknown item type.
 *
 * Same rule as the top-level table: only types a client is OBSERVED to send.
 */
const CANONICAL_ONLY_INPUT_ITEM_TYPES: ReadonlySet<string> = new Set([
  // Codex 0.164 `ResponseItem::ConfigurationUpdate` ({type, reasoning: {effort}}): a durable
  // reasoning-effort change recorded at its position in history. codex-rs sends it only for a
  // catalog row with `supports_reasoning_effort_updates`, and keeps it in saved history after a
  // model switch. Mapping the effort onto another provider is out of scope (#6895).
  "configuration_update",
]);

/**
 * Remove OpenAI-private input items. The caller decides the boundary, exactly as for
 * {@link stripCanonicalOnlyTopLevelFields}; the canonical and OpenAI-operated destinations keep
 * the items verbatim and in order. Returns the input unchanged when none is present.
 */
export function stripCanonicalOnlyInputItems(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const isPrivate = (item: unknown): boolean => isPlainObject(item)
    && typeof item.type === "string" && CANONICAL_ONLY_INPUT_ITEM_TYPES.has(item.type);
  if (!body.input.some(isPrivate)) return body;
  return { ...body, input: body.input.filter(item => !isPrivate(item)) };
}

/**
 * Sampling fields a model on the provider's `noStopModels` / `noPenaltyModels` list rejects on
 * every wire. Claude inbound translates `stop_sequences` into a Responses `stop`
 * (`src/claude/inbound.ts`), and a direct Responses caller can send penalties. Some listed models
 * only have the Responses wire (xAI grok-4.20-multi-agent-0309 answers Chat Completions with 400),
 * so the Chat adapter's omission cannot cover them. Returns the input unchanged when nothing is
 * removed, so the caller-owned raw body is never mutated.
 */
export function stripRejectedSamplingParams(
  body: unknown,
  provider: { noStopModels?: string[]; noPenaltyModels?: string[] },
  modelId: string,
): unknown {
  if (!isPlainObject(body)) return body;
  const dropStop = Object.hasOwn(body, "stop") && modelInList(provider.noStopModels, modelId);
  const penalties = ["presence_penalty", "frequency_penalty"].filter(field => Object.hasOwn(body, field));
  const dropPenalties = penalties.length > 0 && modelInList(provider.noPenaltyModels, modelId);
  if (!dropStop && !dropPenalties) return body;
  const next = { ...body };
  if (dropStop) delete next.stop;
  if (dropPenalties) for (const field of penalties) delete next[field];
  return next;
}

/**
 * When `store: false`, the upstream cannot retrieve stored turns by ID. An ID
 * forwarded in `input` is then interpreted as a reference to a stored item that does not
 * exist, producing a 404. Strip all item IDs in this case unless `preserveIds` is true
 * — `call_id` pairing is unaffected. Also repairs missing or broken xAI custom_tool_call IDs
 * when `requireCustomCallIds` is true, regardless of `preserveIds`.
 * Matches codex-rs behavior (core/src/client.rs:918-925).
 */
export function stripItemIdsWhenUnstored(
  body: unknown,
  requireCustomCallIds = false,
  preserveIds = false,
): unknown {
  const repairCustomCallIds = requireCustomCallIds === true;
  if (!isPlainObject(body) || (body.store !== false && !repairCustomCallIds)) return body;
  if (!Array.isArray(body.input)) return body;

  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainObject(item)) return item;
    if (repairCustomCallIds && item.type === "custom_tool_call") {
      try {
        if (typeof item.id === "string" && item.id.startsWith("ctc_")) return item;
        if (
          typeof item.call_id !== "string"
          || typeof item.name !== "string"
          || typeof item.input !== "string"
        ) return item;
        const digest = createHash("sha256")
          .update(JSON.stringify([item.call_id, item.name, item.input]))
          .digest("hex")
          .slice(0, 40);
        changed = true;
        debugProviderDiagnostic("openai-responses", "xai-custom-tool-call-id-repaired", {
          hadId: typeof item.id === "string",
        });
        return { ...item, id: `ctc_${digest}` };
      } catch {
        debugProviderDiagnostic("openai-responses", "xai-custom-tool-call-id-unrepaired", {});
        return item;
      }
    }
    if (preserveIds || body.store !== false || !("id" in item)) return item;
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
 * turn, and only the backend that minted it can decode it. Proxy-minted `ocx1:` and structured `ocx2:` envelopes are
 * transparent base64 rather than encryption, so no upstream can read them and they always become
 * plain user messages. Native blobs have multiple possible minters, so a destination's ability to
 * decode its own blobs does not make a blob from a previous serving identity portable. On a known
 * identity mismatch the blob degrades to the same note the bridged parser uses, even when the
 * destination normally accepts native blobs. Without a known mismatch, the destination capability
 * keeps the existing behavior.
 *
 * A bare `context_compaction` marker carries no blob and is forwarded untouched.
 */
export function scrubOcxCompactionItems(
  body: unknown,
  destinationDecodesNativeBlob: boolean,
  threadServingIdentityChanged: boolean,
  addContinuationNote = false,
): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;

  const expanded = expandRetainedCompactionInput(body.input) as unknown[];
  let changed = expanded !== body.input;
  let decodedCheckpoint = false;
  const input = expanded.map(item => {
    if (!isPlainObject(item) || !isCompactionItemType(item.type)) return item;
    const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
    if (encrypted === undefined) return item;
    if (
      decodeCompactionSummary(encrypted) === null
      && destinationDecodesNativeBlob
      && !threadServingIdentityChanged
    ) return item;
    changed = true;
    if (decodeCompactionSummary(encrypted) !== null) decodedCheckpoint = true;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: compactionItemToText(encrypted) }],
    };
  });

  if (!changed) return body;
  // #6764: a decoded checkpoint is plain user text from here on, so name its role in the
  // instructions. Compaction requests skip this; the summarizer must not be told to continue.
  return addContinuationNote && decodedCheckpoint
    ? { ...body, input, instructions: appendCheckpointContinuationNote(body.instructions) }
    : { ...body, input };
}
