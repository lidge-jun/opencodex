import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { getConfigDir } from "../config";
import { assessUrlDestination, assertUrlResolvesPublic } from "../lib/destination-policy";

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

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

export function createImageBudget(): ImageBudget {
  return { spent: 0 };
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

export function guessExtFromMagic(bytes: Uint8Array): string {
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  if (sig.startsWith("\x89PNG\r\n\x1a\n")) return "png";
  if (sig.startsWith("\xff\xd8\xff")) return "jpg";
  if (sig.startsWith("RIFF") && sig.slice(8, 12) === "WEBP") return "webp";
  if (sig.startsWith("GIF8")) return "gif";
  throw new Error("unrecognized image format — magic bytes do not match PNG, JPEG, WebP, or GIF");
}

export async function materializeInlineImage(
  base64Data: string,
  budget?: ImageBudget,
  keepCount?: number,
): Promise<string> {
  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const buf = decodeValidatedImageBase64(base64Data);
  if (budget && budget.spent + buf.length > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`inline image response exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response cap`);
  }
  if (budget) budget.spent += buf.length;

  // Sniff actual format from decoded bytes rather than trusting the declared mimeType.
  const ext = guessExtFromMagic(buf);
  const filePath = await writeArtifactUnique(dir, "img-", buf, ext);
  pruneOldArtifacts(dir, keepCount ?? DEFAULT_ARTIFACT_KEEP_COUNT);
  return filePath;
}

export async function downloadImageToArtifact(
  url: string,
  budget?: ImageBudget,
  signal?: AbortSignal,
  keepCount?: number,
): Promise<string> {
  if (url.startsWith("data:")) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (!m) throw new Error("data URL is not a valid base64 image");
    return materializeInlineImage(m[2], budget, keepCount);
  }

  // SSRF protection: validate the provider-returned URL before fetching.
  // Require HTTPS strictly — plain HTTP and all other schemes (ftp, file, …) are rejected.
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
  // DNS check: resolve hostname and reject if it points at private/internal space.
  await assertUrlResolvesPublic(url);
  const resp = await fetch(url, { signal, redirect: "error" });
  if (!resp.ok) throw new Error("image download failed: " + resp.status);

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

  if (budget && budget.spent + bytes.length > MAX_DECODED_BYTES_PER_RESPONSE) {
    throw new Error(`image download exceeds ${MAX_DECODED_BYTES_PER_RESPONSE} byte per-response budget`);
  }

  const ext = guessExtFromMagic(bytes);
  const dir = getArtifactsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (budget) budget.spent += bytes.length;

  const filePath = await writeArtifactUnique(dir, "dl-", bytes, ext);
  pruneOldArtifacts(dir, keepCount ?? DEFAULT_ARTIFACT_KEEP_COUNT);
  return filePath;
}
