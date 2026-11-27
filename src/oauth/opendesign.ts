/**
 * Open Design Cloud device-authorization login.
 *
 * Open Design splits its service into two planes, and this module is the control plane's
 * front door:
 *
 * - Model plane (`https://amr-link.open-design.ai/v1`, OpenAI-compatible) authenticates with
 *   an inference key pasted into provider config. It CANNOT read quota.
 * - Control plane (`https://amr-api.open-design.ai`) authenticates with a control key
 *   (`vela_ctrl_…`) that only device authorization issues. Quota lives here.
 *
 * The stored credential is therefore "oauth-shaped" but static: the control key has no
 * refresh token and no scheduled expiry, so `access` and `refresh` carry the same value and
 * `expires` is the safe-integer sentinel the store treats as never-due (the Muse shape,
 * `src/oauth/meta-muse-device.ts`). Provider-config inference keys never reach this module
 * and the control key never reaches the model plane.
 *
 * Protocol source: observed 2026-11-27 from the Vela CLI's device flow and the daemon's own
 * implementation (nexu-io/open-design, Apache-2.0, apps/daemon/src/integrations/vela.ts and
 * vela-workspace-context.ts). It is reverse-engineered rather than vendor-documented, so
 * every response is parsed defensively and no upstream text reaches an error message:
 * status codes only, the same discipline as `meta-muse-device.ts`.
 *
 * Provenance of the numbers below: POST /api/v1/cli/device-authorizations with no body
 * returns { deviceAuthorizationId, userCode, verificationUrl, expiresAt, intervalMs }.
 * Polling POST /api/v1/cli/device-authorizations/{id} resolves { status: 'pending'|'approved',
 * controlKey } once approved. Field names follow the daemon's `VelaRegistrationInvite` and
 * `VelaLoginStatus.userCode` shapes; the poll contract follows vela-workspace-context's
 * directory read (Bearer + x-vela-workspace-id headers, 401/403 = authorization, everything
 * else degrades).
 */
import type { OAuthController, OAuthCredentials } from "./types";

export const OPENDESIGN_CONTROL_API_URL = "https://amr-api.open-design.ai";
export const OPENDESIGN_LINK_URL = "https://amr-link.open-design.ai/v1";

const DEVICE_AUTHORIZATION_PATH = "/api/v1/cli/device-authorizations";
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_FLOW_TTL_MS = 15 * 60_000;
/** A hostile or corrupt `expiresAt` must not park a login for hours. */
const MAX_FLOW_TTL_MS = 30 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Floor: a zero or string interval would otherwise hot-loop an auth endpoint. */
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
/** The control key is a `vela_ctrl_…` secret; only its shape is asserted, never its value. */
const CONTROL_KEY_SHAPE = /^vela_ctrl_[A-Za-z0-9_-]{16,}$/;
const ID_SHAPE = /^[A-Za-z0-9_-]{8,128}$/;
const USER_CODE_SHAPE = /^\d{6}$/;
/** C0/C1 controls plus bidi and zero-width formatting marks that can disguise a URL. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

export type OpenDesignDeviceErrorKind =
  | "device-authorization"
  | "device-token"
  | "device-denied"
  | "device-expired"
  | "device-invalid"
  | "cancelled";

export class OpenDesignDeviceLoginError extends Error {
  readonly kind: OpenDesignDeviceErrorKind;
  readonly status?: number;
  constructor(kind: OpenDesignDeviceErrorKind, message: string, extra: { status?: number } = {}) {
    super(message);
    this.name = "OpenDesignDeviceLoginError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
  }
}

/** Injected so tests never touch the network or a real clock. */
export interface OpenDesignDeviceDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface OpenDesignDeviceAuthorization {
  deviceAuthorizationId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAtMs: number;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function authorize(request: Request, url: string): void {
  const origin = new URL(request.url).origin;
  if (origin !== OPENDESIGN_CONTROL_API_URL) {
    throw new OpenDesignDeviceLoginError("device-authorization", "Open Design control API origin is not allowlisted");
  }
  if (url.includes("..")) {
    throw new OpenDesignDeviceLoginError("device-authorization", "Open Design device path is invalid");
  }
}

/**
 * Interval arrives as seconds, number or string. A string reaches `setTimeout` as 0 and turns
 * the poll into a hot loop, so coerce, floor and cap it.
 */
function normalizeIntervalMs(raw: unknown): number {
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(seconds * 1000)));
}

function normalizeTtlMs(raw: unknown): number {
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_FLOW_TTL_MS;
  return Math.min(MAX_FLOW_TTL_MS, Math.round(seconds * 1000));
}

