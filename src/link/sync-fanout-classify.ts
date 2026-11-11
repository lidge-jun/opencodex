import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";

/**
 * Home-side classification of a pinned Child sync (moved from src/cli/sync-fanout.ts so the Link engine can use it
 * without importing src/cli). Pure: imports only the strict semver parser.
 */
export const REMOTE_LINK_SYNC_MESSAGE = "Remote Link Home catalog synchronized.";
export const STALE_REMOTE_CATALOG_MESSAGE = "Home unavailable; retained and applied the last-known-good remote catalog (stale).";

/**
 * executable is present only when a restarting pinned sync reported that it selected ocx-child, which ignores the
 * restart flags. Callers building ocx.sync.fanout/1 output must drop it.
 */
export type ChildVerdict = { state: "synced" | "skipped" | "failed"; reason: string | null; executable?: "ocx-child" };
const failure = (reason: string): ChildVerdict => ({ state: "failed", reason });
const skipped = (reason: string): ChildVerdict => ({ state: "skipped", reason });
const minimum = parseStrictSemver("2.93.0")!;
const SELECTED_KIND = "ocx-fanout:selected-kind:";

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

/**
 * expectSelectedKind: only a restarting pinned sync asks its script to print ocx-fanout:selected-kind. Every other
 * caller leaves it false, and then a selected-kind line in remote stderr is ignored exactly like any other noise.
 */
export function classifySyncResult(result: { code: number; stdout: string; stderr: string }, options: { expectSelectedKind?: boolean } = {}): ChildVerdict {
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
  // Requested only: at most one selected-kind line, after the selection marker, naming ocx-child (the restart was ignored).
  const selectedAt = lines.findIndex(line => line.startsWith("ocx-fanout:selected:"));
  const kinds = options.expectSelectedKind !== true ? []
    : lines.flatMap((line, index) => line.startsWith(SELECTED_KIND) ? [{ index, value: line.slice(SELECTED_KIND.length) }] : []);
  if (kinds.length > 1 || (kinds.length === 1 && (kinds[0]!.value !== "ocx-child" || kinds[0]!.index < selectedAt))) return failure("child-output-invalid");
  const kind = (verdict: ChildVerdict): ChildVerdict => kinds.length === 1 ? { ...verdict, executable: "ocx-child" } : verdict;
  const outputLines = stdout.split(/\r?\n/);
  const delimiters = outputLines.flatMap((line, index) => line === "ocx-fanout:stdout-begin" ? [index] : []);
  if (delimiters.length !== 1) return failure("child-output-invalid");
  if (code === 5) {
    try {
      const detail: unknown = JSON.parse(last ?? "");
      if (detail && typeof detail === "object" && "phase" in detail && detail.phase === "child_link_mismatch"
          && "reason" in detail && typeof detail.reason === "string" && mismatchReasons.has(detail.reason)) return kind(skipped(`child-link-mismatch:${detail.reason}`));
    } catch { /* The generic mismatch is the only safe fallback. */ }
    return kind(skipped("child-link-mismatch"));
  }
  if (code === 7) return kind(skipped("child-updating"));
  if (code !== 0) return kind(failure("child-sync-failed"));
  const text = outputLines.slice(delimiters[0]! + 1).join("\n").trim();
  if (text.startsWith("{")) {
    try {
      const state = validDocument(JSON.parse(text));
      if (state === "synced") return kind({ state: "synced", reason: null });
      if (state === "stale") return kind(failure("child-catalog-stale"));
    } catch { /* Reject invalid or multiple JSON documents. */ }
    return kind(failure("child-output-invalid"));
  }
  if (text.includes(STALE_REMOTE_CATALOG_MESSAGE)) return kind(failure("child-catalog-stale"));
  if (text.includes(REMOTE_LINK_SYNC_MESSAGE)) return kind({ state: "synced", reason: null });
  return kind(failure("child-output-invalid"));
}

