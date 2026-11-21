/**
 * Pure flow view model for one request row: who was asked, who answered, who was skipped and why.
 * No React, no i18n: reasons stay codes and `route-reasons.ts` owns the wording.
 */
import { readableAccountLabel, requestedOf, rowAccountLabel, type RouteRoster, type RouteRow } from "./route-rows";

export type FlowStatus = "answered" | "failed" | "skipped" | "idle";

export interface FlowCandidate {
  key: string;
  provider: string;
  model: string;
  accountLabel?: string;
  displayName?: string;
  status: FlowStatus;
  reasonCode?: string;
  httpStatus?: number;
  ttftMs?: number;
  durationMs?: number;
}

export type FlowOutcome =
  | { kind: "ok"; answered: FlowCandidate }
  | { kind: "moved"; answered: FlowCandidate; tries: number }
  | { kind: "failed"; httpStatus: number; reasonCode?: string; tries: number }
  | { kind: "local" };

export interface RouteFlow {
  client: { value: unknown; surface?: string };
  requested: { model: string; alias?: string };
  candidates: FlowCandidate[];
  outcome: FlowOutcome;
}

/** provider -> account log label -> display name (from `/api/oauth/accounts`). */
export type AccountNames = Readonly<Record<string, Readonly<Record<string, string>>>>;

const NUL = String.fromCharCode(0);
const pm = (provider: string, model: string) => `${provider}${NUL}${model}`;

export function candidateWho(c: FlowCandidate): string {
  return c.displayName ?? (c.accountLabel ? readableAccountLabel(c.accountLabel, c.provider) : c.provider);
}

export function buildRouteFlow(row: RouteRow, names: AccountNames = {}): RouteFlow {
  const attempts = row.attempts ?? [];
  const candidates: FlowCandidate[] = [];
  const coveredModels = new Set<string>();
  const coveredLabels = new Set<string>();
  const nameOf = (provider: string, label?: string) => (label ? names[provider]?.[label] : undefined);

  attempts.forEach((a, i) => {
    const label = a.accountLogLabel ?? a.accountTag;
    const last = i === attempts.length - 1;
    const ok = a.status < 400 && !a.errorCode;
    const answered = last && ok && row.status < 400;
    const reasonCode = answered ? undefined : a.errorCode ?? (last ? row.errorCode : undefined);
    coveredModels.add(pm(a.provider, a.model));
    if (label) coveredLabels.add(label);
    candidates.push({
      key: `attempt:${i}`, provider: a.provider, model: a.model, status: answered ? "answered" : "failed",
      httpStatus: a.status,
      ...(label ? { accountLabel: label } : {}),
      ...(nameOf(a.provider, label) ? { displayName: nameOf(a.provider, label) } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      ...(typeof a.firstOutputMs === "number" ? { ttftMs: a.firstOutputMs } : {}),
      ...(typeof a.durationMs === "number" ? { durationMs: a.durationMs } : {}),
    });
  });

  row.routeDecision?.candidates?.forEach((c, i) => {
    if (typeof c.provider !== "string" || typeof c.model !== "string" || coveredModels.has(pm(c.provider, c.model))) return;
    const code = c.exclusions?.find(e => typeof e.code === "string")?.code;
    const skipped = c.eligible === false;
    candidates.push({
      key: `decision:${i}`, provider: c.provider, model: c.model, status: skipped ? "skipped" : "idle",
      ...(skipped && code ? { reasonCode: code } : {}),
    });
  });

  const roster: RouteRoster | undefined = row.accountRoster;
  roster?.accounts.forEach(account => {
    if (coveredLabels.has(account.label)) return;
    const served = account.label === row.accountLogLabel;
    const status: FlowStatus = served ? (row.status < 400 ? "answered" : "failed")
      : account.state === "available" ? "idle" : "skipped";
    candidates.push({
      key: `roster:${account.label}`, provider: roster.provider, model: row.model, status,
      accountLabel: account.label,
      ...(nameOf(roster.provider, account.label) ? { displayName: nameOf(roster.provider, account.label) } : {}),
      ...(status === "skipped" ? { reasonCode: account.state } : {}),
      ...(served ? { httpStatus: row.status, durationMs: row.durationMs } : {}),
    });
  });

  const answered = candidates.find(c => c.status === "answered");
  const tries = Math.max(attempts.length, 1);
  const outcome: FlowOutcome = answered
    ? (tries > 1 ? { kind: "moved", answered, tries } : { kind: "ok", answered })
    : row.status >= 400
      ? { kind: "failed", httpStatus: row.status, tries: attempts.length, ...(row.errorCode ? { reasonCode: row.errorCode } : {}) }
      : { kind: "local" };

  return {
    client: { value: row.client, ...(row.surface ? { surface: row.surface } : {}) },
    requested: {
      model: requestedOf(row),
    },
    candidates,
    outcome,
  };
}

export interface PoolSummary {
  provider: string;
  total: number;
  available: number;
  cooldown: number;
  paused: number;
  needsReauth: number;
  quotaExhausted: number;
  modelUnlisted: number;
}

export function summarizePool(roster: RouteRoster | undefined): PoolSummary | undefined {
  if (!roster) return undefined;
  const count = (state: string) => roster.accounts.filter(a => a.state === state).length;
  return {
    provider: roster.provider, total: roster.accounts.length, available: count("available"), cooldown: count("cooldown"),
    paused: count("paused"), needsReauth: count("needs-reauth"), quotaExhausted: count("quota-exhausted"),
    modelUnlisted: count("model-unlisted"),
  };
}

export { rowAccountLabel };
