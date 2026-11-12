import type { ChildOp, ChildOperationSummary } from "../link/child-observations";
import type { InstallKind, UpdateRoute } from "../link/child-update-contract";
import type { LinkChildOpsStatus } from "../link/status-projection";

/** What the Child reports about its Codex app-servers (wp8); known fields only, each optional. */
export interface LinkChildCodexView {
  appServers?: "fresh" | "stale" | "not_running" | "unknown"; staleCount?: number; catalogMatchesHome?: boolean | null;
  catalogSyncedAt?: number | null; reportedAt?: number | null;
}

/**
 * A row's `child` block as this CLI reads it. Tolerant (G1): a later Home may add keys or enum values, so unknown keys
 * are dropped and an unknown enum value reads "unknown"; a known key with the wrong type is still rejected.
 */
export type LinkChildOpsView = Omit<LinkChildOpsStatus, "update" | "codex" | "activeJob" | "lastOperation" | "holds"> & {
  update: { route: UpdateRoute | "unknown" | null; reason: string | null; observedAt: string | null };
  codex: LinkChildCodexView | null;
  activeJob: { jobId: string; op: ChildOp | string; state: "queued" | "running" | "unknown" } | null;
  lastOperation: (Omit<ChildOperationSummary, "op"> & { op: ChildOp | string }) | null;
  /** Link WebSocket activity holds (D8); absent while nothing holds the link. Unknown reasons read "unknown". */
  holds?: LinkHoldsView;
};

export interface LinkHoldsView { holds: Array<{ since: number; reasons: string[]; pendingResults: number; runningTurns: number; runningUnknown: number }>; unknown: string | null }

const INSTALL_KINDS: ReadonlySet<string> = new Set<InstallKind>(["npm", "pnpm", "bun", "source", "mise", "desktop-app", "goat", "standalone", "ocx-child", "unknown"]);
const ROUTES: ReadonlySet<string> = new Set<UpdateRoute>(["orchestrated", "desktop-request", "owner-action", "replant", "none"]);
const SKEWS: ReadonlySet<string> = new Set(["same", "behind", "ahead", "unknown"]);
const CATALOG_STATES: ReadonlySet<string> = new Set(["current", "behind", "unknown"]);
const APP_SERVER_STATES: ReadonlySet<string> = new Set(["fresh", "stale", "not_running", "unknown"]);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateChildOps(value: unknown, index: number): LinkChildOpsView {
  const fail = (field: string): never => { throw new Error(`invalid link API response: link ${index} child ${field}`); };
  const record = (target: unknown, field: string): Record<string, unknown> => isRecord(target) ? target : fail(field);
  const text = (target: unknown, field: string): string => typeof target === "string" && target.length <= 256 ? target : fail(field);
  const nullableText = (target: unknown, field: string): string | null => target === null ? null : text(target, field);
  const count = (target: unknown, field: string): number => typeof target === "number" && Number.isFinite(target) && target >= 0 ? target : fail(field);
  const nullableCount = (target: unknown, field: string): number | null => target === null ? null : count(target, field);
  const member = <T extends string>(set: ReadonlySet<string>, target: unknown, field: string): T | "unknown" =>
    set.has(text(target, field)) ? target as T : "unknown";
  const child = record(value, "");
  const update = record(child.update, "update");
  const catalog = record(child.catalog, "catalog");
  const activity = record(child.activity, "activity");
  if (typeof activity.idle !== "boolean") fail("activity.idle");
  const installKind = child.installKind === null ? null : member<InstallKind>(INSTALL_KINDS, child.installKind, "installKind");
  return {
    homeVersion: text(child.homeVersion, "homeVersion"),
    runningVersion: nullableText(child.runningVersion, "runningVersion"),
    installedVersion: nullableText(child.installedVersion, "installedVersion"),
    installKind: installKind as InstallKind | null,
    versionSkew: member<LinkChildOpsStatus["versionSkew"]>(SKEWS, child.versionSkew, "versionSkew"),
    update: {
      route: update.route === null ? null : member<UpdateRoute>(ROUTES, update.route, "update.route"),
      reason: nullableText(update.reason, "update.reason"),
      observedAt: nullableText(update.observedAt, "update.observedAt"),
    },
    catalog: {
      state: member<LinkChildOpsStatus["catalog"]["state"]>(CATALOG_STATES, catalog.state, "catalog.state"),
      pulledAt: nullableCount(catalog.pulledAt, "catalog.pulledAt"),
      homeChangedAt: nullableCount(catalog.homeChangedAt, "catalog.homeChangedAt"),
    },
    codex: child.codex === null ? null : validateCodex(record(child.codex, "codex"), fail, member, nullableCount, count),
    activity: { idle: activity.idle as boolean, inFlight: count(activity.inFlight, "activity.inFlight"), lastDataEndAt: nullableCount(activity.lastDataEndAt, "activity.lastDataEndAt") },
    activeJob: child.activeJob === null ? null : (() => {
      const job = record(child.activeJob, "activeJob");
      const state = text(job.state, "activeJob.state");
      return { jobId: text(job.jobId, "activeJob.jobId"), op: text(job.op, "activeJob.op"), state: state === "queued" || state === "running" ? state : "unknown" as const };
    })(),
    lastOperation: child.lastOperation === null ? null : (() => {
      const last = record(child.lastOperation, "lastOperation");
      return {
        op: text(last.op, "lastOperation.op"), jobId: text(last.jobId, "lastOperation.jobId"), state: text(last.state, "lastOperation.state"),
        reason: nullableText(last.reason, "lastOperation.reason"),
        ...(last.fromVersion === undefined ? {} : { fromVersion: text(last.fromVersion, "lastOperation.fromVersion") }),
        ...(last.toVersion === undefined ? {} : { toVersion: text(last.toVersion, "lastOperation.toVersion") }),
        finishedAt: text(last.finishedAt, "lastOperation.finishedAt"),
      };
    })(),
    ...(child.holds === undefined ? {} : { holds: validateHolds(child.holds, fail) }),
  };
}

