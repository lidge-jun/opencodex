/**
 * OCX-scoped handles for public `/v1/videos` jobs (#9110).
 *
 * `POST /v1/videos` answers with the upstream job, but its `id` is replaced by a handle that names the
 * provider row, the upstream job id and the model it ran. `GET /v1/videos/{handle}` and `/content` read
 * the provider from the handle, so they return to the destination that created the job and never
 * re-route.
 *
 * The handle is AES-256-GCM encrypted and authenticated with a key derived from a per-install secret kept in the config directory
 * (`video-handle-key`, 32 random bytes, mode 0600) so it survives restarts while a job renders. The key
 * is published atomically (written to a private temporary file, then hard-linked into place, which
 * fails rather than replaces when another process won the race) and read through a no-follow
 * descriptor whose type, size, owner and mode are checked on that same descriptor; anything unsafe
 * fails closed. Handlers load it before the paid create, so a key failure sends nothing.
 *
 * The authentication tag also covers the admission principal (as associated data) without carrying it: the admission kind, the configured
 * key id and a SHA-256 of the exact secret the caller presented. A handle presented under another key,
 * a replacement secret on the same key id (including a pending rotation), a changed environment token,
 * or after any edit does not open, and the caller sees the same 404 as for an unknown id. Loopback
 * admission carries no secret and is its own principal. The claims are encrypted, so nothing an upstream
 * returned as its job id (or a long model name) can be read back out of the handle by the caller.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { authorizationCredential } from "../lib/authorization-scheme";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { isUsableUpstreamVideoId } from "../images/openai-video-client";
import type { DataPlaneAdmission } from "./auth-cors";

export const VIDEO_HANDLE_PREFIX = "video_ocx_";
export const VIDEO_HANDLE_KEY_FILE = "video-handle-key";
/** Bounds that keep every sealable handle under {@link MAX_HANDLE_LENGTH}, checked before the create. */
export const MAX_HANDLE_PROVIDER_BYTES = 128;
export const MAX_HANDLE_MODEL_BYTES = 256;
const MAX_HANDLE_LENGTH = 8192;

export interface VideoHandleClaims {
  /** Provider row that created the job. */
  provider: string;
  /** Upstream job id on that row. */
  upstreamId: string;
  /** Upstream model id the job was created with, when the request named one. */
  model?: string;
}

let cachedKey: Buffer | undefined;
let testKey: Buffer | undefined;

/** Test seam: a fixed key, so tests never create a key file. `undefined` restores the real key. */
export function setVideoHandleKeyForTests(key: Buffer | undefined): void {
  testKey = key;
  cachedKey = undefined;
}

class VideoHandleKeyError extends Error {
  constructor(reason: string) {
    super("video handle key is unavailable: " + reason);
    this.name = "VideoHandleKeyError";
  }
}

export function isVideoHandleKeyError(error: unknown): boolean {
  return error instanceof VideoHandleKeyError;
}