/** RFC 7231 `Retry-After`: delta-seconds or an HTTP date. Clamped to the poll ceiling. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  const raw = text(header ?? undefined);
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_POLL_INTERVAL_MS, Math.round(seconds * 1000));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(0, at - now));
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelled();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelled(): OpenDesignDeviceLoginError {
  return new OpenDesignDeviceLoginError("cancelled", "Open Design login cancelled");
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response, signal: AbortSignal, kind: OpenDesignDeviceErrorKind): Promise<Record<string, unknown> | undefined> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > 65_536) {
    void response.body?.cancel().catch(() => undefined);
    throw new OpenDesignDeviceLoginError(kind, "Open Design response exceeded the size limit", { status: response.status });
  }
  const body = await response.arrayBuffer();
  signal.throwIfAborted();
  try {
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch {
    return undefined;
  }
}

function deviceUrl(...path: (string | number)[]): string {
  const url = `${OPENDESIGN_CONTROL_API_URL}${DEVICE_AUTHORIZATION_PATH}`;
  return path.length ? `${url}/${path.join("/")}` : url;
}

/** Step 1: ask the control plane for a user code. */
export async function requestOpenDesignDeviceAuthorization(
  deps: OpenDesignDeviceDeps = {},
  signal?: AbortSignal,
): Promise<OpenDesignDeviceAuthorization> {
  const now = deps.now ?? Date.now;
  const request = requestSignal(signal);
  const url = deviceUrl();
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({}),
    redirect: "error",
    signal: request,
  });
  if (!response.ok) {
    // The error body is never parsed, but it still has to be released: an unread
    // response body keeps the underlying connection occupied.
    void response.body?.cancel().catch(() => undefined);
    throw new OpenDesignDeviceLoginError(
      "device-authorization",
      `Open Design device authorization request failed: HTTP ${response.status}`,
      { status: response.status },
    );
  }
  const payload = await readJson(response, request, "device-authorization");
  const deviceAuthorizationId = text(payload?.deviceAuthorizationId) ?? text(payload?.id);
  const userCode = text(payload?.userCode) ?? text(payload?.user_code);
  const verificationUrl = text(payload?.verificationUrl) ?? text(payload?.verification_url) ?? text(payload?.approvalUrl);
  if (!deviceAuthorizationId || !ID_SHAPE.test(deviceAuthorizationId) || !userCode || !USER_CODE_SHAPE.test(userCode)) {
    throw new OpenDesignDeviceLoginError(
      "device-authorization",
      "Open Design device authorization response is missing the device id or user code",
      { status: response.status },
    );
  }
  if (verificationUrl && (verificationUrl.length > 2048 || CONTROL.test(verificationUrl))) {
    throw new OpenDesignDeviceLoginError("device-authorization", "Open Design device authorization returned an invalid verification URL");
  }
  return {
    deviceAuthorizationId,
    userCode,
    verificationUrl: verificationUrl ?? `${OPENDESIGN_CONTROL_API_URL}/login`,
    intervalMs: normalizeIntervalMs(payload?.intervalMs ?? payload?.interval),
    expiresAtMs: now() + normalizeTtlMs(payload?.expiresIn ?? payload?.expires_in),
  };
}

/**
 * Step 2: poll until approval.
 *
 * The daemon treats 401/403 as terminal authorization failures on every control-plane read
 * (vela-billing.ts `isVelaWorkspaceAuthorizationError`), so a poll that answers one of those
 * stops rather than retrying: the grant is either denied or the account lost access.
 */
export async function pollOpenDesignDeviceAuthorization(
  authorization: OpenDesignDeviceAuthorization,
  deps: OpenDesignDeviceDeps = {},
  signal?: AbortSignal,
): Promise<string> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  let intervalMs = authorization.intervalMs;
  while (true) {
    if (signal?.aborted) throw cancelled();
    // Poll FIRST, then decide whether there is time to sleep again: a sleep ending exactly
    // at the deadline must not discard an approval the user already completed.
    const request = requestSignal(signal);
    const url = deviceUrl(authorization.deviceAuthorizationId);
    const response = await (deps.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({}),
      redirect: "error",
      signal: request,
    });
    const payload = await readJson(response, request, "device-token");
    if (response.ok) {
      const controlKey = text(payload?.controlKey) ?? text(payload?.control_key);
      if (controlKey && CONTROL_KEY_SHAPE.test(controlKey)) return controlKey;
      const status = text(payload?.status)?.toLowerCase();
      if (status === "denied" || status === "rejected" || text(payload?.error)?.toLowerCase() === "access_denied") {
        throw new OpenDesignDeviceLoginError("device-denied", "Open Design login was denied", { status: response.status });
      }
      // A 200 without a key and without a denial is still pending.
    } else {
      const code = text(payload?.error)?.toLowerCase() ?? text(payload?.code)?.toLowerCase();
      if (code === "access_denied" || code === "authorization_denied" || response.status === 403) {
        throw new OpenDesignDeviceLoginError("device-denied", "Open Design login was denied", { status: response.status });
      }
      if (code === "expired_token" || code === "authorization_expired") {
        throw new OpenDesignDeviceLoginError("device-expired", "Open Design device code expired; start the login again", { status: response.status });
      }
      if (response.status === 429 || code === "slow_down") {
        const advised = retryAfterMs(response.headers.get("retry-after"), now());
        intervalMs = Math.min(MAX_POLL_INTERVAL_MS, Math.max(advised ?? 0, intervalMs + SLOW_DOWN_INCREMENT_MS));
      } else if (response.status >= 500 || response.status === 408) {
        // Transport-shaped failure: keep polling within the grant window.
      } else if (code !== "authorization_pending" && code !== "pending") {
        throw new OpenDesignDeviceLoginError(
          "device-token",
          `Open Design device token poll failed: HTTP ${response.status}`,
          { status: response.status },
        );
      }
    }
    // The deadline is checked ONLY here, before sleeping: reaching it means the grant is spent.
    const remaining = authorization.expiresAtMs - now();
    if (remaining <= 0) {
      throw new OpenDesignDeviceLoginError("device-expired", "Open Design device authorization expired before approval");
    }
    await sleep(Math.min(intervalMs, remaining), signal);
  }
}

