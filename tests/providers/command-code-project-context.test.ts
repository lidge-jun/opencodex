import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  type Stats,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";

const fsPromises = await import("node:fs/promises");
const realOpendir = fsPromises.opendir;
const realOpen = fsPromises.open;
const realLstat = fsPromises.lstat;
const realRealpath = fsPromises.realpath;
const lstatMock = mock(realLstat);
const realpathMock = mock(realRealpath);
const opendirMock = mock(realOpendir);
const openMock = mock(realOpen);
mock.module("node:fs/promises", () => ({
  ...fsPromises,
  opendir: opendirMock,
  open: openMock,
  lstat: lstatMock,
  realpath: realpathMock,
}));

const {
  EMPTY_COMMAND_CODE_PROJECT_CONTEXT,
  commandCodeProjectContextWorkCountsForTests,
  loadCommandCodeProjectContext,
  isContainedCanonicalPath,
  projectContextCache,
  pruneProjectContextCache,
  setCommandCodeFileOpTimeoutForTests,
  setCommandCodeBeforeOpenForTests,
} = await import("../../src/adapters/command-code-project-context");

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
  setCommandCodeFileOpTimeoutForTests(undefined);
});

afterEach(() => {
  lstatMock.mockImplementation(realLstat);
  realpathMock.mockImplementation(realRealpath);
  projectContextCache.clear();
  setCommandCodeFileOpTimeoutForTests(undefined);
  setCommandCodeBeforeOpenForTests(undefined);
});