/** Read an existing key through a no-follow descriptor; undefined when there is no file. */
function readKeyFile(file: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new VideoHandleKeyError(code === "ELOOP" ? "key file is a symbolic link" : `cannot open key file (${code ?? "error"})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256) throw new VideoHandleKeyError("key file is not a small regular file");
    if (process.platform !== "win32") {
      if ((stat.mode & 0o077) !== 0) throw new VideoHandleKeyError("key file is readable by other users; expected mode 0600");
      const uid = process.getuid?.();
      if (uid !== undefined && stat.uid !== uid) throw new VideoHandleKeyError("key file is owned by another user");
    }
    const text = readFileSync(fd, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(text)) throw new VideoHandleKeyError("key file is not a 32-byte hex key");
    return Buffer.from(text, "hex");
  } finally {
    closeSync(fd);
  }
}

function loadOrCreateKey(): Buffer {
  if (testKey) return testKey;
  if (cachedKey) return cachedKey;
  const dir = getConfigDir();
  const file = join(dir, VIDEO_HANDLE_KEY_FILE);
  const existing = readKeyFile(file);
  if (existing) return (cachedKey = existing);
  assertNotRealHomeUnderTest(dir);
  const temp = join(dir, `.${VIDEO_HANDLE_KEY_FILE}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    recordOwnedConfigPath(dir, file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(temp, randomBytes(32).toString("hex") + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      // A hard link publishes the complete file or fails with EEXIST; it never replaces a key.
      linkSync(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } catch (error) {
    if (error instanceof VideoHandleKeyError) throw error;
    throw new VideoHandleKeyError(`cannot create key file (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
  // Read back whatever won: this process's key or a concurrent one, through the same checks.
  const published = readKeyFile(file);
  if (!published) throw new VideoHandleKeyError("key file disappeared after creation");
  return (cachedKey = published);
}

/** Load (or create) the signing key now, so a failure surfaces before any paid request. */
export function ensureVideoHandleKey(): void {
  loadOrCreateKey();
}

/**
 * The principal a request's handles are bound to, or undefined when a non-loopback admission
 * presented no secret (which `resolveApiAuth` would not have admitted). The secret is read with the
 * same header precedence as `resolveApiAuth`.
 */
export function videoHandlePrincipal(admission: DataPlaneAdmission, headers: Pick<Headers, "get">): string | undefined {
  if (admission.kind === "loopback") return "loopback";
  const secret = headers.get("x-opencodex-api-key")?.trim() || authorizationCredential(headers) || headers.get("x-api-key")?.trim();
  if (!secret) return undefined;
  const digest = createHash("sha256").update(secret).digest("hex");
  return `${admission.kind}:${admission.kind === "configured" ? admission.keyId : ""}:${digest}`;
}

/** Why these claims could not be sealed into an openable handle, checked before the paid create. */
export function videoHandleClaimsError(provider: string, model: string | undefined): string | undefined {
  if (Buffer.byteLength(provider) > MAX_HANDLE_PROVIDER_BYTES) return "provider name is too long";
  if (model !== undefined && Buffer.byteLength(model) > MAX_HANDLE_MODEL_BYTES) return `model must be at most ${MAX_HANDLE_MODEL_BYTES} bytes`;
  return undefined;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(secret: Buffer): Buffer {
  return createHmac("sha256", secret).update("ocx-video-handle:v2:aes-256-gcm").digest();
}

function associatedData(principal: string): Buffer {
  return Buffer.from("ocx-video-handle:v2\n" + principal, "utf8");
}

export function sealVideoHandle(claims: VideoHandleClaims, principal: string): string {
  const plaintext = Buffer.from(JSON.stringify({
    v: 2, p: claims.provider, u: claims.upstreamId, ...(claims.model !== undefined ? { m: claims.model } : {}),
  }), "utf8");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(loadOrCreateKey()), nonce);
  cipher.setAAD(associatedData(principal));
  const sealed = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const handle = VIDEO_HANDLE_PREFIX + sealed.toString("base64url");
  if (handle.length > MAX_HANDLE_LENGTH) throw new Error("video handle exceeds its length bound");
  return handle;
}

/** The claims of a handle this install sealed for `principal`, or undefined for anything else. */
export function openVideoHandle(handle: string, principal: string): VideoHandleClaims | undefined {
  if (handle.length > MAX_HANDLE_LENGTH || !handle.startsWith(VIDEO_HANDLE_PREFIX)) return undefined;
  const encoded = handle.slice(VIDEO_HANDLE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  const sealed = Buffer.from(encoded, "base64url");
  if (sealed.length <= NONCE_BYTES + TAG_BYTES) return undefined;
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(loadOrCreateKey()), sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(associatedData(principal));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    plaintext = Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch (error) {
    if (isVideoHandleKeyError(error)) throw error;
    return undefined;
  }
  let claims: unknown;
  try { claims = JSON.parse(plaintext); } catch { return undefined; }
  const c = claims as { v?: unknown; p?: unknown; u?: unknown; m?: unknown } | null;
  if (!c || c.v !== 2 || typeof c.p !== "string" || !c.p || !isUsableUpstreamVideoId(c.u)) return undefined;
  if (c.m !== undefined && typeof c.m !== "string") return undefined;
  return { provider: c.p, upstreamId: c.u, ...(typeof c.m === "string" ? { model: c.m } : {}) };
}
