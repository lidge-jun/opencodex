import { readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { mkdir, writeFile, open, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { getConfigDir } from "../config";
import { assessUrlDestination, resolvePublicAddresses } from "../lib/destination-policy";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { pinnedHttpGet, type PinnedAddress } from "../lib/pinned-http";

export type { PinnedAddress } from "../lib/pinned-http";

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;
/** Hard cap for remote image downloads (also enforced inside pinnedHttpsGet). */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB
/** Idle timeout for pinned HTTPS connect/headers/body when no AbortSignal is provided. */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Upper bound on the raw base64 string length before it is decoded. Base64
 * encoding expands 3 decoded bytes to 4 encoded chars, so this corresponds to
 * MAX_DECODED_BYTES_PER_IMAGE. Checking this in the adapter (before calling
 * materializeInlineImage) rejects oversized payloads before normalization
 * copies them — see Wibias R4 finding 5.
 */
export const MAX_ENCODED_BYTES_PER_IMAGE = Math.ceil(MAX_DECODED_BYTES_PER_IMAGE * 4 / 3);

/** Default cap on files retained under artifacts/. Oldest files are pruned when exceeded. */
export const DEFAULT_ARTIFACT_KEEP_COUNT = 200;

/** Opaque artifact HTTP path prefix (data-plane, API-auth gated). */
export const ARTIFACT_HTTP_PREFIX = "/v1/opencodex/artifacts";

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif)$/i;

// Strict alphabet check: Buffer.from(..., "base64") silently ignores invalid
// characters, so malformed payloads would otherwise decode to garbage bytes.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageBudget {
  spent: number;
}

/** Test seam / custom transport: must connect to `pinned`, not re-resolve `url`'s hostname. */
export type PinnedDownloadFn = (
  url: string,
  pinned: PinnedAddress,
  signal?: AbortSignal,
) => Promise<Response>;

export function createImageBudget(): ImageBudget {
  return { spent: 0 };
}

/** Atomically reserve `bytes` against the per-response budget (no await between check and charge). */
export function chargeImageBudget(budget: ImageBudget | undefined, bytes: number): void {
  if (!budget) return;
  if (budget.spent + bytes > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`image response exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response cap`);
  }
  budget.spent += bytes;
}

export function getArtifactsDir(): string {
  return join(getConfigDir(), "artifacts");
}

/**
 * Markdown-safe relative URL for a materialized artifact. Opaque filename only —
 * never expose host filesystem paths to model-visible content.
 */
export function artifactHttpUrl(filePath: string): string {
  const name = basename(filePath);
  if (!ARTIFACT_ID_RE.test(name)) {
    throw new Error("artifact filename is not a valid opaque id");
  }
  return `${ARTIFACT_HTTP_PREFIX}/${name}`;
}

/**
 * Resolve an opaque artifact id to an absolute path under the artifacts dir.
 * Rejects traversal (`..`, absolute paths, separators).
 */
