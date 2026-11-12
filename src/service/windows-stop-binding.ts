/**
 * Which processes the checked Windows stop may terminate (#7771, 030 "Binding rule").
 *
 * A process is bound, and only a bound process is ever terminated, when ALL hold:
 *
 * 1. its image is wscript.exe, cscript.exe or cmd.exe. The proxy child is observed for
 *    lineage only and is never a target;
 * 2. its command line carries this home's canonical launcher VBS or service script path
 *    as a complete token (commandLineHasPathToken);
 * 3. lineage: it is an ancestor of the identity-checked child, or a descendant of a bound
 *    wrapper (which covers "its parent is a bound wrapper"), or its parent is the Task
 *    Scheduler service host proven by the SCM PID, or, only while this home's task is
 *    registered, its parent is gone. A parent PID that is not in the table, or whose
 *    creation time is later than the wrapper's (a reused PID), counts as gone;
 * 4. a creation time was read for it.
 *
 * A wrapper that passes 1-2 but fails lineage (a launcher started by hand from a live
 * shell, an orphan while no task is registered) is reported as unbound and never touched.
 * A candidate whose evidence cannot be read is reported as unreadable, never skipped and
 * never killed: a matching wrapper without a creation time or image name, a matching
 * wrapper whose parent PID is unreadable while the task is registered, and a wrapper-image
 * process with no readable command line that descends from a bound wrapper or, while a
 * manager is registered, is an ancestor of the child.
 *
 * Pure: the caller supplies the snapshot and every fact; nothing here reads the machine.
 */
import { createHash } from "node:crypto";

import { commandLineHasPathToken } from "./windows-guarded-manager";
import type { WindowsStopProcessEntry } from "./windows-process-evidence";

const WRAPPER_IMAGES = new Set(["wscript.exe", "cscript.exe", "cmd.exe"]);
const DEPTH_LIMIT = 32;

export interface WindowsStopBindingContext {
  processes: readonly WindowsStopProcessEntry[];
  /** This home's canonical launcher VBS and service script paths. */
  canonicalPaths: readonly string[];
  /** The identity-checked proxy child (readPid), when there is one. */
  childPid: number | null;
  /** This home's OpenCodex Task Scheduler task is registered (enables "parent gone"). */
  taskRegistered: boolean;
  /** Any manager (task or WinSW) is registered: unreadable ancestors of the child count. */
  managerRegistered: boolean;
  /** PID of the Task Scheduler service host from the SCM; null disables that clause. */
  scheduleServicePid: number | null;
  /** The stopping process itself, never a candidate. */
  selfPid?: number;
}

/** What a later receipt records about one bound wrapper. The command line is only digested. */
export interface WindowsBoundWrapper {
  pid: number;
  startTime: number;
  image: string;
  parentPid: number | null;
  commandLineDigest: string;
}

export interface WindowsStopBinding {
  /** Terminate order: the deepest bound wrapper first (the looping cmd.exe before its launcher). */
  bound: WindowsBoundWrapper[];
  /** Match image and path but fail lineage. Never terminated; alive at the end = unbound-wrapper. */
  unbound: { pid: number; startTime: number | null }[];
  /** Candidates whose evidence cannot be read; any entry makes the stop unknown. */
  unreadable: number[];
  /** The child as observed in the snapshot, for lineage and a WinSW survival check. */
  child: { pid: number; startTime: number | null } | null;
}

/** The lowercased image name when it is one of the three wrapper images, else null. */
export function windowsWrapperImage(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  return WRAPPER_IMAGES.has(base) ? base : null;
}

function digest(commandLine: string): string {
  return createHash("sha256").update(commandLine, "utf8").digest("hex");
}

type ParentLink = WindowsStopProcessEntry | "gone" | "unreadable";

