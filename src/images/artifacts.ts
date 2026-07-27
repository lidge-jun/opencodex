import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { RequestOptions } from "node:https";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { assessUrlDestination, resolvePublicAddresses } from "../lib/destination-policy";

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;
/** Hard cap for remote image downloads (also enforced inside pinnedHttpsGet). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
/** Idle timeout for pinned HTTPS connect/headers/body when no AbortSignal is provided. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

// Strict alphabet check: Buffer.from(..., "base64") silently ignores invalid
// characters, so malformed payloads would otherwise decode to garbage bytes.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageBudget {
  spent: number;
}

export type PinnedAddress = { address: string; family: number };

/** Test seam / custom transport: must connect to `pinned`, not re-resolve `url`'s hostname. */
export type PinnedDownloadFn = (
  url: string,
  pinned: PinnedAddress,
  signal?: AbortSignal,
) => Promise<Response>;

export function createImageBudget(): ImageBudget {
  return { spent: 0 };
}

function getArtifactsDir(): string {
  return join(getConfigDir(), "artifacts");
}

function timestampPrefix(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
  ].join("");
}

/** Sniff a recognized image extension, or null when the payload is empty/non-image. */
export function sniffImageExtension(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
  if (bytes.byteLength === 0) return null;
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  if (sig.startsWith("\x89PNG")) return "png";
  if (sig.startsWith("\xff\xd8\xff")) return "jpg";
  if (sig.startsWith("RIFF") && sig.slice(8, 12) === "WEBP") return "webp";
  if (sig.startsWith("GIF8")) return "gif";
  return null;
}

export function guessExtFromMagic(bytes: Uint8Array): string {
  return sniffImageExtension(bytes) ?? "png";
}

export async function materializeInlineImage(
  base64Data: string,
  budget?: ImageBudget,
): Promise<string> {
  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const normalized = base64Data.replace(/\s+/g, "");
  if (!BASE64_RE.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("inline image data is not valid base64");
  }
  // Validate decoded size from the base64 length *before* allocating a Buffer, so a
  // malicious or broken upstream cannot force a large allocation / OOM.
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedBytes = (normalized.length / 4) * 3 - padding;
  if (decodedBytes === 0) throw new Error("inline image data is empty after base64 decode");
  if (decodedBytes > MAX_DECODED_BYTES_PER_IMAGE) throw new Error(`inline image exceeds ${MAX_DECODED_BYTES_PER_IMAGE} byte per-image cap`);
  if (budget && budget.spent + decodedBytes > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`inline image response exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response cap`);
  }

  const buf = Buffer.from(normalized, "base64");
  if (budget) budget.spent += buf.length;

  // Sniff actual format from decoded bytes rather than trusting the declared mimeType.
  const ext = sniffImageExtension(buf);
  if (!ext) throw new Error("inline image data is not a recognized image");
  const filePath = join(dir, `img-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`);
  await writeFile(filePath, buf, { mode: 0o600 });
  return filePath;
}

/**
 * HTTPS GET that connects to a previously validated address while keeping the
 * original hostname for SNI / Host. The custom `lookup` never asks the OS
 * resolver again, so a rebinding answer cannot redirect the TCP peer.
 *
 * Returns a streaming Response so callers can enforce byte caps while reading;
 * the transport also destroys the request if `maxBytes` is exceeded mid-stream.
 */
