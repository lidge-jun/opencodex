import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isMissingPathError } from "../config/atomic-write";
import { linkDir } from "./paths";
import { LINK_WS_LIMITS } from "../server/index/link-websocket-limits";

/**
 * Durable activity holds for Remote Link WebSockets (design T4 section 5).
 *
 * A link socket that closes while busy, for any reason except revocation, leaves a hold: the HMAC of
 * its own thread id, the hashed result keys it was waiting for, one running mark per turn that was
 * running, and whether its results were untracked. A hold counts as link activity, so the Home's own
 * automatic and activity-gated Child restarts withhold while it exists. It is a liveness aid against
 * that automation, not an authorization boundary against the Child's own processes.
 *
 * Crash fence: before the first link upgrade of a process is admitted, ws-run-state.json is written
 * durably as "running"; a graceful stop writes the holds, then "clean". A start that finds "running"
 * or an unreadable fence turns every link into an unknown hold, because work may have been in flight
 * when the process died. Nothing here reads or writes a file until a fence exists or is armed.
 */

export type UnknownReason = "crash" | "unreadable" | "overflow" | "write-failed" | "key-rotated" | "key-unavailable";

export interface HoldInput {
  /** HMAC of the socket's own thread id; null when it had none (operator only). */
  threadHash: string | null;
  /** Hashed result keys the socket was waiting for (CodexWebSocketActivity). */
  pendingKeys: readonly string[];
  /** Turns running at close. Until fingerprints are captured each is unknown (operator only). */
  runningMarks: number;
  untracked: boolean;
}

interface Hold {
  threadHash: string | null;
  pendingKeys: string[];
  runningMarks: number;
  untracked: boolean;
  createdAt: number;
}

interface LinkHolds { holds: Hold[]; unknown: UnknownReason | null }

interface HoldsFile { version: 1; keyId: string | null; links: Record<string, LinkHolds> }

export interface ActivityHoldsDeps {
  /** Directory of the files; defaults to <configDir>/link. */
  dir?: string;
  /** Link ids in links.json, read when crash evidence must become unknown holds; null when unreadable. */
  linkIds: () => readonly string[] | null;
  now?: () => number;
  /** Test seam: inject a failure or a crash at each durability point of a write. */
  writeHooks?: HoldWriteHooks;
}

export interface HoldWriteHooks {
  beforeRename?: (temp: string, target: string) => void;
  afterRename?: (target: string) => void;
  syncDir?: (dir: string) => void;
}

const FENCE = "ws-run-state.json";
const HOLDS = "activity-holds.json";
const KEY = "activity-ref-key";

function isLinkHolds(value: unknown): value is LinkHolds {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const reasons = [null, "crash", "unreadable", "overflow", "write-failed", "key-rotated", "key-unavailable"];
  return Array.isArray(entry.holds) && reasons.includes(entry.unknown as string | null) && entry.holds.every(hold => {
    const h = hold as Record<string, unknown>;
    return h && (h.threadHash === null || typeof h.threadHash === "string") && Array.isArray(h.pendingKeys)
      && h.pendingKeys.every(key => typeof key === "string") && Number.isSafeInteger(h.runningMarks) && (h.runningMarks as number) >= 0
      && typeof h.untracked === "boolean" && typeof h.createdAt === "number";
  });
}

