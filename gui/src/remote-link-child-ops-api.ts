import { isRecord, requestLinkJson } from "./remote-link-api";

export type ChildInstallKind = "npm" | "pnpm" | "bun" | "source" | "mise" | "desktop-app" | "goat" | "standalone" | "ocx-child" | "unknown";
export const CHILD_INSTALL_KINDS: readonly ChildInstallKind[] = ["npm", "pnpm", "bun", "source", "mise", "desktop-app", "goat", "standalone", "ocx-child", "unknown"];
export type ChildUpdateRoute = "orchestrated" | "desktop-request" | "owner-action" | "replant" | "none";
/** Wire mirror of src/link/child-observations.ts `ChildOp` (000 "Canonical names"); gui/ cannot import src/. */
export const CHILD_OPS = ["observe", "sync", "restart-codex", "update"] as const;
export type ChildOp = typeof CHILD_OPS[number];
/** src/link/child-ops-types.ts `CHILD_ITEM_STATES` (11). */
export const CHILD_ITEM_STATES = ["queued", "running", "succeeded", "up-to-date", "busy", "offline", "refused",
  "owner-action", "unsupported", "failed", "uncertain"] as const;
export type ChildItemState = typeof CHILD_ITEM_STATES[number];
/** 030 ships exactly these four (child-ops-types.ts:24). 080 may widen it; an unknown value renders as <code>. */
export const CHILD_RESTART_OUTCOMES = ["requested", "unsupported", "not-run", "skipped"] as const;
export type ChildRestartOutcome = typeof CHILD_RESTART_OUTCOMES[number];

export interface ChildCodexView { appServers: "fresh" | "stale" | "not_running" | "unknown"; staleCount: number;
  catalogMatchesHome: boolean | null; catalogSyncedAt: number | null; reportedAt: number }
