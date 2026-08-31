/**
 * xAI image generation/editing client.
 *
 * Calls xAI's `/images/generations` or `/images/edits` endpoint, composing a
 * 60 s timeout with the caller's abort signal so the deadline covers the entire
 * response body read. Non-2xx responses throw with the original status code —
 * no 502 compression — so callers can distinguish rate-limit / auth failures
 * from transient errors.
 */

export interface XaiImageRequest {
  prompt: string;
  model?: string; // default "grok-imagine-image-quality"
  n?: number; // 1-4
  size?: string;
  quality?: string;
  /** Literal xAI aspect_ratio. Wins over `size` when both are present. */
  aspectRatio?: string;
  imageUrl?: string; // if set → /images/edits
}

export interface XaiImageResult {
  images: Array<{ b64_json?: string; url?: string }>;
}

const XAI_IMAGES_TIMEOUT_MS = 60_000;
const XAI_DEFAULT_MODEL = "grok-imagine-image-quality";

// xAI only accepts aspect_ratio + resolution, not OpenAI's size/quality. Map
// OpenAI's "WxH" size to the closest standard ratio (log-space distance) and
// OpenAI quality buckets onto xAI's 1k/2k resolution. Unknown values are
// dropped rather than forwarded, to avoid sending parameters xAI rejects.
const XAI_ASPECT_RATIOS: ReadonlyArray<readonly [string, number]> = [
  ["1:1", 1],
  ["3:4", 0.75],
  ["4:3", 4 / 3],
  ["9:16", 0.5625],
  ["16:9", 16 / 9],
];
const XAI_ASPECT_RATIO_LITERALS = new Set(XAI_ASPECT_RATIOS.map(([label]) => label));

/** Accept a hosted/Codex `aspect_ratio` literal; `auto` and unknown values drop. */
export function resolveXaiAspectRatioLiteral(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const literal = value.trim();
  if (!literal || literal === "auto") return undefined;
  return XAI_ASPECT_RATIO_LITERALS.has(literal) ? literal : undefined;
}

function resolveAspectRatio(req: XaiImageRequest): string | undefined {
  // An explicit aspect_ratio owns the decision even when it resolves to nothing:
  // "auto" means "let xAI choose", so falling back to a size-derived ratio would
  // silently override the caller. Only an absent field consults `size`.
  if (req.aspectRatio !== undefined && req.aspectRatio.trim()) {
    return resolveXaiAspectRatioLiteral(req.aspectRatio);
  }
  return mapSizeToAspectRatio(req.size);
}

function mapSizeToAspectRatio(size?: string): string | undefined {
  if (!size) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return undefined;
  const ratio = parseInt(m[1], 10) / parseInt(m[2], 10);
  let best = XAI_ASPECT_RATIOS[0]!;
  let bestDiff = Infinity;
  for (const [label, r] of XAI_ASPECT_RATIOS) {
    const diff = Math.abs(Math.log(ratio / r));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [label, r] as const;
    }
  }
  return best[0];
}

function mapQualityToResolution(quality?: string): string | undefined {
  if (!quality) return undefined;
  const q = quality.toLowerCase();
  if (q === "hd" || q === "high") return "2k";
  if (q === "standard" || q === "low" || q === "auto") return "1k";
  return undefined;
}

export async function callXaiImages(
  req: XaiImageRequest,
  auth: { baseUrl: string; token: string },
  signal?: AbortSignal,
  timeoutMs: number = XAI_IMAGES_TIMEOUT_MS,
): Promise<XaiImageResult> {
  const isEdit = typeof req.imageUrl === "string" && req.imageUrl.length > 0;
  const endpoint = isEdit ? "/images/edits" : "/images/generations";

  const body: Record<string, unknown> = {
    model: req.model ?? XAI_DEFAULT_MODEL,
    prompt: req.prompt,
    n: req.n ?? 1,
  };
  const aspectRatio = resolveAspectRatio(req);
  const resolution = mapQualityToResolution(req.quality);
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (resolution) body.resolution = resolution;
  if (isEdit) {
    body.image = { url: req.imageUrl as string, type: "image_url" };
  }

  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : XAI_IMAGES_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(deadlineMs);
  const linkedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const baseUrl = auth.baseUrl.replace(/\/+$/, "");
  const resp = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: linkedSignal,
    // Do not follow 3xx while carrying the xAI bearer. Bun may strip Authorization
    // cross-origin but still leave the request on the redirect target.
    redirect: "manual",
  });

  const redirected = resp.type === "opaqueredirect" || (resp.status >= 300 && resp.status < 400);
  if (redirected) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    const status = resp.status >= 300 && resp.status < 400 ? resp.status : 302;
    const err = new Error("xAI images API returned " + status) as Error & { status: number };
    err.status = status;
    throw err;
  }

  if (!resp.ok) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    const err = new Error("xAI images API returned " + resp.status) as Error & { status: number };
    err.status = resp.status;
    throw err;
  }

  // Read the body as text under the linked signal, then parse. The 60 s timeout
  // and caller abort cover the read. A 200 MiB hard cap on the text prevents a
  // runaway response from exhausting memory before materialization caps apply.
  const MAX_RESPONSE_BYTES = 200 * 1024 * 1024;
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("xAI images API returned no body");
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) throw new Error("xAI images API response exceeds size cap");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* ignore cancel errors */ }
    reader.releaseLock();
  }

  const json = JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string }> };

  const images = (json.data ?? []).map((entry) => ({
    b64_json: entry.b64_json,
    url: entry.url,
  }));

  return { images };
}