export function createActivityHolds(deps: ActivityHoldsDeps) {
  const dir = deps.dir ?? linkDir();
  const now = deps.now ?? Date.now;
  const links = new Map<string, LinkHolds>();
  let armed = false;
  let key: Buffer | null = null;
  // Set when crash evidence could not be tied to the links (links.json unreadable): every link,
  // known or not, then counts as unknown, and the fence is left running for the next start.
  let allUnknown: UnknownReason | null = null;
  const hooks = deps.writeHooks ?? {};

  /**
   * Strict durable replace: a private temp file, content fsync, rename, then a directory fsync whose
   * failure is reported, because a fence or a hold that is not durable must not be treated as one.
   * Windows has no directory descriptor to sync; NTFS journals the rename itself.
   */
  const durableWrite = (name: string, content: string): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, name);
    const temp = target + "." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp";
    const descriptor = openSync(temp, "wx", 0o600);
    try { writeSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    try {
      hooks.beforeRename?.(temp, target);
      renameSync(temp, target);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* reported through the original error */ }
      throw error;
    }
    hooks.afterRename?.(target);
    if (process.platform !== "win32") {
      chmodSync(target, 0o600);
      hooks.syncDir?.(dir);
      const directory = openSync(dir, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  };

  const write = (name: string, value: unknown): boolean => {
    try { durableWrite(name, JSON.stringify(value) + "\n"); return true; } catch { return false; }
  };

  const readRaw = (name: string): { missing: true } | { missing: false; text: string | null } => {
    try { return { missing: false, text: readFileSync(join(dir, name), "utf8") }; }
    catch (error) { return isMissingPathError(error) ? { missing: true } : { missing: false, text: null }; }
  };

  /** The private reference key; created on first use. Its id travels in the holds file. */
  const refKey = (): Buffer => {
    if (key) return key;
    const existing = readRaw(KEY);
    if (!existing.missing && existing.text && /^[a-f0-9]{64}$/.test(existing.text.trim())) {
      key = Buffer.from(existing.text.trim(), "hex");
      return key;
    }
    const fresh = randomBytes(32);
    durableWrite(KEY, fresh.toString("hex") + "\n");
    key = fresh;
    return key;
  };
  const keyId = (): string => createHmac("sha256", refKey()).update("opencodex-activity-key-id").digest("hex").slice(0, 16);

  const entry = (linkId: string): LinkHolds => {
    let value = links.get(linkId);
    if (!value) { value = { holds: [], unknown: null }; links.set(linkId, value); }
    return value;
  };

  /** Marks every link unknown; false when the links could not be listed (allUnknown covers them). */
  const markAll = (reason: UnknownReason): boolean => {
    let ids: readonly string[] | null = null;
    try { ids = deps.linkIds(); } catch { ids = null; }
    if (!ids) { allUnknown ??= reason; return false; }
    for (const linkId of ids) entry(linkId).unknown ??= reason;
    return true;
  };

  const total = (): number => [...links.values()].reduce((sum, value) => sum + value.holds.length, 0);

  const persist = (): boolean => {
    let id: string | null = null;
    try { id = key ? keyId() : null; } catch { return false; }
    const out: HoldsFile = { version: 1, keyId: id, links: {} };
    for (const [linkId, value] of links) if (value.holds.length || value.unknown) out.links[linkId] = value;
    return write(HOLDS, out);
  };

  /** A failed hold write keeps the holds in memory and makes the link unknown (fail closed). */
  const persistOrMark = (linkId: string): void => {
    if (!persist()) entry(linkId).unknown ??= "write-failed";
  };

  const finished = (hold: Hold): boolean =>
    hold.threadHash !== null && !hold.untracked && hold.runningMarks === 0 && hold.pendingKeys.length === 0;

  return {
    /** At Home start. Reads only when a fence file exists. */
    start(): void {
      const fence = readRaw(FENCE);
      if (fence.missing) return;
      let state: unknown = null;
      try { state = fence.text === null ? null : (JSON.parse(fence.text) as { state?: unknown }).state; } catch { state = null; }
      const held = readRaw(HOLDS);
      let file: HoldsFile | null = null;
      if (!held.missing) {
        try {
          const parsed = JSON.parse(held.text ?? "") as HoldsFile;
          if (parsed?.version === 1 && parsed.links && typeof parsed.links === "object"
            && Object.values(parsed.links).every(isLinkHolds)) file = parsed;
        } catch { file = null; }
        if (!file) markAll("unreadable");
      }
      let keyUnavailable = false;
      if (file && file.keyId !== null) {
        try { keyId(); } catch { keyUnavailable = true; }
      }
      if (file && keyUnavailable) {
        // Hashes cannot be checked or made: keyed holds and every link stay unknown, nothing is cleaned.
        for (const [linkId, value] of Object.entries(file.links)) {
          links.set(linkId, { holds: value.holds.filter(hold => hold.threadHash === null), unknown: value.unknown ?? "key-unavailable" });
        }
        markAll("key-unavailable");
        if (state !== "clean") markAll("crash");
        return;
      }
      if (file) {
        const rotated = file.keyId !== null && file.keyId !== keyId();
        for (const [linkId, value] of Object.entries(file.links)) {
          const kept = rotated ? value.holds.filter(hold => hold.threadHash === null) : value.holds;
          links.set(linkId, { holds: kept.map(hold => ({ ...hold, pendingKeys: [...hold.pendingKeys] })),
            unknown: value.unknown ?? (rotated && kept.length < value.holds.length ? "key-rotated" : null) });
        }
      }
      if (state !== "clean") {
        // The crash evidence becomes holds; only once that is durable, for links that could be listed,
        // may the fence say clean. Otherwise it stays running and the next start does this again.
        if (markAll("crash") && persist()) write(FENCE, { version: 1, state: "clean" });
      }
    },

    /** Before the first link upgrade of this process. False refuses every link upgrade. */
    arm(): boolean {
      if (armed) return true;
      armed = write(FENCE, { version: 1, state: "running" });
      return armed;
    },

    get armed(): boolean { return armed; },

    threadHash(threadId: string): string {
      return createHmac("sha256", refKey()).update("opencodex-link-thread-v1\0" + threadId).digest("hex");
    },

    add(linkId: string, input: HoldInput): void {
      const value = entry(linkId);
      if (value.holds.length >= LINK_WS_LIMITS.holdsPerLink || total() >= LINK_WS_LIMITS.holdsTotal) {
        value.unknown ??= "overflow";
      } else {
        value.holds.push({ threadHash: input.threadHash, pendingKeys: [...input.pendingKeys], runningMarks: input.runningMarks, untracked: input.untracked, createdAt: now() });
      }
      persistOrMark(linkId);
    },

    /** A later request from the same link and own thread returned these results. */
    observe(linkId: string, threadHash: string | null, resultKeys: readonly string[]): void {
      const value = links.get(linkId);
      if (!value || threadHash === null || resultKeys.length === 0) return;
      const returned = new Set(resultKeys);
      let changed = false;
      for (const hold of value.holds) {
        if (hold.threadHash !== threadHash) continue;
        const left = hold.pendingKeys.filter(keyHash => !returned.has(keyHash));
        if (left.length !== hold.pendingKeys.length) { hold.pendingKeys = left; changed = true; }
      }
      if (!changed) return;
      value.holds = value.holds.filter(hold => !finished(hold));
      persistOrMark(linkId);
    },

    /** Whether a request on this link could release anything: callers skip parsing otherwise. */
    releasable(linkId: string): boolean {
      return links.get(linkId)?.holds.some(hold => hold.threadHash !== null && hold.pendingKeys.length > 0) ?? false;
    },

    /** The operator's override (D8). */
    clear(linkId: string): boolean {
      links.delete(linkId);
      return persist();
    },

    removeLink(linkId: string): void {
      if (links.delete(linkId)) persist();
    },

    /** Activity the restart gates see: one per hold, one more for an unknown link. */
    count(linkId: string): number {
      const value = links.get(linkId);
      return (value?.holds.length ?? 0) + (value?.unknown || allUnknown ? 1 : 0);
    },

    describe(linkId: string): { holds: number; unknown: UnknownReason | null } {
      const value = links.get(linkId);
      return { holds: value?.holds.length ?? 0, unknown: value?.unknown ?? allUnknown };
    },

    /** Graceful stop, after the link sockets closed: holds first, then clean. */
    stop(): boolean {
      if (!armed) return true;
      if (!persist()) return false;
      return write(FENCE, { version: 1, state: "clean" });
    },
  };
}

export type ActivityHolds = ReturnType<typeof createActivityHolds>;

