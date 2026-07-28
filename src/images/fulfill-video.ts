import { pathToFileURL } from "node:url";
import type { VideoBridgePlan, VideoCallResult } from "./types";
import { submitVideoJob, pollVideoJob } from "./xai-video-client";
import { downloadVideoToArtifact, createVideoBudget, type VideoBudget } from "./artifacts";

/** Parsed arguments from the model's video_gen tool call. */
export interface ParsedVideoArgs {
  ok: true;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
}

const INITIAL_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 15_000;
const POLL_BACKOFF = 1.5;
const DEFAULT_VIDEO_TIMEOUT_MS = 300_000; // 5 min

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;
export type PollVideoJobFn = (
  requestId: string,
  auth: { baseUrl: string; token: string },
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
export function parseVideoCallArgs(raw: string):
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

  const prompt =
    typeof obj.prompt === "string" ? obj.prompt : typeof obj.input === "string" ? obj.input : "";
  if (!prompt) {
    return { ok: false, error: "missing prompt" };
  }

  const result: ParsedVideoArgs = { ok: true, prompt };

  // duration: clamp to 1-15
  if (typeof obj.duration === "number") {
    result.duration = Math.max(1, Math.min(15, Math.floor(obj.duration)));
  }

  if (typeof obj.resolution === "string" && (obj.resolution === "480p" || obj.resolution === "720p")) {
    result.resolution = obj.resolution;
  }
  if (typeof obj.aspect_ratio === "string") {
    const VALID_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
    if (VALID_RATIOS.includes(obj.aspect_ratio)) result.aspectRatio = obj.aspect_ratio;
  }

  return result;
}

/**
 * Poll a video generation job, yielding heartbeats with elapsed-time messages so the
 * caller can forward them to the SSE stream. Returns the final result when the job
 * completes or fails/times out.
 */
export async function* pollVideoWithHeartbeats(
  requestId: string,
  auth: { baseUrl: string; token: string },
  signal: AbortSignal,
  timeoutMs: number = DEFAULT_VIDEO_TIMEOUT_MS,
  /** Test seams — avoid mock.module / global setTimeout (both poison parallel Bun CI). */
  sleepFn: SleepFn = sleep,
  pollFn: PollVideoJobFn = pollVideoJob,
): AsyncGenerator<
  { type: "heartbeat"; message: string },
  { ok: true; videoUrl: string } | { ok: false; error: string }
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
        return { ok: false, error: "video generation completed but no video URL was returned" };
      }
      if (poll.status === "failed") {
        return { ok: false, error: "video generation failed" };
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
        return { ok: false, error: `video poll failed permanently: HTTP ${status}` };
      }
      console.warn(`[videos] poll error (will retry): ${e instanceof Error ? e.message : String(e)}`);
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
