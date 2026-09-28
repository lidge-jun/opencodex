import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export type CommandCodeProjectContext = {
  memory: string;
  taste: string | null;
  skills: string | null;
};

export const EMPTY_COMMAND_CODE_PROJECT_CONTEXT: CommandCodeProjectContext = {
  memory: "",
  taste: null,
  skills: null,
};

const MEMORY_CAP_BYTES = 32_768;
const TASTE_CAP_BYTES = 8_192;
const SKILLS_XML_CAP_BYTES = 32_768;
const SKILL_FILE_CAP_BYTES = 8_192;
const SKILLS_READ_CAP_BYTES = 32_768;
const MAX_SKILLS = 16;
// Every visited entry, including hidden files and invalid directories, consumes this
// per-root scan budget. Selection remains separately capped by MAX_SKILLS.
const MAX_SKILL_DIRS_TO_SCAN = 256;
const COMMAND_CODE_FILE_OP_TIMEOUT_MS = 2_000;
let fileOpTimeoutForTests: number | undefined;
let beforeOpenForTests: ((path: string) => void | Promise<void>) | undefined;

/** Test seam for deterministic path replacement between confinement and open. */
export function setCommandCodeBeforeOpenForTests(hook: typeof beforeOpenForTests): void {
  beforeOpenForTests = hook;
}

export function setCommandCodeFileOpTimeoutForTests(timeoutMs: number | undefined): void {
  fileOpTimeoutForTests = timeoutMs;
}
const PROJECT_CONTEXT_TTL_MS = 30_000;
const MAX_PROJECT_CONTEXT_CACHE_ENTRIES = 128;
const MAX_CONCURRENT_PROJECT_CONTEXT_SCANS = 8;
const MAX_PENDING_PROJECT_CONTEXT_FILE_OPS = 64;
class ProjectContextTimeoutError extends Error {}
class ProjectContextAdmissionError extends Error {}
const projectContextInFlight = new Map<string, Promise<CommandCodeProjectContext>>();
type ScanScope = { cwd: string; pendingOps: number; finished: boolean; degraded: boolean };
const outstandingProjectContextScans = new Map<string, ScanScope>();
const pendingProjectContextFileOps = new Set<Promise<unknown>>();

/** Test-only observation of scan admission and abandoned filesystem work. */
export function commandCodeProjectContextWorkCountsForTests(): { inFlight: number; outstandingScans: number; pendingFileOps: number } {
  return {
    inFlight: projectContextInFlight.size,
    outstandingScans: outstandingProjectContextScans.size,
    pendingFileOps: pendingProjectContextFileOps.size,
  };
}

const TRUNCATION_MARKER = "\n<!-- truncated -->";

const SKILL_ROOTS = [
  ".commandcode/skills",
  ".agents/skills",
  ".pi/skills",
] as const;

export const projectContextCache = new Map<string, { collectedAt: number; value: CommandCodeProjectContext }>();

/**
 * Evict expired entries first, then the oldest live entry if at capacity.
 * Called before inserting a new key so the cache never exceeds the cap.
 */
function pruneExpiredProjectContextCache(now: number): void {
  for (const [key, entry] of projectContextCache) {
    if (now - entry.collectedAt >= PROJECT_CONTEXT_TTL_MS) {
      projectContextCache.delete(key);
    }
  }
}

export function pruneProjectContextCache(now: number): void {
  pruneExpiredProjectContextCache(now);
  if (projectContextCache.size >= MAX_PROJECT_CONTEXT_CACHE_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, entry] of projectContextCache) {
      if (entry.collectedAt < oldestAt) {
        oldestAt = entry.collectedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) projectContextCache.delete(oldestKey);
  }
}

/** A timed-out scan retains its cwd slot until every operation it dispatched settles. */
function releaseScanIfSettled(scope: ScanScope): void {
  if (scope.finished && scope.pendingOps === 0 && outstandingProjectContextScans.get(scope.cwd) === scope) {
    outstandingProjectContextScans.delete(scope.cwd);
  }
}

