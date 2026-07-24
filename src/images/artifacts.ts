import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getConfigDir } from "../config";

const MAX_DECODED_BYTES_PER_IMAGE = 50 * 1024 * 1024;
const MAX_DECODED_BYTES_PER_RESPONSE = 100 * 1024 * 1024;

// Strict alphabet check: Buffer.from(..., "base64") silently ignores invalid
// characters, so malformed payloads would otherwise decode to garbage bytes.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageBudget {
  spent: number;
}

export function createImageBudget(): ImageBudget {
  return { spent: 0 };
}

/**
 * Sniff the real image format from leading magic bytes rather than trusting an
 * upstream-declared MIME type, which may be missing or spoofed.
 */
export function guessExtFromMagic(bytes: Uint8Array): string {
  const sig = Buffer.from(bytes.slice(0, 12)).toString("latin1");
  if (sig.startsWith("\x89PNG")) return "png";
  if (sig.startsWith("\xff\xd8\xff")) return "jpg";
  if (sig.startsWith("RIFF") && sig.slice(8, 12) === "WEBP") return "webp";
  if (sig.startsWith("GIF8")) return "gif";
  throw new Error("unrecognized image format — magic bytes do not match PNG, JPEG, WebP, or GIF");
}

export async function materializeInlineImage(
  base64Data: string,
  budget?: ImageBudget,
): Promise<string> {
  const dir = join(getConfigDir(), "artifacts");
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

  // Determine the extension from the actual decoded bytes, not an upstream MIME
  // label, so a spoofed or missing type cannot misname the file.
  const ext = guessExtFromMagic(buf);

  const now = new Date();
  const ts = [
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
  const suffix = crypto.randomUUID();
  const filePath = join(dir, `img-${ts}-${suffix}.${ext}`);

  await writeFile(filePath, buf, { mode: 0o600 });
  return filePath;
}
