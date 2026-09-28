/**
 * Devin / Cognition / Windsurf adapter.
 *
 * Uses the unofficial cloud-direct Connect-RPC client (GetChatMessage).
 * OpenCodex injects the OAuth API key onto provider.apiKey
 * before runTurn. This adapter maps OcxContext <-> ChatHistoryItem and
 * streams CloudChatEvent into AdapterEvent.
 */
import type { AdapterEvent, OcxAssistantMessage, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTool, OcxToolCall, OcxToolResultMessage, OcxUsage } from "../types";
import { namespacedToolName } from "../types";
import type { IncomingMeta, ProviderAdapter } from "./base";
import { streamChatEventsWithResetRetry, devinStatedResetWaitMs, allocateCascadeId, CloudChatError, type ChatHistoryItem, type ToolDef } from "./devin/cloud-direct";
import type { ContentPart } from "./devin/cloud-direct/chat";
import { getCachedCatalog, type CacheEntry, type ModelCatalogEntry } from "./devin/cloud-direct/catalog";
import { collapseDevinModelUid, devinFamiliesOf, devinFamilyBaseId, selectDevinFamilyMember, type DevinVariantRequest } from "./devin/live-models";
import { buildNonOpenAIToolCatalogNudgeForTools } from "./tool-catalog-nudge";
import { DEVIN_DEFAULT_API_SERVER, resolveDevinApiServer } from "../oauth/devin";
import { isProviderIssuedThinkingSignature } from "../responses/reasoning-envelope";
import { SendBudgetExhaustedError } from "../lib/upstream-retry";
import { devinContextOverflowEvent, isDevinHistoryOverflow } from "./devin/context-overflow";

/**
 * Combine two usage frames from one turn by keeping the larger count per field.
 *
 * Devin's counters are cumulative within a turn, so a frame that reports less
 * than an earlier one is reporting a subset, not a correction.
 */
export function mergeDevinUsage(previous: OcxUsage, next: OcxUsage): OcxUsage {
  const keys = [
    "inputTokens", "outputTokens",
    "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
    "reasoningOutputTokens",
  ] as const;
  const merged: OcxUsage = { ...previous, ...next };
  for (const key of keys) {
    const a = previous[key];
    const b = next[key];
    if (typeof a === "number" && typeof b === "number") merged[key] = Math.max(a, b);
    else if (typeof a === "number" && b === undefined) merged[key] = a;
  }
  // totalTokens is derived, not merged. Taking the max of two totals alongside
  // per-field maxima can leave total !== input + output, and the cost and log
  // paths read the total.
  const total = (merged.inputTokens ?? 0) + (merged.outputTokens ?? 0);
  if (total > 0) merged.totalTokens = total;
  return merged;
}

/**
 * The wording `isClientClosedMessage` recognises.
 *
 * "Devin turn was aborted." matched nothing, so a cancelled turn fell through to
 * the default inference and was logged as a 502 upstream failure rather than as
 * the client hanging up.
 */
const DEVIN_CLIENT_CLOSED_MESSAGE = "client closed request";

/** Map a cloud-direct failure onto the structured fields the error event carries. */
export function devinErrorClassification(error: unknown): { status?: number; errorType?: string; retryable?: boolean } {
  const status = error instanceof CloudChatError ? error.status : undefined;
  if (status === undefined) return {};
  if (status === 401) return { status, errorType: "authentication_error", retryable: false };
  if (status === 403) return { status, errorType: "permission_error", retryable: false };
  if (status === 429) return { status, errorType: "rate_limit_error", retryable: true };
  // 501 is the one 5xx that will never succeed on a second attempt: the service
  // does not implement the call. Marking it retryable put `retryable: true` on
  // the SSE failure a client reads, inviting a retry that cannot change.
  if (status === 501) return { status, retryable: false };
  if (status >= 500) return { status, retryable: true };
  return { status, retryable: false };
}

export const DEVIN_API_SERVER = DEVIN_DEFAULT_API_SERVER;

/**
 * Reasoning-effort values a CALLER may name. Deliberately not the same set as
 * the catalog suffix tokens: `priority` is a service tier that appears in a UID
 * but is not something a caller asks for as effort, and `max-1m` / `none-1m`
 * are compound values a caller can send that never appear as a trailing token.
 * The two sets share most members and mean different things; merging them would
 * both admit a tier as an effort and silently drop the compound values.
 */
const CALLER_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max", "none", "1m", "max-1m", "none-1m", "fast"]);

/**
 * Cognition's catalog spells model ids with hyphens (`swe-1-7`), but the same
 * models appear elsewhere - other proxies, hand-written config - with the dotted
 * version number (`swe-1.7`). Left alone, a dotted id misses every catalog
 * lookup and then gets an effort suffix appended to a name the server does not
 * know, which Cognition answers with an opaque permission_denied.
 */
