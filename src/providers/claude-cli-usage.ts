import { markAnthropicFamilyEnumeration } from "./quota/anthropic-family-headers";
import { CLAUDE_CLI_USER_AGENT } from "./claude-cli-identity";
import { asRecord, normalizePercent, normalizeResetAt, readQuotaJson, REQUEST_TIMEOUT_MS } from "./quota-wire";
import type { ProviderQuota, ProviderQuotaWindow } from "./quota-types";
const hasQuotaRows = (q: ProviderQuota) => q.fiveHourPercent !== undefined || q.weeklyPercent !== undefined || Boolean(q.customWindows?.length);

function parseClaudeBucket(value: unknown): { percent?: number; resetAt?: number } | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.utilization);
  const resetAt = normalizeResetAt(rec.resets_at);
  if (percent === undefined && resetAt === undefined) return null;
  return { percent, resetAt };
}

const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;

function parseClaudeLimit(value: unknown): ProviderQuotaWindow | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const percent = normalizePercent(rec.percent);
  if (percent === undefined) return null;
  const scope = asRecord(rec.scope);
  const model = asRecord(scope?.model);
  const rawLabel = String(model?.display_name ?? "")
    .replace(TERMINAL_CONTROL_CHARACTERS, "")
    .trim();
  if (!rawLabel) return null;
  const lowerLabel = rawLabel.toLowerCase();
  const label = lowerLabel.includes("fable") ? "Fable"
    : lowerLabel.includes("opus") ? "Opus"
      : lowerLabel.includes("sonnet") ? "Sonnet"
        : null;
  // An unrecognized display_name is never published as a quota label: stripping
  // control characters still leaves attacker-chosen residue on the quota line.
  if (label === null) return null;
  const resetAt = normalizeResetAt(rec.resets_at);
  // Model scope is proven structurally here, not guessed from text: the caller admits only
  // `kind: "weekly_scoped"`, and a limit without a recognized `scope.model.display_name` has
  // already returned null above. Routing keys on `scope`, never on `label`.
  return { label, scope: "model", percent, ...(resetAt !== undefined ? { resetAt } : {}) };
}

export async function readAnthropicUsageQuota(accessToken: string): Promise<ProviderQuota | null> {
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_CLI_USER_AGENT,
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = asRecord(await readQuotaJson(response));
  if (!body) return null;
  const fiveHour = parseClaudeBucket(body.five_hour);
  const sevenDay = parseClaudeBucket(body.seven_day);
  const fable = parseClaudeBucket(body.seven_day_fable);
  const opus = parseClaudeBucket(body.seven_day_opus);
  const sonnet = parseClaudeBucket(body.seven_day_sonnet);
  const customWindows: ProviderQuotaWindow[] = [];
  if (fable?.percent !== undefined) customWindows.push({ label: "Fable", scope: "model", percent: fable.percent, ...(fable.resetAt !== undefined ? { resetAt: fable.resetAt } : {}) });
  if (opus?.percent !== undefined) customWindows.push({ label: "Opus", scope: "model", percent: opus.percent, ...(opus.resetAt !== undefined ? { resetAt: opus.resetAt } : {}) });
  if (sonnet?.percent !== undefined) customWindows.push({ label: "Sonnet", scope: "model", percent: sonnet.percent, ...(sonnet.resetAt !== undefined ? { resetAt: sonnet.resetAt } : {}) });
  const knownLabels = new Set(customWindows.map(window => window.label.toLowerCase()));
  const limits = Array.isArray(body.limits) ? body.limits : [];
  for (const rawLimit of limits) {
    const limitRecord = asRecord(rawLimit);
    // `session` and `weekly_all` mirror the canonical five-hour and weekly
    // buckets above; only model-scoped weekly limits add a third window.
    if (String(limitRecord?.kind ?? "").trim().toLowerCase() !== "weekly_scoped") continue;
    const limit = parseClaudeLimit(rawLimit);
    if (!limit || knownLabels.has(limit.label.toLowerCase())) continue;
    knownLabels.add(limit.label.toLowerCase());
    customWindows.push(limit);
  }
  const quota: ProviderQuota = {
    // Claude's 5-hour window is a first-class rate limit, same as the Codex login 5h/weekly
    // rows: report it in the canonical fields so the dashboard renders it with the standard
    // "5-hour limit" label and ordering instead of as a generic extra window.
    ...(fiveHour?.percent !== undefined ? { fiveHourPercent: fiveHour.percent } : {}),
    ...(fiveHour?.resetAt !== undefined ? { fiveHourResetAt: fiveHour.resetAt } : {}),
    ...(sevenDay?.percent !== undefined ? { weeklyPercent: sevenDay.percent } : {}),
    ...(sevenDay?.resetAt !== undefined ? { weeklyResetAt: sevenDay.resetAt } : {}),
    ...(customWindows.length > 0 ? { customWindows } : {}),
    updatedAt: Date.now(),
  };
  // Empty / schema-changed payloads must not cache as "success with no bars".
  return hasQuotaRows(quota) ? markAnthropicFamilyEnumeration(quota, Array.isArray(body.limits) && body.limits.every(raw => {
    const kind = asRecord(raw)?.kind;
    return kind === "session" || kind === "weekly_all" || kind === "weekly_scoped" && parseClaudeLimit(raw) !== null;
  })) : null;
}

