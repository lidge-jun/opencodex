import { existsSync, realpathSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join, sep } from "node:path";

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
const MAX_SKILLS = 16;
// Upper bound on how many candidate skill directories one root may enumerate before
// stopping. Realistic projects have far fewer; this bounds pathological/hostile
// directories (millions of entries) to a finite scan while preserving alphabetical
// selection for any realistic case (≤ MAX_SKILL_DIRS_TO_SCAN valid dirs per root).
const MAX_SKILL_DIRS_TO_SCAN = 256;
const FILE_OP_TIMEOUT_MS = 2_000;
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

/** Fail-soft canonical path; returns null when the path does not exist or cannot be resolved. */
function canonicalPath(candidate: string): string | null {
  if (!existsSync(candidate)) return null;
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function normalizePathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function confinedCanonicalPath(filePath: string, cwdCanonical: string): string | null {
  const fileCanonical = canonicalPath(filePath);
  if (!fileCanonical) return null;
  const fileId = normalizePathIdentity(fileCanonical);
  const cwdId = normalizePathIdentity(cwdCanonical);
  if (fileId === cwdId || fileId.startsWith(cwdId + sep)) return fileCanonical;
  return null;
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

async function readUtf8File(path: string, capBytes: number): Promise<string | null> {
  type FileHandle = Awaited<ReturnType<typeof open>>;
  let fileHandle: FileHandle | undefined;
  const closedHandles = new WeakSet<object>();
  const opened = open(path, "r");
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
      const data = Buffer.alloc(capBytes + 1);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      return data.subarray(0, bytesRead).toString("utf8");
    } finally {
      await closeBestEffort(handle);
      if (fileHandle === handle) fileHandle = undefined;
    }
  })();

  try {
    return await withTimeout(read, FILE_OP_TIMEOUT_MS);
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

async function readMemory(cwd: string, cwdCanonical: string): Promise<string> {
  const path = join(cwd, "AGENTS.md");
  const canonical = confinedCanonicalPath(path, cwdCanonical);
  if (!canonical) return "";
  const text = await readUtf8File(canonical, MEMORY_CAP_BYTES);
  if (text === null) return "";
  return truncateUtf8(text, MEMORY_CAP_BYTES);
}

async function readTaste(cwd: string, cwdCanonical: string): Promise<string | null> {
  const path = join(cwd, ".commandcode", "taste", "taste.md");
  const canonical = confinedCanonicalPath(path, cwdCanonical);
  if (!canonical) return null;
  if (!existsSync(canonical)) return null;
  const text = await readUtf8File(canonical, TASTE_CAP_BYTES);
  if (text === null) return null;
  return truncateUtf8(text, TASTE_CAP_BYTES);
}

interface SkillEntry {
  name: string;
  body: string;
}

async function listSkillDirs(skillRoot: string, cwdCanonical: string, scanBudget: number): Promise<string[]> {
  if (scanBudget <= 0) return [];
  const skillRootCanonical = confinedCanonicalPath(skillRoot, cwdCanonical);
  if (!skillRootCanonical) return [];
  let dir: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    return await withTimeout(
      (async () => {
        const openedDir = await opendir(skillRootCanonical);
        dir = openedDir;
        const names: string[] = [];
        try {
          for await (const entry of openedDir) {
            if (entry.name.startsWith(".")) continue;
            if (!entry.isDirectory()) continue;
            const skillMd = join(skillRoot, entry.name, "SKILL.md");
            const skillMdCanonical = confinedCanonicalPath(skillMd, cwdCanonical);
            if (!skillMdCanonical) continue;
            if (!existsSync(skillMdCanonical)) continue;
            names.push(entry.name);
            if (names.length >= scanBudget) break;
          }
        } catch {
          try {
            await openedDir.close();
          } catch {
            /* closing a failed iterator is best-effort */
          }
          /* directory iteration is best-effort */
        }
        names.sort();
        return names;
      })(),
      FILE_OP_TIMEOUT_MS,
    );
  } catch {
    if (dir) {
      try {
        await dir.close();
      } catch {
        /* closing a timed-out iterator is best-effort */
      }
    }
    return [];
  }
}

async function readSkill(skillRoot: string, dirName: string, cwdCanonical: string): Promise<SkillEntry | null> {
  const path = join(skillRoot, dirName, "SKILL.md");
  const canonical = confinedCanonicalPath(path, cwdCanonical);
  if (!canonical) return null;
  const text = await readUtf8File(canonical, SKILLS_XML_CAP_BYTES);
  if (text === null) return null;
  const { name, body } = parseSkillFrontmatter(text);
  return { name: name ?? dirName, body };
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

async function readSkills(cwd: string, cwdCanonical: string): Promise<string | null> {
  const seen = new Set<string>();
  const collected: SkillEntry[] = [];

  for (const rootRel of SKILL_ROOTS) {
    const skillRoot = join(cwd, ...rootRel.split("/"));
    const dirs = await listSkillDirs(skillRoot, cwdCanonical, MAX_SKILL_DIRS_TO_SCAN);
    for (const dirName of dirs) {
      if (collected.length >= MAX_SKILLS) break;
      const skill = await readSkill(skillRoot, dirName, cwdCanonical);
      if (!skill) continue;
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      collected.push(skill);
    }
    if (collected.length >= MAX_SKILLS) break;
  }

  return buildSkillsXml(collected);
}

async function collectProjectContext(cwd: string): Promise<CommandCodeProjectContext> {
  const cwdCanonical = canonicalPath(cwd);
  if (!cwdCanonical) return { ...EMPTY_COMMAND_CODE_PROJECT_CONTEXT };

  const [memory, taste, skills] = await Promise.all([
    readMemory(cwd, cwdCanonical),
    readTaste(cwd, cwdCanonical),
    readSkills(cwd, cwdCanonical),
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

  const value = await collectProjectContext(cwd);
  const now = Date.now();
  if (hadCachedEntry) {
    pruneExpiredProjectContextCache(now);
  } else {
    pruneProjectContextCache(now);
  }
  projectContextCache.set(cwd, { collectedAt: now, value });
  return value;
}
