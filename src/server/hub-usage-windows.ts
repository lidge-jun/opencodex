/**
 * The quota windows this instance's upstream accounts report about themselves.
 *
 * `/v1/usage` answers with a hub's cost-and-token summary, scoped to the calling
 * data key. This companion route answers a different question - how full are the
 * subscription windows the instance routes through (an Anthropic 5-hour bar, a
 * Cursor monthly bar) - with the small windows-only body an upstream usage poller
 * decodes. The windows belong to the upstream accounts, not to the caller's key,
 * so admission is deliberately loose in one direction and tight in another: any
 * real secret (a configured data key, or the instance's own environment token,
 * exactly the two kinds the chat routes admit) opens the route, while a
 * configured key scoped by `allowedProviders` sees only its own providers'
 * windows (#5049). The body carries percentages, reset times and short window
 * labels - no account id, no credential - and the only upstream text it can
 * carry (a custom window's display label) is sanitized before it is served.
 * The readings come through the same reader the pool routes through, so stale,
 * replaced-credential and identity-mismatched rows are filtered here exactly
 * where they are there.
 */
import type { OcxConfig } from "../types";
import { cachedProviderQuotaIsExhausted } from "../combos/resolve";
import { authorizationCredential } from "../lib/authorization-scheme";
import { getCachedProviderAccountQuota, hydrateAccountQuotaCache } from "../providers/quota/account-cache";
import { getAccountSet } from "../oauth/store";
import { OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers-destination";
import { isCodexQuotaExhausted, listAccountQuotas } from "../codex/quota";
import { resetAtToMs } from "../codex/quota-types";
import { resolveAdmissionModelScope, type AdmissionModelScope } from "./admission-model-scope";
import { isAllowedRequestOrigin, resolveDataPlaneAdmissionSecret, withCors, type DataPlaneAdmissionOptions, type RequestPolicyView } from "./auth-cors";

/** One window of the public body. `resetsAt` is epoch millis, as the poller contract names it. */
interface UsageWindow {
  label: string;
  /** The upstream account's provider, so an aggregating reader can gauge each service apart. */
  provider: string;
  percent: number;
  limited: boolean;
  resetsAt: number;
}

/** Slot names order the public list; the display label is separate (custom windows name themselves). */
const SLOT_ORDER: Record<string, number> = { "5-hour": 0, weekly: 1, monthly: 2, custom: 3 };

/** Upstream label text never reaches a terminal or a log with control characters intact. */
const LABEL_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const MAX_LABEL_CHARS = 120;

/** The provider names a scope admits; an absent or empty scope admits every provider. */
function providerVisible(scope: AdmissionModelScope | undefined, provider: string): boolean {
  return !scope || scope.providers.length === 0 || scope.providers.includes(provider.trim().toLowerCase());
}

/** Sanitize an upstream-authored window label: strip control characters, trim, cap. */
function sanitizeCustomLabel(label: string): string {
  return label.replace(LABEL_CONTROL_CHARS, "").trim().slice(0, MAX_LABEL_CHARS);
}

function displayName(provider: string): string {
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider;
}

function finitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function futureReset(value: unknown, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= now) return undefined;
  if (!Number.isFinite(new Date(value).getTime())) return undefined;
  return value;
}

/**
 * Merge one account's quota into the shared window map.
 *
 * Every window must carry a reset time still in the future: a percentage without
 * a bounded window can go stale silently, and a rolled-over window's reading
 * describes an allowance that already renewed. Where several accounts of one
 * provider report the same slot, the fullest reading wins - the caller is asking
 * "can this subscription still serve me", and the answer is only as good as the
 * most-used account rotation might land on.
 */
function collectWindow(
  windows: Map<string, UsageWindow>,
  provider: string,
  slot: string,
  label: string,
  percent: number | undefined,
  resetAt: number | undefined,
  exhausted: boolean,
): void {
  if (percent === undefined) return;
  const reset = futureReset(resetAt, Date.now());
  if (reset === undefined) return;
  const key = `${provider}\u0000${slot}\u0000${label}`;
  const previous = windows.get(key);
  if (!previous) {
    windows.set(key, { label: `${displayName(provider)} ${label}`, provider: displayName(provider), percent, limited: exhausted, resetsAt: reset });
    return;
  }
  if (percent > previous.percent) {
    previous.percent = percent;
    previous.resetsAt = reset;
  }
  if (exhausted) previous.limited = true;
}

