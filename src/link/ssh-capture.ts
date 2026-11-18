/**
 * Opt-in SSH log capture for Remote Link tunnels (#7297).
 *
 * Authority: capture is on only while `<configDir>/link/ssh-capture/control.json` holds an unexpired
 * window. Only `ocx link capture start` on this machine writes that file; it is not a config key, so no
 * Home sync, management route or remote input can turn capture on. The runtime reads it at each
 * tunnel spawn and refuses a control file that is a symlink, not a regular file, or (on POSIX) not
 * owner-only and owned by this user.
 *
 * Lifetime: a window lasts SSH_CAPTURE_DEFAULT_MINUTES unless the operator asks for up to
 * SSH_CAPTURE_MAX_MINUTES; a window further away than that maximum reads as off. While a window is
 * open, the next ssh attempt of a Home (-R) or Child (-L) tunnel runs with LogLevel=DEBUG1; after
 * stop or expiry the next attempt is back at LogLevel=ERROR. A running attempt keeps its level, but
 * nothing it prints is stored once the window closed. Each window writes one capture file of at most
 * SSH_CAPTURE_FILE_MAX_BYTES; files are deleted SSH_CAPTURE_RETENTION_MS after their last write, and
 * at most SSH_CAPTURE_MAX_FILES are kept. Stop removes only the control file, so a capture the
 * operator still needs survives until its retention passes.
 *
 * Content: every stderr line goes through sanitizeSshLine (src/link/ssh-capture-redact.ts), an
 * allowlist of ssh line shapes; raw text never reaches disk.
 */
import { constants, lstatSync, mkdirSync, readdirSync, chmodSync, unlinkSync, type Stats } from "node:fs";
import { chmod, lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  hardenSecretDir, hardenSecretDirAsync, hardenSecretPath, hardenSecretPathAsync, reattributeHardenedSecretPath, windowsSecretAclApplies,
} from "../lib/windows-secret-acl";
import { LINK_ID_PATTERN } from "./ssh-argv";
import { sanitizeSshLine, type SanitizedSshLine } from "./ssh-capture-redact";

export const SSH_CAPTURE_DEFAULT_MINUTES = 15;
export const SSH_CAPTURE_MAX_MINUTES = 60;
export const SSH_CAPTURE_FILE_MAX_BYTES = 1024 * 1024;
export const SSH_CAPTURE_RETENTION_MS = 72 * 60 * 60_000;
export const SSH_CAPTURE_MAX_FILES = 4;
export const SSH_CAPTURE_LOG_LEVEL = "DEBUG1";

const CONTROL_FILE = "control.json";
const CAPTURE_FILE = /^ssh-(\d{13})\.jsonl$/;
const CONTROL_MAX_BYTES = 512;
const QUEUE_MAX = 512;
const TRUNCATION_RESERVE_BYTES = 128;
const TRUNCATION_EVENT = '"event":"capture_truncated"';
const PRUNE_INTERVAL_MS = 60_000;

export type SshCaptureTunnel = "home" | "child";

export interface SshCaptureControl {
  readonly version: 1;
  readonly startedAt: number;
  readonly expiresAt: number;
}

/** What one tunnel spawn gets while capture is on. */
export interface SshCaptureSpawn {
  readonly logLevel: typeof SSH_CAPTURE_LOG_LEVEL;
  /** Stores the line's sanitized form; returns whether the exit classifier reads the raw line. */
  stderrLine(line: string): boolean;
}

export type SshCaptureOpener = (tunnel: SshCaptureTunnel, linkId: string) => SshCaptureSpawn | null;

export interface SshCaptureFileStatus {
  name: string;
  bytes: number;
  lastWriteAt: string;
  deleteAfter: string;
}

export interface SshCaptureStatus {
  enabled: boolean;
  logLevel: typeof SSH_CAPTURE_LOG_LEVEL | "ERROR";
  startedAt: string | null;
  expiresAt: string | null;
  directory: string;
  retentionHours: number;
  maxMinutes: number;
  maxFileBytes: number;
  files: SshCaptureFileStatus[];
  /** Capture files this call deleted: retention, or the oldest beyond SSH_CAPTURE_MAX_FILES at start. */
  removed: number;
}

export class SshCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshCaptureError";
  }
}

export function sshCaptureDir(linkDirectory: string): string {
  return join(linkDirectory, "ssh-capture");
}

