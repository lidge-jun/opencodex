import { createHash } from "node:crypto";
import type { OcxConfig, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent } from "../types";
import type { VisionReasoningEffort } from "../reasoning-effort";
import { describeImage, type DescribeOutcome, type VisionSettings } from "./describe";
import { describeImageAnthropic } from "./anthropic-describe";
import { describeImageRouted } from "./routed-describe";
import { isModelVisionSidecarConsumer as isModelTextOnly, modelAcceptsImageInput } from "./eligibility";
import { normalizeVisionReasoningForModel } from "./reasoning";
import type { CodexAuthContext } from "../codex/auth-context";
import { resolveSidecarAuth } from "../sidecar/auth";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import type { SidecarOutcomeRecorder } from "../web-search/executor";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";
import type { TranslatorBudget } from "../lib/translator-budget";
import {
  DEFAULT_VISION_TIMEOUT_MS,
  MAX_VISION_TIMEOUT_MS,
  MIN_VISION_TIMEOUT_MS,
} from "./timeout-bounds";

export { describeImage } from "./describe";

/** Backward-compatible request-time name for the shared vision-sidecar consumer predicate. */
export { isModelVisionSidecarConsumer as isModelTextOnly } from "./eligibility";
export { describeImageAnthropic, parseAnthropicVisionSSE } from "./anthropic-describe";
export {
  BASELINE_VISION_MODELS,
  isModelVisionSidecarConsumer,
  isVisionEligibleModel,
  isVisionSidecarConsumer,
  modelAcceptsImageInput,
  visionBackendForCandidate,
  visionEligibleModelOptions,
} from "./eligibility";
export type { VisionCandidateModel, VisionModelOption, VisionSidecarBackend } from "./eligibility";
export {
  DEFAULT_VISION_TIMEOUT_MS,
  MAX_VISION_TIMEOUT_MS,
  MIN_VISION_TIMEOUT_MS,
};

const DEFAULT_VISION_MODEL = "gpt-5.4-mini";
const DEFAULT_ANTHROPIC_VISION_MODEL = "claude-sonnet-5";
const DEFAULT_REASONING: VisionReasoningEffort = "low";
export const DEFAULT_MAX_DESCRIPTIONS_PER_TURN = 8;
const DESCRIPTION_CACHE_MAX_ENTRIES = 256;
export const VISION_DESCRIPTION_CACHE_MAX_BYTES = 1024 * 1024;
const descriptionEncoder = new TextEncoder();
/** Max images described in parallel — keeps first-token latency bounded without flooding the backend. */
const VISION_CONCURRENCY = 3;
/** Per-image description hard cap (chars) so multi-image turns can't blow the main model's context. */
const DESC_MAX_CHARS = 2000;
/** User-text context passed to the describer, capped. */
const CONTEXT_MAX_CHARS = 800;

export interface VisionDescriptionCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  clear(): void;
  snapshot?(): { count: number; bytes: number; oldestAt: number | null };
  evictOldest?(): number;
}

class BoundedLruDescriptionCache implements VisionDescriptionCache {
  private readonly entries = new Map<string, { value: string; sizeBytes: number; storedAt: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    entry.storedAt = Date.now();
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.sizeBytes;
    }
    const sizeBytes = descriptionEncoder.encode(key).byteLength + descriptionEncoder.encode(value).byteLength;
    if (sizeBytes > this.maxBytes || this.maxEntries <= 0) return;
    while (this.entries.size + 1 > this.maxEntries || this.bytes + sizeBytes > this.maxBytes) {
      if (this.evictOldest() === 0) return;
    }
    this.entries.set(key, { value, sizeBytes, storedAt: Date.now() });
    this.bytes += sizeBytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  snapshot(): { count: number; bytes: number; oldestAt: number | null } {
    return {
      count: this.entries.size,
      bytes: this.bytes,
      oldestAt: this.entries.values().next().value?.storedAt ?? null,
    };
  }

  evictOldest(): number {
    const oldest = this.entries.keys().next().value;
    if (oldest === undefined) return 0;
    const entry = this.entries.get(oldest);
    if (!entry) return 0;
    this.entries.delete(oldest);
    this.bytes -= entry.sizeBytes;
    return entry.sizeBytes;
  }
}

