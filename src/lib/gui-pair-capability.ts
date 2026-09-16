import { createHmac, timingSafeEqual } from "node:crypto";
import { isLocalAttestationSecret } from "./local-management-attestation";

export const GUI_PAIR_METHOD = "POST";
export const GUI_PAIR_PATH = "/api/gui/pairing-grants";
export const GUI_PAIR_CAPABILITY_VERSION = "v1";
export const GUI_PAIR_EXPECTED_PID_HEADER = "x-opencodex-gui-pair-expected-pid";
export const GUI_PAIR_NONCE_HEADER = "x-opencodex-gui-pair-nonce";
export const GUI_PAIR_EXPIRES_AT_HEADER = "x-opencodex-gui-pair-expires-at";
export const GUI_PAIR_BROWSER_ORIGIN_HEADER = "x-opencodex-gui-pair-origin";
export const GUI_PAIR_CAPABILITY_HEADER = "x-opencodex-gui-pair-capability";
export const GUI_PAIR_CAPABILITY_TTL_MS = 10_000;

const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

export type ExpectedGuiPairPid =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "present"; pid: number };

export function parseExpectedGuiPairPid(value: string | null): ExpectedGuiPairPid {
  if (value === null) return { kind: "absent" };
  if (!/^[1-9]\d*$/.test(value)) return { kind: "invalid" };
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? { kind: "present", pid } : { kind: "invalid" };
}

export function canonicalGuiBrowserOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!parsed.host || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/**
 * A bare http(s) origin, or null.
 *
 * Stricter than {@link canonicalGuiBrowserOrigin}: that one also accepts non-HTTP schemes
 * (a packaged app's custom scheme can be a browser origin), while this is the rule for an
 * origin that will be DIALLED — the hub's management and data origins, and the `serverOrigin`
 * a pairing grant is bound to. Credentials, a path, a query or a fragment are all rejected
 * rather than silently dropped, because every caller goes on to print or compare the result.
 *
 * Exported here, beside the browser-origin canonicaliser, because this file is the only
 * module the CLI pairing path and the hub command already share. `src/config.ts` and
 * `src/server/gui-session.ts` still hold byte-identical private copies; folding those in
 * would pull a heavy config import into a server security-boundary file, so it is its own
 * change rather than a drive-by in a token-UX PR.
 */
export function canonicalHttpOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function capabilityPayload(
  nonce: string,
  method: string,
  path: string,
  browserOrigin: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!BASE64URL_256.test(nonce)) return null;
  if (method !== GUI_PAIR_METHOD || path !== GUI_PAIR_PATH) return null;
  const canonicalOrigin = canonicalGuiBrowserOrigin(browserOrigin);
  if (!canonicalOrigin || canonicalOrigin !== browserOrigin) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;
  return `opencodex-gui-pair-v1\n${nonce}\n${method}\n${path}\n${browserOrigin}\n${pid}\n${port}\n${expiresAt}`;
}

export function createGuiPairCapability(
  secret: string,
  nonce: string,
  method: string,
  path: string,
  browserOrigin: string,
  pid: number,
  port: number,
  expiresAt: number,
): string | null {
  if (!isLocalAttestationSecret(secret)) return null;
  const payload = capabilityPayload(nonce, method, path, browserOrigin, pid, port, expiresAt);
  if (!payload) return null;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function verifyGuiPairCapability(
  secret: string,
  nonce: string | null,
  method: string,
  path: string,
  browserOrigin: string | null,
  pid: number,
  port: number,
  expiresAt: number,
  capability: string | null,
  now = Date.now(),
): boolean {
  if (!nonce || !browserOrigin || !capability || !BASE64URL_256.test(capability)) return false;
  if (!Number.isSafeInteger(now) || expiresAt <= now || expiresAt > now + GUI_PAIR_CAPABILITY_TTL_MS) return false;
  const expected = createGuiPairCapability(
    secret,
    nonce,
    method,
    path,
    browserOrigin,
    pid,
    port,
    expiresAt,
  );
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(capability);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
