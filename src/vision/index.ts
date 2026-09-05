import { createHash } from "node:crypto";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxTextContent } from "../types";
import { describeImage, type DescribeOutcome } from "./describe";
import { describeImageAnthropic } from "./anthropic-describe";
import { describeImageRouted } from "./routed-describe";
import type { CodexAuthContext } from "../codex/auth-context";
import type { SidecarOutcomeRecorder } from "../web-search/executor";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { VisionPlan } from "./plan";
import { carriesImages, descriptionEncoder, syncRawBodyImageDescriptions } from "./image-rewrite";

export { describeImage } from "./describe";
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
export { DEFAULT_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS } from "./timeout-bounds";
export {
  DEFAULT_MAX_DESCRIPTIONS_PER_TURN,
  resolveMaxDescriptionsPerTurn,
  isValidVisionTimeoutMs,
  resolveVisionTimeoutMs,
  findAnthropicVisionProvider,
  resolveVisionBackend,
  resolveOpenAiVisionModel,
  resolveEffectiveVisionModel,
  shouldResolveOpenAiVisionSidecar,
  planVisionSidecar,
} from "./plan";
export type { AnthropicVisionProvider, VisionPlan } from "./plan";
export { stripImagesInPlace } from "./image-rewrite";


const DESCRIPTION_CACHE_MAX_ENTRIES = 256;
export const VISION_DESCRIPTION_CACHE_MAX_BYTES = 1024 * 1024;
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
