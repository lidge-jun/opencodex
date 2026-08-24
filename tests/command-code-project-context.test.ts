import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fsPromises = await import("node:fs/promises");
const realOpendir = fsPromises.opendir;
const realOpen = fsPromises.open;
const opendirMock = mock(realOpendir);
const openMock = mock(realOpen);
mock.module("node:fs/promises", () => ({
  ...fsPromises,
  opendir: opendirMock,
  open: openMock,
}));

const {
  EMPTY_COMMAND_CODE_PROJECT_CONTEXT,
  loadCommandCodeProjectContext,
  projectContextCache,
  pruneProjectContextCache,
} = await import("../src/adapters/command-code-project-context");

const MAX_PROJECT_CONTEXT_CACHE_ENTRIES = 128;
const PROJECT_CONTEXT_TTL_MS = 30_000;

function makeTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function writeSkill(
  root: string,
  skillRoot: string,
  dirName: string,
  body: string,
  frontmatter?: string,
): void {
  const skillDir = join(root, skillRoot, dirName);
  mkdirSync(skillDir, { recursive: true });
  const content = frontmatter ? `---\n${frontmatter}\n---\n${body}` : body;
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf8");
}

beforeEach(() => {
  projectContextCache.clear();
});

afterEach(() => {
  projectContextCache.clear();
});

