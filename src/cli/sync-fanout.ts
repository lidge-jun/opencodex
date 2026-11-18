import type { LinkRecord, LinkStore } from "../link/store";
import type { ChildRestartRequest } from "../link/ssh-argv";
import type { SyncThenRestart } from "../link/sync-then-restart";
import type { LinkStatusPayload } from "./link";
import { LinkStatusError } from "./sync-link-status";
import { childSkipHint } from "../link/sync-fanout-classify";

export { classifySyncResult, classifyVersionProbe, parseOcxVersion, REMOTE_LINK_SYNC_MESSAGE,
  STALE_REMOTE_CATALOG_MESSAGE, type ChildVerdict } from "../link/sync-fanout-classify";
export const SYNC_FANOUT_PARTIAL_EXIT = 6;

export type HomeResult = { state: "synced" | "stale" | "skipped" | "failed"; exit: number };
export type ChildResult = { linkId: string; alias: string; state: "synced" | "skipped" | "failed" | "timed-out"; reason: string | null; exit: number | null; hint?: string };
export type FanoutDocument = { schema: "ocx.sync.fanout/1"; home: HomeResult; fanout: { state: "ran" | "disabled" | "not-applicable" | "failed"; reason: string | null }; children: ChildResult[] };
/** The reason on a synced row whose requested restart did not certainly happen (040 decision 1). Each one exits 6. */
export type RestartNote = "restart-skipped:link-active" | "restart-skipped:activity-unknown" | "restart-skipped:windows"
  | "restart-unsupported:ocx-child" | "restart-not-run" | "restart-result-unknown";
/** readActivity: a fresh status read for this link; null when unknown (D5: unknown is never idle). */
export type ChildRunOptions = { restart?: ChildRestartRequest; readActivity: () => Promise<{ inFlight: number } | null> };

export async function runHomeFanout(deps: {
  home: HomeResult; catalogCurrent: boolean; localOnly?: boolean; applicable?: boolean;
  /** null or absent: every link. Otherwise only these ids run; the rest read skipped/not-selected. */
  selected?: ReadonlySet<string> | null;
  restartChildren?: ChildRestartRequest | null;
  readStore: () => LinkStore; readLinkStatus: () => Promise<LinkStatusPayload>;
  runChild: (link: LinkRecord, deadline: number, options: ChildRunOptions) => Promise<Omit<ChildResult, "linkId" | "alias">>;
  now?: () => number; deadlineMs?: number; concurrency?: number; terminationGraceMs?: number;
}): Promise<FanoutDocument> {
  const result: FanoutDocument = { schema: "ocx.sync.fanout/1", home: deps.home, fanout: { state: deps.localOnly ? "disabled" : "not-applicable", reason: null }, children: [] };
  if (deps.localOnly || deps.applicable === false) return result;
  let store: LinkStore;
  try { store = deps.readStore(); } catch { result.fanout = { state: "failed", reason: "link-store-unreadable" }; return result; }
  if (!store.links.length) return result;
  result.fanout.state = "ran";
  const classify = (link: LinkRecord, state: ChildResult["state"], reason: string | null, exit: number | null = null): ChildResult => ({ linkId: link.id, alias: link.alias, state, reason, exit });
  // Revision 6: selection is applied first in every branch, so an unselected link always reads not-selected.
  const unselected = (link: LinkRecord): boolean => deps.selected != null && !deps.selected.has(link.id);
  const rowFor = (link: LinkRecord, state: ChildResult["state"], reason: string | null): ChildResult =>
    unselected(link) ? classify(link, "skipped", "not-selected") : classify(link, state, reason);
  result.children = store.links.map(link => rowFor(link, "skipped", link.direction === "client-initiated" ? "client-initiated-link" : "home-catalog-not-current"));
  const skipReason = deps.home.state === "failed" || deps.home.exit !== 0 ? "home-sync-failed" : deps.home.state === "skipped" ? "home-sync-skipped" : !deps.catalogCurrent ? "home-catalog-not-current" : null;
  if (skipReason) {
    result.children = store.links.map(link => rowFor(link, "skipped", link.direction === "client-initiated" ? "client-initiated-link" : skipReason));
    return result;
  }
  let status: LinkStatusPayload;
  try { status = await deps.readLinkStatus(); }
  catch (error) {
    const reason = error instanceof LinkStatusError ? error.reason : "home-link-status-unavailable";
    result.children = store.links.map(link => link.direction === "client-initiated" ? rowFor(link, "skipped", "client-initiated-link") : rowFor(link, reason === "home-runtime-not-running" ? "skipped" : "failed", reason));
    return result;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Math.floor(deps.concurrency ?? 3), 3, store.links.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      const link = store.links[index];
      if (!link) return;
      if (unselected(link) || link.direction === "client-initiated") continue;
      const wire = status.links.find(row => row.id === link.id);
      if (!wire) { result.children[index] = classify(link, "skipped", "link-not-in-runtime"); continue; }
      if (wire.state !== "connected") { result.children[index] = classify(link, "skipped", `tunnel-${wire.state}`); continue; }
      // A Child operation (wp2/wp3 job) holds this Child: an intentional skip, no hint, no exit 6.
      if (wire.child?.activeJob) { result.children[index] = classify(link, "skipped", "child-busy"); continue; }
      // Decision 3 / 4529522035: a fresh read per Child, never the first one; a failed read or a row without child is unknown.
      let unknownCause: ActivityUnknownCause = "read-failed";
      const readActivity = async (): Promise<{ inFlight: number } | null> => {
        let fresh: LinkStatusPayload;
        try { fresh = await deps.readLinkStatus(); } catch { unknownCause = "read-failed"; return null; }
        const row = fresh.links.find(candidate => candidate.id === link.id);
        if (!row) { unknownCause = "read-failed"; return null; }
        if (!row.child) { unknownCause = "absent"; return null; }
        return row.child.activity;
      };
      const options: ChildRunOptions = deps.restartChildren ? { restart: deps.restartChildren, readActivity } : { readActivity };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const budget = deps.deadlineMs ?? 180_000;
        const child = await Promise.race([
          deps.runChild(link, (deps.now ?? Date.now)() + budget, options),
          new Promise<Omit<ChildResult, "linkId" | "alias">>(resolve => {
            timer = setTimeout(() => resolve({ state: "timed-out", reason: "termination-unconfirmed", exit: null }), budget + (deps.terminationGraceMs ?? 3000));
          }),
        ]);
        // Build the row from the schema's own fields, so an extra key on a runner's result never reaches ocx.sync.fanout/1.
        const hint = child.state === "skipped" ? childSkipHint(child.reason, link.alias)
          : child.state === "synced" && child.reason?.startsWith("restart-") ? childRestartHint(child.reason, link, deps.restartChildren ?? "app-server", unknownCause) : child.hint;
        result.children[index] = { linkId: link.id, alias: link.alias, state: child.state, reason: child.reason, exit: child.exit, ...(hint === undefined ? {} : { hint }) };
      } catch { result.children[index] = classify(link, "failed", "internal-error"); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
  });
  await Promise.all(workers);
  return result;
}

