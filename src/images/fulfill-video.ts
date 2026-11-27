import { videoModelCapabilities } from "./video-capabilities";
import { safeVideoFailureCode, safeXaiErrorDetail } from "./xai-upstream-error";
import { pathToFileURL } from "node:url";
import type { VideoBridgePlan, VideoCallResult } from "./types";
import { submitVideoJob, pollVideoJob, type VideoProviderAuth } from "./xai-video-client";
import { downloadVideoToArtifact, createVideoBudget, type VideoBudget } from "./artifacts";

/** Parsed arguments from the model's video_gen tool call. */
export interface ParsedVideoArgs {
  ok: true;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  image?: string;
  lastFrame?: string;
  keyframes?: { image: string; timestampS: number }[];
  referenceImages?: string[];
}

const INITIAL_POLL_INTERVAL_MS = 5_000;
/** xAI's clip length when a request names no duration. */
const XAI_DEFAULT_VIDEO_SECONDS = 8;
const MAX_POLL_INTERVAL_MS = 15_000;
const POLL_BACKOFF = 1.5;
const DEFAULT_VIDEO_TIMEOUT_MS = 300_000; // 5 min

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;
export type PollVideoJobFn = (
  requestId: string,
  auth: VideoProviderAuth,
  signal?: AbortSignal,
) => ReturnType<typeof pollVideoJob>;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(new Error("aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Parse the JSON arguments string from a video_gen tool call. Mirrors fulfillImageCall's
 * defensive parsing: invalid JSON or missing prompt returns an error result.
 */
export function parseVideoCallArgs(raw: string, model?: string):
  | ParsedVideoArgs
  | { ok: false; error: string } {
  let args: unknown;
  try {
    args = JSON.parse(raw || "{}");
  } catch {
    return { ok: false, error: "invalid arguments JSON" };
  }
  if (typeof args !== "object" || args === null) {
    return { ok: false, error: "invalid arguments JSON" };
  }
  const obj = args as Record<string, unknown>;

  const caps = videoModelCapabilities(model);
  const prompt = typeof obj.prompt === "string" ? obj.prompt : typeof obj.input === "string" ? obj.input : "";
  const result: ParsedVideoArgs = { ok: true, prompt };
  if (obj.duration !== undefined) {
    // xAI also accepts the seconds as a string ("8"). Anything else is refused rather than
    // clamped or dropped, which would buy a clip of a length the caller did not ask for.
    const seconds = typeof obj.duration === "string" && /^\d{1,2}$/.test(obj.duration) ? Number(obj.duration) : obj.duration;
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 15) {
      return { ok: false, error: "duration must be a whole number of seconds from 1 to 15" };
    }
    result.duration = seconds;
  }
  // An explicit value the model cannot honour is refused: dropping it would buy a video at the
  // upstream default instead of the one the caller asked for.
  for (const [field, allowed] of [["resolution", caps.resolutions], ["aspect_ratio", caps.aspectRatios]] as const) {
    const value = obj[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !allowed.includes(value)) {
      return { ok: false, error: `${field} ${typeof value === "string" ? value.slice(0, 16) : typeof value} is not supported by ${model ?? "unknown"}` };
    }
    if (field === "resolution") result.resolution = value;
    else result.aspectRatio = value;
  }
  for (const [field, supported] of [["image", caps.firstFrame], ["last_frame", caps.lastFrame], ["keyframes", caps.maxKeyframes > 0], ["reference_images", caps.maxReferenceImages > 0]] as const) {
    if (obj[field] !== undefined && !supported) return { ok: false, error: `${field} is not supported by ${model ?? "unknown"}` };
  }
  if (obj.image !== undefined) {
    if (typeof obj.image !== "string" || !obj.image) return { ok: false, error: "invalid image" };
    result.image = obj.image;
  }
  if (obj.last_frame !== undefined) {
    if (typeof obj.last_frame !== "string" || !obj.last_frame) return { ok: false, error: "invalid last_frame" };
    result.lastFrame = obj.last_frame;
  }
  if (obj.keyframes !== undefined) {
    if (!Array.isArray(obj.keyframes) || obj.keyframes.length > caps.maxKeyframes) return { ok: false, error: "invalid keyframes" };
    result.keyframes = [];
    // xAI snaps keyframes to a 1/3-second grid and rejects two in the same slot.
    const slots = new Set<number>();
    for (const frame of obj.keyframes) {
      // Strictly inside the clip that will be generated: xAI uses 8 s when duration is omitted.
      const clip = result.duration ?? XAI_DEFAULT_VIDEO_SECONDS;
      if (!frame || typeof frame !== "object" || typeof frame.image !== "string" || !frame.image || typeof frame.timestamp_s !== "number" || !Number.isFinite(frame.timestamp_s) || frame.timestamp_s <= 0 || frame.timestamp_s >= clip) return { ok: false, error: `invalid keyframe: timestamp_s must be inside the ${clip}s clip` };
      const slot = Math.round(frame.timestamp_s * 3);
      if (slots.has(slot)) return { ok: false, error: "invalid keyframe: two keyframes snap to the same 1/3-second slot" };
      slots.add(slot);
      result.keyframes.push({ image: frame.image, timestampS: frame.timestamp_s });
    }
  }
  if (obj.reference_images !== undefined) {
    if (!Array.isArray(obj.reference_images) || obj.reference_images.length > caps.maxReferenceImages || obj.reference_images.some(value => typeof value !== "string" || !value)) return { ok: false, error: "invalid reference_images" };
    result.referenceImages = obj.reference_images;
  }
  const references = (result.referenceImages?.length ?? 0) > 0;
  if (references && result.duration !== undefined && result.duration > caps.referenceMaxSeconds) {
    return { ok: false, error: `reference_images allow at most ${caps.referenceMaxSeconds}s on ${model ?? "unknown"}` };
  }
  // Pinned last/key frames and references all make it reference-to-video, which stops at 720p.
  if ((references || result.lastFrame || result.keyframes?.length) && result.resolution === "1080p" && caps.referenceMaxResolution === "720p") {
    return { ok: false, error: "reference_images, last_frame and keyframes are limited to 720p" };
  }
  if (result.image && references && !caps.firstFrameWithReferences) {
    return { ok: false, error: `image and reference_images cannot be combined on ${model ?? "unknown"}` };
  }
  // Image-to-video keeps the input image's aspect ratio; an explicit one would be ignored.
  if (result.image && result.aspectRatio && !references && !result.lastFrame && !result.keyframes?.length) {
    return { ok: false, error: "aspect_ratio is ignored when animating an image: the video keeps the image's aspect ratio" };
  }
  if (!prompt && !result.image && !result.lastFrame && !result.keyframes?.length && !result.referenceImages?.length) return { ok: false, error: "missing prompt" };

  return result;
}

/**
 * Poll a video generation job, yielding heartbeats with elapsed-time messages so the
 * caller can forward them to the SSE stream. Returns the final result when the job
 * completes or fails/times out.
 */
export async function* pollVideoWithHeartbeats(
  requestId: string,
  auth: VideoProviderAuth,
  signal: AbortSignal,
  timeoutMs: number = DEFAULT_VIDEO_TIMEOUT_MS,
  /** Test seams — avoid mock.module / global setTimeout (both poison parallel Bun CI). */
  sleepFn: SleepFn = sleep,
  pollFn: PollVideoJobFn = pollVideoJob,
  /** False for a wire whose finished job is fetched from a content endpoint instead of a URL. */
  requireUrl = true,
): AsyncGenerator<
  { type: "heartbeat"; message: string },
  { ok: true; videoUrl?: string } | { ok: false; error: string }
> {
  const start = Date.now();
  let interval = INITIAL_POLL_INTERVAL_MS;
  const timeoutStr = `video generation timed out after ${Math.floor(timeoutMs / 1000)}s`;

  for (;;) {
    if (Date.now() - start >= timeoutMs) {
      return { ok: false, error: timeoutStr };
    }

    try {
      const poll = await pollFn(requestId, auth, signal);
      if (poll.status === "done") {
        if (poll.videoUrl) {
          return { ok: true, videoUrl: poll.videoUrl };
        }
        if (!requireUrl) return { ok: true };
        return { ok: false, error: "video generation completed but no video URL was returned" };
      }
      if (poll.status === "failed") {
        const details = [safeVideoFailureCode(poll.error?.code), safeXaiErrorDetail(poll.error?.message)].filter(Boolean);
        return { ok: false, error: ["video generation failed", ...details].join(": ") };
      }
      if (poll.status === "expired") {
        return { ok: false, error: "video generation expired" };
      }
      // still processing — continue with backoff
    } catch (e) {
      // Distinguish deadline-expiry from client-cancel.
      // AbortSignal.timeout sets signal.reason to a TimeoutError.
      const isDeadline = signal.aborted && e instanceof Error && e.name === "TimeoutError";
      if (isDeadline) return { ok: false, error: timeoutStr };
      if (signal.aborted) return { ok: false, error: "client closed request during video generation" };
      const status = (e as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        // Only the allowlisted detail the client attached; never the raw message.
        const detail = (e as { detail?: unknown }).detail;
        return { ok: false, error: `video poll failed permanently: HTTP ${status}${typeof detail === "string" && detail ? `: ${detail}` : ""}` };
      }
      console.warn(`[videos] poll error (will retry): ${status ? `HTTP ${status}` : "unknown status"}`);
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    yield { type: "heartbeat", message: `Generating video... ${elapsed}s` };

    try {
      await sleepFn(interval, signal);
    } catch {
      const isDeadline = signal.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError";
      if (isDeadline) return { ok: false, error: timeoutStr };
      return { ok: false, error: "client closed request during video generation" };
    }

    interval = Math.min(MAX_POLL_INTERVAL_MS, Math.floor(interval * POLL_BACKOFF));
  }
}

/**
 * Build a success VideoCallResult after the video has been downloaded to disk.
 */
export function buildVideoResult(path: string, prompt: string, model: string): VideoCallResult {
  return {
    ok: true,
    model,
    prompt,
    path,
    files: [path],
    count: 1,
    markdown: `[video](${pathToFileURL(path).href})`,
  };
}

export type { VideoBudget };
export { createVideoBudget };
