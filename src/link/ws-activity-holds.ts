import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isMissingPathError } from "../config/atomic-write";
import { linkDir } from "./paths";

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

/** Why a hold keeps a link in flight (the operator's view, D8). */
export type HoldReason = "pending-results" | "running-turn" | "running-unknown" | "untracked" | "no-thread";

/** One hold as the operator sees it: reasons and counts only, no hash, key or id. */
export interface HoldSummary { since: number; reasons: HoldReason[]; pendingResults: number; runningTurns: number; runningUnknown: number }

export interface LinkHoldsSummary { holds: HoldSummary[]; unknown: UnknownReason | null }

export type ClearHoldsResult = { ok: true; cleared: LinkHoldsSummary | null } | { ok: false; reason: "write-failed" | "links-unreadable" };

export interface HoldInput {
  /** HMAC of the socket's own thread id; null when it had none (operator only). */
  threadHash: string | null;
  /** Hashed result keys the socket was waiting for (CodexWebSocketActivity). */
  pendingKeys: readonly string[];
  /** Running turns whose cut request could not be fingerprinted: unknown, operator only. */
  runningMarks: number;
  /** Running turns whose cut request was fingerprinted after expansion; each is released on its own. */
  marks?: readonly FingerprintMark[];
  untracked: boolean;
}

/** The cut request of a running turn: its expanded-input prefix length, HMAC, and turn reference. */
export interface FingerprintMark { n: number; inputHmac: string; turnRef: string }

/** A stored mark: its own random id, so a release removes exactly the marks a request saw, never an identical later one. */
export interface StoredMark extends FingerprintMark { id: string }

interface Hold {
  threadHash: string | null;
  pendingKeys: string[];
  runningMarks: number;
  marks: StoredMark[];
  untracked: boolean;
  createdAt: number;
  /** In memory only: creation order in this process, so a request settles only holds older than itself. */
  seq: number;
}

/** Canonical JSON: object keys sorted, no whitespace; throws for anything JSON cannot represent. */
function canonical(value: unknown): string {
  const seen = new Set<unknown>();
  const sort = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") { if (!Number.isFinite(input)) throw new Error("non-finite number"); return input; }
    if (typeof input !== "object") throw new Error("not representable");
    if (seen.has(input)) throw new Error("cycle");
    seen.add(input);
    const out = Array.isArray(input) ? input.map(sort)
      : Object.fromEntries(Object.keys(input as Record<string, unknown>).sort()
        .filter(key => (input as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, sort((input as Record<string, unknown>)[key])]));
    seen.delete(input);
    return out;
  };
  return JSON.stringify(sort(value));
}

const isMark = (value: unknown): value is StoredMark => {
  const mark = value as Record<string, unknown> | null;
  return !!mark && Number.isSafeInteger(mark.n) && (mark.n as number) > 0 && typeof mark.inputHmac === "string" && typeof mark.turnRef === "string"
    && typeof mark.id === "string" && mark.id.length > 0;
};

interface LinkHolds { holds: Hold[]; unknown: UnknownReason | null }

interface HoldsFile { version: 1; keyId: string | null; links: Record<string, LinkHolds> }

export interface ActivityHoldsDeps {
  /** Directory of the files; defaults to <configDir>/link. */
  dir?: string;
  /** Link ids in links.json, read when crash evidence must become unknown holds; null when unreadable. */
  linkIds: () => readonly string[] | null;
  now?: () => number;
  /**
   * Holds per link and in total before a link becomes unknown. Required: the owner of every link
   * WebSocket cap is src/server/index/link-websocket-limits.ts, and src/link may not import it.
   */
  limits: { holdsPerLink: number; holdsTotal: number };
  /** Test seam: inject a failure or a crash at each durability point of a write. */
  writeHooks?: HoldWriteHooks;
}

