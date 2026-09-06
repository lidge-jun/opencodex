/**
 * Data-plane hot-path seam (ADR-0008, ticket #24, devlog 034).
 *
 * The Go sidecar owns the public `POST /v1/responses` surface exactly like it
 * owns the Go-owned management routes; until a provider relay lands (#27/#29)
 * its stream source is the private parent bridge, which runs the real
 * in-process `handleResponses` pipeline. This module is the DATA plane's twin
 * of `go-sidecar-write-relay.ts`: it holds the seam gate, the bridge path and
 * headers, and the body-bound parent claim that lets the front door admit one
 * request without ever handing a client credential to the sidecar process.
 *
 * Two hard rules keep this seam honest:
 *
 * - The seam is gated separately from the management surface
 *   (`OPENCODEX_GO_HOTPATH_SEAM`): attaching a sidecar for management reads
 *   must never silently reroute data-plane traffic (spec #4, story 10).
 * - The bridge verifies the claim, not the caller: it accepts neither an admin
 *   token nor a client API key as a substitute for a freshly minted,
 *   body-bound, replay-bounded parent assertion.
 *
 * The Go sidecar only relays the claim headers verbatim and never validates
 * them; minting (front door) and verification (bridge) both live in this
 * process under the same per-activation secret the write relay uses.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DataPlaneAdmission } from "./auth-cors";

/** Independent activation gate: management reads and the data plane roll back separately. */
export const HOT_PATH_SEAM_ENV = "OPENCODEX_GO_HOTPATH_SEAM";

/**
 * Independent gate for the direct non-streaming provider relay (ticket #27,
 * devlog 036). The seam's default source is the parent bridge, which runs the
 * in-process pipeline; when this is set the sidecar serves a relay-safe
 * non-streaming request for one key-mode openai-responses provider directly
 * upstream. The front door only declares it and passes the environment
 * through at spawn — the sidecar process reads it per request, exactly like
 * the seam gate is read on this side.
 */
export const HOT_PATH_RELAY_ENV = "OPENCODEX_GO_HOTPATH_RELAY";

/** The declared data-plane seam route. One entry; a later ticket flips the marker, never the dispatch. */
export const HOT_PATH_SEAM_PATH = "/v1/responses";

/** Private parent endpoint the seam asks to run the responses pipeline for one admitted request. */
export const HOT_PATH_RESPONSES_BRIDGE_PATH = "/__ocx_go_sidecar/responses";

/** Same value as the management write-relay bridge capability header. */
export const HOT_PATH_BRIDGE_HEADER = "x-ocx-go-sidecar-bridge";

/** Parent request-token header the sidecar seam authenticates. */
export const HOT_PATH_SIDECAR_REQUEST_HEADER = "x-ocx-go-sidecar-request";

/** Claim headers relayed verbatim by the sidecar between mint (front door) and verify (bridge). */
export const HOT_PATH_CLAIM_NONCE_HEADER = "x-ocx-go-dataplane-nonce";
export const HOT_PATH_CLAIM_EXPIRES_AT_HEADER = "x-ocx-go-dataplane-expires-at";
export const HOT_PATH_CLAIM_ADMISSION_HEADER = "x-ocx-go-dataplane-admission";
export const HOT_PATH_CLAIM_PROOF_HEADER = "x-ocx-go-dataplane-proof";

