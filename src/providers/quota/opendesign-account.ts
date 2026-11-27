/**
 * Open Design Cloud account quota probe.
 *
 * One control key, many workspaces: `GET /api/v1/workspaces` lists the account's workspaces,
 * and each workspace's `GET /api/v1/workspaces/{id}/billing/preflight` carries its own
 * coding-plan windows. The quota row for the account is the aggregate; each workspace's
 * windows ride as `customWindows` keyed by label, mirroring how DeepSeek's wallet windows
 * ride a single report.
 *
 * Error semantics follow Open Design's own daemon (nexu-io/open-design, Apache-2.0,
 * apps/daemon/src/integrations/vela-billing.ts):
 * - 401/403 is an authorization failure → `TERMINAL_QUOTA_FAILURE` (credential expired,
 *   key switch / re-login).
 * - Any other failure (5xx, transport, malformed payload) is "no evidence" → null, which
 *   preserves the last-good row for the cache's retention window.
 *
 * The endpoints are reverse-engineered from the Vela CLI's traffic and the daemon's
 * implementation — not an officially documented public API — so every report carries
 * `reverseEngineered: true`.
 *
 * `resetMode` is `anchored_recurring`: `resetsAt` is a fixed schedule anchor, never
 * now-plus-duration. The probe passes it through untouched and never synthesizes a reset
 * from the observation time.
 */
import type { ProviderQuota } from "../quota-types";
import { TERMINAL_QUOTA_FAILURE, type ProviderQuotaProbeResult } from "./report-cache";
import { OPENDESIGN_CONTROL_API_URL, listOpenDesignWorkspaces, type OpenDesignDeviceDeps } from "../../oauth/opendesign";

/** The control key is a `vela_ctrl_…` secret; only its shape is asserted, never its value. */
const CONTROL_KEY_SHAPE = /^vela_ctrl_[A-Za-z0-9_-]{16,}$/;

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_WORKSPACES = 25;
const MAX_WINDOWS_PER_WORKSPACE = 4;
/** Billing preflight reads are advisory budget snapshots, never spend authority. */
const WINDOW_LABELS: Record<number, string> = {
  18_000: "5-hour",
  604_800: "weekly",
};

interface OpenDesignBillingWindow {
  policyId?: unknown;
  durationSeconds?: unknown;
  resetMode?: unknown;
  usedCredits?: unknown;
  limitCredits?: unknown;
  remainingCredits?: unknown;
  windowStart?: unknown;
  resetsAt?: unknown;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Credits arrive as digit strings ("1234"); the daemon asserts the same regex. */
function credits(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function epochMs(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function percent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.round((used / limit) * 100);
}

/**
 * Read one workspace's billing preflight. A 401/403 here is workspace-scoped — Open
 * Design answers `workspace_forbidden` for revoked or deleted workspaces while the
 * control key stays valid (observed 2026-11-27: the profile user id as a workspace id
 * 403s exactly this way) — so the workspace is skipped, not the account. Every other
 * failure (5xx, transport, malformed payload) is also "no evidence" for this workspace.
 * Returns null in all of those cases; only a successful parse returns windows.
 */
async function fetchWorkspacePreflight(
  controlKey: string,
  workspaceId: string,
  deps: OpenDesignDeviceDeps,
  signal: AbortSignal,
): Promise<ProviderQuota["customWindows"] | null> {
  const url = `${OPENDESIGN_CONTROL_API_URL}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`;
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${controlKey}`,
        "x-vela-workspace-id": workspaceId,
      },
      redirect: "error",
      signal,
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  let payload: Record<string, unknown> | null;
  try {
    payload = record(JSON.parse(await response.text()));
  } catch {
    return null;
  }
  if (!payload) return null;
  // The daemon validates against the response's wrapper; the raw route returns the
  // preflight object itself (contracts WorkspaceBillingPreflightResponse unwraps it).
  const preflight = record(payload.preflight) ?? payload;
  const plan = record(preflight.codingPlan);
  const rawWindows = Array.isArray(plan?.windows) ? plan.windows : [];
  const windows: ProviderQuota["customWindows"] = [];
  for (const raw of rawWindows.slice(0, MAX_WINDOWS_PER_WORKSPACE)) {
    const window = record(raw) as unknown as OpenDesignBillingWindow | null;
    if (!window) continue;
    const durationSeconds = typeof window.durationSeconds === "number" ? window.durationSeconds : undefined;
    if (!Number.isSafeInteger(durationSeconds) || !durationSeconds || durationSeconds <= 0) continue;
    const used = credits(window.usedCredits);
    const limit = credits(window.limitCredits);
    if (used === undefined || limit === undefined || limit <= 0) continue;
    const label = WINDOW_LABELS[durationSeconds] ?? `${Math.round(durationSeconds / 3600)}h`;
    windows.push({
      label: `${label} · ${workspaceId}`,
      percent: percent(used, limit),
      ...(epochMs(window.resetsAt) ? { resetAt: epochMs(window.resetsAt) } : {}),
    });
  }
  return windows;
}

/**
 * Fetch the account's quota: every workspace, every coding-plan window, one report.
 * A 401/403 on the workspace DIRECTORY is the credential failing, which is terminal
 * (`TERMINAL_QUOTA_FAILURE`: key expired, switch accounts). A 403 on one workspace's
 * preflight is workspace-scoped and only skips that workspace. Anything else is null
 * (no evidence), which preserves the last-good row for the cache's retention window.
 */
export async function fetchOpenDesignAccountQuota(
  provider: string,
  controlKey: string,
  deps: OpenDesignDeviceDeps = {},
): Promise<ProviderQuotaProbeResult> {
  if (!CONTROL_KEY_SHAPE.test(controlKey)) return null;
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let workspaces: Awaited<ReturnType<typeof listOpenDesignWorkspaces>>;
  try {
    workspaces = await listOpenDesignWorkspaces(controlKey, deps, signal);
  } catch (error) {
    // `listOpenDesignWorkspaces` throws OpenDesignDeviceLoginError with a status; 401/403
    // is the credential, every other failure is no evidence.
    if (error && typeof error === "object" && "status" in error
      && ((error as { status?: unknown }).status === 401 || (error as { status?: unknown }).status === 403)) {
      return TERMINAL_QUOTA_FAILURE;
    }
    return null;
  }
  if (!workspaces.length) return null;
  const customWindows: ProviderQuota["customWindows"] = [];
  for (const workspace of workspaces.slice(0, MAX_WORKSPACES)) {
    const windows = await fetchWorkspacePreflight(controlKey, workspace.workspaceId, deps, signal);
    if (windows?.length) customWindows.push(...windows);
  }
  if (!customWindows.length) return null;
  const updatedAt = Date.now();
  return {
    provider,
    label: "Open Design",
    source: "Open Design coding plan",
    updatedAt,
    reverseEngineered: true,
    quota: { updatedAt, customWindows },
  };
}
