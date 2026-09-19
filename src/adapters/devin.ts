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
import { streamChatEventsWithResetRetry, allocateCascadeId, CloudChatError, type ChatHistoryItem, type ToolDef } from "./devin/cloud-direct";
import type { ContentPart } from "./devin/cloud-direct/chat";
import { getCachedCatalog, type CacheEntry } from "./devin/cloud-direct/catalog";
import { collapseDevinModelUid } from "./devin/live-models";
import { buildNonOpenAIToolCatalogNudgeForTools } from "./tool-catalog-nudge";
import { DEVIN_DEFAULT_API_SERVER, resolveDevinApiServer } from "../oauth/devin";
import { SendBudgetExhaustedError } from "../lib/upstream-retry";

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
 * SWE-2 id or the caller named no usable effort. Undefined leaves every existing
 * path untouched, which is what keeps other model families on suffix precedence.
 */
function resolveSwe2Variant(modelId: string, reasoningEffort?: string): string | undefined {
  if (!/^swe-2(?:-(?:medium|high|max))?$/.test(modelId)) return undefined;
  const mapped = reasoningEffort ? SWE2_EFFORT[reasoningEffort.toLowerCase()] : undefined;
  return mapped ? `swe-2-${mapped}` : undefined;
}

/**
 * Resolve the wire model UID using the live catalog as the source of truth.
 * Cognition's catalog lists most models with an effort suffix
 * (e.g. `gpt-5-6-sol-high`); the base id alone is not accepted for those.
 *
 * If the catalog is available: use the exact UID when it exists, otherwise
 * append the reasoning effort (or `medium` default) and pick a variant the
 * account actually has.
 *
 * If the catalog is unavailable (degraded mode): append the effort suffix
 * for any base id that doesn't already carry one, mirroring the catalog shape.
 */
async function resolveWireModelUid(
  rawModelId: string,
  apiKey: string,
  host: string,
  reasoningEffort?: string,
  catalog?: CacheEntry | null,
): Promise<string> {
  const modelId = normalizeDevinModelId(rawModelId);
  // Explicit effort wins over a suffix the picker already baked into the id, so
  // `swe-2-high` asked for at `medium` becomes `swe-2-medium` instead of ignoring
  // the caller. Runs before the shortcut below, which would otherwise return early.
  const swe2 = resolveSwe2Variant(modelId, reasoningEffort);
  if (swe2) return swe2;
  if (hasEffortSuffix(modelId)) return modelId;
  // Callers that already read the catalog this turn pass it in; an explicit
  // null records a failed lookup and must not trigger a same-turn retry —
  // failures are not cached, so re-reading would only pay another timeout.
  const entry = catalog !== undefined ? catalog : await getCachedCatalog(apiKey, host);
  if (entry) {
    if (entry.byUid.has(modelId)) return modelId;
    const effort = reasoningEffort && CALLER_EFFORT_VALUES.has(reasoningEffort) ? reasoningEffort : "medium";
    const suffixed = `${modelId}-${effort}`;
    if (entry.byUid.has(suffixed)) return suffixed;
    // Fall back to any enabled variant of this base model.
    for (const uid of entry.byUid.keys()) {
      if (uid.startsWith(modelId + "-") && !entry.byUid.get(uid)?.disabled) return uid;
    }
  }
  // Degraded mode: append the default effort suffix.
  const effort = reasoningEffort && CALLER_EFFORT_VALUES.has(reasoningEffort) ? reasoningEffort : "medium";
  return `${modelId}-${effort}`;
}

/**
 * Test seam. The resolver stays module-private because it reaches the catalog;
 * exporting it under its bare name would make an async network-touching helper
 * part of the adapter public API. Mirrors sanitizeToolDescriptionForCognitionForTests.
 */
export const resolveWireModelUidForTests = resolveWireModelUid;

/**
 * Resolve the INPUT ceiling for the exact UID selected for this turn. Catalog
 * ClientModelConfig #18 and CompletionConfiguration #3 both carry input tokens;
 * the independent output cap is not subtracted here. Smaller operator hints
 * cap live evidence, never enlarge it. No evidence leaves the encoder's 128k
 * fallback intact; an unrelated or opt-in long-context variant is not evidence.
 */