let descriptionCacheLimits = {
  maxEntries: DESCRIPTION_CACHE_MAX_ENTRIES,
  maxBytes: VISION_DESCRIPTION_CACHE_MAX_BYTES,
};

function defaultDescriptionCache(): VisionDescriptionCache {
  return new BoundedLruDescriptionCache(descriptionCacheLimits.maxEntries, descriptionCacheLimits.maxBytes);
}

let descriptionCache: VisionDescriptionCache = defaultDescriptionCache();

/** Replace the process cache (primarily for deterministic tests). Passing undefined restores the default LRU. */
export function setVisionDescriptionCache(cache?: VisionDescriptionCache): void {
  descriptionCache = cache ?? defaultDescriptionCache();
}

export function resetVisionDescriptionCache(): void {
  descriptionCache.clear();
}

export function setVisionDescriptionCacheLimitsForTests(
  limits?: { maxEntries?: number; maxBytes?: number },
): void {
  descriptionCacheLimits = limits
    ? { maxEntries: limits.maxEntries ?? DESCRIPTION_CACHE_MAX_ENTRIES, maxBytes: limits.maxBytes ?? VISION_DESCRIPTION_CACHE_MAX_BYTES }
    : { maxEntries: DESCRIPTION_CACHE_MAX_ENTRIES, maxBytes: VISION_DESCRIPTION_CACHE_MAX_BYTES };
  descriptionCache = defaultDescriptionCache();
}

export function visionDescriptionRetainedStoreSnapshot(): {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
} {
  const snapshot = descriptionCache.snapshot?.();
  if (!snapshot) return { count: 0, bytes: 0, evictableBytes: 0, pinnedBytes: 0, oldestAt: null };
  return { ...snapshot, evictableBytes: snapshot.bytes, pinnedBytes: 0 };
}

export function evictOldestVisionDescriptionForBudget(): number {
  return descriptionCache.evictOldest?.() ?? 0;
}

/** Runtime config is permissive: zero is intentional; malformed values fall back to the bounded default. */
export function resolveMaxDescriptionsPerTurn(value: unknown): number {
  if (value === 0) return 0;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_DESCRIPTIONS_PER_TURN;
}

export function isValidVisionTimeoutMs(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_VISION_TIMEOUT_MS
    && value <= MAX_VISION_TIMEOUT_MS;
}

/** Runtime config is permissive: malformed or out-of-range values fall back to the default. */
export function resolveVisionTimeoutMs(value: unknown): number {
  return isValidVisionTimeoutMs(value) ? value : DEFAULT_VISION_TIMEOUT_MS;
}