/** Run the whole grant and return the storable credential. */
export async function loginOpenDesign(ctrl: OAuthController = {}, deps: OpenDesignDeviceDeps = {}): Promise<OAuthCredentials> {
  const authorization = await requestOpenDesignDeviceAuthorization(deps, ctrl.signal);
  ctrl.onAuth?.({
    url: authorization.verificationUrl,
    instructions: `Enter code: ${authorization.userCode}`,
    deviceCode: authorization.userCode,
  });
  ctrl.onProgress?.("Waiting for approval in your browser...");
  const controlKey = await pollOpenDesignDeviceAuthorization(authorization, deps, ctrl.signal);
  ctrl.onProgress?.("Approved. Verifying the control key...");
  // Verify the key can list workspaces before storing it: a key that cannot read the control
  // plane would produce an account row that shows no quota forever.
  const identity = await readOpenDesignAccountIdentity(controlKey, deps, ctrl.signal);
  return {
    access: controlKey,
    // Static key: there is nothing to exchange, so refresh carries the same value.
    refresh: controlKey,
    expires: Number.MAX_SAFE_INTEGER,
    source: "oauth",
    ...(identity.accountId ? { accountId: identity.accountId } : identity.email ? { email: identity.email } : {}),
  };
}

/**
 * The account identity behind a control key, read from the workspace directory. The store
 * keys a slot on `accountId ?? email`, so the user id (not a workspace id — workspace ids 403)
 * is what keeps one human to one account row.
 */
export async function readOpenDesignAccountIdentity(
  controlKey: string,
  deps: OpenDesignDeviceDeps = {},
  signal?: AbortSignal,
): Promise<{ accountId?: string; email?: string }> {
  const workspaces = await listOpenDesignWorkspaces(controlKey, deps, signal);
  for (const workspace of workspaces) {
    if (workspace.workspaceMemberId && ID_SHAPE.test(workspace.workspaceMemberId)) {
      return { accountId: workspace.workspaceMemberId };
    }
  }
  return {};
}

export interface OpenDesignWorkspaceSummary {
  workspaceId: string;
  workspaceName: string;
  workspaceMemberId: string;
}

/**
 * Workspace directory read, `GET /api/v1/workspaces` with the control key. The daemon's own
 * mapping drops any row that lacks workspaceId/workspaceName/workspaceMemberId
 * (vela-workspace-context.ts mapVelaWorkspaceDirectoryItem); this reader does the same.
 */
export async function listOpenDesignWorkspaces(
  controlKey: string,
  deps: OpenDesignDeviceDeps = {},
  signal?: AbortSignal,
): Promise<OpenDesignWorkspaceSummary[]> {
  const now = deps.now ?? Date.now;
  const request = requestSignal(signal);
  const url = `${OPENDESIGN_CONTROL_API_URL}/api/v1/workspaces`;
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${controlKey}` },
    redirect: "error",
    signal: request,
  });
  void now;
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new OpenDesignDeviceLoginError(
      "device-authorization",
      `Open Design workspace list failed: HTTP ${response.status}`,
      { status: response.status },
    );
  }
  const payload = await readJson(response, request, "device-authorization");
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const out: OpenDesignWorkspaceSummary[] = [];
  for (const raw of items) {
    const row = record(raw);
    if (!row) continue;
    const workspaceId = text(row.workspaceId);
    const workspaceName = text(row.workspaceName);
    const workspaceMemberId = text(row.workspaceMemberId);
    if (!workspaceId || !workspaceName || !workspaceMemberId) continue;
    out.push({ workspaceId, workspaceName, workspaceMemberId });
  }
  return out;
}
