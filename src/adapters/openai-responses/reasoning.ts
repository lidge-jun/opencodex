import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig, type OcxUsage, type TierDecision } from "../../types";
import { catalogModelSupportsReasoningSummaries } from "../../codex/catalog";
import { OCX_REASONING_PREFIX } from "../../responses/reasoning-envelope";
import { configuredReasoningEfforts, mapReasoningEffort, modelRecordValue } from "../../reasoning-effort";
import { isPlainObject } from "./internal";

/** Drop only replayed Responses reasoning items; all other continuation input stays untouched. */
export function dropResponsesReasoningInputItems(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const input = body.input.filter(item => !isPlainObject(item) || item.type !== "reasoning");
  return input.length === body.input.length ? body : { ...body, input };
}

/** Whether the item already carries a non-empty `reasoning_text` content part. */
function hasPlaintextReasoningContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(part =>
    isPlainObject(part)
    && part.type === "reasoning_text"
    && typeof part.text === "string"
    && part.text.length > 0
  );
}

/**
 * Backfill for a reasoning item that would reach a plaintext-required wire with no
 * `reasoning_text`: its text lived only in ciphertext the provider cannot read and was
 * stripped, so replay the item's `summary_text` as `reasoning_text` — real model output,
 * unlike a fabricated chain — and fall back to the same minimal placeholder the chat
 * adapter emits for `requiresReasoningPlaceholderModels` (#5421). DeepSeek's thinking
 * mode answers a bare emptied item with `The reasoning_text in the thinking mode must
 * be passed back to the API` and aborts the turn.
 */
function plaintextReasoningBackfill(rec: Record<string, unknown>): unknown[] {
  const fromSummary = Array.isArray(rec.summary)
    ? rec.summary
        .filter(part => isPlainObject(part)
          && part.type === "summary_text"
          && typeof part.text === "string"
          && part.text.length > 0)
        .map(part => ({ type: "reasoning_text", text: part.text }))
    : [];
  return fromSummary.length > 0 ? fromSummary : [{ type: "reasoning_text", text: " " }];
}

/**
 * Sanitize reasoning input by field policy, not by preserving each item's shape. Retaining a
 * native `encrypted_content` guarantees only that blob value: `status` is always removed;
 * proxy-owned `ocxr1:` envelopes are always removed; and native blobs are removed when the caller
 * requests stripping after a route-identity change or opaque-blob recovery. On routed/non-OpenAI
 * destinations, a present non-array `content` field is omitted. Otherwise non-empty array content
 * is blanked unless raw reasoning preservation is enabled; removing an `ocxr1:` envelope selects
 * the same blanking path when non-array omission is not active.
 *
 * A reasoning item that arrives with no `summary` key at all also gets an empty one. The field is
 * required on a reasoning input item by the Responses API — a missing one is refused with
 * `Missing required parameter: 'input[N].summary'` before inference — while
 * responsesRequestSchema marks it optional, so such an item passes every local gate and fails only
 * on the wire. This is not gated on the destination, because it reshapes nothing a canonical
 * backend issued: every reasoning item Codex and this proxy emit already carries `summary`, so an
 * item missing the key came from a translated ingress (`/v1/chat/completions`, `/v1/messages`) or
 * a third-party client, and injecting the empty array is the whole shape it was missing.
 */
