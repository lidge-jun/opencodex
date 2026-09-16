/**
 * ZCode plan gateway vendor probe — billing/balance for the Start Plan.
 *
 * Auth is the plan JWT; the gateway fingerprints control-plane calls, so the identity
 * header set mirrors the client minus `X-ZCode-Agent` (which the client itself omits on
 * control-plane fetches). Balance rows are plan-specific pools (`show_name`, used/total
 * units, `expires_at`), surfaced as custom quota windows. The billing endpoint requires
 * the `X-Device-Mid` header — its absence answers biz code 3001.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../../config/paths";
import {
  AUTHORITATIVE_EMPTY_QUOTA,
  report,
  TERMINAL_QUOTA_FAILURE,
  type ProviderQuotaProbeResult,
} from "./report-cache";

const ZCODE_PLAN_ORIGIN = "https://zcode.z.ai";
const ZCODE_PLAN_APP_VERSION = process.env.ZCODE_PLAN_APP_VERSION?.trim() || "3.11.2";

export function isCanonicalZcodePlanBaseUrl(baseUrl: string): boolean {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  return normalized === `${ZCODE_PLAN_ORIGIN}/api/v1/zcode-plan/anthropic`
    || normalized === `${ZCODE_PLAN_ORIGIN}/api/v1/zcode-plan`;
}

/**
 * Stable per-install device id the plan gateway's control plane expects on billing calls.
 * Generated once and stored under the configured OpenCodex home (isolated
 * OPENCODEX_HOME installs keep separate device identities); `ZCODE_DEVICE_MID` overrides
 * (e.g. to reuse the desktop client's id so the gateway sees one continuous device).
 */
export function zcodePlanDeviceMid(): string {
  const fromEnv = process.env.ZCODE_DEVICE_MID?.trim();
  if (fromEnv) return fromEnv;
  const dir = getConfigDir();
  const file = join(dir, "zcode-plan-device-mid");
  try {
    const stored = readFileSync(file, "utf8").trim();
    if (stored) return stored;
  } catch { /* first run or unreadable: generate below */ }
  const mid = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, mid, { mode: 0o600 });
  } catch { /* persistence is best-effort; an unpersisted id still works per-process */ }
  return mid;
}

/**
 * Mint one billing snapshot. Non-exhausted snapshots carry recovery semantics: the
 * publisher clears combo cooldowns recorded against the provider (see
 * quota-routing-cache).
 */
export async function fetchZcodeStartPlanQuota(provider: string, accessToken: string): Promise<ProviderQuotaProbeResult | null> {
  if (!accessToken) return null;
  const platform = `${process.platform}-${process.arch}`;
  const language = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
    } catch {
      return "unknown";
    }
  })();
  const timezone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    } catch {
      return "unknown";
    }
  })();
  const response = await fetch(
    `${ZCODE_PLAN_ORIGIN}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(ZCODE_PLAN_APP_VERSION)}&platform=${encodeURIComponent(platform)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "HTTP-Referer": ZCODE_PLAN_ORIGIN,
        "User-Agent": `ZCode/${ZCODE_PLAN_APP_VERSION}`,
        "X-ZCode-App-Version": ZCODE_PLAN_APP_VERSION,
        "X-Title": "Z Code@cli",
        "X-Release-Channel": process.env.ZCODE_ENV?.trim().toLowerCase() === "test" ? "test" : "production",
        "X-Client-Language": language,
        "X-Client-Timezone": timezone,
        "X-Platform": platform,
        "X-Os-Category": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
        "X-Device-Mid": zcodePlanDeviceMid(),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
      ? TERMINAL_QUOTA_FAILURE
      : null;
  }
  let body: {
    code?: unknown;
    data?: { balances?: unknown; server_time?: unknown };
  };
  try {
    body = JSON.parse(await response.text()) as typeof body;
  } catch {
    return null;
  }
  if (!body || (typeof body.code === "number" && body.code !== 0)) return null;
  const data = body.data && typeof body.data === "object" ? body.data : {};
  const balances = Array.isArray(data.balances) ? data.balances : [];
  const windows: Array<{ label: string; percent: number; resetAt?: number }> = [];
  for (const row of balances) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const label = typeof entry.show_name === "string" && entry.show_name.trim() ? entry.show_name.trim() : "balance";
    const total = typeof entry.total_units === "number" && Number.isFinite(entry.total_units) ? entry.total_units : undefined;
    const used = typeof entry.used_units === "number" && Number.isFinite(entry.used_units) ? entry.used_units : undefined;
    if (total === undefined || total <= 0) continue;
    const ratio = used === undefined
      ? (total - (typeof entry.remaining_units === "number" && Number.isFinite(entry.remaining_units) ? entry.remaining_units : total)) / total
      : used / total;
    const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
    const expiresAt = typeof entry.expires_at === "number" && Number.isFinite(entry.expires_at) ? entry.expires_at : undefined;
    windows.push({ label, percent, ...(expiresAt !== undefined ? { resetAt: expiresAt * 1000 } : {}) });
  }
  if (windows.length === 0) return AUTHORITATIVE_EMPTY_QUOTA;
  return report(
    provider,
    "zcode-start-plan:billing-balance",
    { customWindows: windows, updatedAt: Date.now() },
  );
}