function trackedFileOperation<T>(operation: () => Promise<T>, scope: ScanScope, enforceLimit = true): Promise<T> {
  if (enforceLimit && pendingProjectContextFileOps.size >= MAX_PENDING_PROJECT_CONTEXT_FILE_OPS) {
    throw new ProjectContextAdmissionError("project context filesystem admission limit");
  }
  const pending = operation();
  scope.pendingOps++;
  pendingProjectContextFileOps.add(pending);
  const settle = (): void => {
    pendingProjectContextFileOps.delete(pending);
    scope.pendingOps--;
    releaseScanIfSettled(scope);
  };
  void pending.then(settle, settle);
  return pending;
}

/** Keep filesystem metadata work off the request thread and inside one load deadline. */
async function withinDeadline<T>(operation: () => Promise<T>, deadline: number, scope: ScanScope): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    scope.degraded = true;
    throw new ProjectContextTimeoutError("timeout");
  }
  try {
    return await withTimeout(trackedFileOperation(operation, scope), remaining);
  } catch (error) {
    if (error instanceof ProjectContextTimeoutError || error instanceof ProjectContextAdmissionError) scope.degraded = true;
    throw error;
  }
}

/** Fail-soft canonical path; no synchronous filesystem calls run on the request thread. */
async function canonicalPath(candidate: string, deadline: number, scope: ScanScope): Promise<string | null> {
  try {
    await withinDeadline(() => lstat(candidate), deadline, scope);
    return await withinDeadline(() => realpath(candidate), deadline, scope);
  } catch {
    return null;
  }
}

function normalizePathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/** Relative paths also work when cwd is a filesystem root; other volumes remain outside. */
export function isContainedCanonicalPath(cwdCanonical: string, fileCanonical: string): boolean {
  const rel = relative(normalizePathIdentity(cwdCanonical), normalizePathIdentity(fileCanonical));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function confinedCanonicalPath(
  filePath: string, cwdCanonical: string, deadline: number, kind: "file" | "directory", scope: ScanScope,
): Promise<string | null> {
  const canonical = await canonicalPath(filePath, deadline, scope);
  if (!canonical || !isContainedCanonicalPath(cwdCanonical, canonical)) return null;
  try {
    const info = await withinDeadline(() => stat(canonical), deadline, scope);
    return (kind === "file" ? info.isFile() : info.isDirectory()) ? canonical : null;
  } catch {
    return null;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProjectContextTimeoutError("timeout")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function truncateUtf8(text: string, capBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= capBytes) return text;
  const markerBuf = Buffer.from(TRUNCATION_MARKER, "utf8");
  const prefixCap = capBytes - markerBuf.length;
  if (prefixCap <= 0) return TRUNCATION_MARKER.slice(0, capBytes);
  let end = prefixCap;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + TRUNCATION_MARKER;
}

/** Match the opened inode to a still-canonical path inside cwd before publishing bytes. */
async function openedFileIsConfined(
  handle: Awaited<ReturnType<typeof open>>, path: string, cwdCanonical: string, deadline: number, scope: ScanScope,
): Promise<boolean> {
  const opened = await withinDeadline(() => handle.stat(), deadline, scope);
  if (!opened.isFile()) return false;
  const current = await withinDeadline(() => lstat(path), deadline, scope);
  if (!current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) return false;
  const resolved = await withinDeadline(() => realpath(path), deadline, scope);
  // The input path was canonical before open. A changed intermediate symlink changes this
  // result even though O_NOFOLLOW protects only the final component on macOS and Linux.
  if (!isContainedCanonicalPath(cwdCanonical, resolved)
    || normalizePathIdentity(resolved) !== normalizePathIdentity(path)) return false;
  const resolvedInfo = await withinDeadline(() => lstat(resolved), deadline, scope);
  return resolvedInfo.isFile() && opened.dev === resolvedInfo.dev && opened.ino === resolvedInfo.ino;
}

async function readUtf8File(path: string, capBytes: number, deadline: number, cwdCanonical: string, scope: ScanScope): Promise<string | null> {
  type FileHandle = Awaited<ReturnType<typeof open>>;
  let fileHandle: FileHandle | undefined;
  const closedHandles = new WeakSet<object>();
  if (beforeOpenForTests) {
    try {
      await withinDeadline(() => Promise.resolve(beforeOpenForTests!(path)), deadline, scope);
    } catch {
      return null;
    }
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    scope.degraded = true;
    return null;
  }
  // O_NONBLOCK prevents a race that swaps a checked regular file for a FIFO.
  // Windows lacks these POSIX open guards; post-open path/identity checks remain best-effort there.
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  let opened: ReturnType<typeof open>;
  try {
    opened = trackedFileOperation(() => open(path, flags), scope);
  } catch (error) {
    if (error instanceof ProjectContextAdmissionError) scope.degraded = true;
    return null;
  }
  const closeBestEffort = (handle: FileHandle): Promise<void> => {
    if (closedHandles.has(handle)) return Promise.resolve();
    closedHandles.add(handle);
    return Promise.resolve()
      .then(() => trackedFileOperation(() => handle.close(), scope, false))
      .catch(() => {
        /* closing a timed-out read is best-effort */
      });
  };

  let read: Promise<string | null>;
  try {
    read = trackedFileOperation(async () => {
      const handle = await opened;
      fileHandle = handle;
      try {
        if (Date.now() >= deadline || !await openedFileIsConfined(handle, path, cwdCanonical, deadline, scope)) return null;
        const data = Buffer.alloc(capBytes + 1);
        const { bytesRead } = await handle.read(data, 0, data.length, 0);
        // Do not return bytes if an intermediate directory changed while the read was pending.
        if (!await openedFileIsConfined(handle, path, cwdCanonical, deadline, scope)) return null;
        return data.subarray(0, bytesRead).toString("utf8");
      } finally {
        await closeBestEffort(handle);
        if (fileHandle === handle) fileHandle = undefined;
      }
    }, scope);
  } catch (error) {
    if (error instanceof ProjectContextAdmissionError) scope.degraded = true;
    void opened.then(handle => closeBestEffort(handle), () => undefined);
    return null;
  }

  try {
    return await withTimeout(read, remaining);
  } catch (error) {
    if (error instanceof ProjectContextTimeoutError || error instanceof ProjectContextAdmissionError) scope.degraded = true;
    if (fileHandle) void closeBestEffort(fileHandle);
    void opened.then(handle => closeBestEffort(handle), () => undefined);
    return null;
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseSkillFrontmatter(text: string): { name: string | null; body: string } {
  const opening = text.startsWith("---\r\n") ? "---\r\n" : text.startsWith("---\n") ? "---\n" : null;
  if (!opening) return { name: null, body: text };
  const closing = text.slice(opening.length).match(/^---(?:\r?\n|$)/m);
  if (!closing || closing.index === undefined) return { name: null, body: text };
  const end = opening.length + closing.index;
  const frontmatter = text.slice(opening.length, end).replace(/\r?\n$/, "");
  let name: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^name:\s*(.+)$/);
    if (match) {
      const parsed = match[1]!.trim();
      if (parsed.length > 0) name = parsed;
      break;
    }
  }
  const bodyStart = end + closing[0].length;
  const body = text.slice(bodyStart);
  return { name, body };
}

async function readMemory(cwd: string, cwdCanonical: string, deadline: number, scope: ScanScope): Promise<string> {
  const path = join(cwd, "AGENTS.md");
  const canonical = await confinedCanonicalPath(path, cwdCanonical, deadline, "file", scope);
  if (!canonical) return "";
  const text = await readUtf8File(canonical, MEMORY_CAP_BYTES, deadline, cwdCanonical, scope);
  if (text === null) return "";
  return truncateUtf8(text, MEMORY_CAP_BYTES);
}

async function readTaste(cwd: string, cwdCanonical: string, deadline: number, scope: ScanScope): Promise<string | null> {
  const path = join(cwd, ".commandcode", "taste", "taste.md");
  const canonical = await confinedCanonicalPath(path, cwdCanonical, deadline, "file", scope);
  if (!canonical) return null;
  const text = await readUtf8File(canonical, TASTE_CAP_BYTES, deadline, cwdCanonical, scope);
  if (text === null) return null;
  return truncateUtf8(text, TASTE_CAP_BYTES);
}

interface SkillEntry {
  name: string;
  body: string;
  bytesRead: number;
}

function closeSkillDirectoryBestEffort(dir: Awaited<ReturnType<typeof opendir>>, scope: ScanScope): void {
  try {
    void trackedFileOperation(() => dir.close(), scope, false).catch(() => undefined);
  } catch {
    /* a failed cleanup must not reject the request */
  }
}

async function listSkillDirs(skillRoot: string, cwdCanonical: string, scanBudget: number, deadline: number, scope: ScanScope): Promise<string[]> {
  if (scanBudget <= 0) return [];
  const skillRootCanonical = await confinedCanonicalPath(skillRoot, cwdCanonical, deadline, "directory", scope);
  if (!skillRootCanonical) return [];
  let dir: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    return await withinDeadline(
      async () => {
        const openedDir = await opendir(skillRootCanonical);
        dir = openedDir;
        if (Date.now() >= deadline) {
          closeSkillDirectoryBestEffort(openedDir, scope);
          return [];
        }
        const names: string[] = [];
        let visitedEntries = 0;
        try {
          for await (const entry of openedDir) {
            if (Date.now() >= deadline) break;
            visitedEntries++;
            const atLimit = visitedEntries >= scanBudget;
            if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) {
              const skillMd = join(skillRoot, entry.name, "SKILL.md");
              const skillMdCanonical = await confinedCanonicalPath(skillMd, cwdCanonical, deadline, "file", scope);
              if (skillMdCanonical) {
                names.push(entry.name);
              }
            }
            if (atLimit) break;
          }
        } catch {
          try {
            closeSkillDirectoryBestEffort(openedDir, scope);
          } catch {
            /* closing a failed iterator is best-effort */
          }
          /* directory iteration is best-effort */
        }
        names.sort();
        return names;
      },
      deadline,
      scope,
    );
  } catch {
    if (dir) {
      try {
        closeSkillDirectoryBestEffort(dir, scope);
      } catch {
        /* closing a timed-out iterator is best-effort */
      }
    }
    return [];
  }
}