export function sanitizeReasoningInputContent(
  body: unknown,
  opts?: {
    preserveRawReasoningContent?: boolean;
    dropNullContentChannel?: boolean;
    stripEncryptedContent?: boolean;
    /**
     * Remove `id` from every reasoning item, with or without a blob, because the ids name items in a
     * store this destination cannot read; see `OcxParsedRequest._dropForeignReasoningItemIds`.
     */
    dropForeignItemId?: boolean;
    /**
     * The destination documents a strict plaintext-replay contract (DeepSeek's Responses
     * thinking mode): every reasoning input item must carry `reasoning_text` content.
     * An item left with none is backfilled from its summary, or with a minimal
     * placeholder, rather than emitted in the shape the upstream 400s on.
     */
    requirePlaintextReasoning?: boolean;
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
    const missingSummary = !Object.prototype.hasOwnProperty.call(rec, "summary");
    const stripEncryptedContent = hasOcxEnvelope
      || (opts?.stripEncryptedContent === true && hasEncryptedContent);
    // An id-only item is as foreign as one with a blob: a stateful destination still resolves it
    // against its own store.
    const dropItemId = opts?.dropForeignItemId === true
      && Object.prototype.hasOwnProperty.call(rec, "id");
    // Codex serializes an absent reasoning content channel as `"content": null`. The field is
    // optional and null carries nothing, but a strict gateway rejects the item on its declared type
    // — xAI answers `Could not decode the compaction blob`, naming the sibling `encrypted_content`
    // rather than the field it actually refused, which is why this reads as a blob failure. Drop the
    // key so the item matches the shape the upstream issued.
    //
    // Gated to routed destinations. An OpenAI-operated backend rejects a blob-bearing item when its
    // null `content` channel is deleted (`The encrypted content ... could not be verified`); that
    // live result establishes this channel constraint, not whole-item shape preservation. The gate
    // is also why this drop may touch an item that keeps its blob: xAI demonstrably accepts its own
    // blob without the null channel. This is independent of the output-only status removal below.
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
    // A strict plaintext-replay destination cannot consume a reasoning item emptied of its
    // `reasoning_text` — the resumed-subagent shape (#5421), where the text lived only in
    // ciphertext the provider cannot read. Backfill after every other strip has run.
    const missingPlaintextReasoning = opts?.requirePlaintextReasoning === true
      && !hasPlaintextReasoningContent(rec.content);
    if (
      !blankContent && !stripOutputStatus && !stripEncryptedContent && !dropNullContentChannel
      && !missingSummary && !dropItemId && !missingPlaintextReasoning
    ) {
      return item;
    }
    changed = true;
    const next: Record<string, unknown> = { ...rec };
    if (missingSummary) next.summary = [];
    if (dropNullContentChannel) delete next.content;
    if (stripOutputStatus) delete next.status;
    if (stripEncryptedContent) delete next.encrypted_content;
    if (dropItemId) delete next.id;
    // Routed models can produce raw `reasoning_text` output items. Codex echoes those in later
    // native GPT requests, but ChatGPT's Responses backend accepts reasoning input only with empty
    // `content`; keep summaries/ids and drop the raw content so native passthrough does not 400.
    // DeepSeek's Responses API instead ACCEPTS plaintext reasoning replay (its compatibility
    // guide merges reasoning items into the adjacent assistant message), so providers flagged
    // `preserveResponsesReasoningContent` keep it — deleting valid replay content there breaks
    // continuations after tool calls (issue #875 family).
    if (blankContent) next.content = [];
    if (missingPlaintextReasoning) next.content = plaintextReasoningBackfill(next);
    return next;
  });

  return changed ? { ...raw, input } : body;
}

export function stripUnsupportedReasoningSummaryDelivery(body: unknown, modelId: string): unknown {
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

/**
 * A false model capability prevents Codex from emitting summary fields after the catalog refresh.
 * Strip them here as well so an already-running client with a stale catalog cannot keep sending an
 * upstream-rejected `reasoning_summary_delivery` value (issue #323).
 */
export function stripDisabledReasoningSummaries(
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
 * Hide a no-op Responses verbosity control from the wire as well as the catalog. This runs at
 * final serialization so a stale catalog or direct caller cannot bypass the capability. Other
 * `text` settings (notably structured-output `format`) remain untouched.
 */
export function stripDisabledVerbosity(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): unknown {
  if (modelRecordValue(provider.modelSupportsVerbosity, modelId) !== false || !isPlainObject(body)) {
    return body;
  }
  if (!isPlainObject(body.text) || !Object.hasOwn(body.text, "verbosity")) return body;
  const { verbosity: _verbosity, ...rest } = body.text;
  return {
    ...body,
    ...(Object.keys(rest).length > 0 ? { text: rest } : { text: undefined }),
  };
}

/**
 * Normalize only the delivery enum Codex already emitted. Do not inject a field into callers that
 * did not request summaries, and leave every unconfigured provider/model byte-for-byte unchanged.
 */
export function normalizeConfiguredReasoningSummaryDelivery(
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
 * Apply the routed provider's real effort ladder to an existing Responses reasoning field.
 * Native forward requests keep the server-owned native clamp; unknown third-party ladders stay
 * byte-equivalent instead of acquiring a policy from this adapter.
 */
export function mapRoutedResponsesReasoningEffort(
  body: unknown,
  provider: OcxProviderConfig,
  modelId: string,
): unknown {
  if (provider.authMode === "forward") return body;
  if (configuredReasoningEfforts(provider, modelId) === undefined) return body;
  if (!isPlainObject(body) || !isPlainObject(body.reasoning)) return body;
  const declaredEfforts = modelRecordValue(provider.modelReasoningEfforts, modelId) ?? provider.reasoningEfforts;
  // An explicitly empty ladder means no effort control, not no reasoning output.
  // Omit only effort so the upstream default applies; unknown/non-rankable ladders stay untouched.
  if (declaredEfforts?.length === 0 && Object.hasOwn(body.reasoning, "effort")) {
    const { effort: _effort, ...reasoning } = body.reasoning;
    return { ...body, reasoning: Object.keys(reasoning).length > 0 ? reasoning : undefined };
  }
  const requested = body.reasoning.effort;
  if (typeof requested !== "string") return body;

  const mapped = mapReasoningEffort(provider, modelId, requested);
  if (!mapped || mapped === requested) return body;
  return { ...body, reasoning: { ...body.reasoning, effort: mapped } };
}