export interface ChildOpsRowView {
  homeVersion: string; runningVersion: string | null; installedVersion: string | null; installKind: ChildInstallKind | null;
  versionSkew: "same" | "behind" | "ahead" | "unknown";
  update: { route: ChildUpdateRoute | null; reason: string | null; observedAt: string | null };
  catalog: { state: "current" | "behind" | "unknown"; pulledAt: number | null; homeChangedAt: number | null };
  /** Always null on this base (status-projection.ts `LinkChildOpsStatus.codex` is typed `null`); 080 fills it. */
  codex: ChildCodexView | null; childBuild: string | null;
  activity: { idle: boolean; inFlight: number; lastDataEndAt: number | null };
  activeJob: { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
  lastOperation: { op: ChildOp; jobId: string; state: string; reason: string | null;
    fromVersion: string | null; toVersion: string | null; finishedAt: string | null } | null;
}
export interface ChildJobItemView { linkId: string; alias: string; state: string; reason: string | null; hint: string | null;
  fromVersion: string | null; toVersion: string | null;
  sync: { state: string; reason: string | null } | null;
  restart: { requested: string; outcome: string } | null }
export interface ChildJobView { jobId: string; op: ChildOp; trigger: "manual" | "auto"; restart: "none" | "app-server" | "codex";
  state: "queued" | "running" | "done"; items: ChildJobItemView[] }
export interface ChildPolicyView { catalogFanout: "auto" | "manual"; childCodexRestart: "never" | "app-server-when-idle";
  updates: "off" | "notify" | "auto-when-idle"; idleAfterMs: number }
export interface ChildPolicyReadView { policy: ChildPolicyView; warning: "policy-file-invalid" | null }
export interface ChildOperationBody { op: ChildOp; linkIds: string[] | "all"; restart?: "app-server" | "codex" }

const text = (v: unknown): string | null => typeof v === "string" && v.length > 0 && v.length <= 256 ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;
const member = <T extends string>(all: readonly T[], v: unknown): T | null => (all as readonly unknown[]).includes(v) ? v as T : null;

/** Tolerant: absent, or any key this build cannot type, yields null so the row renders exactly as today. */
export function parseChildOps(value: unknown): ChildOpsRowView | null {
  if (!isRecord(value)) return null;
  const homeVersion = text(value.homeVersion);
  const update = isRecord(value.update) ? value.update : null;
  const catalog = isRecord(value.catalog) ? value.catalog : null;
  const activity = isRecord(value.activity) ? value.activity : null;
  const job = isRecord(value.activeJob) ? value.activeJob : null;
  const last = isRecord(value.lastOperation) ? value.lastOperation : null;
  const codex = isRecord(value.codex) ? {
    appServers: member(["fresh", "stale", "not_running", "unknown"] as const, value.codex.appServers) ?? "unknown",
    staleCount: num(value.codex.staleCount) ?? 0,
    catalogMatchesHome: bool(value.codex.catalogMatchesHome),
    catalogSyncedAt: num(value.codex.catalogSyncedAt), reportedAt: num(value.codex.reportedAt) ?? 0,
  } : null;
  if (!homeVersion || !update || !catalog || !activity) return null;
  const op = member(CHILD_OPS, last?.op);
  return {
    homeVersion,
    runningVersion: text(value.runningVersion), installedVersion: text(value.installedVersion),
    installKind: member(CHILD_INSTALL_KINDS, value.installKind),
    versionSkew: member(["same", "behind", "ahead", "unknown"] as const, value.versionSkew) ?? "unknown",
    update: { route: member(["orchestrated", "desktop-request", "owner-action", "replant", "none"] as const, update.route),
      reason: text(update.reason), observedAt: text(update.observedAt) },
    catalog: { state: member(["current", "behind", "unknown"] as const, catalog.state) ?? "unknown",
      pulledAt: num(catalog.pulledAt), homeChangedAt: num(catalog.homeChangedAt) },
    codex, childBuild: text(value.childBuild),
    activity: { idle: activity.idle === true, inFlight: num(activity.inFlight) ?? 0, lastDataEndAt: num(activity.lastDataEndAt) },
    activeJob: job && text(job.jobId) && job.state !== "done" && member(CHILD_OPS, job.op)
      ? { jobId: text(job.jobId)!, op: member(CHILD_OPS, job.op)!, state: job.state === "queued" ? "queued" : "running" } : null,
    lastOperation: last && op && text(last.jobId) ? { op, jobId: text(last.jobId)!, state: text(last.state) ?? "failed",
      reason: text(last.reason), fromVersion: text(last.fromVersion), toVersion: text(last.toVersion), finishedAt: text(last.finishedAt) } : null,
  };
}

/** Strict on the fields it renders, open on the enum strings: an unknown state or outcome is kept and shown as <code>. */
export function parseChildJob(value: unknown): ChildJobView {
  if (!isRecord(value) || value.schema !== "ocx.link.child-job/1" || !text(value.jobId) || !Array.isArray(value.items)) throw new Error("invalid job");
  const op = member(CHILD_OPS, value.op);
  if (!op) throw new Error("invalid job op");
  return {
    jobId: text(value.jobId)!, op,
    trigger: value.trigger === "auto" ? "auto" : "manual",
    restart: member(["none", "app-server", "codex"] as const, value.restart) ?? "none",
    state: member(["queued", "running", "done"] as const, value.state) ?? "running",
    items: value.items.filter(isRecord).map(raw => {
      const sync = isRecord(raw.sync) ? { state: text(raw.sync.state) ?? "failed", reason: text(raw.sync.reason) } : null;
      const restart = isRecord(raw.restart) ? { requested: text(raw.restart.requested) ?? "app-server", outcome: text(raw.restart.outcome) ?? "" } : null;
      return { linkId: text(raw.linkId) ?? "", alias: text(raw.alias) ?? "", state: text(raw.state) ?? "failed",
        reason: text(raw.reason), hint: text(raw.hint), fromVersion: text(raw.fromVersion), toVersion: text(raw.toVersion), sync, restart };
    }),
  };
}

export function parseChildPolicyRead(value: unknown): ChildPolicyReadView {
  const policy = isRecord(value) && isRecord(value.policy) ? value.policy : null;
  const idle = policy ? num(policy.idleAfterMs) : null;
  if (!policy || idle === null) throw new Error("invalid policy");
  return {
    policy: {
      catalogFanout: member(["auto", "manual"] as const, policy.catalogFanout) ?? "manual",
      childCodexRestart: member(["never", "app-server-when-idle"] as const, policy.childCodexRestart) ?? "never",
      updates: member(["off", "notify", "auto-when-idle"] as const, policy.updates) ?? "off",
      idleAfterMs: idle,
    },
    warning: isRecord(value) && value.warning === "policy-file-invalid" ? "policy-file-invalid" : null,
  };
}

const json = { "content-type": "application/json" };
/** A submit that never settles would keep the row (or the bulk bar) busy until a reload; the job, if the Home took it,
 *  still shows up through the status rows' `activeJob`. */
export const CHILD_OPERATION_POST_TIMEOUT_MS = 30_000;
export async function postChildOperation(apiBase: string, body: ChildOperationBody,
  timeoutMs: number = CHILD_OPERATION_POST_TIMEOUT_MS): Promise<ChildJobView> {
  const request = new AbortController();
  const deadline = setTimeout(() => request.abort(), timeoutMs);
  try {
    const out = await settleOrAbort(requestLinkJson<{ job?: unknown }>(apiBase, "/api/link/children/operations",
      { method: "POST", headers: json, body: JSON.stringify(body), signal: request.signal }), request.signal);
    return parseChildJob(out.job);
  } finally { clearTimeout(deadline); }
}
export async function getChildJob(apiBase: string, jobId: string, signal?: AbortSignal): Promise<ChildJobView> {
  const out = await requestLinkJson<{ job?: unknown }>(apiBase, `/api/link/children/jobs/${encodeURIComponent(jobId)}`, { signal });
  return parseChildJob(out.job);
}
export async function getChildPolicy(apiBase: string, signal?: AbortSignal): Promise<ChildPolicyReadView> {
  return parseChildPolicyRead(await requestLinkJson<unknown>(apiBase, "/api/link/children/policy", { signal }));
}
export async function putChildPolicy(apiBase: string, patch: Partial<ChildPolicyView>): Promise<ChildPolicyReadView> {
  return parseChildPolicyRead(await requestLinkJson<unknown>(apiBase, "/api/link/children/policy", { method: "PUT", headers: json, body: JSON.stringify(patch) }));
}

/** Pure view helpers (unit-tested directly). */
export function updateAvailable(row: ChildOpsRowView): boolean {
  return row.versionSkew === "behind" && (row.update.route === "orchestrated" || row.update.route === "desktop-request");
}
export function codexRestartNeeded(row: ChildOpsRowView): boolean {
  return row.codex !== null && (row.codex.appServers === "stale" || row.codex.catalogMatchesHome === false);
}
/** Badges and actions exist only where the Home can reach the Child: a Home-initiated link with its row. */
export function rowOperable(direction: "hub-initiated" | "client-initiated", row: ChildOpsRowView | null): boolean {
  return direction === "hub-initiated" && row !== null;
}
/** "Restart held: a turn was running" is the server's only withheld outcome, so it owns the one warning tone. */
export function restartWithheld(outcome: string): boolean { return outcome === "skipped"; }
/** A job this page tracked holds its links from acceptance, before the next status poll reports `activeJob`. */
export function jobHoldsLink(jobs: readonly ChildJobView[], linkId: string): boolean {
  return jobs.some(job => job.state !== "done"
    && job.items.some(item => item.linkId === linkId && (item.state === "queued" || item.state === "running")));
}
export const CHILD_JOB_POLL_MS = 2_000;
/** The operations route refuses a body naming more links than this (`CHILD_OPS_MAX_LINK_IDS` in src/link/child-ops-types.ts;
 *  gui/tests/remote-link-child-ops.test.tsx pins the copy). */
export const CHILD_OPERATION_MAX_LINK_IDS = 64;
/** Splits a bulk target list into the fewest groups of at most `size` ids, with sizes differing by at most one; a
 *  Home's link count is unbounded. Even groups never leave a one-id tail for a list longer than one, which the route
 *  would treat as a single-link request (a held link answers 409 for the whole request instead of a `busy` item). */
export function chunkLinkIds(ids: readonly string[], size = CHILD_OPERATION_MAX_LINK_IDS): string[][] {
  const groups = Math.ceil(ids.length / size);
  const base = groups > 0 ? Math.floor(ids.length / groups) : 0;
  const larger = groups > 0 ? ids.length % groups : 0;     // the first `larger` groups take one extra id
  const chunks: string[][] = [];
  let start = 0;
  for (let index = 0; index < groups; index += 1) {
    const length = base + (index < larger ? 1 : 0);
    chunks.push(ids.slice(start, start + length));
    start += length;
  }
  return chunks;
}
/** One job poll may take this long; a GET that never settles would otherwise stop every later poll. */
export const CHILD_JOB_POLL_TIMEOUT_MS = 15_000;

/** Rejects as soon as `signal` aborts, even when the request underneath ignores it and never settles. */
export function settleOrAbort<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The keys the operator changed, so a save never rewrites a mode they left alone (Revision 6: full PUT over damage). */
export function changedPolicyKeys(current: ChildPolicyView, draft: ChildPolicyView): Partial<ChildPolicyView> {
  const changed: Partial<ChildPolicyView> = {};
  for (const key of ["catalogFanout", "childCodexRestart", "updates", "idleAfterMs"] as const) {
    if (draft[key] !== current[key]) Object.assign(changed, { [key]: draft[key] });
  }
  return changed;
}