export function normalizeDevinModelId(modelId: string): string {
  return modelId.replace(/\./g, "-");
}

/**
 * Does this id already carry a catalog effort/variant suffix?
 *
 * Delegates to the collapser so there is one answer to "what is a suffix".
 * The previous local set had drifted: it was missing `priority`, so
 * `gpt-5-6-sol-medium-priority` read as unsuffixed and got a second suffix
 * appended, producing a UID Cognition answers with an opaque permission_denied.
 * Delegating also handles compound suffixes, which testing only the final
 * hyphen-separated token never could.
 */
function hasEffortSuffix(modelId: string): boolean {
  return collapseDevinModelUid(modelId) !== modelId;
}

/**
 * SWE-2 ships exactly three native lanes. Cognition spells them as the model id,
 * not as a separate effort field, so an explicit caller effort has to be resolved
 * to the UID before the suffix shortcut below accepts whatever the picker sent.
 *
 * Kept as a named table rather than an inline branch because the caller-effort
 * set does not carry `ultra`, `off`, or `minimal`, so the two would drift apart
 * silently.
 * Values below Medium select Medium: SWE-2 has no lane under it, and rounding down
 * to nothing would quietly disable its reasoning.
 */
const SWE2_EFFORT: Record<string, "medium" | "high" | "max"> = {
  none: "medium",
  off: "medium",
  minimal: "medium",
  low: "medium",
  medium: "medium",
  high: "high",
  xhigh: "max",
  ultra: "max",
  max: "max",
};

/**
 * Resolve an explicit effort onto a SWE-2 lane, or undefined when this is not a
 * SWE-2 id or the caller named no usable effort. Reached only when the catalog
 * is unavailable or lacks family metadata; otherwise the catalog's SWE-2 family
 * rows decide, with the same rounding. Undefined leaves every existing
 * path untouched, which is what keeps other model families on suffix precedence.
 */
function resolveSwe2Variant(modelId: string, reasoningEffort?: string): string | undefined {
  if (!/^swe-2(?:-(?:medium|high|max))?$/.test(modelId)) return undefined;
  const mapped = reasoningEffort ? SWE2_EFFORT[reasoningEffort.toLowerCase()] : undefined;
  return mapped ? `swe-2-${mapped}` : undefined;
}

const VARIANT_EFFORT_TOKENS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_ALIASES: Record<string, string> = { off: "none", ultra: "max" };

/**
 * Read hyphen-separated variant tokens as a request. Any token outside the
 * vocabulary voids the whole value, so an unknown effort changes nothing
 * rather than half-applying. `priority` is the uid spelling of Fast Mode on
 * the GPT rows; a caller never sends it as effort (see CALLER_EFFORT_VALUES).
 */
function variantRequestOf(tokens: string[], allowPriority: boolean): DevinVariantRequest | undefined {
  const request: DevinVariantRequest = {};
  for (const raw of tokens) {
    const token = EFFORT_ALIASES[raw] ?? raw;
    if (VARIANT_EFFORT_TOKENS.has(token)) request.effort = token;
    else if (token === "fast" || (allowPriority && token === "priority")) request.fast = true;
    else if (token === "1m") request.longContext = true;
    else return undefined;
  }
  return request;
}

function callerVariantRequest(reasoningEffort: string | undefined): DevinVariantRequest | undefined {
  const value = reasoningEffort?.toLowerCase();
  if (!value) return undefined;
  const aliased = EFFORT_ALIASES[value] ?? value;
  if (!CALLER_EFFORT_VALUES.has(aliased) && aliased !== "minimal") return undefined;
  return variantRequestOf(aliased.split("-"), false);
}

/**
 * Resolve through the catalog's family metadata (ClientModelConfig #23/#30/#31).
 * Returns undefined when the id belongs to no family, which leaves the
 * suffix-based path for legacy rows and catalogs without that metadata.
 *
 * The family id wins over an identical row uid on purpose: bare `swe-1-7` is
 * the Max row while the family default is `swe-1-7-medium`, and `glm-5-2` is
 * both the family id and its default row. A caller naming the family means the
 * family, so no effort selects the default member and an effort moves only the
 * effort axis. A caller naming a member row keeps that row's other axes.
 */