export function pinnedHttpsGet(
  url: string,
  pinned: PinnedAddress,
  signal?: AbortSignal,
  options?: {
    maxBytes?: number;
    idleTimeoutMs?: number;
    rejectUnauthorized?: boolean;
  },
): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`image URL must use HTTPS, got ${parsed.protocol}`);
  }
  const maxBytes = options?.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const idleTimeoutMs = options?.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }

    let settled = false;
    const fail = (err: unknown) => {
      try { req.destroy(); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const optionsHttps: RequestOptions & { servername?: string } = {
      protocol: "https:",
      hostname: parsed.hostname,
      servername: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: { Host: parsed.host },
      rejectUnauthorized: options?.rejectUnauthorized,
      lookup(_hostname, lookupOptions, callback) {
        const opts = typeof lookupOptions === "function" ? undefined : lookupOptions;
        const cb = typeof lookupOptions === "function" ? lookupOptions : callback;
        if (!cb) return;
        // Pin the validated peer — do not call dns.lookup again.
        // Honor `{ all: true }` array shape used by some Node/Bun https paths.
        if (opts && typeof opts === "object" && "all" in opts && opts.all) {
          (cb as (err: NodeJS.ErrnoException | null, addresses: PinnedAddress[]) => void)(
            null,
            [{ address: pinned.address, family: pinned.family }],
          );
          return;
        }
        (cb as (err: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void)(
          null,
          pinned.address,
          pinned.family as 4 | 6,
        );
      },
    };

    const req = https.request(optionsHttps, (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      // Any non-2xx must destroy immediately. Returning a streaming Response for
      // 4xx/5xx (or 3xx) lets callers that only check `Response.ok` abandon an
      // unread body while the peer keeps sending — a failed-response socket leak.
      if (status < 200 || status >= 300) {
        try { res.destroy(); } catch { /* ignore */ }
        fail(new Error("image download failed: " + status));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, String(item));
        } else {
          headers.set(key, String(value));
        }
      }

      let received = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.setTimeout(idleTimeoutMs, () => {
            fail(new Error("image download stalled"));
            try { controller.error(new Error("image download stalled")); } catch { /* closed */ }
          });
          res.on("data", (chunk: Buffer | string) => {
            const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            received += buf.byteLength;
            if (received > maxBytes) {
              const err = new Error(`image download exceeds ${maxBytes} byte cap`);
              fail(err);
              try { controller.error(err); } catch { /* closed */ }
              return;
            }
            try { controller.enqueue(buf); } catch { /* closed */ }
          });
          res.on("end", () => {
            try { controller.close(); } catch { /* closed */ }
          });
          res.on("error", (err: Error) => {
            fail(err);
            try { controller.error(err); } catch { /* closed */ }
          });
        },
        cancel() {
          req.destroy();
        },
      });

      if (settled) return;
      settled = true;
      resolve(new Response(stream, { status, headers }));
    });

    const onAbort = () => {
      fail(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.setTimeout(idleTimeoutMs, () => {
      fail(new Error("image download timed out"));
    });
    req.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      fail(err);
    });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.end();
  });
}

function pickPinnedAddress(addresses: PinnedAddress[]): PinnedAddress {
  return addresses.find(a => a.family === 4) ?? addresses[0]!;
}

export async function downloadImageToArtifact(
  url: string,
  budget?: ImageBudget,
  signal?: AbortSignal,
  options?: { pinnedDownload?: PinnedDownloadFn },
): Promise<string> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!m) throw new Error("data URL is not a valid base64 image");
    return materializeInlineImage(m[2], budget);
  }

  // SSRF protection: validate the provider-returned URL before fetching.
  // Require HTTPS strictly — plain HTTP and all other schemes (ftp, file, …) are rejected.
  // Resolve DNS once, then pin that public address for the HTTPS connect (SNI/Host keep
  // the original hostname) so a rebinding answer cannot retarget the TCP peer.
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { throw new Error("image URL is not valid"); }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`image URL must use HTTPS, got ${parsedUrl.protocol}`);
  }
  // Reject literal private/loopback/link-local/metadata addresses.
  const assessment = assessUrlDestination(url);
  if (assessment && assessment.kind !== "public" && assessment.kind !== "hostname") {
    throw new Error(`image URL targets ${assessment.detail}`);
  }
  const resolved = await resolvePublicAddresses(url);
  const pinned = pickPinnedAddress(resolved.addresses);
  const download = options?.pinnedDownload ?? pinnedHttpsGet;
  const resp = await download(url, pinned, signal);
  if (!resp.ok) {
    // Custom `pinnedDownload` seams may still return a failed Response with a
    // live body; cancel it so unread error payloads cannot keep the socket warm.
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw new Error("image download failed: " + resp.status);
  }

  // Stream the body with a hard byte cap so a missing/lying Content-Length or a
  // compromised CDN URL cannot exhaust memory before the size check runs.
  if (!resp.body) throw new Error("image download returned no body");
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error(`image download exceeds ${MAX_DOWNLOAD_BYTES} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore cancel errors */ }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }

  if (bytes.byteLength === 0) throw new Error("image download returned empty body");
  const ext = sniffImageExtension(bytes);
  if (!ext) throw new Error("image download did not contain a recognized image");

  if (budget && budget.spent + bytes.length > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`image download exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response budget`);
  }

  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (budget) budget.spent += bytes.length;

  const filePath = join(dir, `dl-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`);
  await writeFile(filePath, bytes, { mode: 0o600 });
  return filePath;
}
