import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_HTTP_PREFIX } from "./artifacts";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(png|jpe?g|webp|gif)$/i;
const entries = new Map<string, { path: string; url: string; expires: number }>();
const lifetime = 60 * 60 * 1000;

/** Record only a successfully downloaded image; this function never opens a file. */
export function rememberArtifactSourceUrl(path: string, url: string, now = Date.now()): void {
  if (!isAbsolute(path) || !idPattern.test(basename(path))) return;
  try { if (new URL(url).protocol !== "https:") return; } catch { return; }
  const id = basename(path);
  entries.delete(id);
  entries.set(id, { path: resolve(path), url, expires: now + lifetime });
  while (entries.size > 256) entries.delete(entries.keys().next().value!);
}

/** Resolve approved inputs without reading the filesystem. Artifact references require pinned xAI. */
export function resolveVideoImageInput(value: unknown, now = Date.now(), allowArtifacts = true): string {
  if (typeof value !== "string") throw new Error("invalid video image input");
  if (value.startsWith("data:")) {
    const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!m || m[1]!.length % 4 !== 0 || m[1]!.length / 4 * 3 - (m[1]!.endsWith("==") ? 2 : m[1]!.endsWith("=") ? 1 : 0) > 10 * 1024 * 1024) throw new Error("invalid video image input");
    return value;
  }
  if (value.startsWith("https://")) {
    try { const parsed = new URL(value); if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return value; } catch { /* invalid */ }
    throw new Error("invalid video image input");
  }
  let path: string | undefined;
  let id: string;
  if (value.startsWith(`${ARTIFACT_HTTP_PREFIX}/`)) {
    id = value.slice(ARTIFACT_HTTP_PREFIX.length + 1);
  } else {
    try { path = value.startsWith("file:") ? fileURLToPath(value) : value; } catch { throw new Error("invalid video image input"); }
    if (!isAbsolute(path)) throw new Error("invalid video image input");
    id = basename(path);
  }
  if (!allowArtifacts || !idPattern.test(id)) throw new Error("invalid video image input");
  const entry = entries.get(id);
  if (!entry || now >= entry.expires || (path !== undefined && resolve(path) !== entry.path)) throw new Error("invalid video image input");
  return entry.url;
}
