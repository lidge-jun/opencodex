import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterRequest } from "../../adapters/base";
import { readBoundedResponseBody } from "../../lib/bounded-body";

// DeepSeek's image-token accounting does not include the inline base64 wire cost.
// https://api-docs.deepseek.com/guides/vision/ documents a separate 48 MiB body cap.
const INLINE_THRESHOLD = 40 * 1024 * 1024;
const TARGET_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_REPAIR_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 512;
const CACHE_MS = 50 * 60 * 1000;
let activeRepairs = 0;
const files = new Map<string, { id: string; until: number }>();

/** Narrow parsed JSON objects without treating arrays as image or message records. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only the first-party Responses image contract, never a similarly named gateway. */
export function needsDeepSeekImageFiles(request: AdapterRequest): boolean {
  const url = new URL(request.url);
  return url.origin === "https://api.deepseek.com"
    && (url.pathname === "/responses" || url.pathname === "/v1/responses")
    && request.method === "POST"
    && Buffer.byteLength(request.body, "utf8") > INLINE_THRESHOLD;
}

/**
 * Replace older inline images with same-account, expiring file references. The client history
 * and images stay intact; provider token usage and Codex's compaction policy remain truthful.
 * The caller owns the provider's transport, cancellation and credential-selection fence.
 */
export async function deepSeekImageFileBody(
  request: AdapterRequest,
  execute: typeof globalThis.fetch,
  abortSignal?: AbortSignal,
  options?: { allowedModels: readonly string[]; budget?: TranslatorBudget },
): Promise<string | undefined> {
  if (!options?.allowedModels.length || !needsDeepSeekImageFiles(request)) return undefined;
  const requestBytes = Buffer.byteLength(request.body, "utf8");
  if (requestBytes > MAX_REPAIR_BYTES) throw new Error("DeepSeek image replay exceeds the 128 MiB repair limit; compact the request.");
  if (activeRepairs >= 2) throw new Error("DeepSeek image replay preparation is busy; retry after an active request completes.");
  activeRepairs++;
  const releaseCopy = options.budget?.observeAcceptedRequestCopy(requestBytes * 2);
  try {
    abortSignal?.throwIfAborted();
    const body: unknown = JSON.parse(request.body);
    if (!record(body) || !options.allowedModels.includes(String(body.model))
      || !Array.isArray(body.input)) return undefined;
    const auth = new Headers(request.headers).get("authorization");
    if (!auth) return undefined;
    const scope = new Bun.CryptoHasher("sha256").update(auth).digest("hex");
    const signal = AbortSignal.any([...(abortSignal ? [abortSignal] : []), AbortSignal.timeout(60_000)]);
    let bytes = Buffer.byteLength(request.body, "utf8");
    let changed = false;
    for (const item of body.input) {
      if (!record(item)) continue;
      const parts = item.type === "function_call_output" || item.type === "custom_tool_call_output"
        ? item.output : item.role === "user" || item.role === "developer" ? item.content : undefined; // DeepSeek rejects other roles' images.
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (bytes <= TARGET_BYTES) break;
        // file_id ignores detail; keep explicit low-resolution requests inline.
        if (!record(part) || part.type !== "input_image" || part.file_id !== undefined
          || part.detail === "low" || typeof part.image_url !== "string") continue;
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(part.image_url);
        if (!match) continue;
        signal.throwIfAborted();
        const data = part.image_url.slice(match[0].length);
        if (data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) continue;
        const hash = new Bun.CryptoHasher("sha256").update(part.image_url).digest("hex");
        const key = `${scope}:${hash}`;
        let entry = files.get(key);
        if (entry && entry.until <= Date.now()) { files.delete(key); entry = undefined; }
        if (!entry) {
          // Conservative peak: UTF-16 base64 slice/re-encoding, decoded buffer, Blob and multipart.
          const releaseUpload = options.budget?.observeExternallyCapped("provider_image_upload", data.length * 4 + Math.ceil(data.length * 3 / 4) * 3 + 65_536);
          try {
            const image = Buffer.from(data, "base64");
            if (image.length > MAX_FILE_BYTES || image.toString("base64") !== data) continue;
            const form = new FormData();
            form.set("purpose", "user_data");
            form.set("expires_after[anchor]", "created_at");
            form.set("expires_after[seconds]", "3600");
            form.set("file", new Blob([image], { type: match[1] }), "image");
            // Never follow a redirect with credentials or copy request-specific Content-Length.
            const response = await execute("https://api.deepseek.com/files", {
              method: "POST", headers: { authorization: auth }, body: form, signal, redirect: "manual",
            });
            if (!response.ok) {
              await response.body?.cancel();
              throw new Error(`DeepSeek image upload failed (HTTP ${response.status}); conversation images were preserved.`);
            }
            const result = await readBoundedResponseBody(response, { signal, maxBytes: 65_536 });
            let uploaded: unknown;
            try { uploaded = JSON.parse(result.text); } catch { /* Safe, fixed error below. */ }
            if (result.truncated || !record(uploaded) || typeof uploaded.id !== "string"
              || !/^file-api-[A-Za-z0-9_-]{1,200}$/.test(uploaded.id)) {
              throw new Error("DeepSeek image upload returned an invalid file reference; conversation images were preserved.");
            }
            // Cache only opaque ids and hashes, not image bytes or plaintext credentials.
            entry = { id: uploaded.id, until: Date.now() + CACHE_MS };
            if (typeof uploaded.expires_at === "number") entry.until = Math.min(entry.until, uploaded.expires_at * 1000 - 60_000);
            while (files.size >= MAX_CACHE_ENTRIES) files.delete(files.keys().next().value!);
            files.set(key, entry);
          } finally { releaseUpload?.(); }
        }
        const removedBytes = part.image_url.length + "image_url".length;
        delete part.image_url;
        part.file_id = entry.id;
        bytes += entry.id.length + "file_id".length - removedBytes;
        changed = true;
      }
    }
    if (!changed) return undefined;
    const releaseSerialization = options.budget?.observeExternallyCapped("passthrough_serialization", requestBytes * 2);
    try { return JSON.stringify(body); } finally { releaseSerialization?.(); }
  } finally { releaseCopy?.(); activeRepairs--; }
}