describe("loadCommandCodeProjectContext", () => {
  test("undefined cwd returns empty context", async () => {
    const result = await loadCommandCodeProjectContext(undefined);
    expect(result).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
  });

  test("relative containment includes descendants of a filesystem root", () => {
    const fsRoot = parse(tmpdir()).root;
    expect(isContainedCanonicalPath(fsRoot, join(fsRoot, "AGENTS.md"))).toBe(true);
    const nested = join(fsRoot, "project");
    expect(isContainedCanonicalPath(nested, join(nested, "..hidden"))).toBe(true);
    expect(isContainedCanonicalPath(nested, join(fsRoot, "project-sibling", "SKILL.md"))).toBe(false);
  });

  test("stalled asynchronous path metadata obeys the overall deadline", async () => {
    const root = makeTempDir("ocx-cc-ctx-metadata-timeout-");
    const agentsPath = join(root, "AGENTS.md");
    try {
      writeFileSync(agentsPath, "private memory", "utf8");
      for (const stalled of ["lstat", "realpath"] as const) {
        projectContextCache.clear();
        let stalledCalls = 0;
        let releaseStalled: () => Promise<void> = async () => {};
        if (stalled === "lstat") {
          lstatMock.mockImplementation(path => {
            if (String(path) !== agentsPath) return realLstat(path);
            stalledCalls++;
            return new Promise<Stats>(resolve => {
              releaseStalled = async () => { resolve(await realLstat(path)); };
            });
          });
        } else {
          realpathMock.mockImplementation(path => {
            if (String(path) !== agentsPath) return realRealpath(path);
            stalledCalls++;
            return new Promise<string>(resolve => {
              releaseStalled = async () => { resolve(await realRealpath(path)); };
            });
          });
        }
        try {
          setCommandCodeFileOpTimeoutForTests(500);
          const result = await loadCommandCodeProjectContext(root);
          expect(stalledCalls).toBe(1);
          expect(result.memory).toBe("");
        } finally {
          lstatMock.mockImplementation(realLstat);
          realpathMock.mockImplementation(realRealpath);
          await releaseStalled();
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("concurrent cold-cache requests share one project scan", async () => {
    const root = makeTempDir("ocx-cc-ctx-single-flight-");
    const agentsPath = join(root, "AGENTS.md");
    let releaseRead: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    let openGates = 0;
    try {
      writeFileSync(agentsPath, "shared memory", "utf8");
      setCommandCodeBeforeOpenForTests(path => {
        if (path !== agentsPath) return;
        openGates++;
        markStarted();
        return gate;
      });
      const first = loadCommandCodeProjectContext(root);
      await started;
      const second = loadCommandCodeProjectContext(root);
      releaseRead();
      const [one, two] = await Promise.all([first, second]);
      expect(openGates).toBe(1);
      expect(one).toBe(two);
      expect(one.memory).toBe("shared memory");
    } finally {
      releaseRead();
      setCommandCodeBeforeOpenForTests(undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never-settling scans retain their cwd slots and cap work across keys", async () => {
    const roots = Array.from({ length: 12 }, () => makeTempDir("ocx-cc-ctx-abandoned-cap-"));
    const rootSet = new Set(roots);
    const release: Array<() => Promise<void>> = [];
    let lstatCalls = 0;
    try {
      lstatMock.mockImplementation(path => {
        if (!rootSet.has(String(path))) return realLstat(path);
        lstatCalls++;
        return new Promise<Stats>(resolve => {
          release.push(async () => { resolve(await realLstat(path)); });
        });
      });
      setCommandCodeFileOpTimeoutForTests(20);
      for (const root of roots) {
        expect(await loadCommandCodeProjectContext(root)).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
      }
      expect(lstatCalls).toBe(8);
      projectContextCache.delete(roots[0]!);
      expect(await loadCommandCodeProjectContext(roots[0])).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
      expect(lstatCalls).toBe(8);
    } finally {
      lstatMock.mockImplementation(realLstat);
      await Promise.all(release.map(settle => settle()));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(commandCodeProjectContextWorkCountsForTests()).toEqual({ inFlight: 0, outstandingScans: 0, pendingFileOps: 0 });
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a FIFO without attempting a blocking open", async () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("ocx-cc-ctx-fifo-");
    const fifo = join(root, "AGENTS.md");
    let openedFifo = false;
    try {
      execFileSync("mkfifo", [fifo]);
      openMock.mockImplementation(async (path, flags) => {
        if (String(path) === fifo) {
          openedFifo = true;
          throw new Error("FIFO must be rejected before open");
        }
        return realOpen(path, flags);
      });
      expect((await loadCommandCodeProjectContext(root)).memory).toBe("");
      expect(openedFifo).toBe(false);
    } finally {
      openMock.mockImplementation(realOpen);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads a skill directory symlink that resolves inside cwd", async () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("ocx-cc-ctx-internal-skill-link-");
    try {
      const skillRoot = join(root, ".commandcode", "skills");
      const target = join(root, "internal-skill-target");
      mkdirSync(skillRoot, { recursive: true });
      mkdirSync(target);
      writeFileSync(join(target, "SKILL.md"), "inside symlink body", "utf8");
      symlinkSync(target, join(skillRoot, "linked"), "dir");
      expect((await loadCommandCodeProjectContext(root)).skills)
        .toBe('<skills>\n  <skill name="linked">inside symlink body</skill>\n</skills>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a skill directory symlink that resolves outside cwd", async () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("ocx-cc-ctx-external-skill-link-");
    const outside = makeTempDir("ocx-cc-ctx-external-skill-target-");
    try {
      const skillRoot = join(root, ".commandcode", "skills");
      mkdirSync(skillRoot, { recursive: true });
      writeFileSync(join(outside, "SKILL.md"), "outside secret body", "utf8");
      symlinkSync(outside, join(skillRoot, "external"), "dir");
      expect((await loadCommandCodeProjectContext(root)).skills).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a timed-out scan is not cached and recovers after its operation settles", async () => {
    const root = makeTempDir("ocx-cc-ctx-transient-timeout-");
    const agentsPath = join(root, "AGENTS.md");
    let release: () => Promise<void> = async () => {};
    try {
      writeFileSync(agentsPath, "recovered memory", "utf8");
      lstatMock.mockImplementation(path => {
        if (String(path) !== agentsPath) return realLstat(path);
        return new Promise<Stats>(resolve => {
          release = async () => { resolve(await realLstat(path)); };
        });
      });
      setCommandCodeFileOpTimeoutForTests(100);
      expect((await loadCommandCodeProjectContext(root)).memory).toBe("");
      expect(projectContextCache.has(root)).toBe(false);
      lstatMock.mockImplementation(realLstat);
      await release();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(commandCodeProjectContextWorkCountsForTests()).toEqual({ inFlight: 0, outstandingScans: 0, pendingFileOps: 0 });
      expect((await loadCommandCodeProjectContext(root)).memory).toBe("recovered memory");
      expect(projectContextCache.has(root)).toBe(true);
    } finally {
      lstatMock.mockImplementation(realLstat);
      await release();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing files return empty memory, null taste, null skills", async () => {
    const root = makeTempDir("ocx-cc-ctx-empty-");
    try {
      const result = await loadCommandCodeProjectContext(root);
      expect(result).toEqual({ memory: "", taste: null, skills: null });
      expect(await loadCommandCodeProjectContext(root)).toBe(result);
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
      writeSkill(root, ".commandcode/skills", "shared-cc", "from commandcode", "name: shared");
      writeSkill(root, ".agents/skills", "shared-agents", "from agents", "name: shared");
      writeSkill(root, ".pi/skills", "shared-pi", "from pi", "name: shared");
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
    let releaseNext: () => void = () => {};
    const hangingDir = {
      close: async () => { closeCalls++; },
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<unknown>>(resolve => {
            releaseNext = () => resolve({ done: true, value: undefined });
          }),
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
      setCommandCodeFileOpTimeoutForTests(250);
      const result = await loadCommandCodeProjectContext(root);
      expect(result).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
      expect(closeCalls).toBe(1);
    } finally {
      opendirMock.mockImplementation(realOpendir);
      releaseNext();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(commandCodeProjectContextWorkCountsForTests()).toEqual({ inFlight: 0, outstandingScans: 0, pendingFileOps: 0 });
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
      // stop at the scan cap, not walk all 300 (each valid entry needs path checks).
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
      // iteration stops after 256 entries, independent of validity.
      expect(entriesIterated).toBeLessThan(300);
      expect(entriesIterated).toBeLessThanOrEqual(256);
    } finally {
      opendirMock.mockImplementation(realOpendir);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bounds mixed and nonmatching directory enumeration to the scan budget", async () => {
    const root = makeTempDir("ocx-cc-ctx-mixed-budget-");
    const skillRoot = join(root, ".commandcode", "skills");
    try {
      mkdirSync(skillRoot, { recursive: true });
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(skillRoot, `file-${String(i).padStart(3, "0")}.txt`), "data", "utf8");
        mkdirSync(join(skillRoot, `no-skill-${String(i).padStart(3, "0")}`));
        mkdirSync(join(skillRoot, `.hidden-${String(i).padStart(3, "0")}`));
      }

      let entriesIterated = 0;
      opendirMock.mockImplementation(async path => {
        const dir = await realOpendir(path);
        const originalIterator = dir[Symbol.asyncIterator].bind(dir);
        dir[Symbol.asyncIterator] = function () {
          const iter = originalIterator();
          return {
            async next() {
              const res = await iter.next();
              if (!res.done) entriesIterated++;
              return res;
            },
            async return() {
              return typeof iter.return === "function" ? iter.return() : { done: true, value: undefined };
            },
            [Symbol.asyncIterator]() {
              return this;
            },
          };
        };
        return dir;
      });

      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).toBeNull();
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
          stat: handle.stat.bind(handle),
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

  test("bounds each skill read and the total bytes read", async () => {
    const root = makeTempDir("ocx-cc-ctx-total-bytes-");
    let totalRead = 0;
    const skillReads: number[] = [];
    try {
      for (let i = 0; i < 8; i++) writeSkill(root, ".commandcode/skills", `large-${i}`, "x".repeat(20_000));
      openMock.mockImplementation(async path => {
        const handle = await realOpen(path);
        if (!String(path).endsWith("SKILL.md")) return handle;
        const originalRead = handle.read.bind(handle);
        return {
          ...handle,
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            const result = await originalRead(buffer, offset, length, position);
            skillReads.push(result.bytesRead);
            totalRead += result.bytesRead;
            return result;
          },
          stat: handle.stat.bind(handle),
          close: handle.close.bind(handle),
        } as Awaited<ReturnType<typeof realOpen>>;
      });
      const result = await loadCommandCodeProjectContext(root);
      expect(result.skills).not.toBeNull();
      expect(skillReads.length).toBeGreaterThan(1);
      expect(skillReads.length).toBeLessThan(8);
      expect(Math.max(...skillReads)).toBeLessThanOrEqual(8_193);
      expect(totalRead).toBeLessThanOrEqual(32_768);
      expect(Buffer.byteLength(result.skills!, "utf8")).toBeLessThanOrEqual(32_768);
    } finally {
      openMock.mockImplementation(realOpen);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("times out and closes a hanging file read", async () => {
    const root = makeTempDir("ocx-cc-ctx-read-timeout-");
    const agentsPath = join(root, "AGENTS.md");
    let closeCalls = 0;
    let releaseRead: () => void = () => {};
    const hangingFile = {
      stat: async () => statSync(agentsPath),
      read: () => new Promise<{ bytesRead: number; buffer: Buffer }>(resolve => {
        releaseRead = () => resolve({ bytesRead: 0, buffer: Buffer.alloc(0) });
      }),
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
      setCommandCodeFileOpTimeoutForTests(250);
      const result = await loadCommandCodeProjectContext(root);

      expect(result).not.toBe("timeout");
      expect(result).toEqual(EMPTY_COMMAND_CODE_PROJECT_CONTEXT);
      expect(closeCalls).toBe(1);
    } finally {
      openMock.mockImplementation(realOpen);
      releaseRead();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(commandCodeProjectContextWorkCountsForTests()).toEqual({ inFlight: 0, outstandingScans: 0, pendingFileOps: 0 });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the production file-operation timeout by default", async () => {
    const root = makeTempDir("ocx-cc-ctx-default-timeout-");
    try {
      writeFileSync(join(root, "AGENTS.md"), "memory", "utf8");
      expect((await loadCommandCodeProjectContext(root)).memory).toBe("memory");
    } finally {
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

  test("rejects a skill when its intermediate directory becomes an outside symlink before open", async () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("ocx-cc-ctx-dir-swap-");
    const outside = makeTempDir("ocx-cc-ctx-dir-swap-outside-");
    const skillDir = join(root, ".commandcode", "skills", "swap-skill");
    const skillFile = join(skillDir, "SKILL.md");
    const outsideDir = join(outside, "outside-skill");
    let swapped = false;
    try {
      writeSkill(root, ".commandcode/skills", "swap-skill", "inside body");
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, "SKILL.md"), "outside secret body", "utf8");
      setCommandCodeBeforeOpenForTests(path => {
        if (path !== skillFile) return;
        swapped = true;
        renameSync(skillDir, join(root, ".commandcode", "skills", "held-skill"));
        symlinkSync(outsideDir, skillDir, "dir");
      });
      const result = await loadCommandCodeProjectContext(root);
      expect(swapped).toBe(true);
      expect(result.skills).toBeNull();
      expect(JSON.stringify(result)).not.toContain("outside secret body");
    } finally {
      setCommandCodeBeforeOpenForTests(undefined);
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
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
    const roots: string[] = [];
    try {
      for (let i = 0; i < MAX_PROJECT_CONTEXT_CACHE_ENTRIES + 10; i++) {
        const root = makeTempDir(`ocx-cc-ctx-cap-${i}-`);
        roots.push(root);
        writeFileSync(join(root, "AGENTS.md"), `agents ${i}`, "utf8");
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
    let releaseRead: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    let reads = 0;
    try {
      for (let i = 0; i < MAX_PROJECT_CONTEXT_CACHE_ENTRIES - 1; i++) {
        projectContextCache.set(`/sibling-${i}`, { collectedAt: now, value: emptyValue });
      }
      projectContextCache.set(root, { collectedAt: now - PROJECT_CONTEXT_TTL_MS - 1, value: emptyValue });
      writeFileSync(join(root, "AGENTS.md"), "refreshed", "utf8");
      setCommandCodeBeforeOpenForTests(path => {
        if (path !== join(root, "AGENTS.md")) return;
        reads++;
        markStarted();
        return gate;
      });
      const first = loadCommandCodeProjectContext(root);
      await started;
      const second = loadCommandCodeProjectContext(root);
      releaseRead();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toBe(two);
      expect(reads).toBe(1);
      expect(projectContextCache.size).toBe(MAX_PROJECT_CONTEXT_CACHE_ENTRIES);
      expect(projectContextCache.has("/sibling-0")).toBe(true);
      expect(projectContextCache.get(root)?.value.memory).toBe("refreshed");
    } finally {
      releaseRead();
      setCommandCodeBeforeOpenForTests(undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cache insertion rechecks capacity after an in-flight key is evicted", async () => {
    const root = makeTempDir("ocx-cc-ctx-interleaved-capacity-");
    const now = Date.now();
    const emptyValue = { memory: "", taste: null, skills: null };
    let releaseRead: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    try {
      for (let i = 0; i < MAX_PROJECT_CONTEXT_CACHE_ENTRIES - 1; i++) {
        projectContextCache.set(`/sibling-${i}`, { collectedAt: now, value: emptyValue });
      }
      projectContextCache.set(root, { collectedAt: now - PROJECT_CONTEXT_TTL_MS - 1, value: emptyValue });
      writeFileSync(join(root, "AGENTS.md"), "new value", "utf8");
      setCommandCodeBeforeOpenForTests(path => {
        if (path !== join(root, "AGENTS.md")) return;
        markStarted();
        return gate;
      });
      const loading = loadCommandCodeProjectContext(root);
      await started;
      projectContextCache.delete(root);
      projectContextCache.set("/replacement", { collectedAt: Date.now(), value: emptyValue });
      releaseRead();
      expect((await loading).memory).toBe("new value");
      expect(projectContextCache.size).toBe(MAX_PROJECT_CONTEXT_CACHE_ENTRIES);
      expect(projectContextCache.has(root)).toBe(true);
      expect(projectContextCache.has("/replacement")).toBe(true);
    } finally {
      releaseRead();
      setCommandCodeBeforeOpenForTests(undefined);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
