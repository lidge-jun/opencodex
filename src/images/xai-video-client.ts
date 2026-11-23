import { DEFAULT_VIDEO_MODEL } from "./video-capabilities";
import { readSafeXaiErrorDetail, safeVideoFailureCode, safeXaiErrorDetail } from "./xai-upstream-error";
/**
 * xAI video generation client.
 *
 * Video generation is asynchronous: a POST to `/videos/generations` returns a `request_id`,
 * which is then polled via GET `/videos/{request_id}` until the status is terminal.
 * The submit call uses a 60 s timeout (it only returns an ID); the poll call uses 30 s.
 * Non-2xx responses throw with the original status code so callers can distinguish
 * rate-limit / auth failures from transient errors.
 *
 * Both calls go through the provider outbound transport, which resolves the destination host,
 * applies the selected row's `allowPrivateNetwork` to every DNS answer and pins the connection to
 * a validated address, so a hostname that resolves to loopback or private space never receives the
 * bearer key without the opt-in and a later DNS answer cannot redirect it (rebinding).
 * The poll GET carries the same key as the submit POST, so it obeys the same cleartext rules.
 */
import type { OcxProviderConfig } from "../types";
import { getProviderRegistryEntry } from "../providers/registry";
import {
  providerOutboundGet,
  providerOutboundPost,
  type ProviderOutboundDependencies,
} from "../lib/provider-outbound";

/**
 * Destination and credential of one video provider. `providerName` and the destination fields are
 * the selected row's, read by the outbound policy; the pinned xAI path uses `xai` with no
 * private-network opt-in because its destination is the registry host.
 */
export interface VideoProviderAuth {
  baseUrl: string;
  token: string;
  providerName: string;
  allowPrivateNetwork?: boolean;
  proxy?: OcxProviderConfig["proxy"];
  noProxy?: OcxProviderConfig["noProxy"];
}

/** Test seam for DNS resolution and the pinned transport; production passes nothing. */
export type VideoOutboundDependencies = Pick<ProviderOutboundDependencies, "resolveAddresses" | "pinnedGet" | "pinnedPost">;

export interface XaiVideoSubmitRequest {
  prompt: string;
  model?: string; // default grok-imagine-video-1.5-lite
  duration?: number; // 1-15 seconds
  resolution?: string; // model-dependent: 480p, 720p, or 1080p
  aspectRatio?: string; // model-dependent aspect ratio
  image?: string;
  lastFrame?: string;
  keyframes?: { image: string; timestampS: number }[];
  referenceImages?: string[];
}

export interface XaiVideoSubmitResult {
  requestId: string;
}

export interface XaiVideoPollResult {
  status: "processing" | "done" | "failed" | "expired";
  videoUrl?: string;
  progress?: number;
  error?: { code?: string; message?: string };
}

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;

function xaiRegistryBaseUrl(): string {
  return (getProviderRegistryEntry("xai")?.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "");
}

/**
 * Only the registry xAI video endpoints qualify for the outbound fake-IP TUN exception, which
 * keeps the pinned xAI path reachable under Clash/Surge TUN mode as it was with plain fetch.
 */
function isCanonicalXaiVideoUrl(name: string, url: string): boolean {
  return name === "xai" && url.startsWith(`${xaiRegistryBaseUrl()}/videos/`);
}

function outboundConfig(auth: VideoProviderAuth) {
  return {
    baseUrl: auth.baseUrl,
    ...(auth.allowPrivateNetwork === true ? { allowPrivateNetwork: true } : {}),
    ...(auth.proxy !== undefined ? { proxy: auth.proxy } : {}),
    ...(auth.noProxy !== undefined ? { noProxy: auth.noProxy } : {}),
  };
}

function outboundDependencies(dependencies: VideoOutboundDependencies): ProviderOutboundDependencies {
  return {
    ...dependencies,
    isCanonicalUrl: isCanonicalXaiVideoUrl,
    // A self-hosted http video service is reachable only on localhost or a local address
    // literal, and only when the row itself sets allowPrivateNetwork (see provider-outbound).
    allowLocalCleartextPost: true,
    // The poll GET sends the bearer key too, so it gets exactly the submit POST's cleartext rules:
    // a public answer for an http host, or a proxied http route, is refused before any send.
    cleartextPolicy: "credentialed",
  };
}

/** Maximum response body size for the submit and poll calls (responses are small JSON). */
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MiB — these endpoints return small JSON

/**
 * Read an HTTP response body as text with a hard byte cap. Used for the non-streaming
 * video submit/poll endpoints.
 */