function validateCodex(codex: Record<string, unknown>, fail: (field: string) => never,
  member: <T extends string>(set: ReadonlySet<string>, target: unknown, field: string) => T | "unknown",
  nullableCount: (target: unknown, field: string) => number | null, count: (target: unknown, field: string) => number): LinkChildCodexView {
  const view: LinkChildCodexView = {};
  if (codex.appServers !== undefined) view.appServers = member<NonNullable<LinkChildCodexView["appServers"]>>(APP_SERVER_STATES, codex.appServers, "codex.appServers");
  if (codex.staleCount !== undefined) view.staleCount = count(codex.staleCount, "codex.staleCount");
  if (codex.catalogMatchesHome !== undefined) {
    if (codex.catalogMatchesHome !== null && typeof codex.catalogMatchesHome !== "boolean") fail("codex.catalogMatchesHome");
    view.catalogMatchesHome = codex.catalogMatchesHome as boolean | null;
  }
  if (codex.catalogSyncedAt !== undefined) view.catalogSyncedAt = nullableCount(codex.catalogSyncedAt, "codex.catalogSyncedAt");
  if (codex.reportedAt !== undefined) view.reportedAt = nullableCount(codex.reportedAt, "codex.reportedAt");
  return view;
}

const HOLD_REASONS: ReadonlySet<string> = new Set(["pending-results", "running-turn", "running-unknown", "untracked", "no-thread"]);

/** The tolerant reader of a row's `child.holds` (G1): unknown reasons read "unknown"; a wrong type is rejected. */
function validateHolds(value: unknown, fail: (field: string) => never): LinkHoldsView {
  if (!isRecord(value) || !Array.isArray(value.holds)) return fail("holds");
  const count = (target: unknown, field: string): number => typeof target === "number" && Number.isFinite(target) && target >= 0 ? target : fail(field);
  return {
    holds: value.holds.map((raw, index) => {
      if (!isRecord(raw) || !Array.isArray(raw.reasons)) return fail(`holds.${index}`);
      return { since: count(raw.since, `holds.${index}.since`),
        reasons: raw.reasons.map(reason => typeof reason === "string" && HOLD_REASONS.has(reason) ? reason : "unknown"),
        pendingResults: count(raw.pendingResults, `holds.${index}.pendingResults`), runningTurns: count(raw.runningTurns, `holds.${index}.runningTurns`),
        runningUnknown: count(raw.runningUnknown, `holds.${index}.runningUnknown`) };
    }),
    unknown: value.unknown === null ? null : typeof value.unknown === "string" && value.unknown.length <= 64 ? value.unknown : fail("holds.unknown"),
  };
}

/** A row's `ws` block (design 9.3) as this CLI reads it: counts are checked, reason keys are kept as sent (G1). */
export interface LinkWsView { open: number; upgrades: number; refused: Record<string, number>; closes: Record<string, number>; holds: number }

export function validateLinkWs(value: unknown, index: number): LinkWsView {
  const fail = (field: string): never => { throw new Error(`invalid link API response: link ${index} ws ${field}`); };
  if (!isRecord(value)) return fail("object");
  const count = (target: unknown, field: string): number => typeof target === "number" && Number.isSafeInteger(target) && target >= 0 ? target : fail(field);
  const tally = (target: unknown, field: string): Record<string, number> => {
    if (!isRecord(target)) return fail(field);
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(target)) {
      if (key.length > 32) fail(field);
      out[key] = count(raw, `${field}.${key}`);
    }
    return out;
  };
  return { open: count(value.open, "open"), upgrades: count(value.upgrades, "upgrades"), refused: tally(value.refused, "refused"),
    closes: tally(value.closes, "closes"), holds: count(value.holds, "holds") };
}