function resolveFamilyUid(catalog: CacheEntry, modelId: string, reasoningEffort?: string): string | undefined {
  const families = devinFamiliesOf(catalog);
  const caller = callerVariantRequest(reasoningEffort);
  let members = families.get(modelId);
  let anchor: ModelCatalogEntry | undefined;
  let fromId: DevinVariantRequest = {};
  if (!members) {
    const row = catalog.byUid.get(modelId);
    if (row?.familyUid) {
      members = families.get(devinFamilyBaseId(row.familyUid));
      if (members) anchor = row;
    }
  }
  if (!members) {
    // A suffixed spelling the catalog does not list (`swe-1-7-high`) still
    // names a family; its suffix is the request.
    const base = collapseDevinModelUid(modelId);
    const suffix = base !== modelId ? variantRequestOf(modelId.slice(base.length + 1).split("-"), true) : undefined;
    members = suffix ? families.get(base) : undefined;
    if (suffix) fromId = suffix;
  }
  if (!members) return undefined;
  if (anchor && !caller) return anchor.modelUid;
  const request: DevinVariantRequest = {
    ...fromId,
    ...(caller?.effort ? { effort: caller.effort } : {}),
    ...(caller?.fast || fromId.fast ? { fast: true } : {}),
    ...(caller?.longContext || fromId.longContext ? { longContext: true } : {}),
  };
  // A disabled row the caller named keeps its uid when the request still lands
  // on it (`swe-2-max` asked for at `max`), so the chat preflight reports that
  // row's tier refusal instead of quietly serving a different tier. A request
  // for a different variant still passes over disabled rows.
  if (anchor?.disabled && selectDevinFamilyMember(members, request, anchor, { includeDisabled: true }) === anchor) {
    return anchor.modelUid;
  }
  return selectDevinFamilyMember(members, request, anchor)?.modelUid;
}

/**
 * Resolve the wire model UID using the live catalog as the source of truth.
 *
 * With family metadata in the catalog, resolution picks a family member by
 * axis (see resolveFamilyUid). Without it — legacy rows, an older catalog, or
 * no catalog at all — the id is resolved by suffix: an exact or suffixed UID is
 * kept, otherwise the reasoning effort (or `medium`) is appended.
 */
async function resolveWireModelUid(
  rawModelId: string,
  apiKey: string,
  host: string,
  reasoningEffort?: string,
  catalog?: CacheEntry | null,
): Promise<string> {
  const modelId = normalizeDevinModelId(rawModelId);
  // Callers that already read the catalog this turn pass it in; an explicit
  // null records a failed lookup and must not trigger a same-turn retry —
  // failures are not cached, so re-reading would only pay another timeout.
  const entry = catalog !== undefined ? catalog : await getCachedCatalog(apiKey, host);
  if (entry) {
    const fromFamily = resolveFamilyUid(entry, modelId, reasoningEffort);
    if (fromFamily) return fromFamily;
  }
  // Explicit effort wins over a suffix the picker already baked into the id, so
  // `swe-2-high` asked for at `medium` becomes `swe-2-medium` instead of ignoring
  // the caller. Runs before the shortcut below, which would otherwise return early.
  const swe2 = resolveSwe2Variant(modelId, reasoningEffort);
  if (swe2) return swe2;
  if (hasEffortSuffix(modelId)) return modelId;
  const effort = reasoningEffort && CALLER_EFFORT_VALUES.has(reasoningEffort) ? reasoningEffort : "medium";
  if (entry) {
    if (entry.byUid.has(modelId)) return modelId;
    const suffixed = `${modelId}-${effort}`;
    if (entry.byUid.has(suffixed)) return suffixed;
    // Any enabled variant of this exact base. The base must match after
    // collapsing, not as a string prefix: `claude-opus-5-` prefixes
    // `claude-opus-5-5-low` and `gpt-5-4-` prefixes `gpt-5-4-mini-low`.
    for (const [uid, row] of entry.byUid) {
      if (!row.disabled && uid !== modelId && collapseDevinModelUid(uid) === modelId) return uid;
    }
  }
  // Degraded mode: append the default effort suffix.
  return `${modelId}-${effort}`;
}

/**
 * Test seam. The resolver stays module-private because it reaches the catalog;
 * exporting it under its bare name would make an async network-touching helper
 * part of the adapter public API. Mirrors sanitizeToolDescriptionForCognitionForTests.
 */
export const resolveWireModelUidForTests = resolveWireModelUid;

const positiveTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

/**
 * Read a per-model token count for the exact UID selected for this turn.
 *
 * Tries the selected UID, then its catalog family id (the picker id, e.g.
 * `claude-sonnet-4-6` for `claude-sonnet-4-6-thinking`), then its collapsed
 * base id, preferring the
 * canonical spelling and accepting dotted or case-folded saved hints — the same
 * normalization the inference request applies to the model id. Where several
 * spellings match one id, the smallest wins: a ceiling stated twice is
 * satisfied by the lower statement.
 */
