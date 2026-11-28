/**
 * OpenAI Videos API wire (#9110): `POST {baseUrl}/videos` creates a job, `GET {baseUrl}/videos/{id}`
 * reports `queued | in_progress | completed | failed`, and `GET {baseUrl}/videos/{id}/content`
 * returns the rendered bytes with the same bearer key. OpenAI itself shut its Videos API down on
 * 2026-09-24; the shape survives on self-hosted and third-party upstreams (LiteLLM, AI Studio
 * shims), which is what a provider row with `videoApi: "openai"` names.
 *
 * Every request goes through the provider outbound transport with the selected row's name and
 * destination fields, exactly like the xAI wire: DNS answers are checked against that row's
 * `allowPrivateNetwork` and pinned, cleartext is limited to local addresses on an opted-in row,
 * every request carries the key (`cleartextPolicy: "credentialed"`), and no redirect is followed.
 * The content download is the same destination and key as submit and poll; it never leaves that
 * host and never falls back to another provider.
 */
import { providerOutboundGet, providerOutboundPost } from "../lib/provider-outbound";
import { writeVideoResponseToArtifact, type VideoBudget } from "./artifacts";
import { readSafeXaiErrorDetail, safeVideoFailureCode, safeXaiErrorDetail } from "./xai-upstream-error";
import {
  readBoundedText,
  videoOutboundConfig,
  videoOutboundDependencies,
  type VideoOutboundDependencies,
  type VideoProviderAuth,
  type XaiVideoPollResult,
  type XaiVideoSubmitRequest,
} from "./xai-video-client";

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
/** Bound on one content download; the 200 MiB artifact cap bounds its size. */
export const OPENAI_VIDEO_CONTENT_TIMEOUT_MS = 600_000;

/** `variant` values the content endpoint accepts; anything else is refused before any send. */
export const OPENAI_VIDEO_CONTENT_VARIANTS: ReadonlySet<string> = new Set(["video", "thumbnail", "spritesheet"]);

/** Error carrying the upstream HTTP status and, when allowlisted, a safe detail. */
export class VideoUpstreamError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(what: string, status: number, detail?: string) {
    super(`${what} returned ${status}${detail ? `: ${detail}` : ""}`);
    this.name = "VideoUpstreamError";
    this.status = status;
    if (detail) this.detail = detail;
  }
}

/**
 * Whether an upstream job id is safe to place in a request path. It is percent-encoded there, but
 * `.` and `..` survive encoding and a URL parser would collapse them onto another endpoint of the
 * same host, which still receives the key.
 */
export function isUsableUpstreamVideoId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 256 && id !== "." && id !== ".."
    && !/[\u0000-\u001f\u007f]/.test(id);
}