/** Read only the windows of explicitly authenticated upstream accounts. */
export async function handleHubUsageWindows(req: Request, config: OcxConfig, policy: RequestPolicyView): Promise<Response> {
  const reply = (body: unknown, status = 200) => withCors(Response.json(body, {
    status, headers: { "cache-control": "no-store" },
  }), req, policy);
  const error = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const token = req.headers.get("x-opencodex-api-key")?.trim() || authorizationCredential(req.headers)?.trim() || "";
  const options: DataPlaneAdmissionOptions = { linkIngress: policy.linkIngress?.allowedKeyIds };
  // Unlike `/v1/usage` the environment token is admitted here too; what it does not get is
  // the aggregate view a scoped configured key is refused below, which is where the owner's
  // "data-plane keys must not see cross-account windows" decision lands.
  const admission = resolveDataPlaneAdmissionSecret(token, config, "dedicated", options);
  if (!admission) return error("usage_windows_unauthorized", "A client data key is required", 401);
  if (!isAllowedRequestOrigin(req, policy)) return error("origin_rejected", "Cross-origin request blocked", 403);
  // Role gate AFTER admission, in the /v1/hub-state (#4236) tradition: answering an
  // unauthenticated caller would turn this into a free "is that machine a hub?" probe.
  if (config.runtimeRole !== "hub") return error("usage_windows_not_a_hub", "usage windows are served only by a host whose runtimeRole is hub", 404);
  // #5049: aggregate windows are cross-account by construction, so a configured key scoped
  // by allowedProviders sees only the providers it may spend. Only a configured key carries
  // a scope; the environment token stays unrestricted, exactly as on the chat routes.
  const scope = resolveAdmissionModelScope(config, admission);
  hydrateAccountQuotaCache();
  const now = Date.now();
  const windows = new Map<string, UsageWindow>();
  // Enumerate the hub's own enabled providers and their registered accounts rather than
  // walking the raw cache: that is how /v1/hub-state decides what a data key may learn (a
  // disabled provider is absent everywhere on the data plane), and reading each row through
  // getCachedProviderAccountQuota applies its staleness, replaced-credential and Kiro
  // identity filters instead of silently skipping them.
  for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
    if (providerConfig.disabled === true || !providerVisible(scope, provider)) continue;
    for (const account of getAccountSet(provider)?.accounts ?? []) {
      const quota = getCachedProviderAccountQuota(provider, account.id);
      if (!quota) continue;
      const exhausted = cachedProviderQuotaIsExhausted(quota, now);
      collectWindow(windows, provider, "5-hour", "5-hour", finitePercent(quota.fiveHourPercent), quota.fiveHourResetAt, exhausted);
      collectWindow(windows, provider, "weekly", "Weekly", finitePercent(quota.weeklyPercent), quota.weeklyResetAt, exhausted);
      collectWindow(windows, provider, "monthly", "Monthly", finitePercent(quota.monthlyPercent), quota.monthlyResetAt, exhausted);
      // Per-model rows duplicate a family bar the dialog already shows. `scope: "model"` is
      // the structural attribution evidence; `modelId` is the older spelling of the same fact.
      // Vendor-level custom windows (Cursor's "First-party models") are the subscription truth.
      for (const custom of quota.customWindows ?? []) {
        if (custom.scope === "model" || custom.modelId !== undefined) continue;
        if (custom.rejected === true && custom.resetAt === undefined) continue;
        // The label is upstream text (Antigravity names groups by `group.displayName`), so it
        // is served only after control characters are stripped; a name that sanitizes away
        // entirely names nothing and is dropped.
        const label = sanitizeCustomLabel(custom.label);
        if (!label) continue;
        collectWindow(windows, provider, "custom", label, finitePercent(custom.percent), custom.resetAt, exhausted || (custom.rejected === true));
      }
    }
  }
  // ChatGPT subscriptions live in the codex pool store, not the generic account-quota cache:
  // the burst (5-hour), weekly and monthly bars the /usage backend reports. Stored resets may
  // be in Unix seconds, so normalize them through the pool's own reader before the futures
  // filter applies. Credits are deliberately absent: a balance has no percentage, and a
  // percent-less row would freeze the ring's lower half at empty. The scope check admits the
  // pool under its display name and under the provider id the pool actually routes as.
  if (providerVisible(scope, "ChatGPT") || providerVisible(scope, OPENAI_CODEX_PROVIDER_ID)) {
    for (const [, quota] of listAccountQuotas()) {
      const exhausted = isCodexQuotaExhausted(quota, undefined, true);
      const ms = (resetAt: number | undefined) => (resetAt === undefined ? undefined : resetAtToMs(resetAt));
      collectWindow(windows, "ChatGPT", "5-hour", "5-hour", finitePercent(quota.shortPercent), ms(quota.shortResetAt), exhausted);
      collectWindow(windows, "ChatGPT", "weekly", "Weekly", finitePercent(quota.weeklyPercent), ms(quota.weeklyResetAt), exhausted);
      collectWindow(windows, "ChatGPT", "monthly", "Monthly", finitePercent(quota.monthlyPercent), ms(quota.monthlyResetAt), exhausted);
    }
  }
  const body = {
    windows: [...windows.entries()].sort((a, b) => {
      const [keyA, windowA] = a;
      const [keyB, windowB] = b;
      return (SLOT_ORDER[keyA.split("\u0000")[1]!] ?? 9) - (SLOT_ORDER[keyB.split("\u0000")[1]!] ?? 9)
        || windowA.label.localeCompare(windowB.label);
    }).map(([, window]) => window),
  };
  return reply(body);
}
