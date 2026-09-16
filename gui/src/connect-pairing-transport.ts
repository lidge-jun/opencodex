import { installApiSessionFromHtml } from "./api";
import type { ApiTarget } from "./api-targets";

const PAIRING_CODE = /^ocx_pair_[A-Za-z0-9_-]{43}$/;

export class PairingError extends Error {
  readonly kind: "invalid-code" | "refused" | "unreachable" | "request-failed" | "invalid-response";
  constructor(kind: PairingError["kind"]) {
    super(`pairing_${kind}`);
    this.kind = kind;
    this.name = "PairingError";
  }
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
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new PairingError(response.status === 401 || response.status === 403 ? "refused" : "request-failed");
  }
  let html: string;
  try { html = await response.text(); }
  catch (error) { if (signal?.aborted) throw error; throw new PairingError("invalid-response"); }
  signal?.throwIfAborted();
  if (!installApiSessionFromHtml("shared", html)) throw new PairingError("invalid-response");
  return true;
}