function linked(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function jobUrl(auth: VideoProviderAuth, id: string, suffix = ""): string {
  if (!isUsableUpstreamVideoId(id)) throw new Error("video job id is not usable");
  return `${auth.baseUrl}/videos/${encodeURIComponent(id)}${suffix}`;
}

async function upstreamFailure(what: string, resp: Response, signal: AbortSignal): Promise<VideoUpstreamError> {
  return new VideoUpstreamError(what, resp.status, await readSafeXaiErrorDetail(resp, signal));
}

async function readVideoObject(resp: Response, what: string): Promise<Record<string, unknown>> {
  let json: unknown;
  try { json = JSON.parse(await readBoundedText(resp)); } catch (error) {
    if (error instanceof Error && /size cap/.test(error.message)) throw new Error(`${what} response exceeds size cap`);
    throw new Error(`${what} returned invalid JSON`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error(`${what} returned a non-object body`);
  return json as Record<string, unknown>;
}

/** POST one create body (already shaped for the upstream) and return the job object it answered. */
export async function createOpenAiVideo(
  body: Record<string, unknown>,
  auth: VideoProviderAuth,
  signal?: AbortSignal,
  dependencies: VideoOutboundDependencies = {},
): Promise<Record<string, unknown>> {
  const deadline = linked(signal, SUBMIT_TIMEOUT_MS);
  const resp = await providerOutboundPost(auth.providerName, videoOutboundConfig(auth), `${auth.baseUrl}/videos`, {
    headers: { "Authorization": `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: deadline,
  }, videoOutboundDependencies(dependencies));
  if (!resp.ok) throw await upstreamFailure("OpenAI videos API", resp, deadline);
  const job = await readVideoObject(resp, "OpenAI videos API");
  if (!isUsableUpstreamVideoId(job.id)) throw new Error("OpenAI videos API did not return a usable video id");
  return job;
}

/** GET the job object for one upstream id. */
export async function retrieveOpenAiVideo(
  id: string,
  auth: VideoProviderAuth,
  signal?: AbortSignal,
  dependencies: VideoOutboundDependencies = {},
): Promise<Record<string, unknown>> {
  const deadline = linked(signal, POLL_TIMEOUT_MS);
  const resp = await providerOutboundGet(auth.providerName, videoOutboundConfig(auth), jobUrl(auth, id), {
    headers: { "Authorization": `Bearer ${auth.token}` },
    signal: deadline,
  }, videoOutboundDependencies(dependencies));
  if (!resp.ok) throw await upstreamFailure("OpenAI videos poll API", resp, deadline);
  return readVideoObject(resp, "OpenAI videos poll API");
}

/**
 * GET the rendered content for one upstream id. Returns the successful response with its body
 * unread; the caller streams it under its own cap. A non-2xx answer (a redirect included) throws.
 */
export async function fetchOpenAiVideoContent(
  id: string,
  auth: VideoProviderAuth,
  options: { variant?: string; signal?: AbortSignal } = {},
  dependencies: VideoOutboundDependencies = {},
): Promise<Response> {
  return (await fetchOpenAiVideoContentWithDeadline(id, auth, options, dependencies)).response;
}

/** The public download route also observes this same deadline while its consumer is idle. */
export async function fetchOpenAiVideoContentWithDeadline(
  id: string,
  auth: VideoProviderAuth,
  options: { variant?: string; signal?: AbortSignal } = {},
  dependencies: VideoOutboundDependencies = {},
): Promise<{ response: Response; signal: AbortSignal }> {
  if (options.variant !== undefined && !OPENAI_VIDEO_CONTENT_VARIANTS.has(options.variant)) {
    throw new Error("video content variant is not supported");
  }
  const suffix = options.variant === undefined ? "/content" : `/content?variant=${options.variant}`;
  const deadline = linked(options.signal, OPENAI_VIDEO_CONTENT_TIMEOUT_MS);
  const resp = await providerOutboundGet(auth.providerName, videoOutboundConfig(auth), jobUrl(auth, id, suffix), {
    headers: { "Authorization": `Bearer ${auth.token}` },
    signal: deadline,
  }, videoOutboundDependencies(dependencies));
  if (!resp.ok) throw await upstreamFailure("OpenAI videos content API", resp, deadline);
  return { response: resp, signal: deadline };
}

const SHORT_SIDE: Readonly<Record<string, number>> = { "480p": 480, "720p": 720, "1080p": 1080 };

/**
 * `size` (`WIDTHxHEIGHT`) for a bridge resolution and aspect ratio, or undefined when neither was
 * asked for (the upstream default). The resolution names the short side; 720p and 16:9 fill in
 * whichever is missing. Sides are rounded to even pixels: 720p 16:9 is `1280x720`.
 */
export function openAiVideoSize(resolution: string | undefined, aspectRatio: string | undefined): string | undefined {
  if (resolution === undefined && aspectRatio === undefined) return undefined;
  const short = SHORT_SIDE[resolution ?? "720p"];
  const ratio = /^(\d{1,2}):(\d{1,2})$/.exec(aspectRatio ?? "16:9");
  if (short === undefined || !ratio) throw new Error("resolution or aspect_ratio cannot be expressed as an OpenAI video size");
  const w = Number(ratio[1]);
  const h = Number(ratio[2]);
  if (!w || !h) throw new Error("resolution or aspect_ratio cannot be expressed as an OpenAI video size");
  const long = Math.round((short * Math.max(w, h)) / Math.min(w, h) / 2) * 2;
  return w >= h ? `${long}x${short}` : `${short}x${long}`;
}

/**
 * Bridge submit on the OpenAI wire. `duration` becomes `seconds` (a string, as the API takes it),
 * resolution and aspect ratio become `size`, and a first-frame `image` becomes
 * `input_reference.image_url`. Last frames, keyframes and reference images have no OpenAI Videos
 * field, so they are refused before anything is sent rather than dropped.
 */
export async function submitOpenAiVideoJob(
  req: XaiVideoSubmitRequest,
  auth: VideoProviderAuth,
  signal?: AbortSignal,
  dependencies: VideoOutboundDependencies = {},
): Promise<{ requestId: string }> {
  if (req.lastFrame !== undefined || req.keyframes?.length || req.referenceImages?.length) {
    throw new Error("last_frame, keyframes and reference_images are not supported by the OpenAI Videos API");
  }
  const body: Record<string, unknown> = { prompt: req.prompt };
  if (req.model !== undefined) body.model = req.model;
  if (typeof req.duration === "number") body.seconds = String(req.duration);
  const size = openAiVideoSize(req.resolution, req.aspectRatio);
  if (size !== undefined) body.size = size;
  if (req.image !== undefined) body.input_reference = { image_url: req.image };
  const job = await createOpenAiVideo(body, auth, signal, dependencies);
  return { requestId: job.id as string };
}

/** Map an OpenAI Videos status onto the bridge's poll states; anything unknown keeps polling. */
export function openAiVideoPollStatus(raw: unknown): XaiVideoPollResult["status"] {
  const status = typeof raw === "string" ? raw.toLowerCase() : "";
  if (status === "completed" || status === "succeeded") return "done";
  if (status === "failed" || status === "cancelled" || status === "canceled") return "failed";
  if (status === "expired") return "expired";
  return "processing";
}

/** Bridge poll on the OpenAI wire. A finished job has no URL: its bytes come from `/content`. */
export async function pollOpenAiVideoJob(
  requestId: string,
  auth: VideoProviderAuth,
  signal?: AbortSignal,
  dependencies: VideoOutboundDependencies = {},
): Promise<XaiVideoPollResult> {
  // A thrown VideoUpstreamError carries `status` and `detail`, which the heartbeat loop reads.
  const job = await retrieveOpenAiVideo(requestId, auth, signal, dependencies);
  const error = job.error && typeof job.error === "object" && !Array.isArray(job.error)
    ? job.error as { code?: unknown; message?: unknown }
    : undefined;
  return {
    status: openAiVideoPollStatus(job.status),
    ...(error ? { error: { code: safeVideoFailureCode(error.code), message: safeXaiErrorDetail(error.message) } } : {}),
    ...(typeof job.progress === "number" ? { progress: job.progress } : {}),
  };
}

/** Download a finished job's MP4 from the same destination with the same key, into an artifact. */
export async function downloadOpenAiVideoToArtifact(
  requestId: string,
  auth: VideoProviderAuth,
  budget?: VideoBudget,
  signal?: AbortSignal,
  dependencies: VideoOutboundDependencies = {},
): Promise<string> {
  const resp = await fetchOpenAiVideoContent(requestId, auth, { ...(signal ? { signal } : {}) }, dependencies);
  return writeVideoResponseToArtifact(resp, budget);
}
