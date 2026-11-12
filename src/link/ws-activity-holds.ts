import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileStreamed, isMissingPathError, type AtomicWriteHooks } from "../config/atomic-write";
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

export type UnknownReason = "crash" | "unreadable" | "overflow" | "write-failed" | "key-rotated";

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
  /** Link ids in links.json, read when crash evidence must become unknown holds. */
  linkIds: () => readonly string[];
  now?: () => number;
  /** Test seam: atomic-write hooks, to inject a failure or a crash at a durability point. */
  writeHooks?: AtomicWriteHooks;
}

const FENCE = "ws-run-state.json";
const HOLDS = "activity-holds.json";
const KEY = "activity-ref-key";

function isLinkHolds(value: unknown): value is LinkHolds {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const reasons = [null, "crash", "unreadable", "overflow", "write-failed", "key-rotated"];
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

  const write = (name: string, value: unknown): boolean => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const content = JSON.stringify(value) + "\n";
      atomicWriteFileStreamed(join(dir, name), descriptor => { writeSync(descriptor, content); }, deps.writeHooks);
      if (process.platform !== "win32") chmodSync(join(dir, name), 0o600);
      return true;
    } catch { return false; }
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
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileStreamed(join(dir, KEY), descriptor => { writeSync(descriptor, fresh.toString("hex") + "\n"); }, deps.writeHooks);
    if (process.platform !== "win32") chmodSync(join(dir, KEY), 0o600);
    key = fresh;
    return key;
  };
  const keyId = (): string => createHmac("sha256", refKey()).update("opencodex-activity-key-id").digest("hex").slice(0, 16);

  const entry = (linkId: string): LinkHolds => {
    let value = links.get(linkId);
    if (!value) { value = { holds: [], unknown: null }; links.set(linkId, value); }
    return value;
  };

  const markAll = (reason: UnknownReason): void => {
    for (const linkId of deps.linkIds()) entry(linkId).unknown ??= reason;
  };

  const total = (): number => [...links.values()].reduce((sum, value) => sum + value.holds.length, 0);

  const persist = (): boolean => {
    const out: HoldsFile = { version: 1, keyId: key ? keyId() : null, links: {} };
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
      if (file) {
        const rotated = file.keyId !== null && file.keyId !== keyId();
        for (const [linkId, value] of Object.entries(file.links)) {
          const kept = rotated ? value.holds.filter(hold => hold.threadHash === null) : value.holds;
          links.set(linkId, { holds: kept.map(hold => ({ ...hold, pendingKeys: [...hold.pendingKeys] })),
            unknown: value.unknown ?? (rotated && kept.length < value.holds.length ? "key-rotated" : null) });
        }
      }
      if (state !== "clean") {
        markAll("crash");
        // The crash evidence is now a hold; only once that is durable may the fence say clean.
        if (persist()) write(FENCE, { version: 1, state: "clean" });
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
      return value ? value.holds.length + (value.unknown ? 1 : 0) : 0;
    },

    describe(linkId: string): { holds: number; unknown: UnknownReason | null } {
      const value = links.get(linkId);
      return { holds: value?.holds.length ?? 0, unknown: value?.unknown ?? null };
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

