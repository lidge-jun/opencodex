import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { assessUrlDestination, assertUrlResolvesPublic } from "../lib/destination-policy";

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Default cap on files retained under artifacts/. Oldest files are pruned when exceeded. */
export const DEFAULT_ARTIFACT_KEEP_COUNT = 200;

// Strict alphabet check: Buffer.from(..., "base64") silently ignores invalid
// characters, so malformed payloads would otherwise decode to garbage bytes.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageBudget {
  spent: number;
}

export function createImageBudget(): ImageBudget {
  return { spent: 0 };
}

function getArtifactsDir(): string {
  return join(getConfigDir(), "artifacts");
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

export function guessExtFromMagic(bytes: Uint8Array): string {
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  if (sig.startsWith("\x89PNG\r\n\x1a\n")) return "png";
  if (sig.startsWith("\xff\xd8\xff")) return "jpg";
  if (sig.startsWith("RIFF") && sig.slice(8, 12) === "WEBP") return "webp";
  if (sig.startsWith("GIF8")) return "gif";
  return "png";
}

export async function materializeInlineImage(
  base64Data: string,
  budget?: ImageBudget,
  keepCount?: number,
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
  const ext = guessExtFromMagic(buf);
  const filePath = join(dir, `img-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`);
  await writeFile(filePath, buf, { mode: 0o600 });
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

  const filePath = join(dir, `dl-${timestampPrefix()}-${crypto.randomUUID()}.${ext}`);
  await writeFile(filePath, bytes, { mode: 0o600 });
  pruneOldArtifacts(dir, keepCount ?? DEFAULT_ARTIFACT_KEEP_COUNT);
  return filePath;
}
