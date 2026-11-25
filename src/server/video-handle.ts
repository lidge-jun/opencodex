/**
 * OCX-scoped handles for public `/v1/videos` jobs (#9110).
 *
 * `POST /v1/videos` answers with the upstream job object, but its `id` is replaced by a handle that
 * names the provider row, the upstream job id and the model it ran. `GET /v1/videos/{handle}` and
 * `/content` read the provider from the handle, so they return to the destination that created the
 * job and never re-route.
 *
 * The handle is HMAC-SHA256 sealed with a per-install key kept in the config directory
 * (`video-handle-key`, mode 0600) so it survives restarts while a job renders. The MAC also covers
 * the admission principal that created the job — a configured key id, the environment key, or the
 * loopback listener — without carrying it: a handle presented by another principal, or edited in any
 * byte, does not open, and the caller sees the same 404 as for an unknown id. The payload is
 * readable (base64url JSON); it holds no credential.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { isUsableUpstreamVideoId } from "../images/openai-video-client";
import type { DataPlaneAdmission } from "./auth-cors";

export const VIDEO_HANDLE_PREFIX = "video_ocx_";
export const VIDEO_HANDLE_KEY_FILE = "video-handle-key";
const MAX_HANDLE_LENGTH = 2048;

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

function loadOrCreateKey(): Buffer {
  if (testKey) return testKey;
  if (cachedKey) return cachedKey;
  const dir = getConfigDir();
  const file = join(dir, VIDEO_HANDLE_KEY_FILE);
  try {
    if (existsSync(file)) {
      const stat = lstatSync(file);
      const text = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 256 ? readFileSync(file, "utf8").trim() : "";
      if (/^[0-9a-f]{64}$/.test(text)) {
        cachedKey = Buffer.from(text, "hex");
        return cachedKey;
      }
      throw new Error("video handle key file is not a 32-byte hex key");
    }
    const fresh = randomBytes(32);
    assertNotRealHomeUnderTest(dir);
    recordOwnedConfigPath(dir, file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, fresh.toString("hex") + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    cachedKey = fresh;
    return fresh;
  } catch (error) {
    // A lost race on first use: another request minted the file between the check and the write.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateKey();
    // An unreadable or unwritable key is not replaced by a process-local one: a silent per-process
    // key would make every handle issued before a restart unopenable, and that job's paid output
    // unreachable, with no error naming why.
    throw new Error("video handle key is unavailable: " + (error instanceof Error ? error.message : String(error)));
  }
}

/** Stable identity of the admission secret that made the request, for the MAC only. */
export function videoHandlePrincipal(admission: DataPlaneAdmission): string {
  if (admission.kind === "configured") return "key:" + admission.keyId;
  return admission.kind;
}

function mac(key: Buffer, principal: string, payload: string): Buffer {
  return createHmac("sha256", key).update("ocx-video-handle:v1\n").update(principal).update("\n").update(payload).digest();
}

export function sealVideoHandle(claims: VideoHandleClaims, principal: string): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1, p: claims.provider, u: claims.upstreamId, ...(claims.model !== undefined ? { m: claims.model } : {}),
  })).toString("base64url");
  return `${VIDEO_HANDLE_PREFIX}${payload}.${mac(loadOrCreateKey(), principal, payload).toString("base64url")}`;
}

/** The claims of a handle this install sealed for `principal`, or undefined for anything else. */
export function openVideoHandle(handle: string, principal: string): VideoHandleClaims | undefined {
  if (handle.length > MAX_HANDLE_LENGTH || !handle.startsWith(VIDEO_HANDLE_PREFIX)) return undefined;
  const body = handle.slice(VIDEO_HANDLE_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot !== body.lastIndexOf(".")) return undefined;
  const payload = body.slice(0, dot);
  const tag = body.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(tag)) return undefined;
  const expected = mac(loadOrCreateKey(), principal, payload);
  const presented = Buffer.from(tag, "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return undefined; }
  const c = claims as { v?: unknown; p?: unknown; u?: unknown; m?: unknown } | null;
  if (!c || c.v !== 1 || typeof c.p !== "string" || !c.p || !isUsableUpstreamVideoId(c.u)) return undefined;
  if (c.m !== undefined && typeof c.m !== "string") return undefined;
  return { provider: c.p, upstreamId: c.u, ...(typeof c.m === "string" ? { model: c.m } : {}) };
}
