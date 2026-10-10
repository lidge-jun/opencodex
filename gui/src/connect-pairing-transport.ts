import { hasApiSession, installApiSessionFromHtml } from "./api";
import type { ApiTarget } from "./api-targets";
import { parseRemoteLinkStatus } from "./remote-link-api";

const PAIRING_CODE = /^ocx_pair_[A-Za-z0-9_-]{43}$/;

export class PairingError extends Error {
  readonly kind: "invalid-code" | "refused" | "origin-denied" | "cloudflare-challenge" | "remote-link-unauthorized" | "remote-link-forbidden" | "unreachable" | "request-failed" | "invalid-response";
  constructor(kind: PairingError["kind"]) {
    super(`pairing_${kind}`);
    this.kind = kind;
    this.name = "PairingError";
  }
}

const CHALLENGE_PREFIX_LIMIT = 16 * 1024;

function isCloudflareChallenge(response: Response, body = ""): boolean {
  if (response.headers.get("cf-mitigated")?.trim().toLowerCase() === "challenge") return true;
  return /<title>\s*Just a moment\.\.\./i.test(body)
    || /cf-chl-|challenge-platform|challenges\.cloudflare\.com/i.test(body);
}

async function readResponsePrefix(response: Response, limit = CHALLENGE_PREFIX_LIMIT): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const chunk = value.subarray(0, limit - size);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(buffer);
}

async function isHtmlChallenge(response: Response): Promise<boolean> {
  if (isCloudflareChallenge(response)) return true;
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return false;
  return isCloudflareChallenge(response, await readResponsePrefix(response));
}

/**
 * Exchange a pairing code for a shared-plane session.
 *
 * Separate module from the form that calls it so neither file mixes a component export with
 * a plain one. That mix is what `react-refresh/only-export-components` flags, and the two
 * have no reason to share a file: the transport is testable without React and the form has
 * no logic beyond calling it.
 */
export async function submitConnectPairing(
  target: ApiTarget,
  grant: string,
  fetchImpl?: typeof fetch,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const code = grant.trim();
  if (!PAIRING_CODE.test(code)) throw new PairingError("invalid-code");
  // Resolved at CALL time, not as a default parameter.
  //
  // `installApiAuthFetch` replaces `window.fetch` with the wrapper that attaches plane
  // credentials — including the machine-session headers a relayed exchange needs to reach
  // the hub. A default of `fetch` binds whatever the global was when this module was
  // evaluated, which on the relay path is the unwrapped original, so the request went out
  // unauthenticated and the relay refused it.
  const send = fetchImpl ?? ((input, init) => window.fetch(input, init));
  let response: Response;
  try {
    response = await send(target.bootstrapPath, {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Accept: "text/html" },
      body: JSON.stringify({ grant: code }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new PairingError("unreachable");
  }
  if (!response.ok) {
    if (await isHtmlChallenge(response)) throw new PairingError("cloudflare-challenge");
    try { await response.body?.cancel(); } catch { /* best effort */ }
    if (response.status === 401) throw new PairingError("refused");
    if (response.status === 403) throw new PairingError("origin-denied");
    throw new PairingError("request-failed");
  }
  let html: string;
  try { html = await response.text(); }
  catch (error) { if (signal?.aborted) throw error; throw new PairingError("invalid-response"); }
  signal?.throwIfAborted();
  if (isCloudflareChallenge(response, html)) throw new PairingError("cloudflare-challenge");
  if (!installApiSessionFromHtml("shared", html)) throw new PairingError("invalid-response");
  return true;
}

/** Accept pairing only after the new browser session can read the protected Remote Link status. */
export async function validateRemoteLinkSession(apiBase: string, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const send = fetchImpl ?? ((input, init) => window.fetch(input, init));
  let response: Response;
  try {
    response = await send(`${apiBase}/api/link/status`, {
      cache: "no-store", signal,
      headers: { Accept: "application/json" },
    });
  } catch {
    signal?.throwIfAborted();
    throw new PairingError("unreachable");
  }
  signal?.throwIfAborted();
  if (!response.ok) {
    if (await isHtmlChallenge(response)) throw new PairingError("cloudflare-challenge");
    try { await response.body?.cancel(); } catch { /* best effort */ }
    if (response.status === 401) throw new PairingError("remote-link-unauthorized");
    if (response.status === 403) throw new PairingError("remote-link-forbidden");
    throw new PairingError("request-failed");
  }
  if (await isHtmlChallenge(response)) throw new PairingError("cloudflare-challenge");
  if (!hasApiSession("shared")) throw new PairingError("invalid-response");
  try {
    const status = await response.json();
    signal?.throwIfAborted();
    parseRemoteLinkStatus(status);
  } catch {
    signal?.throwIfAborted();
    throw new PairingError("invalid-response");
  }
}