export function bindWindowsStopWrappers(context: WindowsStopBindingContext): WindowsStopBinding {
  const processes = context.processes.filter(entry => entry.pid !== context.selfPid);
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));

  const parentLink = (entry: WindowsStopProcessEntry): ParentLink => {
    if (entry.parentPid === null) return "unreadable";
    const parent = byPid.get(entry.parentPid);
    if (!parent) return "gone";
    if (entry.startTime !== null && parent.startTime !== null && parent.startTime > entry.startTime) return "gone";
    return parent;
  };
  const ancestors = (entry: WindowsStopProcessEntry): WindowsStopProcessEntry[] => {
    const chain: WindowsStopProcessEntry[] = [];
    const seen = new Set<number>([entry.pid]);
    let current = entry;
    for (let depth = 0; depth < DEPTH_LIMIT; depth += 1) {
      const link = parentLink(current);
      if (typeof link === "string" || seen.has(link.pid)) break;
      seen.add(link.pid);
      chain.push(link);
      current = link;
    }
    return chain;
  };

  const childEntry = context.childPid === null ? undefined : byPid.get(context.childPid);
  const childAncestors = new Set(childEntry ? ancestors(childEntry).map(entry => entry.pid) : []);
  const matchesPath = (entry: WindowsStopProcessEntry): boolean =>
    context.canonicalPaths.some(path => commandLineHasPathToken(entry.commandLine, path));

  const unreadable = new Set<number>();
  const candidates: WindowsStopProcessEntry[] = [];
  for (const entry of processes) {
    if (entry.pid === context.childPid || !matchesPath(entry)) continue;
    if (entry.name === null) unreadable.add(entry.pid);
    else if (windowsWrapperImage(entry.name)) candidates.push(entry);
  }

  const bound = new Set<number>();
  const descendsFromBound = (entry: WindowsStopProcessEntry): boolean =>
    ancestors(entry).some(ancestor => bound.has(ancestor.pid));
  const lineage = (entry: WindowsStopProcessEntry): boolean => {
    if (childAncestors.has(entry.pid) || descendsFromBound(entry)) return true;
    const link = parentLink(entry);
    if (link === "gone") return context.taskRegistered;
    if (link === "unreadable") return false;
    return context.scheduleServicePid !== null && link.pid === context.scheduleServicePid;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of candidates) {
      if (bound.has(entry.pid) || entry.startTime === null) continue;
      if (lineage(entry)) {
        bound.add(entry.pid);
        changed = true;
      }
    }
  }

  const unbound: WindowsStopBinding["unbound"] = [];
  for (const entry of candidates) {
    if (bound.has(entry.pid)) continue;
    if (entry.startTime === null) unreadable.add(entry.pid);
    else if (context.taskRegistered && parentLink(entry) === "unreadable") unreadable.add(entry.pid);
    else unbound.push({ pid: entry.pid, startTime: entry.startTime });
  }

  for (const entry of processes) {
    if (entry.pid === context.childPid || entry.commandLine?.trim() || !windowsWrapperImage(entry.name)) continue;
    if (descendsFromBound(entry) || (context.managerRegistered && childAncestors.has(entry.pid))) {
      unreadable.add(entry.pid);
    }
  }

  const boundEntries = candidates.filter(entry => bound.has(entry.pid));
  const depth = (entry: WindowsStopProcessEntry): number =>
    ancestors(entry).filter(ancestor => bound.has(ancestor.pid)).length;
  boundEntries.sort((a, b) => depth(b) - depth(a) || a.pid - b.pid);

  return {
    bound: boundEntries.map(entry => ({
      pid: entry.pid,
      startTime: entry.startTime!,
      image: windowsWrapperImage(entry.name)!,
      parentPid: entry.parentPid,
      commandLineDigest: digest(entry.commandLine ?? ""),
    })),
    unbound,
    unreadable: [...unreadable].sort((a, b) => a - b),
    child: childEntry ? { pid: childEntry.pid, startTime: childEntry.startTime } : null,
  };
}

/** Wrapper-image processes still carrying this home's paths (Part B's final enumeration). */
export function windowsHomeWrapperPids(
  processes: readonly WindowsStopProcessEntry[],
  canonicalPaths: readonly string[],
  selfPid?: number,
): number[] {
  return processes
    .filter(entry => entry.pid !== selfPid && windowsWrapperImage(entry.name)
      && canonicalPaths.some(path => commandLineHasPathToken(entry.commandLine, path)))
    .map(entry => entry.pid);
}