describe("loadCommandCodeProjectContext", () => {
  test("undefined cwd returns empty context", async () => {
    const result = await loadCommandCodeProjectContext(undefined);
    expect(result).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
  });

  test("missing files return empty memory, null taste, null skills", async () => {
    const root = makeTempDir("ocx-cc-ctx-empty-");
    try {
      const result = await loadCommandCodeProjectContext(root);
      expect(result).toEqual({ memory: "", taste: null, skills: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads memory, taste, and skills XML from fixture tree", async () => {
    const root = makeTempDir("ocx-cc-ctx-fixture-");
    try {
      writeFileSync(join(root, "AGENTS.md"), "project agents content", "utf8");
      mkdirSync(join(root, ".commandcode", "taste"), { recursive: true });
      writeFileSync(join(root, ".commandcode", "taste", "taste.md"), "taste prefs", "utf8");
      writeSkill(root, ".commandcode/skills", "yaml-skill", "yaml body", "name: YAML Named");
      writeSkill(root, ".commandcode/skills", "dir-fallback", "dir body");

      const result = await loadCommandCodeProjectContext(root);
      expect(result.memory).toBe("project agents content");
      expect(result.taste).toBe("taste prefs");
      expect(result.skills).toBe(
        '<skills>\n' +
          '  <skill name="dir-fallback">dir body</skill>\n' +
          '  <skill name="YAML Named">yaml body</skill>\n' +
          "</skills>",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("first-wins across skill roots by resolved name", async () => {
    const root = makeTempDir("ocx-cc-ctx-firstwins-");
    try {
      writeSkill(root, ".commandcode/skills", "shared", "from commandcode");
      writeSkill(root, ".agents/skills", "shared", "from agents");
      writeSkill(root, ".pi/skills", "shared", "from pi");
      writeSkill(root, ".agents/skills", "agents-only", "agents only body");
      writeSkill(root, ".pi/skills", "pi-only", "pi only body");

      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).toContain('<skill name="shared">from commandcode</skill>');
      expect(result.skills).not.toContain("from agents");
      expect(result.skills).not.toContain("from pi");
      expect(result.skills).toContain('<skill name="agents-only">agents only body</skill>');
      expect(result.skills).toContain('<skill name="pi-only">pi only body</skill>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips hidden skill dirs and entries without SKILL.md", async () => {
    const root = makeTempDir("ocx-cc-ctx-skip-");
    try {
      mkdirSync(join(root, ".commandcode", "skills", ".hidden"), { recursive: true });
      writeFileSync(join(root, ".commandcode", "skills", ".hidden", "SKILL.md"), "hidden", "utf8");
      mkdirSync(join(root, ".commandcode", "skills", "no-skill-md"), { recursive: true });
      writeFileSync(join(root, ".commandcode", "skills", "no-skill-md", "README.md"), "readme", "utf8");
      writeSkill(root, ".commandcode/skills", "visible", "visible body");

      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).toBe('<skills>\n  <skill name="visible">visible body</skill>\n</skills>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("times out a hanging skill directory iteration", async () => {
    const root = makeTempDir("ocx-cc-ctx-iteration-timeout-");
    const skillRoot = join(root, ".commandcode", "skills");
    mkdirSync(skillRoot, { recursive: true });
    let closeCalls = 0;
    const hangingDir = {
      close: async () => {
        closeCalls++;
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<never>(() => {}),
        };
      },
    };

    opendirMock.mockImplementation(async path => {
      if (String(path) === skillRoot) {
        return hangingDir as Awaited<ReturnType<typeof realOpendir>>;
      }
      return realOpendir(path);
    });

    try {
      const result = await Promise.race([
        loadCommandCodeProjectContext(root),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500)),
      ]);
      expect(result).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
      expect(closeCalls).toBe(1);
    } finally {
      opendirMock.mockImplementation(realOpendir);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("caps skills at 16 entries", async () => {
    const root = makeTempDir("ocx-cc-ctx-maxskills-");
    try {
      for (let i = 0; i < 17; i++) {
        writeSkill(root, ".commandcode/skills", `skill-${String(i).padStart(2, "0")}`, `body ${i}`);
      }

      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).not.toBeNull();
      const matches = result.skills!.match(/<skill /g);
      expect(matches?.length).toBe(16);
      expect(result.skills).toContain("body 0");
      expect(result.skills).not.toContain("body 16");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds skill directory enumeration to a finite scan cap", async () => {
    const root = makeTempDir("ocx-cc-ctx-skillbudget-");
    const skillRoot = join(root, ".commandcode", "skills");
    try {
      // 300 valid skill dirs — above MAX_SKILL_DIRS_TO_SCAN (256). Enumeration must
      // stop near the scan cap, not walk all 300 (each costs canonicalize + existsSync).
      for (let i = 0; i < 300; i++) {
        writeSkill(root, ".commandcode/skills", `skill-${String(i).padStart(3, "0")}`, `body ${i}`);
      }

      let entriesIterated = 0;
      opendirMock.mockImplementation(async path => {
        const dir = await realOpendir(path);
        if (String(path) !== skillRoot) return dir;
        const realIter = dir[Symbol.asyncIterator]();
        return {
          close: () => dir.close(),
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                const res = await realIter.next();
                if (!res.done) entriesIterated++;
                return res;
              },
            };
          },
        } as Awaited<ReturnType<typeof realOpendir>>;
      });

      const result = await loadCommandCodeProjectContext(root);
      const matches = result.skills!.match(/<skill /g);
      expect(matches?.length).toBe(16);
      // Without bounding, all 300 entries are iterated. With the scan cap,
      // iteration stops once 256 valid dirs are found.
      expect(entriesIterated).toBeLessThan(300);
      expect(entriesIterated).toBeLessThanOrEqual(256);
    } finally {
      opendirMock.mockImplementation(realOpendir);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncates oversize AGENTS.md with marker", async () => {
    const root = makeTempDir("ocx-cc-ctx-trunc-mem-");
    try {
      const payload = "x".repeat(32768 + 100);
      writeFileSync(join(root, "AGENTS.md"), payload, "utf8");

      const result = await loadCommandCodeProjectContext(root);
      expect(result.memory.endsWith("\n<!-- truncated -->")).toBe(true);
      expect(Buffer.byteLength(result.memory, "utf8")).toBeLessThanOrEqual(32768);
      expect(result.memory.startsWith("x".repeat(100))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds the file read to the memory cap plus one byte", async () => {
    const root = makeTempDir("ocx-cc-ctx-bounded-read-");
    const agentsPath = join(root, "AGENTS.md");
    let requestedLength = 0;
    try {
      writeFileSync(agentsPath, "x".repeat(4 * 1024 * 1024), "utf8");
      openMock.mockImplementation(async path => {
        const handle = await realOpen(path);
        if (String(path) !== agentsPath) return handle;
        const originalRead = handle.read.bind(handle);
        return {
          ...handle,
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            requestedLength = length;
            return originalRead(buffer, offset, length, position);
          },
          close: handle.close.bind(handle),
        } as Awaited<ReturnType<typeof realOpen>>;
      });

      const result = await loadCommandCodeProjectContext(root);

      expect(requestedLength).toBe(32_768 + 1);
      expect(Buffer.byteLength(result.memory, "utf8")).toBeLessThanOrEqual(32_768);
      expect(result.memory.endsWith("\n<!-- truncated -->")).toBe(true);
    } finally {
      openMock.mockImplementation(realOpen);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("times out and closes a hanging file read", async () => {
    const root = makeTempDir("ocx-cc-ctx-read-timeout-");
    const agentsPath = join(root, "AGENTS.md");
    let closeCalls = 0;
    const hangingFile = {
      read: () => new Promise<never>(() => {}),
      close: async () => {
        closeCalls++;
      },
    };
    openMock.mockImplementation(async path => {
      if (String(path) === agentsPath) {
        return hangingFile as Awaited<ReturnType<typeof realOpen>>;
      }
      return realOpen(path);
    });

    try {
      writeFileSync(agentsPath, "hanging", "utf8");
      const result = await Promise.race([
        loadCommandCodeProjectContext(root),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_500)),
      ]);

      expect(result).not.toBe("timeout");
      expect(result).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
      expect(closeCalls).toBe(1);
    } finally {
      openMock.mockImplementation(realOpen);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("omits symlink escape for AGENTS.md", async () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("ocx-cc-ctx-symlink-");
    try {
      const outside = makeTempDir("ocx-cc-ctx-outside-");
      try {
        writeFileSync(join(outside, "secret.txt"), "outside secret", "utf8");
        symlinkSync(join(outside, "secret.txt"), join(root, "AGENTS.md"));
        const result = await loadCommandCodeProjectContext(root);
        expect(result.memory).toBe("");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads the canonical file after confinement check", async () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("ocx-cc-ctx-toctou-");
    const outside = makeTempDir("ocx-cc-ctx-toctou-outside-");
    const agentsPath = join(root, "AGENTS.md");
    const insidePath = join(root, "agents-inside.md");
    const outsidePath = join(outside, "secret.txt");
    try {
      writeFileSync(insidePath, "inside content", "utf8");
      writeFileSync(outsidePath, "outside secret", "utf8");
      symlinkSync(insidePath, agentsPath);
      openMock.mockImplementation(async path => {
        if (String(path) === agentsPath) {
          unlinkSync(agentsPath);
          symlinkSync(outsidePath, agentsPath);
        }
        return realOpen(path);
      });

      const result = await loadCommandCodeProjectContext(root);

      expect(result.memory).toBe("inside content");
    } finally {
      openMock.mockImplementation(realOpen);
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("omits unreadable AGENTS.md when chmod is enforced", async () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("ocx-cc-ctx-unreadable-");
    try {
      const agentsPath = join(root, "AGENTS.md");
      writeFileSync(agentsPath, "secret", "utf8");
      chmodSync(agentsPath, 0o000);
      const canRead = (() => {
        try {
          readFileSync(agentsPath, "utf8");
          return true;
        } catch {
          return false;
        }
      })();
      if (!canRead) {
        const result = await loadCommandCodeProjectContext(root);
        expect(result.memory).toBe("");
      }
    } finally {
      try {
        chmodSync(join(root, "AGENTS.md"), 0o644);
      } catch {
        /* file may not exist */
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("escapes XML special characters in skill names and bodies", async () => {
    const root = makeTempDir("ocx-cc-ctx-xml-");
    try {
      writeSkill(
        root,
        ".commandcode/skills",
        "xml-skill",
        'body with & < > " chars',
        'name: Skill & "Quoted"',
      );

      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).toBe(
        '<skills>\n' +
          '  <skill name="Skill &amp; &quot;Quoted&quot;">body with &amp; &lt; &gt; &quot; chars</skill>\n' +
          "</skills>",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not treat a non-exact delimiter line as frontmatter closing", async () => {
    const root = makeTempDir("ocx-cc-ctx-frontmatter-marker-");
    try {
      writeSkill(root, ".commandcode/skills", "marker-skill", "");
      writeFileSync(
        join(root, ".commandcode", "skills", "marker-skill", "SKILL.md"),
        "---\nname: Marker\n---foo\nbody",
        "utf8",
      );

      const result = await loadCommandCodeProjectContext(root);

      expect(result.skills).toBe(
        '<skills>\n' +
          '  <skill name="marker-skill">---\nname: Marker\n---foo\nbody</skill>\n' +
          "</skills>",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves the body for empty frontmatter", async () => {
    const root = makeTempDir("ocx-cc-ctx-empty-frontmatter-");
    try {
      writeSkill(root, ".commandcode/skills", "empty-frontmatter", "");
      writeFileSync(
        join(root, ".commandcode", "skills", "empty-frontmatter", "SKILL.md"),
        "---\n---\nbody",
        "utf8",
      );

      const result = await loadCommandCodeProjectContext(root);

      expect(result.skills).toBe('<skills>\n  <skill name="empty-frontmatter">body</skill>\n</skills>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts CRLF YAML frontmatter delimiters", async () => {
    const root = makeTempDir("ocx-cc-ctx-crlf-");
    try {
      writeSkill(
        root,
        ".commandcode/skills",
        "crlf-skill",
        "crlf body",
      );
      writeFileSync(
        join(root, ".commandcode", "skills", "crlf-skill", "SKILL.md"),
        "---\r\nname: CRLF Named\r\n---\r\ncrlf body",
        "utf8",
      );

      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).toBe('<skills>\n  <skill name="CRLF Named">crlf body</skill>\n</skills>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fits XML-escaped repeated ampersands within the skills byte cap", async () => {
    const root = makeTempDir("ocx-cc-ctx-xml-cap-");
    try {
      writeSkill(root, ".commandcode/skills", "ampersands", "&".repeat(32_768));

      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).not.toBeNull();
      expect(Buffer.byteLength(result.skills!, "utf8")).toBeLessThanOrEqual(32_768);
      expect(result.skills).toContain("&amp;");
      expect(result.skills).toContain("&lt;!-- truncated --&gt;");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes expired entries before refreshing an existing cache key", async () => {
    const root = makeTempDir("ocx-cc-ctx-refresh-prune-");
    try {
      writeFileSync(join(root, "AGENTS.md"), "refreshed", "utf8");
      const now = Date.now();
      const emptyValue = { memory: "", taste: null, skills: null };
      projectContextCache.set("/expired", { collectedAt: now - PROJECT_CONTEXT_TTL_MS - 1, value: emptyValue });
      projectContextCache.set(root, { collectedAt: now - PROJECT_CONTEXT_TTL_MS - 1, value: emptyValue });

      const result = await loadCommandCodeProjectContext(root);
      expect(result.memory).toBe("refreshed");
      expect(projectContextCache.has("/expired")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty taste.md yields empty string not null", async () => {
    const root = makeTempDir("ocx-cc-ctx-empty-taste-");
    try {
      mkdirSync(join(root, ".commandcode", "taste"), { recursive: true });
      writeFileSync(join(root, ".commandcode", "taste", "taste.md"), "", "utf8");

      const result = await loadCommandCodeProjectContext(root);
      expect(result.taste).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cache hit within TTL returns same object without re-read", async () => {
    const root = makeTempDir("ocx-cc-ctx-cache-");
    try {
      writeFileSync(join(root, "AGENTS.md"), "version one", "utf8");
      const first = await loadCommandCodeProjectContext(root);
      writeFileSync(join(root, "AGENTS.md"), "version two", "utf8");
      const second = await loadCommandCodeProjectContext(root);
      expect(second).toBe(first);
      expect(second.memory).toBe("version one");

      const cached = projectContextCache.get(root);
      expect(cached).toBeDefined();
      cached!.collectedAt = Date.now() - PROJECT_CONTEXT_TTL_MS - 1;
      const third = await loadCommandCodeProjectContext(root);
      expect(third).not.toBe(first);
      expect(third.memory).toBe("version two");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("projectContextCache eviction", () => {
  const dummyValue = { memory: "", taste: null, skills: null };

  test("expired entries are evicted before capacity check", () => {
    const now = Date.now();
    projectContextCache.set("/old1", { collectedAt: now - 60_000, value: dummyValue });
    projectContextCache.set("/old2", { collectedAt: now - 45_000, value: dummyValue });
    projectContextCache.set("/fresh", { collectedAt: now - 1_000, value: dummyValue });

    pruneProjectContextCache(now);

    expect(projectContextCache.size).toBe(1);
    expect(projectContextCache.has("/fresh")).toBe(true);
    expect(projectContextCache.has("/old1")).toBe(false);
    expect(projectContextCache.has("/old2")).toBe(false);
  });

  test("oldest live entry is evicted when at capacity", () => {
    const now = Date.now();
    for (let i = 0; i < MAX_PROJECT_CONTEXT_CACHE_ENTRIES; i++) {
      projectContextCache.set(`/dir-${i}`, {
        collectedAt: now - (MAX_PROJECT_CONTEXT_CACHE_ENTRIES - i),
        value: dummyValue,
      });
    }

    pruneProjectContextCache(now);

    expect(projectContextCache.size).toBe(MAX_PROJECT_CONTEXT_CACHE_ENTRIES - 1);
    expect(projectContextCache.has("/dir-0")).toBe(false);
    expect(projectContextCache.has(`/dir-${MAX_PROJECT_CONTEXT_CACHE_ENTRIES - 1}`)).toBe(true);
  });

  test("cache never exceeds the cap when inserting via loader", async () => {
    const now = Date.now();
    const roots: string[] = [];
    try {
      for (let i = 0; i < MAX_PROJECT_CONTEXT_CACHE_ENTRIES + 10; i++) {
        const root = makeTempDir(`ocx-cc-ctx-cap-${i}-`);
        roots.push(root);
        writeFileSync(join(root, "AGENTS.md"), `agents ${i}`, "utf8");
        pruneProjectContextCache(now + i);
        await loadCommandCodeProjectContext(root);
      }
      expect(projectContextCache.size).toBeLessThanOrEqual(MAX_PROJECT_CONTEXT_CACHE_ENTRIES);
    } finally {
      for (const root of roots) {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("refreshing an expired cached key does not evict a live sibling at capacity", async () => {
    const root = makeTempDir("ocx-cc-ctx-refresh-capacity-");
    const now = Date.now();
    const emptyValue = { memory: "", taste: null, skills: null };
    let releaseFirstRead!: () => void;
    let releaseSecondRead!: () => void;
    let firstReadStarted!: () => void;
    let secondReadStarted!: () => void;
    const firstRead = new Promise<void>(resolve => { firstReadStarted = resolve; });
    const secondRead = new Promise<void>(resolve => { secondReadStarted = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirstRead = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecondRead = resolve; });
    let readCount = 0;

    for (let i = 0; i < MAX_PROJECT_CONTEXT_CACHE_ENTRIES - 1; i++) {
      projectContextCache.set(`/sibling-${i}`, { collectedAt: now, value: emptyValue });
    }
    projectContextCache.set(root, {
      collectedAt: now - PROJECT_CONTEXT_TTL_MS - 1,
      value: emptyValue,
    });
    writeFileSync(join(root, "AGENTS.md"), "refreshed", "utf8");
    openMock.mockImplementation(async path => {
      if (String(path) === join(root, "AGENTS.md")) {
        const handle = await realOpen(path);
        const originalRead = handle.read.bind(handle);
        return {
          ...handle,
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            readCount++;
            if (readCount === 1) {
              firstReadStarted();
              await firstGate;
            } else if (readCount === 2) {
              secondReadStarted();
              await secondGate;
            }
            return originalRead(buffer, offset, length, position);
          },
          close: handle.close.bind(handle),
        } as Awaited<ReturnType<typeof realOpen>>;
      }
      return realOpen(path);
    });

    try {
      const firstLoad = loadCommandCodeProjectContext(root);
      await firstRead;
      const secondLoad = loadCommandCodeProjectContext(root);
      await secondRead;

      releaseFirstRead();
      await firstLoad;
      releaseSecondRead();
      await secondLoad;

      expect(projectContextCache.size).toBe(MAX_PROJECT_CONTEXT_CACHE_ENTRIES);
      expect(projectContextCache.has("/sibling-0")).toBe(true);
      expect(projectContextCache.get(root)?.value.memory).toBe("refreshed");
    } finally {
      openMock.mockImplementation(realOpen);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