function resolveDevinMaxInputTokens(
  provider: OcxProviderConfig,
  modelUid: string,
  liveWindow?: number,
): number | undefined {
  const positive = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  const baseId = collapseDevinModelUid(modelUid);
  const configured = (record: Record<string, number> | undefined): number | undefined => {
    if (!record) return undefined;
    for (const id of [modelUid, baseId]) {
      // Prefer the canonical spelling; retain dotted/case-folded saved hints,
      // matching the model-id normalization used for the inference request.
      const exact = Object.hasOwn(record, id) ? positive(record[id]) : undefined;
      if (exact !== undefined) return exact;
      const matches = Object.entries(record)
        .filter(([key]) => normalizeDevinModelId(key).toLowerCase() === id.toLowerCase())
        .map(([, value]) => positive(value))
        .filter((value): value is number => value !== undefined);
      if (matches.length > 0) return Math.min(...matches);
    }
    return undefined;
  };
  const contextHint = configured(provider.modelContextWindows) ?? positive(provider.contextWindow);
  const inputHint = configured(provider.modelMaxInputTokens);
  const ceilings = [positive(liveWindow), contextHint, inputHint]
    .filter((value): value is number => value !== undefined);
  return ceilings.length > 0 ? Math.min(...ceilings) : undefined;
}

/** Pure test seam; runtime uses the same resolver immediately before dispatch. */
export const resolveDevinMaxInputTokensForTests = resolveDevinMaxInputTokens;

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

/**
 * Convert inbound content parts to the multimodal shape the wire encoder accepts.
 *
 * The wire layer already carries images (ChatMessagePrompt field #10 ImageData),
 * but every image was discarded at this boundary: textFromParts returned a
 * text-only string and a message whose only content was an image was dropped
 * entirely, which is why a pasted screenshot killed the turn and the only
 * workaround was running OCR before sending. A data: URL carries everything
 * field #10 needs; a remote https URL cannot be inlined without a fetch, so it
 * stays as an explicit text reference rather than pretending the model can see
 * a picture it cannot. Video has no Devin field and is skipped.
 */
function mapOcxContentToWire(content: string | OcxContentPart[] | undefined): string | ContentPart[] {
  if (typeof content === "string" || !Array.isArray(content)) return content ?? "";
  const out: ContentPart[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text) {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const m = part.imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (m) out.push({ type: "image", mimeType: m[1]!, base64Data: m[2]! });
      else out.push({ type: "text", text: `[image url: ${part.imageUrl}]` });
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
 * The signature attests the thinking it was produced with, so a block without
 * one contributes its text and nothing else rather than borrowing a neighbour's.
 */
function assistantThinking(
  message: OcxAssistantMessage,
): { thinking?: string; signature?: string } {
  const blocks = message.content.filter(
    (part): part is Extract<typeof part, { type: "thinking" }> => part.type === "thinking",
  );
  if (blocks.length === 0) return {};
  const thinking = blocks.map(b => b.thinking).filter(Boolean).join("\n");
  // Only one signature can ride the prompt, so take the last block that has
  // one: that is the block the turn actually ended on.
  const signature = blocks.filter(b => b.signature).at(-1)?.signature;
  return {
    ...(thinking ? { thinking } : {}),
    ...(signature ? { signature } : {}),
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
      const host = resolveDevinApiServer(provider.baseUrl, credentialProviderId);
      // One catalog read per turn serves model-UID resolution, the input
      // ceiling, and the chat pre-flight inside streamChatEvents. Failures are
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

      const closeOpenTool = () => {
        if (!openToolId) return;
        emit({ type: "tool_call_end" });
        openToolId = undefined;
      };

      try {
        // Read the selected UID's catalog row, not the picker's collapsed base.
        const maxInputTokens = resolveDevinMaxInputTokens(
          provider, modelUid, catalog?.byUid.get(modelUid)?.contextWindow,
        );
        // The reset-retry wrapper waits out a 429 that states its own recovery
        // delay ("limit will reset in 35 seconds") and replays the identical
        // request — but only while zero events have been yielded, so a
        // post-output failure still takes the terminal path untouched.
        for await (const event of streamChatEventsWithResetRetry({
          apiKey,
          apiServerUrl: host,
          modelUid,
          catalog,
          messages: mapOcxMessagesToDevin(parsed),
          tools: mapOcxToolsToDevin(parsed.context.tools),
          cascadeId,
          // Input and output ceilings are separate wire fields. Omitting the
          // input hint used to force every model through the 128k default.
          completionOpts: {
            ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
            ...(typeof parsed.options.maxOutputTokens === "number" ? { maxOutputTokens: parsed.options.maxOutputTokens } : {}),
            ...(typeof parsed.options.temperature === "number" ? { temperature: parsed.options.temperature } : {}),
            ...(typeof parsed.options.topP === "number" ? { topP: parsed.options.topP } : {}),
          },
          signal: incoming.abortSignal,
        }, {
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