async function readSkill(skillRoot: string, dirName: string, cwdCanonical: string, capBytes: number, deadline: number, scope: ScanScope): Promise<SkillEntry | null> {
  const path = join(skillRoot, dirName, "SKILL.md");
  const canonical = await confinedCanonicalPath(path, cwdCanonical, deadline, "file", scope);
  if (!canonical) return null;
  const text = await readUtf8File(canonical, capBytes, deadline, cwdCanonical, scope);
  if (text === null) return null;
  const { name, body } = parseSkillFrontmatter(truncateUtf8(text, capBytes));
  return { name: name ?? dirName, body, bytesRead: Buffer.byteLength(text, "utf8") };
}

function buildSkillsXml(skills: SkillEntry[]): string | null {
  if (skills.length === 0) return null;
  const lines = ["<skills>"];
  let usedBytes = Buffer.byteLength(lines[0]! + "\n</skills>", "utf8");

  for (const skill of skills) {
    const open = `  <skill name="${xmlEscape(skill.name)}">`;
    const close = "</skill>";
    let body = skill.body;
    let line = `${open}${xmlEscape(body)}${close}`;
    let lineBytes = Buffer.byteLength(line + "\n", "utf8");

    if (usedBytes + lineBytes > SKILLS_XML_CAP_BYTES) {
      const overhead = Buffer.byteLength(open + close + "\n", "utf8");
      const bodyBudget = SKILLS_XML_CAP_BYTES - usedBytes - overhead;
      if (bodyBudget <= 0) break;
      const fittedBody = truncateUtf8BodyForXml(body, bodyBudget);
      if (fittedBody === null) break;
      const wasTruncated = fittedBody !== body;
      body = fittedBody;
      line = `${open}${xmlEscape(body)}${close}`;
      lineBytes = Buffer.byteLength(line + "\n", "utf8");
      if (usedBytes + lineBytes > SKILLS_XML_CAP_BYTES) break;
      lines.push(line);
      usedBytes += lineBytes;
      if (wasTruncated) break;
      continue;
    }

    lines.push(line);
    usedBytes += lineBytes;
  }

  lines.push("</skills>");
  if (lines.length === 2) return null;
  return lines.join("\n");
}

