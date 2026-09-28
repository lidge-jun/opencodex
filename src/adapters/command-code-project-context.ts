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

/** Keep filesystem metadata work off the request thread and inside one load deadline. */
async function withinDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("timeout");
  return withTimeout(operation(), remaining);
}

/** Fail-soft canonical path; no synchronous filesystem calls run on the request thread. */
async function canonicalPath(candidate: string, deadline: number): Promise<string | null> {
  try {
    await withinDeadline(() => lstat(candidate), deadline);
    return await withinDeadline(() => realpath(candidate), deadline);
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
  filePath: string, cwdCanonical: string, deadline: number, kind: "file" | "directory",
): Promise<string | null> {
  const canonical = await canonicalPath(filePath, deadline);
  if (!canonical || !isContainedCanonicalPath(cwdCanonical, canonical)) return null;
  try {
    const info = await withinDeadline(() => stat(canonical), deadline);
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
        timer = setTimeout(() => reject(new Error("timeout")), ms);
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
  handle: Awaited<ReturnType<typeof open>>, path: string, cwdCanonical: string, deadline: number,
): Promise<boolean> {
  const opened = await withinDeadline(() => handle.stat(), deadline);
  if (!opened.isFile()) return false;
  const current = await withinDeadline(() => lstat(path), deadline);
  if (!current.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) return false;
  const resolved = await withinDeadline(() => realpath(path), deadline);
  // The input path was canonical before open. A changed intermediate symlink changes this
  // result even though O_NOFOLLOW protects only the final component on macOS and Linux.
  if (!isContainedCanonicalPath(cwdCanonical, resolved)
    || normalizePathIdentity(resolved) !== normalizePathIdentity(path)) return false;
  const resolvedInfo = await withinDeadline(() => lstat(resolved), deadline);
  return resolvedInfo.isFile() && opened.dev === resolvedInfo.dev && opened.ino === resolvedInfo.ino;
}

async function readUtf8File(path: string, capBytes: number, deadline: number, cwdCanonical: string): Promise<string | null> {
  type FileHandle = Awaited<ReturnType<typeof open>>;
  let fileHandle: FileHandle | undefined;
  const closedHandles = new WeakSet<object>();
  if (beforeOpenForTests) {
    try {
      await withinDeadline(() => Promise.resolve(beforeOpenForTests!(path)), deadline);
    } catch {
      return null;
    }
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  // O_NONBLOCK prevents a race that swaps a checked regular file for a FIFO.
  // Windows lacks these POSIX open guards; post-open path/identity checks remain best-effort there.
  const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  const opened = open(path, flags);
  const closeBestEffort = (handle: FileHandle): Promise<void> => {
    if (closedHandles.has(handle)) return Promise.resolve();
    closedHandles.add(handle);
    return Promise.resolve()
      .then(() => handle.close())
      .catch(() => {
        /* closing a timed-out read is best-effort */
      });
  };

  const read = (async () => {
    const handle = await opened;
    fileHandle = handle;
    try {
      if (Date.now() >= deadline || !await openedFileIsConfined(handle, path, cwdCanonical, deadline)) return null;
      const data = Buffer.alloc(capBytes + 1);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      // Do not return bytes if an intermediate directory changed while the read was pending.
      if (!await openedFileIsConfined(handle, path, cwdCanonical, deadline)) return null;
      return data.subarray(0, bytesRead).toString("utf8");
    } finally {
      await closeBestEffort(handle);
      if (fileHandle === handle) fileHandle = undefined;
    }
  })();

  try {
    return await withTimeout(read, remaining);
  } catch {
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

async function readMemory(cwd: string, cwdCanonical: string, deadline: number): Promise<string> {
  const path = join(cwd, "AGENTS.md");
  const canonical = await confinedCanonicalPath(path, cwdCanonical, deadline, "file");
  if (!canonical) return "";
  const text = await readUtf8File(canonical, MEMORY_CAP_BYTES, deadline, cwdCanonical);
  if (text === null) return "";
  return truncateUtf8(text, MEMORY_CAP_BYTES);
}

async function readTaste(cwd: string, cwdCanonical: string, deadline: number): Promise<string | null> {
  const path = join(cwd, ".commandcode", "taste", "taste.md");
  const canonical = await confinedCanonicalPath(path, cwdCanonical, deadline, "file");
  if (!canonical) return null;
  const text = await readUtf8File(canonical, TASTE_CAP_BYTES, deadline, cwdCanonical);
  if (text === null) return null;
  return truncateUtf8(text, TASTE_CAP_BYTES);
}

interface SkillEntry {
  name: string;
  body: string;
  bytesRead: number;
}

async function listSkillDirs(skillRoot: string, cwdCanonical: string, scanBudget: number, deadline: number): Promise<string[]> {
  if (scanBudget <= 0) return [];
  const skillRootCanonical = await confinedCanonicalPath(skillRoot, cwdCanonical, deadline, "directory");
  if (!skillRootCanonical) return [];
  let dir: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    return await withinDeadline(
      async () => {
        const openedDir = await opendir(skillRootCanonical);
        dir = openedDir;
        if (Date.now() >= deadline) {
          void openedDir.close().catch(() => undefined);
          return [];
        }
        const names: string[] = [];
        let visitedEntries = 0;
        try {
          for await (const entry of openedDir) {
            if (Date.now() >= deadline) break;
            visitedEntries++;
            const atLimit = visitedEntries >= scanBudget;
            if (!entry.name.startsWith(".") && entry.isDirectory()) {
              const skillMd = join(skillRoot, entry.name, "SKILL.md");
              const skillMdCanonical = await confinedCanonicalPath(skillMd, cwdCanonical, deadline, "file");
              if (skillMdCanonical) {
                names.push(entry.name);
              }
            }
            if (atLimit) break;
          }
        } catch {
          try {
            void openedDir.close().catch(() => undefined);
          } catch {
            /* closing a failed iterator is best-effort */
          }
          /* directory iteration is best-effort */
        }
        names.sort();
        return names;
      },
      deadline,
    );
  } catch {
    if (dir) {
      try {
        void dir.close().catch(() => undefined);
      } catch {
        /* closing a timed-out iterator is best-effort */
      }
    }
    return [];
  }
}

async function readSkill(skillRoot: string, dirName: string, cwdCanonical: string, capBytes: number, deadline: number): Promise<SkillEntry | null> {
  const path = join(skillRoot, dirName, "SKILL.md");
  const canonical = await confinedCanonicalPath(path, cwdCanonical, deadline, "file");
  if (!canonical) return null;
  const text = await readUtf8File(canonical, capBytes, deadline, cwdCanonical);
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

async function readSkills(cwd: string, cwdCanonical: string, deadline: number): Promise<string | null> {
  const seen = new Set<string>();
  const collected: SkillEntry[] = [];
  let remainingBytes = SKILLS_READ_CAP_BYTES;

  for (const rootRel of SKILL_ROOTS) {
    const remainingScanMs = deadline - Date.now();
    if (remainingScanMs <= 0) break;
    const skillRoot = join(cwd, ...rootRel.split("/"));
    const dirs = await listSkillDirs(skillRoot, cwdCanonical, MAX_SKILL_DIRS_TO_SCAN, deadline);
    for (const dirName of dirs) {
      if (collected.length >= MAX_SKILLS || remainingBytes <= 1) break;
      const remainingReadMs = deadline - Date.now();
      if (remainingReadMs <= 0) break;
      const skill = await readSkill(skillRoot, dirName, cwdCanonical, Math.min(SKILL_FILE_CAP_BYTES, remainingBytes - 1), deadline);
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

async function collectProjectContext(cwd: string, timeoutMs: number): Promise<CommandCodeProjectContext> {
  const deadline = Date.now() + timeoutMs;
  const cwdCanonical = await canonicalPath(cwd, deadline);
  if (!cwdCanonical) return { ...EMPTY_COMMAND_CODE_PROJECT_CONTEXT };

  const [memory, taste, skills] = await Promise.all([
    readMemory(cwd, cwdCanonical, deadline),
    readTaste(cwd, cwdCanonical, deadline),
    readSkills(cwd, cwdCanonical, deadline),
  ]);

  return { memory, taste, skills };
}

export async function loadCommandCodeProjectContext(cwd: string | undefined): Promise<CommandCodeProjectContext> {
  if (!cwd) return { ...EMPTY_COMMAND_CODE_PROJECT_CONTEXT };

  const hadCachedEntry = projectContextCache.has(cwd);
  const cached = projectContextCache.get(cwd);
  if (cached && Date.now() - cached.collectedAt < PROJECT_CONTEXT_TTL_MS) {
    return cached.value;
  }

  const value = await collectProjectContext(cwd, fileOpTimeoutForTests ?? COMMAND_CODE_FILE_OP_TIMEOUT_MS);
  const now = Date.now();
  if (hadCachedEntry) {
    pruneExpiredProjectContextCache(now);
  } else {
    pruneProjectContextCache(now);
  }
  projectContextCache.set(cwd, { collectedAt: now, value });
  return value;
}