export function resolveArtifactPath(id: string): string | null {
  if (!ARTIFACT_ID_RE.test(id)) return null;
  const dir = resolve(getArtifactsDir());
  const candidate = resolve(dir, id);
  if (candidate !== dir && !candidate.startsWith(dir + sep)) return null;
  if (!existsSync(candidate)) return null;
  try {
    if (!statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  return candidate;
}

export function readArtifactBytes(id: string): { bytes: Buffer; contentType: string } | null {
  const path = resolveArtifactPath(id);
  if (!path) return null;
  const bytes = readFileSync(path);
  const ext = path.split(".").pop()?.toLowerCase();
  const contentType =
    ext === "png" ? "image/png"
      : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
        : ext === "webp" ? "image/webp"
          : ext === "gif" ? "image/gif"
            : "application/octet-stream";
  return { bytes, contentType };
}

/**
 * Decode + validate base64 image bytes (alphabet, size, magic). Used by CCA
 * Images fallback before returning b64_json and by materializeInlineImage.
 */
export function decodeValidatedImageBase64(base64Data: string): Buffer {
  const normalized = base64Data.replace(/\s+/g, "");
  if (!BASE64_RE.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("inline image data is not valid base64");
  }
  if (normalized.length > MAX_ENCODED_BYTES_PER_IMAGE) {
    throw new Error(`inline image exceeds ${MAX_DECODED_BYTES_PER_IMAGE} byte per-image cap`);
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const decodedBytes = (normalized.length / 4) * 3 - padding;
  if (decodedBytes === 0) throw new Error("inline image data is empty after base64 decode");
  if (decodedBytes > MAX_DECODED_BYTES_PER_IMAGE) {
    throw new Error(`inline image exceeds ${MAX_DECODED_BYTES_PER_IMAGE} byte per-image cap`);
  }
  const buf = Buffer.from(normalized, "base64");
  guessExtFromMagic(buf);
  return buf;
}

/**
 * Best-effort retention cap: when the artifact directory holds more than `maxFiles`,
 * delete the oldest (by mtime) until the count is back under the limit. Synchronous
 * on purpose — it runs right after each successful write and touches at most a handful
 * of files. All errors are swallowed and logged so a prune failure never breaks an image write.
 */
export function pruneOldArtifacts(dir: string, maxFiles: number): void {
  // A non-positive maxFiles disables pruning entirely (do not delete everything).
  if (maxFiles <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    console.warn(`[images] prune: could not read ${dir}:`, e instanceof Error ? e.message : e);
    return;
  }
  if (entries.length <= maxFiles) return;

  let stats: Array<{ name: string; mtime: number }>;
  try {
    stats = entries.map(name => {
      const st = statSync(join(dir, name));
      return { name, mtime: st.mtimeMs };
    });
  } catch (e) {
    console.warn(`[images] prune: could not stat files in ${dir}:`, e instanceof Error ? e.message : e);
    return;
  }

  // Sort oldest-first, delete the excess.
  stats.sort((a, b) => a.mtime - b.mtime);
  const toDelete = stats.slice(0, stats.length - maxFiles);
  for (const { name } of toDelete) {
    try {
      unlinkSync(join(dir, name));
    } catch (e) {
      console.warn(`[images] prune: could not delete ${name}:`, e instanceof Error ? e.message : e);
    }
  }
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

/**
 * Write a buffer to a unique artifact file using `flag: "wx"` (exclusive create).
 * Collisions on the random UUID suffix are astronomically unlikely, but `wx`
 * would surface them as EEXIST; retry a few times with a fresh UUID before
 * giving up so a fluke name clash can never fail an image write.
 */
async function writeArtifactUnique(
  dir: string,
  prefix: string,
  buf: Uint8Array,
  ext: string,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? crypto.randomUUID() : `${crypto.randomUUID()}-${attempt}`;
    const filePath = join(dir, `${prefix}${timestampPrefix()}-${suffix}.${ext}`);
    try {
      await writeFile(filePath, buf, { mode: 0o600, flag: "wx" });
      return filePath;
    } catch (e) {
      if (e instanceof Error && "code" in e && (e as { code: string }).code === "EEXIST" && attempt < 3) continue;
      throw e;
    }
  }
}

/** Sniff a recognized image extension, or null when the payload is empty/non-image. */
export function sniffImageExtension(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
  if (bytes.byteLength === 0) return null;
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  // Full 8-byte PNG signature (89 50 4E 47 0D 0A 1A 0A) — reject truncated/malformed prefixes.
  if (sig.startsWith("\x89PNG\r\n\x1a\n")) return "png";
  if (sig.startsWith("\xff\xd8\xff")) return "jpg";
  if (sig.startsWith("RIFF") && sig.slice(8, 12) === "WEBP") return "webp";
  if (sig.startsWith("GIF8")) return "gif";
  return null;
}

export function guessExtFromMagic(bytes: Uint8Array): string {
  const ext = sniffImageExtension(bytes);
  if (!ext) {
    throw new Error("unrecognized image format — magic bytes do not match PNG, JPEG, WebP, or GIF");
  }
  return ext;
}

/** Prune `OPENCODEX_HOME/artifacts` after a full image batch has been written. */
export function pruneArtifacts(keepCount?: number): void {
  pruneOldArtifacts(getArtifactsDir(), keepCount ?? DEFAULT_ARTIFACT_KEEP_COUNT);
}

export async function materializeInlineImage(
  base64Data: string,
  budget?: ImageBudget,
): Promise<string> {
  const dir = getArtifactsDir();
  recordOwnedConfigPath(getConfigDir(), dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const buf = decodeValidatedImageBase64(base64Data);
  chargeImageBudget(budget, buf.length);

  // Sniff actual format from decoded bytes rather than trusting the declared mimeType.
  const ext = sniffImageExtension(buf);
  if (!ext) throw new Error("inline image data is not a recognized image");
  // Retention is post-batch via pruneArtifacts (see fulfill.ts) so a tight keepCount
  // cannot delete earlier images from the same call before their paths are returned.
  return writeArtifactUnique(dir, "img-", buf, ext);
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
  return pinnedHttpGet(url, pinned, signal, {
    maxBytes,
    idleTimeoutMs,
    rejectUnauthorized: options?.rejectUnauthorized,
    context: "image download",
  }).then(response => {
    if (!response.ok) throw new Error("image download failed: " + response.status);
    return response;
  });
}

function pickPinnedAddress(addresses: PinnedAddress[]): PinnedAddress {
  return addresses.find(a => a.family === 4) ?? addresses[0]!;
}

/**
 * HTTPS-only destination check, public-address resolution, and pinned connect.
 * Callers own the !ok / 3xx policy so image vs video error text can stay distinct.
 */
async function connectPublicHttps(
  url: string,
  options: {
    context: string;
    signal?: AbortSignal;
    pinnedDownload?: PinnedDownloadFn;
    maxBytes?: number;
  },
): Promise<Response> {
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { throw new Error(`${options.context} URL is not valid`); }
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`${options.context} URL must use HTTPS, got ${parsedUrl.protocol}`);
  }
  const assessment = assessUrlDestination(url);
  if (assessment && assessment.kind !== "public" && assessment.kind !== "hostname") {
    throw new Error(`${options.context} URL targets ${assessment.detail}`);
  }
  const resolved = await resolvePublicAddresses(url, options.context);
  const pinned = pickPinnedAddress(resolved.addresses);
  const download = options.pinnedDownload ?? ((resource, peer, signal) =>
    pinnedHttpGet(resource, peer, signal, {
      // `maxBytes` is optional in pinnedHttpGet, so forwarding undefined removes the
      // cap entirely instead of inheriting a default. Keep the 50 MiB ceiling when a
      // caller omits a limit, and honour an explicit tighter one.
      maxBytes: options.maxBytes ?? MAX_DOWNLOAD_BYTES,
      context: `${options.context} download`,
    }));
  return download(url, pinned, options.signal);
}

/**
 * Fetch a provider-returned image URL after destination-policy + pinned HTTPS.
 * Redirects are not followed: the default pinned GET returns the status, and this
 * helper rejects every non-2xx including 3xx. Throws a message that names the
 * class of failure (scheme / destination kind / download) without reflecting the
 * target URL.
 */
export async function fetchPublicHttpsImage(
  url: string,
  options?: {
    signal?: AbortSignal;
    pinnedDownload?: PinnedDownloadFn;
    maxBytes?: number;
  },
): Promise<Response> {
  const resp = await connectPublicHttps(url, {
    context: "image",
    signal: options?.signal,
    pinnedDownload: options?.pinnedDownload,
    maxBytes: options?.maxBytes,
  });
  if (!resp.ok || (resp.status >= 300 && resp.status < 400)) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw new Error("image download failed");
  }
  return resp;
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

  const resp = await fetchPublicHttpsImage(url, {
    signal,
    pinnedDownload: options?.pinnedDownload,
    maxBytes: MAX_DOWNLOAD_BYTES,
  });

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

  chargeImageBudget(budget, bytes.length);

  const dir = getArtifactsDir();
  recordOwnedConfigPath(getConfigDir(), dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  // Retention is post-batch via pruneArtifacts (see fulfill.ts).
  return writeArtifactUnique(dir, "dl-", bytes, ext);
}

const MAX_VIDEO_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB
/** Aggregate per-turn video download cap (600 MiB = 3 × max single download). */
const MAX_VIDEO_BYTES_PER_TURN = MAX_VIDEO_DOWNLOAD_BYTES * 3;

export interface VideoBudget {
  spent: number;
  /** Ceiling on total bytes across all downloads this turn. */
  cap: number;
}

export function createVideoBudget(): VideoBudget {
  return { spent: 0, cap: MAX_VIDEO_BYTES_PER_TURN };
}

/** Charge bytes to the budget; returns false if the ceiling would be exceeded. */
export function chargeVideoBudget(budget: VideoBudget, bytes: number): boolean {
  if (budget.spent + bytes > budget.cap) return false;
  budget.spent += bytes;
  return true;
}

export function guessVideoExtFromMagic(bytes: Uint8Array): string {
  if (bytes.byteLength < 12) throw new Error("video data too short for magic byte sniffing");
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  // MP4/QuickTime/MOV: bytes 4-7 == "ftyp" (ISO BMFF)
  if (sig.slice(4, 8) === "ftyp") return "mp4";
  // WebM/Matroska: \x1a\x45\xdf\xa3
  if (sig.startsWith("\x1a\x45\xdf\xa3")) return "webm";
  throw new Error("unrecognized video format — magic bytes do not match MP4 or WebM");
}

/**
 * Download a video from a URL to an artifact file with a 200 MiB hard cap, streaming the body
 * to disk to avoid buffering. SSRF protection reuses the same destination policy + pinned HTTPS
 * as image downloads. Format is sniffed from magic bytes.
 */
export async function downloadVideoToArtifact(
  url: string,
  budget?: VideoBudget,
  signal?: AbortSignal,
): Promise<string> {
  // For data: URLs, handle inline (unlikely for video but keep parity)
  if (url.startsWith("data:")) {
    const commaIdx = url.indexOf(",");
    const meta = url.slice(0, commaIdx);
    const data = url.slice(commaIdx + 1);
    const isBase64 = meta.includes(";base64");
    if (!isBase64) throw new Error("non-base64 data URI for video is not supported");
    const buf = Buffer.from(data, "base64");
    if (budget && !chargeVideoBudget(budget, buf.byteLength)) {
      throw new Error("video data URI exceeds per-turn download budget");
    }
    if (buf.byteLength > MAX_VIDEO_DOWNLOAD_BYTES) throw new Error("video data URI exceeds size cap");
    const ext = guessVideoExtFromMagic(buf);
    const dir = getArtifactsDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `vid-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`;
    const dest = join(dir, name);
    await writeFile(dest, buf, { mode: 0o600 });
    return dest;
  }

  const resp = await connectPublicHttps(url, {
    context: "video",
    signal,
    maxBytes: MAX_VIDEO_DOWNLOAD_BYTES,
  });
  if (!resp.ok) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw new Error("video download failed: " + resp.status);
  }

  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("video download returned no body");

  // Buffer at least 12 bytes for magic-byte sniffing before opening the file.
  // A single read() can return fewer bytes; accumulate until we have enough.
  let dest: string | undefined;
  let fh: { close(): Promise<void>; writeFile(data: Uint8Array): Promise<void> } | undefined;
  try {
    const sniffChunks: Uint8Array[] = [];
    let sniffLen = 0;
    while (sniffLen < 12) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      sniffChunks.push(value);
      sniffLen += value.byteLength;
    }
    if (sniffLen === 0) {
      throw new Error("video download returned empty body");
    }
    const sniffBuf = Buffer.concat(sniffChunks);
    const ext = guessVideoExtFromMagic(new Uint8Array(sniffBuf));
    const name = `vid-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`;
    dest = join(dir, name);
    fh = await open(dest, "w", 0o600);
    // Write all buffered chunks and set up accounting
    let totalBytes = sniffBuf.byteLength;
    if (budget && !chargeVideoBudget(budget, totalBytes)) {
      throw new Error("video download exceeds per-turn budget");
    }
    if (totalBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
      throw new Error("video download exceeds size cap");
    }
    await fh.writeFile(new Uint8Array(sniffBuf));
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (budget && !chargeVideoBudget(budget, value.byteLength)) {
        throw new Error("video download exceeds per-turn budget");
      }
      if (totalBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
        throw new Error("video download exceeds size cap");
      }
      await fh.writeFile(value);
    }
    await fh.close();
    try { await reader.cancel(); } catch { /* ignore */ }
    reader.releaseLock();
    return dest;
  } catch (err) {
    try { await reader.cancel(); } catch { /* ignore */ }
    reader.releaseLock();
    if (fh) {
      try { await fh.close(); } catch { /* ignore */ }
    }
    if (dest) await unlink(dest).catch(() => {});
    throw err;
  }
}
