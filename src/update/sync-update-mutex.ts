import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { acquireOwnershipMutationLease, inspectOwnershipMutationLease, ownershipMutationLeasePath } from "../service/ownership-mutation-lease.mjs";
import { serviceStatePathsForOpenCodexHome } from "../service/state";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";

type Holder = "sync" | "update" | "free" | "unknown";
type Acquisition = { kind: "acquired"; release(): void } | { kind: "busy"; holder: Exclude<Holder, "free"> };

function paths(home: string): string[] { return [join(home, "sync-update")]; }
function holderKind(holder: { alive: boolean | null; holderKind: unknown } | null): Exclude<Holder, "free"> {
  return holder?.alive === true && (holder.holderKind === "sync" || holder.holderKind === "update")
    ? holder.holderKind : "unknown";
}

/** Non-blocking and never joins the separate service-ownership lease. */
export function tryAcquireUpdateSyncMutex(home: string, kind: "sync" | "update", deps: { now?: () => number; processAlive?: (pid: number) => boolean } = {}): Acquisition {
  assertNotRealHomeUnderTest(home);
  try {
    const lease = acquireOwnershipMutationLease(paths(home), { ...deps, waitMs: 0, isolated: true, holderKind: kind, processImage: () => null });
    return { kind: "acquired", release: () => lease.release() };
  } catch (error) {
    if (error && typeof error === "object" && "holder" in error) {
      return { kind: "busy", holder: holderKind(error.holder as Parameters<typeof holderKind>[0]) };
    }
    return { kind: "busy", holder: "unknown" };
  }
}

/** Read only: absence is accepted only after an explicit filesystem absence check. */
export function inspectUpdateSyncMutex(home: string): Holder {
  assertNotRealHomeUnderTest(home);
  try {
    const lock = join(realpathSync(home), "sync-update.mutation.lock");
    try { lstatSync(lock); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unknown";
    }
    return holderKind(inspectOwnershipMutationLease(paths(home), { processImage: () => null }));
  } catch { return "unknown"; }
}

type Observation = "free" | "active" | "unknown";
type InFlightDeps = { mutex(home: string): Holder; ownershipLease(home: string): Observation; marker(home: string): Observation };

function inspectOwnershipLease(home: string): Observation {
  try {
    const statePaths = serviceStatePathsForOpenCodexHome(home);
    const path = ownershipMutationLeasePath(statePaths);
    try { lstatSync(path); } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unknown";
    }
    const holder = inspectOwnershipMutationLease(statePaths, { processImage: () => null });
    return holder?.alive === true ? "active" : holder?.alive === false ? "free" : "unknown";
  } catch { return "unknown"; }
}

export function inspectUpdateMarker(home: string): Observation {
  const path = join(home, "update-orchestrated.json");
  let found = false;
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    found = true;
    if (!before.isFile() || before.size > 4096) return "unknown";
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return "unknown";
    const buffer = Buffer.alloc(4097);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 4096 || count !== opened.size) return "unknown";
    const raw = buffer.subarray(0, count).toString("utf8");
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return "unknown";
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return "unknown";
    const marker = value as Record<string, unknown>;
    if (!Number.isSafeInteger(marker.pid) || Number(marker.pid) <= 0 || typeof marker.phase !== "string") return "unknown";
    if (["installed", "failed", "refused"].includes(marker.phase)) return "free";
    if (!["preflight", "mutating", "overrun"].includes(marker.phase)) return "unknown";
    try { process.kill(Number(marker.pid), 0); return "active"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "free" : "unknown"; }
  } catch (error) { return !found && (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unknown"; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** False requires positive absence of an update across all three read-only observations. */
export function isUpdateInFlight(home: string, deps: InFlightDeps = { mutex: inspectUpdateSyncMutex, ownershipLease: inspectOwnershipLease, marker: inspectUpdateMarker }): boolean {
  try {
    const mutex = deps.mutex(home);
    if (mutex !== "free" && mutex !== "sync") return true;
    return deps.ownershipLease(home) !== "free" || deps.marker(home) !== "free";
  } catch { return true; }
}