function devinModelTokenHint(
  record: Record<string, number> | undefined,
  modelUid: string,
  familyBase?: string,
): number | undefined {
  if (!record) return undefined;
  for (const id of [modelUid, ...(familyBase ? [familyBase] : []), collapseDevinModelUid(modelUid)]) {
    const exact = Object.hasOwn(record, id) ? positiveTokenCount(record[id]) : undefined;
    if (exact !== undefined) return exact;
    const matches = Object.entries(record)
      .filter(([key]) => normalizeDevinModelId(key).toLowerCase() === id.toLowerCase())
      .map(([, value]) => positiveTokenCount(value))
      .filter((value): value is number => value !== undefined);
    if (matches.length > 0) return Math.min(...matches);
  }
  return undefined;
}

/**
 * Resolve the OUTPUT ceiling for this turn, highest authority first:
 *
 * 1. the caller's explicit `max_output_tokens`, forwarded unchanged — an
 *    explicit cap is a request, so a small one is never widened into a
 *    configured larger one;
 * 2. the configured per-model cap (`modelMaxOutputTokens`), read through the
 *    through the UID-aware hint lookup above;
 * 3. the provider-wide `defaultMaxOutputTokens`;
 * 4. the catalog's own ceiling for the selected UID (ModelInfo #13) — without
 *    it every uncapped turn stopped at the encoder's 8192, far below the
 *    128k most rows advertise;
 * 5. undefined, which leaves the cloud-direct encoder's 8192 fallback in
 *    place when there is no catalog and nothing configured.
 *
 * A context window is not an output cap: feeding one into CompletionConfiguration
 * #2 would ask Cognition to generate a whole window's worth of output. Nothing
 * here reads `contextWindow` or `modelContextWindows` for that reason.
 *
 * Step 1 keeps the caller's raw value rather than `positiveTokenCount`: the
 * inbound parser owns what a caller may send, and re-filtering here would
 * silently promote a rejected value to a configured cap the caller never asked
 * for.
 */
function resolveDevinMaxOutputTokens(
  provider: OcxProviderConfig,
  modelUid: string,
  requested: number | undefined,
  catalogRow?: Pick<ModelCatalogEntry, "maxOutputTokens" | "familyUid">,
): number | undefined {
  if (typeof requested === "number") return requested;
  const familyBase = catalogRow?.familyUid ? devinFamilyBaseId(catalogRow.familyUid) : undefined;
  return devinModelTokenHint(provider.modelMaxOutputTokens, modelUid, familyBase)
    ?? positiveTokenCount(provider.defaultMaxOutputTokens)
    ?? positiveTokenCount(catalogRow?.maxOutputTokens);
}

/** Pure test seam; runtime uses the same resolver immediately before dispatch. */
export const resolveDevinMaxOutputTokensForTests = resolveDevinMaxOutputTokens;

