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
  imageUrl?: string; // if set → /images/edits
}

export interface XaiImageResult {
  images: Array<{ b64_json?: string; url?: string }>;
}

const XAI_IMAGES_TIMEOUT_MS = 60_000;
const XAI_DEFAULT_MODEL = "grok-imagine-image-quality";

export async function callXaiImages(
  req: XaiImageRequest,
  auth: { baseUrl: string; token: string },
  signal?: AbortSignal,
): Promise<XaiImageResult> {
  const isEdit = typeof req.imageUrl === "string" && req.imageUrl.length > 0;
  const endpoint = isEdit ? "/images/edits" : "/images/generations";

  const body: Record<string, unknown> = {
    model: req.model ?? XAI_DEFAULT_MODEL,
    prompt: req.prompt,
    n: req.n ?? 1,
  };
  if (req.size) body.size = req.size;
  if (req.quality) body.quality = req.quality;
  if (isEdit) {
    body.image = { url: req.imageUrl as string, type: "image_url" };
  }

  const timeout = AbortSignal.timeout(XAI_IMAGES_TIMEOUT_MS);
  const linkedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const resp = await fetch(`${auth.baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: linkedSignal,
  });

  if (!resp.ok) {
    throw new Error("xAI images API returned " + resp.status);
  }

  // resp.json() runs under linkedSignal — the timeout / caller abort covers the body read.
  const json = (await resp.json()) as { data?: Array<{ b64_json?: string; url?: string }> };

  const images = (json.data ?? []).map((entry) => ({
    b64_json: entry.b64_json,
    url: entry.url,
  }));

  return { images };
}
