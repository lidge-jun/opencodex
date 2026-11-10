import type { LinkRecord, LinkStore } from "../link/store";
import type { LinkStatusDto } from "../link/status-projection";
import { LinkStatusError } from "./sync-link-status";

export { classifySyncResult, classifyVersionProbe, parseOcxVersion, REMOTE_LINK_SYNC_MESSAGE,
  STALE_REMOTE_CATALOG_MESSAGE, type ChildVerdict } from "../link/sync-fanout-classify";
export const SYNC_FANOUT_PARTIAL_EXIT = 6;

export type HomeResult = { state: "synced" | "stale" | "skipped" | "failed"; exit: number };
export type ChildResult = { linkId: string; alias: string; state: "synced" | "skipped" | "failed" | "timed-out"; reason: string | null; exit: number | null; hint?: string };
export type FanoutDocument = { schema: "ocx.sync.fanout/1"; home: HomeResult; fanout: { state: "ran" | "disabled" | "not-applicable" | "failed"; reason: string | null }; children: ChildResult[] };

function childSkipHint(reason: string | null, alias: string): string {
  if (reason === "child-ocx-lacks-expect-link") return `Update OpenCodex on ${alias} to >= 2.93.0 using the installer that owns its selected ocx. For Desktop on headless Windows, use Check for Updates in the signed-in Desktop tray.`;
  if (reason === "child-updating") return "Wait for the Child update to finish, then retry sync.";
  if (reason === "child-link-mismatch:pending_operation" || reason === "child-link-mismatch:disconnect_pending") return "Wait for the Child's link operation to finish, then check its link and retry sync.";
  if (reason === "child-link-mismatch:disconnected" || reason === "child-link-mismatch:other_link") return "Please re-link this Child to this Home, then retry sync.";
  if (reason?.startsWith("child-link-mismatch")) return "Check the Child's Remote Link connection and re-link it to this Home if needed, then retry sync.";
  if (reason === "child-ocx-version-unknown") return "Check the Child's selected OpenCodex installation and version, then retry sync.";
  if (reason === "child-platform-unsupported") return "Check the Child's platform and Remote Link setup before retrying sync.";
  return "Check the Child's sync status and retry sync.";
}

export async function runHomeFanout(deps: {
  home: HomeResult; catalogCurrent: boolean; localOnly?: boolean; applicable?: boolean;
  readStore: () => LinkStore; readLinkStatus: () => Promise<LinkStatusDto>;
  runChild: (link: LinkRecord, deadline: number) => Promise<Omit<ChildResult, "linkId" | "alias">>;
  now?: () => number; deadlineMs?: number; concurrency?: number; terminationGraceMs?: number;
}): Promise<FanoutDocument> {
  const result: FanoutDocument = { schema: "ocx.sync.fanout/1", home: deps.home, fanout: { state: deps.localOnly ? "disabled" : "not-applicable", reason: null }, children: [] };
  if (deps.localOnly || deps.applicable === false) return result;
  let store: LinkStore;
  try { store = deps.readStore(); } catch { result.fanout = { state: "failed", reason: "link-store-unreadable" }; return result; }
  if (!store.links.length) return result;
  result.fanout.state = "ran";
  const classify = (link: LinkRecord, state: ChildResult["state"], reason: string | null, exit: number | null = null): ChildResult => ({ linkId: link.id, alias: link.alias, state, reason, exit });
  result.children = store.links.map(link => classify(link, "skipped", link.direction === "client-initiated" ? "client-initiated-link" : "home-catalog-not-current"));
  const skipReason = deps.home.state === "failed" || deps.home.exit !== 0 ? "home-sync-failed" : deps.home.state === "skipped" ? "home-sync-skipped" : !deps.catalogCurrent ? "home-catalog-not-current" : null;
  if (skipReason) {
    result.children = store.links.map(link => classify(link, "skipped", link.direction === "client-initiated" ? "client-initiated-link" : skipReason));
    return result;
  }
  let status: LinkStatusDto;
  try { status = await deps.readLinkStatus(); }
  catch (error) {
    const reason = error instanceof LinkStatusError ? error.reason : "home-link-status-unavailable";
    result.children = store.links.map(link => link.direction === "client-initiated" ? classify(link, "skipped", "client-initiated-link") : classify(link, reason === "home-runtime-not-running" ? "skipped" : "failed", reason));
    return result;
  }
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(Math.floor(deps.concurrency ?? 3), 3, store.links.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      const link = store.links[index];
      if (!link) return;
      if (link.direction === "client-initiated") continue;
      const wire = status.links.find(row => row.id === link.id);
      if (!wire) { result.children[index] = classify(link, "skipped", "link-not-in-runtime"); continue; }
      if (wire.state !== "connected") { result.children[index] = classify(link, "skipped", `tunnel-${wire.state}`); continue; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const budget = deps.deadlineMs ?? 180_000;
        const child = await Promise.race([
          deps.runChild(link, (deps.now ?? Date.now)() + budget),
          new Promise<Omit<ChildResult, "linkId" | "alias">>(resolve => {
            timer = setTimeout(() => resolve({ state: "timed-out", reason: "termination-unconfirmed", exit: null }), budget + (deps.terminationGraceMs ?? 3000));
          }),
        ]);
        // Build the row from the schema's own fields, so an extra key on a runner's result never reaches ocx.sync.fanout/1.
        const hint = child.state === "skipped" ? childSkipHint(child.reason, link.alias) : child.hint;
        result.children[index] = { linkId: link.id, alias: link.alias, state: child.state, reason: child.reason, exit: child.exit, ...(hint === undefined ? {} : { hint }) };
      } catch { result.children[index] = classify(link, "failed", "internal-error"); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
  });
  await Promise.all(workers);
  return result;
}

export function fanoutExitCode(document: FanoutDocument): number {
  if (document.home.exit !== 0) return document.home.exit;
  return document.fanout.state === "failed" || document.children.some(child => child.state === "failed" || child.state === "timed-out" || (child.state === "skipped" && child.hint !== undefined)) ? SYNC_FANOUT_PARTIAL_EXIT : 0;
}

export function renderFanoutJson(document: FanoutDocument): string { return JSON.stringify(document); }
export function renderFanoutHuman(document: FanoutDocument): string[] {
  return document.children.map(child => `${child.alias} (${child.linkId}): ${child.state}${child.reason ? ` (${child.reason})` : ""}${child.hint ? ` — ${child.hint}` : ""}`);
}