function truncateUtf8BodyForXml(body: string, capBytes: number): string | null {
  const rawBuf = Buffer.from(body, "utf8");
  if (Buffer.byteLength(xmlEscape(body), "utf8") <= capBytes) return body;
  if (Buffer.byteLength(xmlEscape(TRUNCATION_MARKER), "utf8") > capBytes) return null;

  // XML entities can expand a raw body by several bytes per character. Binary-search the
  // largest UTF-8 prefix whose escaped form, including the marker, fits the actual wire cap.
  let low = 0;
  let high = rawBuf.length;
  let best = TRUNCATION_MARKER;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    let rawEnd = mid;
    while (rawEnd > 0 && (rawBuf[rawEnd]! & 0xc0) === 0x80) rawEnd--;
    const candidate = rawBuf.subarray(0, rawEnd).toString("utf8") + TRUNCATION_MARKER;
    if (Buffer.byteLength(xmlEscape(candidate), "utf8") <= capBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

async function readSkills(cwd: string, cwdCanonical: string, deadline: number, scope: ScanScope): Promise<string | null> {
  const seen = new Set<string>();
  const collected: SkillEntry[] = [];
  let remainingBytes = SKILLS_READ_CAP_BYTES;

  for (const rootRel of SKILL_ROOTS) {
    const remainingScanMs = deadline - Date.now();
    if (remainingScanMs <= 0) { scope.degraded = true; break; }
    const skillRoot = join(cwd, ...rootRel.split("/"));
    const dirs = await listSkillDirs(skillRoot, cwdCanonical, MAX_SKILL_DIRS_TO_SCAN, deadline, scope);
    for (const dirName of dirs) {
      if (collected.length >= MAX_SKILLS || remainingBytes <= 1) break;
      const remainingReadMs = deadline - Date.now();
      if (remainingReadMs <= 0) { scope.degraded = true; break; }
      const skill = await readSkill(skillRoot, dirName, cwdCanonical, Math.min(SKILL_FILE_CAP_BYTES, remainingBytes - 1), deadline, scope);
      if (!skill) continue;
      remainingBytes -= skill.bytesRead;
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      collected.push(skill);
    }
    if (collected.length >= MAX_SKILLS || remainingBytes <= 1) break;
  }

  return buildSkillsXml(collected);
}

async function collectProjectContext(cwd: string, timeoutMs: number, scope: ScanScope): Promise<CommandCodeProjectContext> {
  const deadline = Date.now() + timeoutMs;
  const cwdCanonical = await canonicalPath(cwd, deadline, scope);
  if (!cwdCanonical) return { ...EMPTY_COMMAND_CODE_PROJECT_CONTEXT };

  const [memory, taste, skills] = await Promise.all([
    readMemory(cwd, cwdCanonical, deadline, scope),
    readTaste(cwd, cwdCanonical, deadline, scope),
    readSkills(cwd, cwdCanonical, deadline, scope),
  ]);

  return { memory, taste, skills };
}

export async function loadCommandCodeProjectContext(cwd: string | undefined): Promise<CommandCodeProjectContext> {
  if (!cwd) return { ...EMPTY_COMMAND_CODE_PROJECT_CONTEXT };

  const cached = projectContextCache.get(cwd);
  if (cached && Date.now() - cached.collectedAt < PROJECT_CONTEXT_TTL_MS) return cached.value;
  const existing = projectContextInFlight.get(cwd);
  if (existing) return existing;
  // A stuck filesystem operation stays counted after its caller's timeout. Once the cap is
  // reached, fail soft without dispatching another scan or consuming another I/O worker.
  if (outstandingProjectContextScans.has(cwd)
    || outstandingProjectContextScans.size >= MAX_CONCURRENT_PROJECT_CONTEXT_SCANS
    || pendingProjectContextFileOps.size >= MAX_PENDING_PROJECT_CONTEXT_FILE_OPS) {
    return { ...EMPTY_COMMAND_CODE_PROJECT_CONTEXT };
  }
  const scope: ScanScope = { cwd, pendingOps: 0, finished: false, degraded: false };
  outstandingProjectContextScans.set(cwd, scope);
  const scan = (async () => {
    const value = await collectProjectContext(cwd, fileOpTimeoutForTests ?? COMMAND_CODE_FILE_OP_TIMEOUT_MS, scope);
    if (!scope.degraded) {
      const now = Date.now();
      pruneExpiredProjectContextCache(now);
      if (!projectContextCache.has(cwd)) pruneProjectContextCache(now);
      projectContextCache.set(cwd, { collectedAt: now, value });
    }
    return value;
  })();
  projectContextInFlight.set(cwd, scan);
  try {
    return await scan;
  } finally {
    if (projectContextInFlight.get(cwd) === scan) projectContextInFlight.delete(cwd);
    scope.finished = true;
    releaseScanIfSettled(scope);
  }
}
