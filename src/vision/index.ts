import { createHash } from "node:crypto";
import type { OcxConfig, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent } from "../types";
import { modelInList } from "../types";
import { describeImage, type DescribeOutcome, type VisionSettings } from "./describe";
import { describeImageAnthropic } from "./anthropic-describe";
import type { CodexAuthContext } from "../codex/auth-context";
import { getAccountSet } from "../oauth/store";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import type { SidecarOutcomeRecorder } from "../web-search/executor";

export { describeImage } from "./describe";
export { describeImageAnthropic, parseAnthropicVisionSSE } from "./anthropic-describe";

const DEFAULT_VISION_MODEL = "gpt-5.4-mini";
const DEFAULT_ANTHROPIC_VISION_MODEL = "claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_DESCRIPTIONS_PER_TURN = 8;
const DESCRIPTION_CACHE_MAX_ENTRIES = 256;
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
}

class BoundedLruDescriptionCache implements VisionDescriptionCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

let descriptionCache: VisionDescriptionCache = new BoundedLruDescriptionCache(DESCRIPTION_CACHE_MAX_ENTRIES);

/** Replace the process cache (primarily for deterministic tests). Passing undefined restores the default LRU. */
export function setVisionDescriptionCache(cache?: VisionDescriptionCache): void {
  descriptionCache = cache ?? new BoundedLruDescriptionCache(DESCRIPTION_CACHE_MAX_ENTRIES);
}

export function resetVisionDescriptionCache(): void {
  descriptionCache.clear();
}

/** Runtime config is permissive: zero is intentional; malformed values fall back to the bounded default. */
export function resolveMaxDescriptionsPerTurn(value: unknown): number {
  if (value === 0) return 0;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_MAX_DESCRIPTIONS_PER_TURN;
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

/** First enabled Anthropic OAuth provider whose active stored account is not marked for reauth. */
export function findAnthropicVisionProvider(config: OcxConfig): AnthropicVisionProvider | undefined {
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (provider.disabled === true || provider.adapter !== "anthropic" || provider.authMode !== "oauth") continue;
    const accountSet = getAccountSet(providerName);
    const active = accountSet?.accounts.find(account => account.id === accountSet.activeAccountId);
    if (active && active.needsReauth !== true) return { providerName, provider };
  }
  return undefined;
}

export function resolveVisionBackend(
  explicit: "openai" | "anthropic" | undefined,
  anthropicSidecar: AnthropicVisionProvider | undefined,
): "openai" | "anthropic" {
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  return anthropicSidecar ? "anthropic" : "openai";
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
  if (!modelInList(provider.noVisionModels, modelId) || !messagesHaveImage(parsed)) return false;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return false;
  return resolveVisionBackend(cfg.backend, findAnthropicVisionProvider(config)) === "openai";
}

export interface VisionPlan {
  backend: "openai" | "anthropic";
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  anthropicSidecar?: AnthropicVisionProvider;
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
  if (!modelInList(provider.noVisionModels, modelId)) return undefined;
  if (!messagesHaveImage(parsed)) return undefined;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  const anthropicSidecar = findAnthropicVisionProvider(config);
  const backend = resolveVisionBackend(cfg.backend, anthropicSidecar);
  const maxDescriptionsPerTurn = resolveMaxDescriptionsPerTurn(cfg.maxDescriptionsPerTurn);

  if (backend === "anthropic") {
    if (!anthropicSidecar) return undefined;
    return {
      backend,
      anthropicSidecar,
      settings: { model: cfg.model ?? DEFAULT_ANTHROPIC_VISION_MODEL, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      maxDescriptionsPerTurn,
    };
  }

  if (!openAiSidecar) return undefined;
  return {
    backend,
    forwardSidecar: openAiSidecar,
    settings: { model: cfg.model ?? DEFAULT_VISION_MODEL, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS },
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
): Promise<void> {
  // 1. Gather every image part across messages, each with its own message's text as context.
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
  if (jobs.length === 0) return;

  // 2. Admit misses in source order. Cache hits and same-turn waiters do not consume the cap.
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
      const successfulText = outcome.error ? "" : outcome.text.trim();
      if (identity.persistent && successfulText) descriptionCache.set(identity.key, successfulText);
      resolveOutcome(outcome);
    });
  }

  await runBounded(executions, VISION_CONCURRENCY, execute => execute());
  const outcomes = await Promise.all(outcomePromises);

  // 3. Rebuild each message, replacing image parts with their descriptions in order.
  let oi = 0;
  for (const { msg, parts } of targets) {
    const newParts: OcxContentPart[] = [];
    for (const p of parts) newParts.push(p.type === "image" ? renderDescription(outcomes[oi++]) : p);
    msg.content = newParts;
  }
}

/**
 * Fail-closed image strip for sidecar-covered models when NO sidecar plan exists (no forward
 * provider / missing forwarded auth / sidecar disabled): the upstream is text-only, so forwarding
 * raw images would 400 or silently confuse it. Replace each image with an explicit marker so the
 * model (and the user, via its reply) knows the image was dropped rather than ignored.
 */
export function stripImagesInPlace(parsed: OcxParsedRequest): boolean {
  let stripped = false;
  for (const msg of parsed.context.messages) {
    if (!carriesImages(msg.role) || !Array.isArray(msg.content)) continue;
    const parts = msg.content as OcxContentPart[];
    if (!parts.some(p => p.type === "image")) continue;
    msg.content = parts.map(p => p.type === "image"
      ? { type: "text", text: "[image omitted: this model is text-only and the vision sidecar is unavailable (no ChatGPT login)]" } as OcxContentPart
      : p);
    stripped = true;
  }
  return stripped;
}