/** Maps the shared sequence's result to a synced row's reason; null keeps the row as the sync reported it. */
export function restartNote(done: SyncThenRestart<{ state: string; reason: string | null }>): RestartNote | null {
  if (!done.restart) return null;
  // Reached only after a successful plain sync; done.sync is then the restarting sync's verdict.
  if (done.restartUnknown) return "restart-result-unknown";
  // Any failed plain sync keeps its own row, including on Windows or ocx-child (those are checked first).
  if (done.sync.state !== "synced") return null;
  switch (done.withheld) {
    case undefined: case "sync-failed": return null;
    case "platform": return "restart-skipped:windows";
    case "ocx-child": return "restart-unsupported:ocx-child";
    case "activity-unknown": return "restart-skipped:activity-unknown";
    case "link-active": return "restart-skipped:link-active";
    case "second-not-run": return "restart-not-run";
  }
}

type ActivityUnknownCause = "absent" | "read-failed";

function childRestartHint(reason: string, link: LinkRecord, restart: ChildRestartRequest, cause: ActivityUnknownCause): string | undefined {
  const retry = `ocx sync --child ${link.id} --restart-children${restart === "codex" ? "=codex --yes" : ""}`;
  switch (reason as RestartNote) {
    case "restart-skipped:link-active": return `A model request was running on ${link.alias}; its Codex was not restarted. Retry when it is idle: ${retry}.`;
    case "restart-skipped:activity-unknown": return cause === "absent"
      ? `This Home's OpenCodex runtime did not report ${link.alias}'s activity; restart or update it, then retry ${retry}.`
      : `The Home could not read ${link.alias}'s activity (the status read failed or timed out); retry ${retry}.`;
    case "restart-skipped:windows": return "Codex restarts over SSH are not supported on Windows Children; restart Codex on that machine.";
    case "restart-unsupported:ocx-child": return "ocx-child does not restart Codex; restart the Codex app or its app-servers on that machine.";
    case "restart-not-run": return `The restart was not sent to ${link.alias}; check its sync status and retry ${retry}.`;
    case "restart-result-unknown": return `The restart was sent to ${link.alias} but its result is unknown; check Codex on that machine.`;
    default: return undefined;
  }
}

export function fanoutExitCode(document: FanoutDocument): number {
  if (document.home.exit !== 0) return document.home.exit;
  return document.fanout.state === "failed" || document.children.some(child => child.state === "failed" || child.state === "timed-out"
    || (child.state === "skipped" && child.hint !== undefined)
    // A requested restart that did not certainly happen (040 decision 2).
    || (child.state === "synced" && child.reason?.startsWith("restart-") === true)) ? SYNC_FANOUT_PARTIAL_EXIT : 0;
}

export function renderFanoutJson(document: FanoutDocument): string { return JSON.stringify(document); }
export function renderFanoutHuman(document: FanoutDocument): string[] {
  return document.children.map(child => `${child.alias} (${child.linkId}): ${child.state}${child.reason ? ` (${child.reason})` : ""}${child.hint ? ` — ${child.hint}` : ""}`);
}
