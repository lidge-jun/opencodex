import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import type { LinkRecord, LinkStore } from "../link/store";
import type { LinkStatusDto } from "../link/status-projection";
import { LinkStatusError } from "./sync-link-status";

export const REMOTE_LINK_SYNC_MESSAGE = "Remote Link Home catalog synchronized.";
export const STALE_REMOTE_CATALOG_MESSAGE = "Home unavailable; retained and applied the last-known-good remote catalog (stale).";
export const SYNC_FANOUT_PARTIAL_EXIT = 6;

export type ChildVerdict = { state: "synced" | "skipped" | "failed"; reason: string | null };
const failure = (reason: string): ChildVerdict => ({ state: "failed", reason });
const skipped = (reason: string): ChildVerdict => ({ state: "skipped", reason });
const minimum = parseStrictSemver("2.93.0")!;

export function parseOcxVersion(output: string): string | null {
  const version = output.trim().replace(/^opencodex /, "");
  return parseStrictSemver(version) ? version : null;
}

export function classifyVersionProbe(output: string): "child-ocx-version-unknown" | "child-ocx-lacks-expect-link" | null {
  const version = parseOcxVersion(output);
  if (!version) return "child-ocx-version-unknown";
  return compareStrictSemver(parseStrictSemver(version)!, minimum) < 0 ? "child-ocx-lacks-expect-link" : null;
}

const mismatchReasons = new Set(["disconnected", "invalid_state", "disconnect_pending", "pending_operation", "hub_client", "link_client", "other_link", "other_key"]);

function validDocument(value: unknown): "synced" | "stale" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keysAre = (object: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
  if (!keysAre(v, ["schema", "home", "fanout", "children"])) return null;
  if (v.schema !== "ocx.sync.fanout/1" || !v.home || typeof v.home !== "object" || Array.isArray(v.home)
      || !v.fanout || typeof v.fanout !== "object" || Array.isArray(v.fanout) || !Array.isArray(v.children)) return null;
  const home = v.home as Record<string, unknown>, fanout = v.fanout as Record<string, unknown>;
  if (!keysAre(home, ["state", "exit"]) || !keysAre(fanout, ["state", "reason"])) return null;
  if (home.exit !== 0 || (home.state !== "synced" && home.state !== "stale")) return null;
  if (fanout.state !== "not-applicable" || fanout.reason !== null || v.children.length !== 0) return null;
  return home.state;
}

export function classifySyncResult(result: { code: number; stdout: string; stderr: string }): ChildVerdict {
  const { code, stdout, stderr } = result;
  if (code === 255) return failure("ssh-failed");
  if (code === 127) return failure("child-ocx-not-found");
  if (code === 126) return failure("child-ocx-not-contained");
  if (code === 125) return skipped("child-platform-unsupported");
  const lines = stderr.split(/\r?\n/);
  const last = stderr.trimEnd().split(/\r?\n/).at(-1);
  if (code === 121) {
    if (last === "ocx-fanout:child-ocx-lacks-expect-link") return skipped("child-ocx-lacks-expect-link");
    if (last === "ocx-fanout:child-ocx-version-unknown") return skipped("child-ocx-version-unknown");
    return failure("child-sync-failed");
  }
  const markers = lines.map(line => /^ocx-fanout:selected:(.+)$/.exec(line)).filter(match => match !== null);
  if (markers.length !== 1 || !parseStrictSemver(markers[0]![1]!)) return failure("child-output-invalid");
  const outputLines = stdout.split(/\r?\n/);
  const delimiters = outputLines.flatMap((line, index) => line === "ocx-fanout:stdout-begin" ? [index] : []);
  if (delimiters.length !== 1) return failure("child-output-invalid");
  if (code === 5) {
    try {
      const detail: unknown = JSON.parse(last ?? "");
      if (detail && typeof detail === "object" && "phase" in detail && detail.phase === "child_link_mismatch"
          && "reason" in detail && typeof detail.reason === "string" && mismatchReasons.has(detail.reason)) return skipped(`child-link-mismatch:${detail.reason}`);
    } catch { /* The generic mismatch is the only safe fallback. */ }
    return skipped("child-link-mismatch");
  }
  if (code === 7) return skipped("child-updating");
  if (code !== 0) return failure("child-sync-failed");
  const text = outputLines.slice(delimiters[0]! + 1).join("\n").trim();
  if (text.startsWith("{")) {
    try {
      const state = validDocument(JSON.parse(text));
      if (state === "synced") return { state: "synced", reason: null };
      if (state === "stale") return failure("child-catalog-stale");
    } catch { /* Reject invalid or multiple JSON documents. */ }
    return failure("child-output-invalid");
  }
  if (text.includes(STALE_REMOTE_CATALOG_MESSAGE)) return failure("child-catalog-stale");
  if (text.includes(REMOTE_LINK_SYNC_MESSAGE)) return { state: "synced", reason: null };
  return failure("child-output-invalid");
}

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
        result.children[index] = { linkId: link.id, alias: link.alias, ...child, ...(child.state === "skipped" ? { hint: childSkipHint(child.reason, link.alias) } : {}) };
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