function captureFileName(startedAt: number): string {
  return "ssh-" + startedAt + ".jsonl";
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) { if (isMissing(error)) return null; throw error; }
}

function isSafeEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000;
}

/** Owner-only and owned by this user on POSIX; Windows relies on the private ACL the writers apply. */
function privateEnough(stat: Stats, mask: number): boolean {
  if (process.platform === "win32") return true;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (stat.mode & mask) === 0 && (uid === undefined || stat.uid === uid);
}

/** The control window if one is open now, else null. Never throws for a damaged or foreign file. */
export function readSshCaptureControl(dir: string, now: number): SshCaptureControl | null {
  try {
    const directory = lstatOrNull(dir);
    if (!directory || !directory.isDirectory() || directory.isSymbolicLink() || !privateEnough(directory, 0o077)) return null;
    const path = join(dir, CONTROL_FILE);
    const entry = lstatOrNull(path);
    if (!entry || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || !privateEnough(entry, 0o077)) return null;
    const raw: unknown = JSON.parse(readBoundedRegularFileSync(path, CONTROL_MAX_BYTES).toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const body = raw as Record<string, unknown>;
    const keys = Object.keys(body).sort().join(",");
    if (keys !== "expiresAt,startedAt,version" || body.version !== 1 || !isSafeEpoch(body.startedAt) || !isSafeEpoch(body.expiresAt)) return null;
    // A window further out than the hard maximum (a wrong clock or a hand edit) reads as off.
    if (body.expiresAt <= body.startedAt || now >= body.expiresAt || body.expiresAt - now > SSH_CAPTURE_MAX_MINUTES * 60_000) return null;
    return { version: 1, startedAt: body.startedAt, expiresAt: body.expiresAt };
  } catch {
    return null;
  }
}

function listCaptureFiles(dir: string): Array<{ name: string; startedAt: number; bytes: number; mtimeMs: number }> {
  let names: string[];
  try { names = readdirSync(dir); } catch (error) { if (isMissing(error)) return []; throw error; }
  const files: Array<{ name: string; startedAt: number; bytes: number; mtimeMs: number }> = [];
  for (const name of names) {
    const match = CAPTURE_FILE.exec(name);
    if (!match) continue;
    const stat = lstatOrNull(join(dir, name));
    // Never follow or count anything but a plain single-link file.
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
    files.push({ name, startedAt: Number(match[1]), bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files.sort((left, right) => left.startedAt - right.startedAt);
}

/**
 * Delete capture files whose last write is older than the retention period, and an expired control
 * file. Returns the number of capture files removed. Never follows a link.
 */
export function pruneSshCapture(dir: string, now: number): number {
  const directory = lstatOrNull(dir);
  if (!directory || !directory.isDirectory() || directory.isSymbolicLink()) return 0;
  let removed = 0;
  for (const file of listCaptureFiles(dir)) {
    if (now - file.mtimeMs < SSH_CAPTURE_RETENTION_MS) continue;
    try { unlinkSync(join(dir, file.name)); removed += 1; } catch (error) { if (!isMissing(error)) throw error; }
  }
  const control = lstatOrNull(join(dir, CONTROL_FILE));
  if (control && control.isFile() && !control.isSymbolicLink() && readSshCaptureControl(dir, now) === null) {
    try { unlinkSync(join(dir, CONTROL_FILE)); } catch (error) { if (!isMissing(error)) throw error; }
  }
  return removed;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function sshCaptureStatus(linkDirectory: string, now: number, removed = 0): SshCaptureStatus {
  const dir = sshCaptureDir(linkDirectory);
  const control = readSshCaptureControl(dir, now);
  return {
    enabled: control !== null,
    logLevel: control ? SSH_CAPTURE_LOG_LEVEL : "ERROR",
    startedAt: control ? iso(control.startedAt) : null,
    expiresAt: control ? iso(control.expiresAt) : null,
    directory: dir,
    retentionHours: SSH_CAPTURE_RETENTION_MS / 3_600_000,
    maxMinutes: SSH_CAPTURE_MAX_MINUTES,
    maxFileBytes: SSH_CAPTURE_FILE_MAX_BYTES,
    files: listCaptureFiles(dir).map(file => ({
      name: file.name,
      bytes: file.bytes,
      lastWriteAt: iso(file.mtimeMs),
      deleteAfter: iso(file.mtimeMs + SSH_CAPTURE_RETENTION_MS),
    })),
    removed,
  };
}

/** Create the capture directory owner-only, refusing a symlink or a non-directory in its place. */
function ensurePrivateDir(linkDirectory: string): string {
  const dir = sshCaptureDir(linkDirectory);
  assertNotRealHomeUnderTest(dirname(linkDirectory));
  mkdirSync(linkDirectory, { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SshCaptureError("the SSH capture directory is not a plain directory; remove it and try again");
  if (windowsSecretAclApplies()) hardenSecretDir(dir, { required: true });
  else {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) throw new SshCaptureError("the SSH capture directory belongs to another user");
    chmodSync(dir, 0o700);
  }
  return dir;
}

export interface SshCaptureStartOptions {
  linkDirectory: string;
  now: number;
  minutes?: number;
}

/** Open or extend the capture window. Starting while a window is open keeps its capture file. */
export function startSshCapture(options: SshCaptureStartOptions): SshCaptureStatus {
  const minutes = options.minutes ?? SSH_CAPTURE_DEFAULT_MINUTES;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > SSH_CAPTURE_MAX_MINUTES) {
    throw new SshCaptureError("--minutes must be an integer from 1 to " + SSH_CAPTURE_MAX_MINUTES);
  }
  if (!isSafeEpoch(options.now)) throw new SshCaptureError("the system clock is not usable for an SSH capture window");
  const dir = ensurePrivateDir(options.linkDirectory);
  let removed = pruneSshCapture(dir, options.now);
  const startedAt = readSshCaptureControl(dir, options.now)?.startedAt ?? options.now;
  // Keep room for this window's file: the oldest files beyond the cap go first.
  const others = listCaptureFiles(dir).filter(file => file.startedAt !== startedAt);
  for (const file of others.slice(0, Math.max(0, others.length - (SSH_CAPTURE_MAX_FILES - 1)))) {
    try { unlinkSync(join(dir, file.name)); removed += 1; } catch (error) { if (!isMissing(error)) throw error; }
  }
  const control: SshCaptureControl = { version: 1, startedAt, expiresAt: options.now + minutes * 60_000 };
  const path = join(dir, CONTROL_FILE);
  atomicWriteFileNoFollow(path, JSON.stringify(control) + "\n");
  if (windowsSecretAclApplies()) hardenSecretPath(path, { required: true });
  else chmodSync(path, 0o600);
  return sshCaptureStatus(options.linkDirectory, options.now, removed);
}

/** Close the window now. Capture files stay until their retention passes. */
export function stopSshCapture(linkDirectory: string, now: number): SshCaptureStatus {
  const dir = sshCaptureDir(linkDirectory);
  const directory = lstatOrNull(dir);
  if (directory && directory.isDirectory() && !directory.isSymbolicLink()) {
    // unlink never follows: a planted link is removed itself, its target untouched.
    try { unlinkSync(join(dir, CONTROL_FILE)); } catch (error) { if (!isMissing(error)) throw error; }
  }
  return sshCaptureStatus(linkDirectory, now, pruneSshCapture(dir, now));
}

/** Apply retention and report. Deletes only capture files past retention and an expired control file. */
export function readSshCaptureStatus(linkDirectory: string, now: number): SshCaptureStatus {
  return sshCaptureStatus(linkDirectory, now, pruneSshCapture(sshCaptureDir(linkDirectory), now));
}

type CaptureRecord = {
  at: number;
  tunnel: SshCaptureTunnel;
  linkId?: string;
  level?: SanitizedSshLine["level"];
  event: string;
  text?: string;
  count?: number;
  dropped?: number;
};

type AppendResult = "written" | "full" | "refused";

/** Append to a capture file through a private no-follow handle, never past the per-file cap. */
async function appendCapture(dir: string, name: string, lines: readonly string[], truncatedLine: string): Promise<AppendResult> {
  assertNotRealHomeUnderTest(dirname(dirname(dir)));
  // The writer never creates the directory: only an explicit start does.
  const directory = await lstat(dir).catch(() => null);
  if (!directory || !directory.isDirectory() || directory.isSymbolicLink()) return "refused";
  const windows = windowsSecretAclApplies();
  if (windows) await hardenSecretDirAsync(dir, { required: true });
  else await chmod(dir, 0o700);
  const path = join(dir, name);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags = constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    file = await open(path, flags, 0o600);
    const current = await file.stat();
    if (!current.isFile() || current.nlink !== 1) return "refused";
    if (windows) await hardenSecretPathAsync(path, { required: true });
    else await file.chmod(0o600);
    // A marker ends the file for every process, not only the one that wrote it.
    if (current.size > 0) {
      const length = Math.min(current.size, TRUNCATION_RESERVE_BYTES);
      const tail = Buffer.alloc(length);
      await file.read(tail, 0, length, current.size - length);
      if (tail.toString("utf8").includes(TRUNCATION_EVENT)) return "full";
    }
    if (current.size >= SSH_CAPTURE_FILE_MAX_BYTES - TRUNCATION_RESERVE_BYTES) {
      // Reached without a marker (lines that filled it exactly): end it with the one marker that fits.
      if (current.size + Buffer.byteLength(truncatedLine) <= SSH_CAPTURE_FILE_MAX_BYTES) await file.write(truncatedLine);
      return "full";
    }
    let size = current.size;
    let data = "";
    let full = false;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line);
      if (size + bytes > SSH_CAPTURE_FILE_MAX_BYTES - TRUNCATION_RESERVE_BYTES) { full = true; break; }
      data += line;
      size += bytes;
    }
    if (full) data += truncatedLine;
    if (data) await file.write(data);
    if (windows) {
      const written = await file.stat({ bigint: true });
      const named = await lstat(path, { bigint: true });
      if (!named.isSymbolicLink() && named.dev === written.dev && named.ino === written.ino) {
        await file.close();
        file = undefined;
        reattributeHardenedSecretPath(path);
      }
    }
    return full ? "full" : "written";
  } finally {
    await file?.close();
  }
}

export interface SshCaptureOpenerOptions {
  linkDirectory: string;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface SshCaptureOpenerWithFlush extends SshCaptureOpener {
  /** Wait for queued records; tests and shutdown only. */
  flush(): Promise<void>;
  /** Apply retention now and arm deletion for the earliest remaining file; runs at process start. */
  retain(): void;
}

/**
 * The per-directory opener the Home supervisor and the Child tunnel call at each spawn. With no
 * capture directory it costs one lstat and returns null; nothing else runs and nothing is written.
 */
export function createSshCaptureOpener(options: SshCaptureOpenerOptions): SshCaptureOpenerWithFlush {
  const dir = sshCaptureDir(options.linkDirectory);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
  const queue: Array<{ startedAt: number; record: CaptureRecord }> = [];
  const fullSessions = new Set<number>();
  let dropped = 0;
  let flight: Promise<void> | undefined;
  let lastPrune = Number.NEGATIVE_INFINITY;
  let retentionTimer: ReturnType<typeof setTimeout> | undefined;

  // Retention must not depend on the process that wrote a file staying alive: every prune, in any
  // process, re-arms one unref'd timer for the earliest remaining file's expiry (#7297).
  const prune = (): void => {
    let earliest = Number.POSITIVE_INFINITY;
    try {
      pruneSshCapture(dir, now());
      for (const file of listCaptureFiles(dir)) earliest = Math.min(earliest, file.mtimeMs);
    } catch { /* Retention runs again at the next spawn, command or process start. */ }
    if (retentionTimer !== undefined) { clearTimer(retentionTimer); retentionTimer = undefined; }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.max(0, Math.ceil(earliest + SSH_CAPTURE_RETENTION_MS - now())) + 1_000;
    retentionTimer = setTimer(() => { retentionTimer = undefined; prune(); }, Math.min(delay, SSH_CAPTURE_RETENTION_MS + 1_000));
    (retentionTimer as { unref?: () => void } | undefined)?.unref?.();
  };
  const armRetention = prune;

  const drain = async (): Promise<void> => {
    while (queue.length) {
      const batch = queue.splice(0, queue.length);
      const overflow = dropped;
      dropped = 0;
      const sessions = new Map<number, CaptureRecord[]>();
      for (const item of batch) sessions.set(item.startedAt, [...(sessions.get(item.startedAt) ?? []), item.record]);
      for (const [startedAt, records] of sessions) {
        try {
          // A stop or an expiry since the line was queued stores nothing more for that window.
          const control = readSshCaptureControl(dir, now());
          if (!control || control.startedAt !== startedAt || fullSessions.has(startedAt)) continue;
          if (overflow) records.push({ at: now(), tunnel: records[0]!.tunnel, event: "queue_overflow", dropped: overflow });
          const result = await appendCapture(dir, captureFileName(startedAt), records.map(record => JSON.stringify(record) + "\n"),
            JSON.stringify({ at: now(), event: "capture_truncated" }) + "\n");
          if (result === "full") fullSessions.add(startedAt);
          if (result !== "refused") armRetention();
        } catch { /* Best effort: capture never changes a tunnel. */ }
      }
    }
  };
  const startWriter = (): void => {
    if (flight) return;
    flight = drain().finally(() => {
      flight = undefined;
      if (queue.length) startWriter();
    });
  };

  const push = (control: SshCaptureControl, tunnel: SshCaptureTunnel, linkId: string, line: SanitizedSshLine): void => {
    const at = now();
    if (at >= control.expiresAt || fullSessions.has(control.startedAt)) return;
    const last = queue.at(-1);
    const id = LINK_ID_PATTERN.test(linkId) ? linkId : undefined;
    if (line.event === "unrecognized" && last && last.startedAt === control.startedAt && last.record.event === "unrecognized"
      && last.record.tunnel === tunnel && last.record.linkId === id) {
      last.record.count = (last.record.count ?? 1) + 1;
      return;
    }
    if (queue.length >= QUEUE_MAX) {
      // A flood of debug lines must not push out the line that explains a failure: an error-level
      // line takes the place of the oldest queued debug or verbose record, counted as dropped.
      const evict = line.level === "error" ? queue.findIndex(item => item.record.level !== "error") : -1;
      dropped += 1;
      if (evict === -1) return;
      queue.splice(evict, 1);
    }
    const record: CaptureRecord = { at, tunnel, ...(id ? { linkId: id } : {}), level: line.level, event: line.event,
      ...(line.text !== undefined ? { text: line.text } : {}) };
    queue.push({ startedAt: control.startedAt, record });
    startWriter();
  };

  const opener = ((tunnel: SshCaptureTunnel, linkId: string): SshCaptureSpawn | null => {
    const directory = lstatOrNull(dir);
    if (!directory) return null;
    const at = now();
    if (at - lastPrune >= PRUNE_INTERVAL_MS || at < lastPrune) { lastPrune = at; prune(); }
    const control = readSshCaptureControl(dir, at);
    if (!control) return null;
    // The window this spawn started in; an extension by a later `start` keeps the same startedAt and
    // moves expiresAt, so once the cached expiry passes it is re-read (at most once a second).
    let current = control;
    let lastRefresh = Number.NEGATIVE_INFINITY;
    const refresh = (): void => {
      const at = now();
      if (at < current.expiresAt || (at - lastRefresh < 1_000 && at >= lastRefresh)) return;
      lastRefresh = at;
      const fresh = readSshCaptureControl(dir, at);
      if (fresh && fresh.startedAt === current.startedAt) current = fresh;
    };
    return {
      logLevel: SSH_CAPTURE_LOG_LEVEL,
      stderrLine(line: string): boolean {
        const sanitized = sanitizeSshLine(line);
        try { refresh(); push(current, tunnel, linkId, sanitized); } catch { /* Storage never changes classification. */ }
        return sanitized.classify;
      },
    };
  }) as SshCaptureOpenerWithFlush;
  opener.flush = async () => { while (flight) await flight; };
  opener.retain = () => {
    if (!lstatOrNull(dir)) return;
    lastPrune = now();
    prune();
  };
  return opener;
}

const defaultOpeners = new Map<string, SshCaptureOpenerWithFlush>();

/** One opener (and one writer queue) per link directory for the life of the process. */
export function defaultSshCaptureOpener(linkDirectory: string): SshCaptureOpener {
  return defaultOpenerFor(linkDirectory);
}

function defaultOpenerFor(linkDirectory: string): SshCaptureOpenerWithFlush {
  let opener = defaultOpeners.get(linkDirectory);
  if (!opener) {
    opener = createSshCaptureOpener({ linkDirectory });
    defaultOpeners.set(linkDirectory, opener);
  }
  return opener;
}

/**
 * Apply retention at process start, before any tunnel spawns, so files a previous process wrote are
 * deleted on time even when this process never spawns a tunnel or writes a capture.
 */
export function retainSshCapture(linkDirectory: string): void {
  try { defaultOpenerFor(linkDirectory).retain(); } catch { /* Capture never blocks startup. */ }
}

/** Open capture for one spawn. Any failure means "off": capture can never stop a tunnel from starting. */
export function openSshCapture(opener: SshCaptureOpener, tunnel: SshCaptureTunnel, linkId: string): SshCaptureSpawn | null {
  try { return opener(tunnel, linkId); } catch { return null; }
}