/** The classifier reads the selected UID's catalog input window, capped by configured limits. */
function resolveDevinContextWindow(
  provider: OcxProviderConfig,
  modelUid: string,
  catalogRow?: Pick<ModelCatalogEntry, "contextWindow" | "familyUid">,
): number | undefined {
  const familyBase = catalogRow?.familyUid ? devinFamilyBaseId(catalogRow.familyUid) : undefined;
  const limits = [
    positiveTokenCount(catalogRow?.contextWindow),
    devinModelTokenHint(provider.modelContextWindows, modelUid, familyBase),
    positiveTokenCount(provider.contextWindow),
    devinModelTokenHint(provider.modelMaxInputTokens, modelUid, familyBase),
  ].filter((value): value is number => value !== undefined);
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

/** Pure test seam for configured caps and selected-row lookup. */
export const resolveDevinContextWindowForTests = resolveDevinContextWindow;

export class DevinMissingCredentialError extends Error {
  constructor() {
    super("Devin live transport requires a Devin API key. Run ocx login devin to sign in with your Cognition/Devin account.");
    this.name = "DevinMissingCredentialError";
  }
}

export function resolveDevinToken(provider: OcxProviderConfig, headers?: Headers): string {
  const providerKey = provider.apiKey?.trim();
  if (providerKey) return providerKey;
  const forwarded = headers?.get("authorization") ?? headers?.get("Authorization");
  if (forwarded?.toLowerCase().startsWith("bearer ")) return forwarded.slice("bearer ".length).trim();
  const envToken = process.env.OPENCODEX_DEVIN_TEST_TOKEN?.trim();
  if (envToken) return envToken;
  throw new DevinMissingCredentialError();
}

function textFromParts(content: string | OcxContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n");
}

const MAX_DEVIN_REMOTE_IMAGE_URL_CHARS = 8_192;

function boundedDevinRemoteImageReference(imageUrl: string): string | undefined {
  if (imageUrl.length > MAX_DEVIN_REMOTE_IMAGE_URL_CHARS) return undefined;
  try {
    return new URL(imageUrl).protocol === "https:" ? imageUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert inbound content parts to the multimodal shape the wire encoder accepts.
 *
 * The wire layer already carries images (ChatMessagePrompt field #10 ImageData),
 * but every image was discarded at this boundary: textFromParts returned a
 * text-only string and a message whose only content was an image was dropped
 * entirely, which is why a pasted screenshot killed the turn and the only
 * workaround was running OCR before sending. A data: URL carries everything
 * field #10 needs; a bounded remote https URL cannot be inlined without a fetch,
 * so it stays as an explicit text reference rather than pretending the model can
 * see a picture it cannot. Unsupported and oversized references become a fixed
 * omission marker, never attacker-sized prompt text. Video has no Devin field.
 */
function mapOcxContentToWire(content: string | OcxContentPart[] | undefined): string | ContentPart[] {
  if (typeof content === "string" || !Array.isArray(content)) return content ?? "";
  const out: ContentPart[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "document") {
      // No Devin document field; the marker keeps the turn from disappearing entirely.
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const m = part.imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) out.push({ type: "image", mimeType: m[1]!, base64Data: m[2]! });
      else {
        const remoteReference = boundedDevinRemoteImageReference(part.imageUrl);
        out.push({
          type: "text",
          text: remoteReference ? `[image url: ${remoteReference}]` : "[image omitted: unsupported or oversized URL]",
        });
      }
    }
  }
  return out;
}

function assistantToolCalls(message: OcxAssistantMessage): Array<{ id: string; name: string; arguments: string }> {
  return message.content
    .filter((part): part is OcxToolCall => part.type === "toolCall")
    .map((part) => ({
      id: part.id,
      name: part.name,
      arguments: JSON.stringify(part.arguments ?? {}),
    }));
}

function assistantText(message: OcxAssistantMessage): string {
  return message.content
    // Thinking stays out of the replayed TEXT: folding chain-of-thought into
    // assistant text sends it back as visible prior output, which the model
    // then treats as something it said to the user. It is replayed in its own
    // field instead — see assistantThinking below.
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The assistant turn's own reasoning, for replay in ChatMessagePrompt #11.
 *
 * This adapter previously asserted that Cognition has no reasoning-replay
 * field and dropped the thinking outright, so a reasoning model restarted its
 * chain on every turn of a tool loop. The field exists: two independent
 * clients of the same service write #11 thinking with #12 signature and #18
 * signature_type on the assistant prompt.
 *
 * Field #12 attests the exact text at #11, and the wire has room for one pair.
 * Every block that carries text is replayed, so the chain stays intact; the
 * signature rides along only when the text being replayed IS the text it
 * attests, which is exactly the single-block case. Several independently signed
 * blocks send an unsigned prompt rather than pairing one block's attestation
 * with another block's words. A signature-only block attests encrypted thinking
 * that is not being replayed at all, so it is not one of these blocks and
 * cannot contribute the pair.
 */
function assistantThinking(
  message: OcxAssistantMessage,
): { thinking?: string; signature?: string } {
  const blocks = message.content.filter(
    (part): part is Extract<typeof part, { type: "thinking" }> => part.type === "thinking",
  ).filter(part => Boolean(part.thinking));
  if (blocks.length === 0) return {};
  const signature = blocks.length === 1 ? blocks[0]!.signature : undefined;
  return {
    thinking: blocks.map(part => part.thinking).join("\n"),
    ...(isProviderIssuedThinkingSignature(signature) ? { signature } : {}),
  };
}

export function mapOcxMessagesToDevin(parsed: OcxParsedRequest): ChatHistoryItem[] {
  const items: ChatHistoryItem[] = [];
  // Cognition is not an OpenAI host, and this adapter does advertise a real
  // client tool catalog (proto #10 via `mapOcxToolsToDevin`), so the same
  // contract paragraph the other non-OpenAI adapters inject belongs here. The
  // wire name is the bare `tool.name` that encoder writes, not the namespaced
  // form, so the nudge names exactly what the model is offered.
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeForTools(
    parsed.context.tools,
    parsed.options.toolChoice,
    (tool) => tool.name,
  );
  const systemPrompt = parsed.context.systemPrompt?.filter((line) => line.trim().length > 0).join("\n");
  const system = [systemPrompt, toolCatalogNudge]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
  if (system) items.push({ role: "system", content: system });

  for (const message of parsed.context.messages) {
    const mapped = mapOneMessage(message);
    if (mapped) items.push(mapped);
  }
  return items;
}

function mapOneMessage(message: OcxMessage): ChatHistoryItem | undefined {
  if (message.role === "user" || message.role === "developer") {
    const content = mapOcxContentToWire(message.content);
    // An image with no caption text is a complete user message on its own.
    // Dropping it — which is what the text-only extraction did — is why a
    // pasted screenshot killed the turn before the model ever saw anything.
    if (typeof content === "string" ? !content.trim() : content.length === 0) return undefined;
    return { role: message.role === "developer" ? "system" : "user", content };
  }
  if (message.role === "assistant") {
    const toolCalls = assistantToolCalls(message);
    const text = assistantText(message);
    const reasoning = assistantThinking(message);
    // A turn that produced only reasoning is still worth replaying: dropping it
    // is what makes the next turn re-derive the same chain.
    if (!text && toolCalls.length === 0 && !reasoning.thinking) return undefined;
    return {
      role: "assistant",
      content: text || "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...reasoning,
    };
  }
  if (message.role === "toolResult") {
    // #9 alone is not enough: live, with a neutral "hello world" result flagged
    // as an error, only gemini-3-8-flash reported a failure; swe-1-6,
    // gpt-6-sol-low and gpt-5-6-luna-low read it as success. So the flag rides
    // with the in-band marker rather than replacing it.
    const wireContent = mapOcxContentToWire(message.content);
    const toolContent = message.isError
      ? (typeof wireContent === "string"
          ? `ERROR: ${wireContent}`
          : [{ type: "text", text: "ERROR:" } as ContentPart, ...wireContent])
      : wireContent;
    return {
      role: "tool",
      content: toolContent,
      tool_call_id: message.toolCallId,
      ...(message.isError ? { is_error: true } : {}),
    };
  }
  return undefined;
}

export function mapOcxToolsToDevin(tools: OcxTool[] | undefined): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * Devin's request mapper advertises the local tool name, so a namespaced Codex tool such as
 * `mcp__cua_repl__js` is sent upstream as `js`. Restore a returned bare name to its canonical request
 * identity only when exactly one advertised tool owns it. A null owner is an ambiguous catalog and
 * must fail before dispatch; an absent owner remains unchanged for the shared undeclared-tool guard
 * to reject.
 *
 * Canonical names are registered as aliases of themselves because the adapter accepts them on return
 * too. Tracking only local names let one tool's canonical identity collide with another tool's local
 * name and resolve to the wrong owner: with `{ namespace: "a", name: "x" }` and
 * `{ namespace: "b", name: "a__x" }`, a returned `a__x` is both the first tool's canonical identity
 * and the second tool's advertised name, and it used to map to `b__a__x` — so the bridge dispatched
 * the call to the wrong client tool. That case is genuinely ambiguous and now fails closed.
 */
function buildDevinReturnedToolNameMap(
  tools: OcxTool[] | undefined,
): ReadonlyMap<string, string | null> {
  const names = new Map<string, string | null>();
  const addOwner = (alias: string, canonical: string) => {
    if (!names.has(alias)) {
      names.set(alias, canonical);
    } else if (names.get(alias) !== canonical) {
      names.set(alias, null);
    }
  };
  for (const tool of tools ?? []) {
    const canonical = namespacedToolName(tool.namespace, tool.name);
    addOwner(tool.name, canonical);
    addOwner(canonical, canonical);
  }
  return names;
}

function restoreDevinReturnedToolName(
  name: string,
  names: ReadonlyMap<string, string | null>,
): string | null {
  return names.has(name) ? names.get(name)! : name;
}

type DevinMappedToolCallStart =
  | Extract<AdapterEvent, { type: "tool_call_start" }>
  | Extract<AdapterEvent, { type: "error" }>;

function mapDevinToolCallStart(
  id: string,
  name: string,
  names: ReadonlyMap<string, string | null>,
): DevinMappedToolCallStart {
  const restoredName = restoreDevinReturnedToolName(name, names);
  if (restoredName === null) {
    return {
      type: "error",
      message: "Devin emitted a bare client tool name that maps to multiple request-declared tools.",
      status: 502,
      retryable: false,
    };
  }
  return { type: "tool_call_start", id, name: restoredName };
}

/** Test seam for the request-scoped tool-call event mapping used by runTurn. */
export function mapDevinToolCallStartForTests(
  id: string,
  name: string,
  tools: OcxTool[] | undefined,
): DevinMappedToolCallStart {
  return mapDevinToolCallStart(id, name, buildDevinReturnedToolNameMap(tools));
}

export function createDevinAdapter(
  provider: OcxProviderConfig,
  context: { providerId?: string } = {},
): ProviderAdapter {
  // Which credential slot holds this row's tenant. The key is the configured
  // provider id verbatim: `devin-cli` is a deprecated alias for the one merged
  // `devin` provider, and the startup migration rekeys the config row and the
  // credential slot together, so normalizing here would only misread a row that
  // has not been migrated yet. Defaults to `devin` so every existing caller —
  // including the tests that construct this adapter directly — behaves exactly
  // as before.
  const credentialProviderId = context.providerId ?? "devin";
  const cascadeIds = new Map<string, string>();
  const CASCADE_ID_MAX = 256;

  return {
    name: "devin",
    // Every GetChatMessage send, including the first, is admitted through the shared budget and
    // reported from the executor that dispatches it. The caller therefore leaves the first
    // send's accounting here rather than logging it before admission can refuse it.
    reportsPhysicalSends: true,

    buildRequest() {
      return {
        url: provider.baseUrl || DEVIN_API_SERVER,
        method: "POST",
        headers: {},
        body: "",
      };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield {
        type: "error",
        message: "Devin adapter uses runTurn; the fetch/parseStream path is disabled.",
      };
    },

    async runTurn(parsed: OcxParsedRequest, incoming: IncomingMeta, emit: (event: AdapterEvent) => void) {
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: DEVIN_CLIENT_CLOSED_MESSAGE, status: 499, retryable: false });
        return;
      }
      let apiKey: string;
      try {
        apiKey = resolveDevinToken(provider, incoming.headers);
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }

      const threadKey = parsed._clientThreadId || parsed.previousResponseId || "default";
      let cascadeId = cascadeIds.get(threadKey);
      if (!cascadeId) {
        // Evict oldest entries to bound memory in long-running proxy processes.
        if (cascadeIds.size >= CASCADE_ID_MAX) {
          const firstKey = cascadeIds.keys().next().value;
          if (firstKey) cascadeIds.delete(firstKey);
        }
        cascadeId = allocateCascadeId();
        cascadeIds.set(threadKey, cascadeId);
      }

      const rawModelId = parsed.modelId.includes("/") ? parsed.modelId.slice(parsed.modelId.lastIndexOf("/") + 1) : parsed.modelId;
      // The signed-in account's tenant decides the host, not the static registry
      // entry: an EU or FedStart account that used provider.baseUrl would send
      // every RPC to the US server it is not provisioned on.
      const host = resolveDevinApiServer(provider.baseUrl, credentialProviderId, apiKey);
      // One catalog read per turn serves model-UID resolution, the output
      // cap, and the chat pre-flight inside streamChatEvents. Failures are
      // not cached, so a second read would only pay another fetch timeout on
      // an otherwise valid turn.
      const catalog = await getCachedCatalog(apiKey, host, incoming.abortSignal);
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: DEVIN_CLIENT_CLOSED_MESSAGE, status: 499, retryable: false });
        return;
      }
      const modelUid = await resolveWireModelUid(rawModelId, apiKey, host, parsed.options.reasoning, catalog);
      const returnedToolNames = buildDevinReturnedToolNameMap(parsed.context.tools);
      let openToolId: string | undefined;
      let usage: OcxUsage | undefined;
      let stopReason: string | undefined;
      // Kept outside the try so the catch can tell an oversized history from a bad request.
      let producedOutput = false;
      let contextWindow: number | undefined;
      let messages: ChatHistoryItem[] = [];
      let tools: ToolDef[] | undefined;

      const closeOpenTool = () => {
        if (!openToolId) return;
        emit({ type: "tool_call_end" });
        openToolId = undefined;
      };

      try {
        // Read the selected UID's catalog row, not the picker's collapsed base.
        contextWindow = resolveDevinContextWindow(provider, modelUid, catalog?.byUid.get(modelUid));
        messages = mapOcxMessagesToDevin(parsed);
        tools = mapOcxToolsToDevin(parsed.context.tools);
        const maxOutputTokens = resolveDevinMaxOutputTokens(
          provider, modelUid, parsed.options.maxOutputTokens, catalog?.byUid.get(modelUid),
        );
        // A combo child has not committed an outer response yet. Holding its preflight through
        // a reset wait would also hold the next-target fallback with no client keepalive.
        const resetWaitMs = incoming.comboAttempt ? 0 : devinStatedResetWaitMs();
        // An admitted HTTP turn owns globally shared capacity until this call
        // emits. Without an explicit wait allowance, preserve the typed reset
        // delay in generated diagnostic wording and return immediately.
        for await (const event of streamChatEventsWithResetRetry({
          apiKey,
          apiServerUrl: host,
          modelUid,
          catalog,
          messages,
          tools,
          cascadeId,
          completionOpts: {
            ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
            ...(typeof parsed.options.temperature === "number" ? { temperature: parsed.options.temperature } : {}),
            ...(typeof parsed.options.topP === "number" ? { topP: parsed.options.topP } : {}),
          },
          signal: incoming.abortSignal,
        }, {
          maxWaitMs: resetWaitMs,
          onWaitHeartbeat: resetWaitMs > 0 && parsed.stream
            ? () => emit({ type: "heartbeat", preflightReady: true }) : undefined,
          execution: {
            executor: incoming.providerFetch,
            sendBudget: incoming.sendBudget,
            onPhysicalSend: incoming.onPhysicalSend,
            onRecoveryWithheld: incoming.onRecoveryWithheld,
          },
        })) {
          if (incoming.abortSignal?.aborted) {
            // Emitting nothing here left the bridge to synthesize adapter_eof.
            // Say what happened instead, the way the other runTurn-only adapter
            // does, and carry any usage already seen.
            closeOpenTool();
            emit({ type: "error", message: DEVIN_CLIENT_CLOSED_MESSAGE, status: 499, retryable: false, ...(usage ? { usage } : {}) });
            return;
          }
          if (event.kind === "text" || event.kind === "reasoning" || event.kind === "tool_call_start") producedOutput = true;
          if (event.kind === "text") {
            closeOpenTool();
            if (event.text) emit({ type: "text_delta", text: event.text });
            continue;
          }
          if (event.kind === "reasoning") {
            if (event.text) emit({ type: "thinking_delta", thinking: event.text });
            continue;
          }
          if (event.kind === "reasoning_signature") {
            // Carried back out so the next turn can replay it in the prompt's
            // signature field; an unsigned replay is what the service ignores.
            emit({ type: "thinking_signature", signature: event.signature });
            continue;
          }
          if (event.kind === "tool_call_start") {
            closeOpenTool();
            const mapped = mapDevinToolCallStart(event.id, event.name, returnedToolNames);
            if (mapped.type === "error") {
              emit({ ...mapped, ...(usage ? { usage } : {}) });
              return;
            }
            openToolId = event.id;
            emit(mapped);
            continue;
          }
          if (event.kind === "tool_call_args") {
            if (event.argsDelta) emit({ type: "tool_call_delta", arguments: event.argsDelta });
            continue;
          }
          if (event.kind === "finish") {
            closeOpenTool();
            // A natural completion carries no stopReason: the bridge reads any
            // truthy value as "this turn did not reach a final answer", so
            // reporting "stop" costs every clean Devin turn its final_answer
            // phase.
            stopReason = event.reason === "length" ? "max_tokens" : event.reason === "stop" ? undefined : event.reason;
            continue;
          }
          if (event.kind === "usage") {
            const total = event.totalTokens ?? ((event.promptTokens ?? 0) + (event.completionTokens ?? 0));
            const next: OcxUsage = {
              inputTokens: event.promptTokens ?? 0,
              outputTokens: event.completionTokens ?? 0,
              ...(total > 0 ? { totalTokens: total } : {}),
              ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
              ...(event.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: event.cacheCreationInputTokens } : {}),
              ...(event.reasoningTokens !== undefined ? { reasoningOutputTokens: event.reasoningTokens } : {}),
            };
            // Merge rather than replace. A turn can carry more than one usage
            // frame, and the counters are cumulative, so a later partial frame
            // that omits a field used to zero a count the earlier frame had
            // already reported.
            usage = usage ? mergeDevinUsage(usage, next) : next;
            continue;
          }
        }
        closeOpenTool();
        if (incoming.abortSignal?.aborted) {
          emit({ type: "error", message: DEVIN_CLIENT_CLOSED_MESSAGE, status: 499, retryable: false, ...(usage ? { usage } : {}) });
        } else {
          emit({ type: "done", ...(usage ? { usage } : {}), ...(stopReason ? { stopReason } : {}) });
        }
      } catch (error) {
        closeOpenTool();
        if (incoming.abortSignal?.aborted) {
          emit({ type: "error", message: DEVIN_CLIENT_CLOSED_MESSAGE, status: 499, retryable: false, ...(usage ? { usage } : {}) });
          return;
        }
        // The Responses boundary already maps this local refusal to its structured 429 code.
        // Converting it to an adapter event would make it an ordinary untyped upstream error.
        if (error instanceof SendBudgetExhaustedError) throw error;
        if (error instanceof CloudChatError && isDevinHistoryOverflow({
          code: error.code, producedOutput, contextWindow, messages, tools,
        })) {
          emit({ ...devinContextOverflowEvent(), ...(usage ? { usage } : {}) });
          return;
        }
        const message = error instanceof CloudChatError
          ? ("Devin cloud error" + (error.code ? " " + error.code : "") + ": " + error.message)
          : error instanceof Error ? error.message : String(error);
        // Usage that already arrived is still real; dropping it loses the
        // accounting for a turn that did most of its work before failing.
        emit({
          type: "error",
          message,
          ...devinErrorClassification(error),
          ...(error instanceof CloudChatError && error.code ? { code: error.code } : {}),
          ...(usage ? { usage } : {}),
        });
      }
    },
  };
}
