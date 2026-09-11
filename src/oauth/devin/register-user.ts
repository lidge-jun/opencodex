/**
 * Exchange a Firebase ID token for a long-lived Cognition/Devin API key.
 *
 * This calls the same Connect-RPC endpoint the Devin desktop client uses
 * after browser sign-in completes:
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
 */

import type { OAuthLoginResult, WindsurfRegion } from './types.js';
import { anySignal } from '../../lib/abort.js';
import { validateDevinApiBaseUrl } from './api-base.js';

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
 * Connect error codes that are safe to repeat to the user.
 *
 * The message body is not: a Connect error can echo the request, and the
 * request here is the Firebase ID token. That message reaches CLI output and
 * /api/logs, and redactSecretString does not recognise a bare JWT, so the code
 * is the only part of an error body that leaves this function.
 */
const SAFE_CONNECT_CODES = new Set([
  'canceled', 'unknown', 'invalid_argument', 'deadline_exceeded', 'not_found', 'already_exists',
  'permission_denied', 'resource_exhausted', 'failed_precondition', 'aborted', 'out_of_range',
  'unimplemented', 'internal', 'unavailable', 'data_loss', 'unauthenticated',
]);

function safeConnectCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CONNECT_CODES.has(value) ? value : undefined;
}

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

  // The register host reaches the network holding the Firebase ID token, so it
  // passes the same allowlist as the api-server host rather than being trusted
  // because it came from a config object.
  const registerBase = validateDevinApiBaseUrl(region.registerApiServerUrl);
  if (!registerBase) {
    throw new WindsurfRegistrationError(
      'Refusing to send the sign-in token to a non-Cognition register host.',
      0,
      'permission_denied',
    );
  }
  const url = `${registerBase}/exa.seat_management_pb.SeatManagementService/RegisterUser`;

  // 30s internal timeout — RegisterUser responds in ~200ms in steady state.
  // CLI users on flaky networks need bounded waits or the sign-in command
  // hangs forever. Compose with the caller's signal via a small polyfill
  // (`anySignal`) because Node 18 / older Bun lack AbortSignal.any; the
  // previous fallback `combinedSignal = abortSignal` would drop the
  // timeout entirely on those runtimes.
  const timeoutSignal = AbortSignal.timeout(30_000);
  const composed = abortSignal ? anySignal([abortSignal, timeoutSignal]) : undefined;
  const combinedSignal: AbortSignal = composed?.signal ?? timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Connect protocol version header — not strictly required for JSON, but
      // matches what the official Connect clients send and avoids accidental
      // routing into a non-Connect HTTP handler.
      'Connect-Protocol-Version': '1',
    },
    body: JSON.stringify({ firebase_id_token: firebaseIdToken }),
    // A 307/308 would replay this POST, and its body is the sign-in token, at
    // whatever host Location names. Fail instead of following.
    redirect: 'error',
    signal: combinedSignal,
    });
  } finally {
    // Detach from the caller's signal; it can outlive this one exchange.
    composed?.cleanup();
  }

  const text = await response.text();

  if (!response.ok) {
    let connectCode: string | undefined;
    let traceId: string | undefined;
    try {
      const errJson = JSON.parse(text) as ConnectErrorJson;
      connectCode = safeConnectCode(errJson.code);
      // The trace id is an opaque server identifier and is the one part of the
      // message worth keeping for a support conversation.
      traceId = typeof errJson.message === 'string' ? errJson.message.match(TRACE_ID_RE)?.[1] : undefined;
    } catch {
      // Non-JSON error body. It stays unread; only the status is reported.
    }
    const message = `RegisterUser failed (HTTP ${response.status}${connectCode ? `, ${connectCode}` : ''}${traceId ? `, trace ${traceId}` : ''})`;
    throw new WindsurfRegistrationError(message, response.status, connectCode, traceId);
  }

  let parsed: RegisterUserResponseJson;
  try {
    parsed = JSON.parse(text) as RegisterUserResponseJson;
  } catch {
    throw new WindsurfRegistrationError(
      // The body is not echoed: a 200 that fails to parse can still contain the
      // key or the token that produced it.
      `RegisterUser returned 200 with a body that is not JSON (${text.length} bytes)`,
      response.status,
      'internal',
    );
  }

  const apiKey = parsed.api_key;
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
  // `name` is optional in the response — default it instead of failing login.
  // src/oauth/devin.ts uses it only as a display label for the account email.
  const name = parsed.name && parsed.name.length > 0 ? parsed.name : 'Devin account';

  return {
    apiKey,
    name,
    apiServerUrl,
    redirectUrl: parsed.redirect_url,
  };
}