export interface HoldWriteHooks {
  /** Test seam: runs after the temporary file is opened, before its content is written. */
  afterOpen?: (temp: string) => void;
  beforeRename?: (temp: string, target: string) => void;
  afterRename?: (target: string) => void;
  /** Test seam: runs after the rename, where the directory fsync follows on Linux and macOS (every platform). */
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
      && typeof h.untracked === "boolean" && typeof h.createdAt === "number"
      && (h.marks === undefined || (Array.isArray(h.marks) && h.marks.every(isMark)));
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
  let holdSeq = 0;
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
    try {
      try { hooks.afterOpen?.(temp); writeSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    } catch (error) {
      // A failure before the rename must not leave the temporary file behind.
      try { unlinkSync(temp); } catch { /* reported through the original error */ }
      throw error;
    }
    try {
      hooks.beforeRename?.(temp, target);
      renameSync(temp, target);
    } catch (error) {
      try { unlinkSync(temp); } catch { /* reported through the original error */ }
      throw error;
    }
    hooks.afterRename?.(target);
    if (process.platform !== "win32") chmodSync(target, 0o600);
    // The seam sits at the post-rename durability point on every platform, so the callers' handling
    // of a rename that landed but is reported as not durable runs under test on Windows too.
    hooks.syncDir?.(dir);
    if (process.platform !== "win32") {
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

  /** Writes every link's holds; `without` leaves one link out (the operator's clear writes before it forgets). */
  const persist = (without?: string): boolean => {
    let id: string | null = null;
    try { id = key ? keyId() : null; } catch { return false; }
    const out: HoldsFile = { version: 1, keyId: id, links: {} };
    for (const [linkId, value] of links) {
      if (linkId !== without && (value.holds.length || value.unknown)) out.links[linkId] = { ...value, holds: value.holds.map(({ seq: _seq, ...hold }) => hold as Hold) };
    }
    return write(HOLDS, out);
  };

  /** A failed hold write keeps the holds in memory and makes the link unknown (fail closed). */
  const persistOrMark = (linkId: string): void => {
    if (!persist()) entry(linkId).unknown ??= "write-failed";
  };

  const finished = (hold: Hold): boolean =>
    hold.threadHash !== null && !hold.untracked && hold.runningMarks === 0 && hold.marks.length === 0 && hold.pendingKeys.length === 0;

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
          links.set(linkId, { holds: value.holds.filter(hold => hold.threadHash === null)
            .map(hold => ({ ...hold, pendingKeys: [...hold.pendingKeys], marks: [...(hold.marks ?? [])], seq: ++holdSeq })), unknown: value.unknown ?? "key-unavailable" });
        }
        markAll("key-unavailable");
        if (state !== "clean") markAll("crash");
        return;
      }
      if (file) {
        const rotated = file.keyId !== null && file.keyId !== keyId();
        for (const [linkId, value] of Object.entries(file.links)) {
          const kept = rotated ? value.holds.filter(hold => hold.threadHash === null) : value.holds;
          links.set(linkId, { holds: kept.map(hold => ({ ...hold, pendingKeys: [...hold.pendingKeys], marks: [...(hold.marks ?? [])], seq: ++holdSeq })),
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
      if (value.holds.length >= deps.limits.holdsPerLink || total() >= deps.limits.holdsTotal) {
        value.unknown ??= "overflow";
      } else {
        // Fingerprints need the thread to be matched by; without it they are operator-only, like unknown marks.
        const marks = input.threadHash === null ? [] : (input.marks ?? []).map(mark => ({ n: mark.n, inputHmac: mark.inputHmac, turnRef: mark.turnRef, id: randomBytes(12).toString("hex") }));
        const unknown = input.runningMarks + (input.threadHash === null ? input.marks?.length ?? 0 : 0);
        value.holds.push({ threadHash: input.threadHash, pendingKeys: [...input.pendingKeys], runningMarks: unknown, marks, untracked: input.untracked, createdAt: now(), seq: ++holdSeq });
      }
      persistOrMark(linkId);
    },

    /** The current hold sequence: a request records it when it begins and passes it to observe. */
    sequence(): number {
      return holdSeq;
    },

    /**
     * A later request from the same link and own thread returned these results. Only holds that existed
     * when the request began (seq at most beganAt) are settled: a hold created later, by another socket,
     * may wait for a new call that reuses the same id, and keeps it.
     */
    observe(linkId: string, threadHash: string | null, resultKeys: readonly string[], beganAt: number): void {
      const value = links.get(linkId);
      if (!value || threadHash === null || resultKeys.length === 0) return;
      const returned = new Set(resultKeys);
      let changed = false;
      for (const hold of value.holds) {
        if (hold.threadHash !== threadHash || hold.seq > beganAt) continue;
        const left = hold.pendingKeys.filter(keyHash => !returned.has(keyHash));
        if (left.length !== hold.pendingKeys.length) { hold.pendingKeys = left; changed = true; }
      }
      if (!changed) return;
      value.holds = value.holds.filter(hold => !finished(hold));
      persistOrMark(linkId);
    },

    /** HMAC of a turn's expanded input items (canonical JSON). Throws when they cannot be canonicalized. */
    inputHmac(items: readonly unknown[]): string {
      return createHmac("sha256", refKey()).update("opencodex-link-input-v1\0" + canonical(items)).digest("hex");
    },

    /** HMAC of Codex's own turn id (client_metadata.turn_id). */
    turnRef(turnId: string): string {
      return createHmac("sha256", refKey()).update("opencodex-link-turn-v1\0" + turnId).digest("hex");
    },

    /**
     * Request-log refs (design 9.1): a domain of their own per kind, so they never join with hold hashes or marks,
     * and the link id inside, so one id gives unrelated refs on two links (the metrics join rows of one link only).
     */
    logRef(kind: "thread" | "turn", linkId: string, id: string): string {
      return createHmac("sha256", refKey()).update("opencodex-link-log-" + kind + "-v2\0" + linkId + "\0" + id).digest("hex");
    },

    /** Whether any hold on this link has a fingerprinted running mark: callers skip hashing otherwise. */
    hasMarks(linkId: string): boolean {
      return links.get(linkId)?.holds.some(hold => hold.marks.length > 0) ?? false;
    },

    /** Fingerprinted marks a request of this own thread and turn could release. */
    markCandidates(linkId: string, threadHash: string, turnRef: string): StoredMark[] {
      return (links.get(linkId)?.holds ?? []).filter(hold => hold.threadHash === threadHash)
        .flatMap(hold => hold.marks.filter(mark => mark.turnRef === turnRef));
    },

    /** Rule (d): an upstream-completed inference request of the same thread and turn re-sent these, by id. */
    releaseMarks(linkId: string, threadHash: string, released: readonly StoredMark[]): void {
      const value = links.get(linkId);
      if (!value || released.length === 0) return;
      const ids = new Set(released.map(mark => mark.id));
      let changed = false;
      for (const hold of value.holds) {
        if (hold.threadHash !== threadHash) continue;
        const left = hold.marks.filter(mark => !ids.has(mark.id));
        if (left.length !== hold.marks.length) { hold.marks = left; changed = true; }
      }
      if (!changed) return;
      value.holds = value.holds.filter(hold => !finished(hold));
      persistOrMark(linkId);
    },

    /** Running marks on a link: fingerprinted and unknown (operator only). */
    markCounts(linkId: string): { fingerprinted: number; unknown: number } {
      const holds = links.get(linkId)?.holds ?? [];
      return { fingerprinted: holds.reduce((sum, hold) => sum + hold.marks.length, 0), unknown: holds.reduce((sum, hold) => sum + hold.runningMarks, 0) };
    },

    /** Whether a request on this link could release anything: callers skip parsing otherwise. */
    releasable(linkId: string): boolean {
      return links.get(linkId)?.holds.some(hold => hold.threadHash !== null && hold.pendingKeys.length > 0) ?? false;
    },

    /** The operator's view of one link (D8); null when nothing holds it. */
    summary(linkId: string): LinkHoldsSummary | null {
      const value = links.get(linkId);
      const unknown = value?.unknown ?? allUnknown;
      if (!value?.holds.length && !unknown) return null;
      return {
        holds: (value?.holds ?? []).map(hold => {
          const reasons: HoldReason[] = [];
          if (hold.pendingKeys.length) reasons.push("pending-results");
          if (hold.marks.length) reasons.push("running-turn");
          if (hold.runningMarks) reasons.push("running-unknown");
          if (hold.untracked) reasons.push("untracked");
          if (hold.threadHash === null) reasons.push("no-thread");
          return { since: hold.createdAt, reasons, pendingResults: hold.pendingKeys.length, runningTurns: hold.marks.length, runningUnknown: hold.runningMarks };
        }),
        unknown,
      };
    },

    /**
     * The operator's override (D8): forgets every hold and the unknown state of one link, durably. The
     * file is written without the link first; memory changes only once every write succeeded. An
     * all-links unknown state (links unreadable at start) is first written per link, which needs the
     * links to be listable; until then nothing is cleared.
     *
     * A failed write may already have replaced the file (a directory sync fails after the rename), so
     * the fence carries the uncertainty: in a process that has not armed it, the clear sets it running
     * first. The durable holds write is the commit point: if it fails, the fence stays running (the
     * next start keeps every link unknown) and nothing is cleared; once it succeeded, the clear is
     * committed and the fence is set clean. That clean write may fail before its rename (running: every
     * link unknown at the next start, fail closed) or after it (clean: the committed clear); neither
     * contradicts the answer. An armed process keeps the fence running until its graceful stop.
     */
    clear(linkId: string): ClearHoldsResult {
      const cleared = this.summary(linkId);
      if (!cleared) return { ok: true, cleared: null };
      if (allUnknown) {
        if (!markAll(allUnknown)) return { ok: false, reason: "links-unreadable" };
        allUnknown = null;
      }
      const fenced = !armed;
      if (fenced && !write(FENCE, { version: 1, state: "running" })) return { ok: false, reason: "write-failed" };
      if (!persist(linkId)) {
        // Best effort: put the link back on disk. The fence is running whatever this write does.
        persist();
        return { ok: false, reason: "write-failed" };
      }
      links.delete(linkId);
      // Committed. A failed clean write leaves the fence running at worst, which only widens the next start's unknown set.
      if (fenced) write(FENCE, { version: 1, state: "clean" });
      return { ok: true, cleared };
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
      // Unknown state that exists only in memory (links unreadable at start) is written per link once
      // the links can be listed; until then the fence is never cleaned.
      if (allUnknown && markAll(allUnknown)) allUnknown = null;
      if (!persist() || allUnknown) return false;
      return write(FENCE, { version: 1, state: "clean" });
    },
  };
}

export type ActivityHolds = ReturnType<typeof createActivityHolds>;