/** Run `worker` over `items` with bounded concurrency, preserving input order in the result array. */
async function runBounded<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[description truncated]`;
}

export interface AnthropicVisionProvider {
  providerName: string;
  provider: OcxProviderConfig;
}

/**
 * First enabled Anthropic OAuth provider whose active stored account is not marked for reauth.
 * Delegates to the shared sidecar auth module (#2188) — same predicate as web-search.
 */
export function findAnthropicVisionProvider(config: OcxConfig): AnthropicVisionProvider | undefined {
  const auth = resolveSidecarAuth(config);
  if (!auth.isAnthropicAuth || !auth.anthropicProviderName || !auth.anthropicProvider) return undefined;
  return { providerName: auth.anthropicProviderName, provider: auth.anthropicProvider };
}

export function resolveVisionBackend(
  explicit: "openai" | "anthropic" | "routed" | undefined,
  anthropicSidecar: AnthropicVisionProvider | undefined,
): "openai" | "anthropic" {
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  // "routed" collapses to the legacy default order until its describe executor
  // lands (roadmap 170 → 180 revised): a persisted routed backend without a
  // dispatchable arm degrades exactly like unset rather than crashing. wp3
  // replaces this collapse with the real routed arm in planVisionSidecar.
  return anthropicSidecar ? "anthropic" : "openai";
}

/** Native model used by the OpenAI vision helper, including its bounded default. */
export function resolveOpenAiVisionModel(config: Pick<OcxConfig, "visionSidecar">): string {
  const configured = config.visionSidecar?.model;
  // Namespaced routed ids never reach the forward executor (see
  // resolveEffectiveVisionModel).
  return configured && !configured.includes("/") ? configured : DEFAULT_VISION_MODEL;
}

/** Effective describer model for the backend `planVisionSidecar` selected. */
export function resolveEffectiveVisionModel(
  config: Pick<OcxConfig, "visionSidecar">,
  backend: "openai" | "anthropic",
): string {
  const configured = config.visionSidecar?.model;
  // A namespaced "provider/model" id belongs to the routed backend only; the
  // forward/OAuth executors POST the model string verbatim, so it falls back
  // to the side's default here (PUT coherence rejects new writes of this
  // shape, but a legacy or hand-edited config must not break the executor).
  const usable = configured && !configured.includes("/") ? configured : undefined;
  return backend === "anthropic"
    ? usable || DEFAULT_ANTHROPIC_VISION_MODEL
    : usable || DEFAULT_VISION_MODEL;
}

/** A user/developer/toolResult message can carry images (toolResult: e.g. Codex view_image output). */
function carriesImages(role: string): boolean {
  return role === "user" || role === "developer" || role === "toolResult";
}

function messagesHaveImage(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(m =>
    carriesImages(m.role) && Array.isArray(m.content) && (m.content as OcxContentPart[]).some(p => p.type === "image"));
}

export function shouldResolveOpenAiVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
 modelId: string,
 parsed: OcxParsedRequest,
): boolean {
  if (!isModelTextOnly(provider, modelId) || !messagesHaveImage(parsed)) return false;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return false;
  return resolveVisionBackend(cfg.backend, findAnthropicVisionProvider(config)) === "openai";
}

export interface VisionPlan {
  backend: "openai" | "anthropic" | "routed";
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  anthropicSidecar?: AnthropicVisionProvider;
  /** Namespaced "provider/model" describer for the routed backend (roadmap 180). */
  routedModel?: string;
  /** Loopback dispatch inputs for the routed backend. */
  routedConfig?: Pick<OcxConfig, "port" | "apiKeys">;
  settings: VisionSettings;
  maxDescriptionsPerTurn: number;
}

/**
 * Decide whether the vision sidecar should pre-describe images for this request, returning the plan
 * if so. Active when: the routed model is in `provider.noVisionModels`, the request actually carries
 * an image, the sidecar isn't disabled, and the selected backend has usable auth. Returns undefined
 * otherwise (the caller strips images before sending to a text-only model).
 */
export function planVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
): VisionPlan | undefined {
  if (!isModelTextOnly(provider, modelId)) return undefined;
  if (!messagesHaveImage(parsed)) return undefined;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return undefined;

  // Routed arm (roadmap 180 revised): explicit backend + NAMESPACED explicit
  // model only — never inferred from credential availability. Plan-time
  // fence: the target must not be provably blind, and must not itself be a
  // model this planner would re-enter for (belt; the terminal marker on the
  // loopback request is the braces).
  if (cfg.backend === "routed") {
    const routedModel = cfg.model;
    const sep = routedModel ? routedModel.indexOf("/") : -1;
    if (routedModel && sep > 0) {
      const targetProvider = routedModel.slice(0, sep);
      const targetId = routedModel.slice(sep + 1);
      const targetProviderConfig = config.providers?.[targetProvider];
      const targetVisible = modelAcceptsImageInput(config, { provider: targetProvider, id: targetId }) !== false
        && !(targetProviderConfig && isModelTextOnly(targetProviderConfig, targetId));
      if (targetVisible) {
        return {
          backend: "routed",
          routedModel,
          routedConfig: { port: config.port, ...(config.apiKeys ? { apiKeys: config.apiKeys } : {}) },
          settings: {
            model: routedModel,
            reasoning: DEFAULT_REASONING,
            timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
          },
          maxDescriptionsPerTurn: resolveMaxDescriptionsPerTurn(cfg.maxDescriptionsPerTurn),
        };
      }
    }
    // Misconfigured routed backend (bare id, unknown provider, or provably
    // blind target): fall through to the legacy default order below rather
    // than dispatching a describe that cannot work.
  }

  const anthropicSidecar = findAnthropicVisionProvider(config);
  const backend = resolveVisionBackend(cfg.backend, anthropicSidecar);
  // A namespaced routed model must never reach the forward/OAuth executors
  // (they POST the string verbatim); the effective-model resolver falls back
  // to each side's default in that case.
  const model = resolveEffectiveVisionModel(config, backend);
  const maxDescriptionsPerTurn = resolveMaxDescriptionsPerTurn(cfg.maxDescriptionsPerTurn);

  if (backend === "anthropic") {
    if (!anthropicSidecar) return undefined;
    return {
      backend,
      anthropicSidecar,
      settings: {
        model,
        reasoning: normalizeVisionReasoningForModel(model, cfg.reasoning) ?? DEFAULT_REASONING,
        timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
      },
      maxDescriptionsPerTurn,
    };
  }

  if (!openAiSidecar) return undefined;
  return {
    backend,
    forwardSidecar: openAiSidecar,
    settings: {
      model,
      reasoning: normalizeVisionReasoningForModel(model, cfg.reasoning) ?? DEFAULT_REASONING,
        timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
    },
    maxDescriptionsPerTurn,
  };
}

interface ImageJob {
  imageUrl: string;
  detail?: string;
  contextText: string;
}

/** Render one describe outcome as the replacement text part (clamped to the per-image budget). */
function renderDescription(out: { text: string; error?: string }): OcxTextContent {
  return {
    type: "text",
    text: out.error
      ? `[An image was attached but could not be processed: ${out.error}]`
      : `[Image content — described by a vision model because you cannot see images directly:\n${clamp(out.text.trim(), DESC_MAX_CHARS)}]`,
  };
}

const IMAGE_OMITTED_TEXT = "[image omitted: this model is text-only and the vision sidecar is unavailable (no ChatGPT login)]";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep the native Responses passthrough body aligned with image replacements made in the parsed
 * message graph. The passthrough adapter serializes `_rawBody`, while translated adapters serialize
 * `context.messages`; updating only the latter would send the original pixels to a text-only
 * Responses upstream even after the vision sidecar produced a caption.
 *
 * Rewrites only image-bearing user/developer messages and tool outputs. All other native Responses
 * items (reasoning, calls, ids, compaction, and provider-specific metadata) remain byte-structurally
 * untouched.
 */
function syncRawBodyImageDescriptions(parsed: OcxParsedRequest, descriptions: readonly string[]): void {
  const rawBody = parsed._rawBody;
  if (!isPlainRecord(rawBody) || !Array.isArray(rawBody.input)) return;

  let nextDescription = 0;
  const rewriteImages = (value: unknown, nonEmptyImageUrlsOnly: boolean): unknown => {
    if (Array.isArray(value)) {
      let changed = false;
      const rewritten = value.map(entry => {
        const next = rewriteImages(entry, nonEmptyImageUrlsOnly);
        if (next !== entry) changed = true;
        return next;
      });
      return changed ? rewritten : value;
    }
    if (!isPlainRecord(value)) return value;
    if (value.type === "input_image" && typeof value.image_url === "string") {
      if (nonEmptyImageUrlsOnly && value.image_url.length === 0) {
        return { type: "input_text", text: IMAGE_OMITTED_TEXT };
      }
      const description = descriptions[nextDescription++];
      return { type: "input_text", text: description ?? IMAGE_OMITTED_TEXT };
    }
    return value;
  };

  let changed = false;
  const input = rawBody.input.map(item => {
    if (!isPlainRecord(item)) return item;
    const type = typeof item.type === "string" ? item.type : (typeof item.role === "string" ? "message" : "");
    const role = typeof item.role === "string" ? item.role : "";
    const isMessageContent = (
      (type === "message" && (role === "user" || role === "developer"))
      || type === "agent_message"
    );
    const field = isMessageContent
      ? "content"
      : (type === "function_call_output" || type === "custom_tool_call_output")
        ? "output"
        : undefined;
    if (!field) return item;
    const rewritten = rewriteImages(item[field], isMessageContent);
    if (rewritten === item[field]) return item;
    changed = true;
    return { ...item, [field]: rewritten };
  });

  if (changed) rawBody.input = input;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedContext(contextText: string): string {
  return contextText.trim().replace(/\s+/g, " ");
}

function descriptionIdentity(job: ImageJob, plan: VisionPlan): { key: string; persistent: boolean } {
  let imageHash: string;
  let persistent = false;
  const data = /^data:[^;,]+;base64,(.*)$/s.exec(job.imageUrl);
  if (data) {
    imageHash = sha256(Buffer.from(data[1], "base64"));
    persistent = true;
  } else {
    imageHash = sha256(job.imageUrl);
  }
  return {
    key: JSON.stringify([
      plan.backend,
      plan.settings.model,
      ...(plan.backend === "openai" ? [plan.settings.reasoning] : []),
      job.detail ?? "high",
      imageHash,
      sha256(normalizedContext(job.contextText)),
    ]),
    persistent,
  };
}

async function executeDescription(
  job: ImageJob,
  plan: VisionPlan,
  selectedForwardHeaders: Headers,
  abortSignal?: AbortSignal,
  recordSidecarOutcome?: SidecarOutcomeRecorder,
): Promise<DescribeOutcome> {
  if (plan.backend === "routed") {
    if (!plan.routedModel || !plan.routedConfig) return { text: "", error: "routed vision sidecar is unavailable" };
    return describeImageRouted(
      job.imageUrl,
      job.detail,
      job.contextText,
      plan.routedModel,
      plan.routedConfig,
      plan.settings,
      abortSignal,
    );
  }
  if (plan.backend === "anthropic") {
    const sidecar = plan.anthropicSidecar;
    if (!sidecar) return { text: "", error: "anthropic vision sidecar is unavailable" };
    return describeImageAnthropic(
      job.imageUrl,
      job.detail,
      job.contextText,
      sidecar.providerName,
      sidecar.provider,
      plan.settings,
      abortSignal,
    );
  }
  if (!plan.forwardSidecar) return { text: "", error: "OpenAI vision sidecar is unavailable" };
  return describeImage(
    job.imageUrl,
    job.detail,
    job.contextText,
    plan.forwardSidecar.provider,
    plan.forwardSidecar.headers,
    plan.settings,
    abortSignal,
    recordSidecarOutcome,
  );
}

/**
 * Replace every image part in the request with a gpt-described text part, so a text-only model can
 * reason about it. Mutates `parsed.context.messages` in place; uses the message's own text as the
 * description context. All images are described with bounded concurrency (not serially) so a
 * multi-image turn doesn't pay the sum of per-image latencies. Failures degrade to a short marker.
 */
export async function describeImagesInPlace(
  parsed: OcxParsedRequest,
  plan: VisionPlan,
  selectedForwardHeaders: Headers,
  abortSignal?: AbortSignal,
  recordSidecarOutcome?: SidecarOutcomeRecorder,
  translatorBudget?: TranslatorBudget,
): Promise<void> {
  const jobs: ImageJob[] = [];
  const targets: { msg: OcxMessage; parts: OcxContentPart[] }[] = [];
  for (const msg of parsed.context.messages) {
    if (!carriesImages(msg.role) || !Array.isArray(msg.content)) continue;
    const parts = msg.content as OcxContentPart[];
    if (!parts.some(p => p.type === "image")) continue;
    const contextText = parts
      .filter((p): p is OcxTextContent => p.type === "text")
      .map(p => p.text)
      .join(" ")
      .slice(0, CONTEXT_MAX_CHARS);
    for (const p of parts) {
      if (p.type === "image") jobs.push({ imageUrl: p.imageUrl, detail: p.detail, contextText });
    }
    targets.push({ msg, parts });
  }
  if (jobs.length === 0) {
    syncRawBodyImageDescriptions(parsed, []);
    return;
  }

  const inFlight = new Map<string, Promise<DescribeOutcome>>();
  const executions: Array<() => Promise<void>> = [];
  const outcomePromises: Array<Promise<DescribeOutcome>> = [];
  let misses = 0;

  for (const job of jobs) {
    const identity = descriptionIdentity(job, plan);
    const cached = identity.persistent ? descriptionCache.get(identity.key) : undefined;
    if (cached !== undefined) {
      outcomePromises.push(Promise.resolve({ text: cached }));
      continue;
    }

    const existing = inFlight.get(identity.key);
    if (existing) {
      outcomePromises.push(existing);
      continue;
    }

    if (misses >= plan.maxDescriptionsPerTurn) {
      const capped = Promise.resolve<DescribeOutcome>({ text: "", error: "description cap reached for this turn" });
      inFlight.set(identity.key, capped);
      outcomePromises.push(capped);
      continue;
    }

    misses += 1;
    let resolveOutcome!: (outcome: DescribeOutcome) => void;
    const pending = new Promise<DescribeOutcome>(resolve => { resolveOutcome = resolve; });
    inFlight.set(identity.key, pending);
    outcomePromises.push(pending);
    executions.push(async () => {
      let outcome: DescribeOutcome;
      try {
        outcome = await executeDescription(job, plan, selectedForwardHeaders, abortSignal, recordSidecarOutcome);
      } catch (error) {
        outcome = { text: "", error: error instanceof Error ? error.message : String(error) };
      }
      const successfulText = outcome.error ? "" : clamp(outcome.text.trim(), DESC_MAX_CHARS);
      if (identity.persistent && successfulText) {
        descriptionCache.set(identity.key, successfulText);
        enforceAppOwnedMemoryBudget();
      }
      const resolvedOutcome = outcome.error ? outcome : { ...outcome, text: successfulText };
      resolveOutcome(resolvedOutcome);
    });
  }

  await runBounded(executions, VISION_CONCURRENCY, execute => execute());
  const outcomes = await Promise.all(outcomePromises);

  let oi = 0;
  const descriptions: string[] = [];
  for (const { msg, parts } of targets) {
    const newParts: OcxContentPart[] = [];
    for (const p of parts) {
      if (p.type !== "image") {
        newParts.push(p);
        continue;
      }
      const replacement = renderDescription(outcomes[oi++]);
      descriptions.push(replacement.text);
      const reservation = translatorBudget?.reserveTransient(
        descriptionEncoder.encode(replacement.text).byteLength,
        { kind: "request_copies" },
      );
      newParts.push(replacement);
      reservation?.commitRetained();
    }
    msg.content = newParts;
  }
  syncRawBodyImageDescriptions(parsed, descriptions);
}

/**
 * Fail-closed image strip for sidecar-covered models when NO sidecar plan exists (no forward
 * provider / missing forwarded auth / sidecar disabled): the upstream is text-only, so forwarding
 * raw images would 400 or silently confuse it. Replace each image with an explicit marker so the
 * model (and the user, via its reply) knows the image was dropped rather than ignored.
 */
export function stripImagesInPlace(parsed: OcxParsedRequest, translatorBudget?: TranslatorBudget): boolean {
  let stripped = false;
  const descriptions: string[] = [];
  for (const msg of parsed.context.messages) {
    if (!carriesImages(msg.role) || !Array.isArray(msg.content)) continue;
    const parts = msg.content as OcxContentPart[];
    if (!parts.some(p => p.type === "image")) continue;
    msg.content = parts.map(p => {
      if (p.type !== "image") return p;
      const replacement = { type: "text", text: IMAGE_OMITTED_TEXT } as OcxContentPart;
      descriptions.push((replacement as OcxTextContent).text);
      const reservation = translatorBudget?.reserveTransient(
        descriptionEncoder.encode((replacement as OcxTextContent).text).byteLength,
        { kind: "request_copies" },
      );
      reservation?.commitRetained();
      return replacement;
    });
    stripped = true;
  }
  syncRawBodyImageDescriptions(parsed, descriptions);
  return stripped;
}
