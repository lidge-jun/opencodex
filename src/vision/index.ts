import type { OcxConfig, OcxContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTextContent } from "../types";
import { modelInList } from "../types";
import { describeImage, type VisionSettings } from "./describe";
import type { CodexAuthContext } from "../codex-auth-context";
import type { SidecarOutcomeRecorder } from "../web-search/executor";

export { describeImage } from "./describe";

const DEFAULT_VISION_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = 45_000;
/** Max images described in parallel — keeps first-token latency bounded without flooding the backend. */
const VISION_CONCURRENCY = 3;
/** Per-image description hard cap (chars) so multi-image turns can't blow the main model's context. */
const DESC_MAX_CHARS = 2000;
/** User-text context passed to the describer, capped. */
const CONTEXT_MAX_CHARS = 800;

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

/** First configured forward (ChatGPT passthrough) provider — the path with native image input. */
function findForwardProvider(config: OcxConfig): OcxProviderConfig | undefined {
  for (const prov of Object.values(config.providers)) {
    if (prov.disabled === true) continue;
    if (prov.authMode === "forward") return prov;
  }
  return undefined;
}

/** A user/developer/toolResult message can carry images (toolResult: e.g. Codex view_image output). */
function carriesImages(role: string): boolean {
  return role === "user" || role === "developer" || role === "toolResult";
}

function messagesHaveImage(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(m =>
    carriesImages(m.role) && Array.isArray(m.content) && (m.content as OcxContentPart[]).some(p => p.type === "image"));
}

export interface VisionPlan {
  forwardProvider: OcxProviderConfig;
  settings: VisionSettings;
}

/**
 * Decide whether the vision sidecar should pre-describe images for this request, returning the plan
 * if so. Active when: the routed model is in `provider.noVisionModels`, the request actually carries
 * an image, a forward provider exists, the sidecar isn't disabled, and the caller forwarded ChatGPT
 * auth. Returns undefined otherwise (the request takes the normal path — images sent natively).
 */
export function planVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
  incomingHeaders: Headers,
  authContext: CodexAuthContext = { kind: "main", accountId: null },
): VisionPlan | undefined {
  if (!modelInList(provider.noVisionModels, modelId)) return undefined;
  if (!messagesHaveImage(parsed)) return undefined;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  if (authContext.kind === "main" && !incomingHeaders.get("authorization")) return undefined;
  const forwardProvider = findForwardProvider(config);
  if (!forwardProvider) return undefined;
  return {
    forwardProvider,
    settings: { model: cfg.model ?? DEFAULT_VISION_MODEL, timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS },
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

/**
 * Replace every image part in the request with a gpt-described text part, so a text-only model can
 * reason about it. Mutates `parsed.context.messages` in place; uses the message's own text as the
 * description context. All images are described with bounded concurrency (not serially) so a
 * multi-image turn doesn't pay the sum of per-image latencies. Failures degrade to a short marker.
 */
export async function describeImagesInPlace(
  parsed: OcxParsedRequest,
  forwardProvider: OcxProviderConfig,
  selectedForwardHeaders: Headers,
  settings: VisionSettings,
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

  // 2. Describe all images with bounded concurrency (order preserved).
  const outcomes = await runBounded(jobs, VISION_CONCURRENCY, j =>
    describeImage(j.imageUrl, j.detail, j.contextText, forwardProvider, selectedForwardHeaders, settings, abortSignal, recordSidecarOutcome));

  // 3. Rebuild each message, replacing image parts with their descriptions in order.
  let oi = 0;
  for (const { msg, parts } of targets) {
    const newParts: OcxContentPart[] = [];
    for (const p of parts) newParts.push(p.type === "image" ? renderDescription(outcomes[oi++]) : p);
    msg.content = newParts;
  }
}