async function readBoundedText(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("xAI video API returned no body");
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) throw new Error("xAI video API response exceeds size cap");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    reader.releaseLock();
  }
  return text;
}

/**
 * Submit a video generation job to xAI. Returns the `request_id` used for polling.
 */
export async function submitVideoJob(
  req: XaiVideoSubmitRequest,
  auth: VideoProviderAuth,
  signal?: AbortSignal,
  dependencies: VideoOutboundDependencies = {},
): Promise<XaiVideoSubmitResult> {
  const body: Record<string, unknown> = {
    model: req.model ?? DEFAULT_VIDEO_MODEL,
    prompt: req.prompt,
  };
  if (typeof req.duration === "number") body.duration = req.duration;
  if (typeof req.resolution === "string") body.resolution = req.resolution;
  if (typeof req.aspectRatio === "string") body.aspect_ratio = req.aspectRatio;

  if (req.image !== undefined) body.image = { url: req.image };
  if (req.lastFrame !== undefined) body.last_frame = { url: req.lastFrame };
  if (req.keyframes !== undefined) body.keyframes = req.keyframes.map(frame => ({ image: { url: frame.image }, timestamp_s: frame.timestampS }));
  if (req.referenceImages !== undefined) body.reference_images = req.referenceImages.map(url => ({ url }));

  const timeout = AbortSignal.timeout(SUBMIT_TIMEOUT_MS);
  const linkedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const resp = await providerOutboundPost(auth.providerName, outboundConfig(auth), `${auth.baseUrl}/videos/generations`, {
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: linkedSignal,
  }, outboundDependencies(dependencies));

  if (!resp.ok) {
    const detail = await readSafeXaiErrorDetail(resp, linkedSignal);
    const err = new Error("xAI videos API returned " + resp.status + (detail ? `: ${detail}` : "")) as Error & { status: number };
    err.status = resp.status;
    throw err;
  }

  const text = await readBoundedText(resp);
  const json = JSON.parse(text) as { request_id?: string; id?: string };
  const requestId = json.request_id ?? json.id;
  if (typeof requestId !== "string") {
    throw new Error("xAI videos API did not return a request_id");
  }
  return { requestId };
}

/**
 * Poll the status of a video generation job. Call this repeatedly with backoff until
 * `status` is `"done"` (video ready) or a terminal failure state.
 */
export async function pollVideoJob(
  requestId: string,
  auth: VideoProviderAuth,
  signal?: AbortSignal,
  dependencies: VideoOutboundDependencies = {},
): Promise<XaiVideoPollResult> {
  const timeout = AbortSignal.timeout(POLL_TIMEOUT_MS);
  const linkedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const resp = await providerOutboundGet(auth.providerName, outboundConfig(auth), `${auth.baseUrl}/videos/${encodeURIComponent(requestId)}`, {
    headers: {
      "Authorization": `Bearer ${auth.token}`,
    },
    signal: linkedSignal,
  }, outboundDependencies(dependencies));

  if (!resp.ok) {
    const detail = await readSafeXaiErrorDetail(resp, linkedSignal);
    const err = new Error("xAI videos poll API returned " + resp.status + (detail ? `: ${detail}` : "")) as Error & { status: number; detail?: string };
    err.status = resp.status;
    if (detail) err.detail = detail;
    throw err;
  }

  const text = await readBoundedText(resp);
  const json = JSON.parse(text) as {
    status?: string;
    state?: string;
    video?: { url?: string };
    videos?: Array<{ url?: string }>;
    progress?: number;
    error?: { code?: unknown; message?: unknown };
  };

  // Normalize status — xAI uses "done"/"processing"/"failed"/"expired" but be lenient.
  const rawStatus = (json.status ?? json.state ?? "").toLowerCase();
  let status: XaiVideoPollResult["status"];
  if (rawStatus === "done" || rawStatus === "completed" || rawStatus === "succeeded") {
    status = "done";
  } else if (rawStatus === "failed" || rawStatus === "error") {
    status = "failed";
  } else if (rawStatus === "expired" || rawStatus === "timeout") {
    status = "expired";
  } else {
    status = "processing";
  }

  const videoUrl = json.video?.url ?? json.videos?.[0]?.url;

  return {
    status,
    ...(json.error ? { error: { code: safeVideoFailureCode(json.error.code), message: safeXaiErrorDetail(json.error.message) } } : {}),
    ...(typeof videoUrl === "string" ? { videoUrl } : {}),
    ...(typeof json.progress === "number" ? { progress: json.progress } : {}),
  };
}