const CLAIM_VERSION = "opencodex-go-dataplane-v1";
const CLAIM_TTL_MS = 60_000;
const REPLAY_LIMIT = 256;
/** Matches src/server/request-decompress.ts MAX_DECOMPRESSED_BODY_BYTES. */
const MAX_RESPONSES_BODY_BYTES = 256 * 1024 * 1024;
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;
const EXPIRY = /^[1-9]\d*$/;
const PATH = /^\/[^?#\r\n]*$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/** True when the operator has switched the data-plane seam on (independent of sidecar attachment). */
export function hotPathSeamEnabled(): boolean {
  return process.env[HOT_PATH_SEAM_ENV] === "1";
}

/** Round-trip a DataPlaneAdmission through JSON so a claim never carries more than the admission. */
function admissionJson(admission: DataPlaneAdmission): string | null {
  const raw = JSON.stringify(admission);
  return raw.length <= 512 ? raw : null;
}

function parseAdmissionJson(raw: string): DataPlaneAdmission | null {
  if (raw.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.kind === "configured") {
    return typeof value.keyId === "string" && typeof value.source === "string"
      ? { kind: "configured", keyId: value.keyId, source: value.source as DataPlaneAdmission["source"] }
      : null;
  }
  if (value.kind === "environment") {
    return typeof value.source === "string"
      ? { kind: "environment", source: value.source as DataPlaneAdmission["source"] }
      : null;
  }
  if (value.kind === "loopback") {
    return { kind: "loopback", source: "loopback" };
  }
  return null;
}

interface DataPlaneSeamClaim {
  nonce: string;
  admission: DataPlaneAdmission;
  method: string;
  path: string;
  expiresAt: number;
  proof: string;
}

function isRelaySecret(value: string): boolean {
  return BASE64URL_256.test(value);
}

function isBridgeToken(value: string | null): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\r\n]/.test(value);
}

function claimPayload(
  claim: Omit<DataPlaneSeamClaim, "proof">,
  body: Uint8Array,
): string | null {
  const serialized = admissionJson(claim.admission);
  if (!serialized) return null;
  if (!BASE64URL_256.test(claim.nonce) || !METHODS.has(claim.method)) return null;
  if (!PATH.test(claim.path) || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= 0) return null;
  const digest = createHash("sha256").update(body).digest("hex");
  return [CLAIM_VERSION, claim.nonce, serialized, claim.method, claim.path, digest, claim.expiresAt].join("\n");
}

