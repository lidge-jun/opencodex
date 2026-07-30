/**
 * xAI video generation client.
 *
 * Video generation is asynchronous: a POST to `/videos/generations` returns a `request_id`,
 * which is then polled via GET `/videos/{request_id}` until the status is terminal.
 * The submit call uses a 60 s timeout (it only returns an ID); the poll call uses 30 s.
 * Non-2xx responses throw with the original status code so callers can distinguish
 * rate-limit / auth failures from transient errors.
 */

export interface XaiVideoSubmitRequest {
  prompt: string;
  model?: string; // default "grok-imagine-video"
  duration?: number; // 1-15 seconds
  resolution?: string; // "480p" | "720p"
  aspectRatio?: string; // "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "3:2" | "2:3"
}

export interface XaiVideoSubmitResult {
  requestId: string;
}

export interface XaiVideoPollResult {
  status: "processing" | "done" | "failed" | "expired";
  videoUrl?: string;
  progress?: number;
}

const SUBMIT_TIMEOUT_MS = 60_000;
const POLL_TIMEOUT_MS = 30_000;
const DEFAULT_VIDEO_MODEL = "grok-imagine-video";

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
  auth: { baseUrl: string; token: string },
  signal?: AbortSignal,
): Promise<XaiVideoSubmitResult> {
  const body: Record<string, unknown> = {
    model: req.model ?? DEFAULT_VIDEO_MODEL,
    prompt: req.prompt,
  };
  if (typeof req.duration === "number") body.duration = req.duration;
  if (typeof req.resolution === "string") body.resolution = req.resolution;
  if (typeof req.aspectRatio === "string") body.aspect_ratio = req.aspectRatio;

  const timeout = AbortSignal.timeout(SUBMIT_TIMEOUT_MS);
  const linkedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const resp = await fetch(`${auth.baseUrl}/videos/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: linkedSignal,
  });

  if (!resp.ok) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    const err = new Error("xAI videos API returned " + resp.status) as Error & { status: number };
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
  auth: { baseUrl: string; token: string },
  signal?: AbortSignal,
): Promise<XaiVideoPollResult> {
  const timeout = AbortSignal.timeout(POLL_TIMEOUT_MS);
  const linkedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const resp = await fetch(`${auth.baseUrl}/videos/${encodeURIComponent(requestId)}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${auth.token}`,
    },
    signal: linkedSignal,
  });

  if (!resp.ok) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    const err = new Error("xAI videos poll API returned " + resp.status) as Error & { status: number };
    err.status = resp.status;
    throw err;
  }

  const text = await readBoundedText(resp);
  const json = JSON.parse(text) as {
    status?: string;
    state?: string;
    video?: { url?: string };
    videos?: Array<{ url?: string }>;
    progress?: number;
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
    ...(typeof videoUrl === "string" ? { videoUrl } : {}),
    ...(typeof json.progress === "number" ? { progress: json.progress } : {}),
  };
}
