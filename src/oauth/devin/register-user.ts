/**
 * Exchange a Firebase ID token for a long-lived Windsurf API key.
 *
 * This calls the same Connect-RPC endpoint the Windsurf desktop extension uses
 * after the browser sign-in completes:
 *
 *   POST https://register.windsurf.com/exa.seat_management_pb.SeatManagementService/RegisterUser
 *   Content-Type: application/json
 *   Body: { "firebase_id_token": "<jwt>" }
 *
 * Connect-RPC happily accepts plain JSON over HTTPS (no gRPC framing required),
 * so we skip @connectrpc/connect entirely and use `fetch`. The response shape
 * matches `exa.seat_management_pb.RegisterUserResponse`:
 *
 *   { api_key, name, api_server_url, redirect_url, team_options[] }
 *
 * Endpoint verified live (returns `{code:"unauthenticated",message:"invalid token ..."}`
 * for a fake token, 200 with the response body for a valid one).
 */

import type { OAuthLoginResult, WindsurfRegion } from './types.js';

/**
 * Polyfill for `AbortSignal.any` — composes multiple signals so the result
 * aborts when ANY input aborts. Built-in in Node ≥20.3 / Bun ≥1.0; we
 * implement the fallback ourselves so the timeout/caller-signal merge
 * works on every runtime our `engines` field permits (Node 18+).
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const builtin = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof builtin === 'function') return builtin(signals);
  const controller = new AbortController();
  const onAbort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s.reason);
      break;
    }
    s.addEventListener('abort', () => onAbort(s.reason), { once: true });
  }
  return controller.signal;
}

interface RegisterUserResponseJson {
  api_key?: string;
  name?: string;
  api_server_url?: string;
  redirect_url?: string;
  team_options?: unknown[];
}

interface ConnectErrorJson {
  code?: string;
  message?: string;
}

export class WindsurfRegistrationError extends Error {
  readonly status: number;
  readonly connectCode?: string;
  readonly traceId?: string;

  constructor(message: string, status: number, connectCode?: string, traceId?: string) {
    super(message);
    this.name = 'WindsurfRegistrationError';
    this.status = status;
    this.connectCode = connectCode;
    this.traceId = traceId;
  }
}

const TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i;

/**
 * Exchange the Firebase ID token for a Windsurf API key.
 *
 * `firebaseIdToken` is the `access_token` (or `firebase_id_token`) value the
 * Windsurf sign-in page returns in the OAuth callback URL — we treat it as
 * opaque.
 */
export async function registerUser(
  firebaseIdToken: string,
  region: WindsurfRegion,
  abortSignal?: AbortSignal,
): Promise<OAuthLoginResult> {
  if (!firebaseIdToken) {
    throw new WindsurfRegistrationError('Empty firebase_id_token', 0, 'invalid_argument');
  }

  const url = `${region.registerApiServerUrl.replace(/\/$/, '')}/exa.seat_management_pb.SeatManagementService/RegisterUser`;

  // 30s internal timeout — RegisterUser responds in ~200ms in steady state.
  // CLI users on flaky networks need bounded waits or the sign-in command
  // hangs forever. Compose with the caller's signal via a small polyfill
  // (`anySignal`) because Node 18 / older Bun lack AbortSignal.any; the
  // previous fallback `combinedSignal = abortSignal` would drop the
  // timeout entirely on those runtimes.
  const timeoutSignal = AbortSignal.timeout(30_000);
  const combinedSignal: AbortSignal = abortSignal
    ? anySignal([abortSignal, timeoutSignal])
    : timeoutSignal;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Connect protocol version header — not strictly required for JSON, but
      // matches what the official Connect clients send and avoids accidental
      // routing into a non-Connect HTTP handler.
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify({ firebase_id_token: firebaseIdToken }),
    signal: combinedSignal,
  });

  const text = await response.text();

  if (!response.ok) {
    let connectCode: string | undefined;
    let message = text || `RegisterUser failed with HTTP ${response.status}`;
    try {
      const errJson = JSON.parse(text) as ConnectErrorJson;
      connectCode = errJson.code;
      if (errJson.message) message = errJson.message;
    } catch {
      // non-JSON error body — keep raw text in `message`
    }
    const traceMatch = message.match(TRACE_ID_RE);
    throw new WindsurfRegistrationError(message, response.status, connectCode, traceMatch?.[1]);
  }

  let parsed: RegisterUserResponseJson;
  try {
    parsed = JSON.parse(text) as RegisterUserResponseJson;
  } catch {
    throw new WindsurfRegistrationError(
      `RegisterUser returned 200 but body is not JSON: ${text.slice(0, 200)}`,
      response.status,
      'internal',
    );
  }

  const apiKey = parsed.api_key;
  const name = parsed.name;
  // Empty `api_server_url` is normal for single-tenant accounts — the desktop
  // extension's `getApiServerUrl` helper falls back to the configured default
  // when this is empty/missing. We mirror that behavior here.
  const apiServerUrl = parsed.api_server_url && parsed.api_server_url.length > 0
    ? parsed.api_server_url
    : 'https://server.codeium.com';

  if (!apiKey) {
    throw new WindsurfRegistrationError(
      'RegisterUser returned 200 but api_key was empty',
      response.status,
      'malformed_response',
    );
  }
  if (!name) {
    throw new WindsurfRegistrationError(
      'RegisterUser returned 200 but name was empty',
      response.status,
      'malformed_response',
    );
  }

  return {
    apiKey,
    name,
    apiServerUrl,
    redirectUrl: parsed.redirect_url,
  };
}