function signClaim(secret: string, claim: Omit<DataPlaneSeamClaim, "proof">, body: Uint8Array): string | null {
  const payload = claimPayload(claim, body);
  if (!payload || !isRelaySecret(secret)) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function equalSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * Mint the claim header set for one already-admitted data-plane request. The
 * front door calls this only after `resolveResponsesApiAuth` succeeded, and
 * only on the seam gate, so the headers always name a real admission and bind
 * to the exact body bytes being forwarded.
 */
export function createDataPlaneSeamHeaders(
  secret: string,
  admission: DataPlaneAdmission,
  method: string,
  path: string,
  body: Uint8Array,
  now: () => number = Date.now,
): Headers | null {
  const expiresAt = now() + CLAIM_TTL_MS;
  if (!Number.isSafeInteger(expiresAt)) return null;
  const nonce = randomBytes(32).toString("base64url");
  const proof = signClaim(secret, { nonce, admission, method, path, expiresAt }, body);
  if (!proof) return null;
  return new Headers({
    [HOT_PATH_CLAIM_NONCE_HEADER]: nonce,
    [HOT_PATH_CLAIM_EXPIRES_AT_HEADER]: String(expiresAt),
    [HOT_PATH_CLAIM_ADMISSION_HEADER]: admissionJson(admission) ?? "",
    [HOT_PATH_CLAIM_PROOF_HEADER]: proof,
  });
}

export interface HotPathResponsesBridgeOptions {
  /** Per-sidecar capability, generated by the parent at activation. */
  bridgeToken: string;
  /** Shared only with the supervised sidecar through its process environment. */
  relaySecret: string;
  /**
   * Runs the in-process responses pipeline for one admitted request and
   * returns its Response. Called only after the bridge verified the claim.
   */
  dispatchResponses(context: {
    admission: DataPlaneAdmission;
    contentType: string | null;
    body: Uint8Array;
    signal: AbortSignal | null;
  }): Promise<Response>;
  now?: () => number;
}

export interface HotPathResponsesBridge {
  handle(request: Request, url: URL): Promise<Response>;
}

/**
 * The private parent bridge for the hot-path seam. Verification order matters:
 * capability first (cheap), then claim shape, then the body-bound proof — the
 * expensive body read happens only once the claim already looks spendable.
 */
export function createHotPathResponsesBridge(options: HotPathResponsesBridgeOptions): HotPathResponsesBridge | null {
  if (!isBridgeToken(options.bridgeToken) || !isRelaySecret(options.relaySecret)) return null;
  const now = options.now ?? Date.now;
  const consumed = new Map<string, number>();

  async function handle(request: Request, url: URL): Promise<Response> {
    if (
      request.method !== "POST"
      || url.pathname !== HOT_PATH_RESPONSES_BRIDGE_PATH
      || url.search !== ""
      || !equalSecret(request.headers.get(HOT_PATH_BRIDGE_HEADER), options.bridgeToken)
    ) return new Response(null, { status: 404 });

    const claim = claimFromHeaders(request.headers);
    if (!claim || claim.method !== "POST" || claim.path !== HOT_PATH_SEAM_PATH) {
      return new Response(null, { status: 404 });
    }

    const clock = now();
    if (
      !Number.isSafeInteger(clock)
      || claim.expiresAt <= clock
      || claim.expiresAt > clock + CLAIM_TTL_MS
    ) return new Response(null, { status: 404 });

    // The proof binds the body digest, so the body must be read before proof
    // verification. Bound it first: an oversized body is refused even if a
    // (stolen) valid claim named it.
    let body: Uint8Array;
    try {
      body = await readBoundedBody(request, MAX_RESPONSES_BODY_BYTES);
    } catch (error) {
      const tooLarge = error instanceof DataPlaneBodyTooLargeError;
      return new Response(tooLarge ? JSON.stringify({ error: "request body too large" }) : JSON.stringify({ error: "bridge read failed" }), {
        status: tooLarge ? 413 : 500,
        headers: { "content-type": "application/json" },
      });
    }

    if (!verifyProof(options.relaySecret, claim, body)) return new Response(null, { status: 404 });

    pruneConsumed(consumed, clock);
    if (consumed.has(claim.nonce) || consumed.size >= REPLAY_LIMIT) return new Response(null, { status: 404 });
    consumed.set(claim.nonce, claim.expiresAt);

    const contentType = request.headers.get("content-type");
    try {
      return await options.dispatchResponses({
        admission: claim.admission,
        contentType,
        body,
        signal: request.signal,
      });
    } catch {
      return new Response(JSON.stringify({ error: "internal_error", message: "responses dispatch failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  return { handle };
}

class DataPlaneBodyTooLargeError extends Error {}

function claimFromHeaders(headers: Headers): DataPlaneSeamClaim | null {
  const nonce = headers.get(HOT_PATH_CLAIM_NONCE_HEADER) ?? "";
  const admissionRaw = headers.get(HOT_PATH_CLAIM_ADMISSION_HEADER) ?? "";
  const expiresAtRaw = headers.get(HOT_PATH_CLAIM_EXPIRES_AT_HEADER) ?? "";
  const proof = headers.get(HOT_PATH_CLAIM_PROOF_HEADER) ?? "";
  if (!BASE64URL_256.test(nonce) || !BASE64URL_256.test(proof)) return null;
  if (!EXPIRY.test(expiresAtRaw)) return null;
  const admission = parseAdmissionJson(admissionRaw);
  if (!admission) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt)) return null;
  // Method and path are not claim headers: the bridge serves exactly one
  // surface (POST /v1/responses) and mint and verify share the constants, so
  // a relayed claim cannot name a different method or route.
  return { nonce, admission, method: "POST", path: HOT_PATH_SEAM_PATH, expiresAt, proof };
}

function verifyProof(secret: string, claim: DataPlaneSeamClaim, body: Uint8Array): boolean {
  const expected = signClaim(secret, claim, body);
  return expected !== null && equalSecret(claim.proof, expected);
}

async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limit) throw new DataPlaneBodyTooLargeError();
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > limit) throw new DataPlaneBodyTooLargeError();
  return body;
}

function pruneConsumed(consumed: Map<string, number>, now: number): void {
  for (const [nonce, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(nonce);
  }
}
