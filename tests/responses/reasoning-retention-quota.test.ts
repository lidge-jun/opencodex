import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyReasoningRetention,
  ReasoningArchiveBusyError,
  ReasoningArchiveError,
  ReasoningArchiveQuotaError,
} from "../../src/responses/reasoning-retention";

const reasoningItem = (text: string) => ({
  type: "reasoning",
  summary: [{ type: "summary_text", text }],
});

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const LOCK_SIDECARS = ["-journal", "-wal", "-shm"] as const;

describe("applyReasoningRetention archive quota", () => {
  const dirs: string[] = [];
  const extraPaths: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dir + ".lock", { recursive: true, force: true });
      for (const suffix of LOCK_SIDECARS) rmSync(dir + ".lock" + suffix, { force: true });
    }
    for (const path of extraPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "reasoning-quota-"));
    dirs.push(dir);
    return dir;
  };

  test("legacy over-capacity scanning stops actual directory reads at the cap and closes", () => {
    const archiveDir = setup();
    for (let i = 0; i < 12; i++) writeFileSync(join(archiveDir, `${i}.md`), "");
    const openDirectory = fs.opendirSync.bind(fs);
    let reads = 0;
    let closes = 0;
    const open = spyOn(fs, "opendirSync").mockImplementation(((path: fs.PathLike) => {
      const dir = openDirectory(path, { bufferSize: 1 });
      const read = dir.readSync.bind(dir);
      const close = dir.closeSync.bind(dir);
      dir.readSync = () => { reads++; return read(); };
      dir.closeSync = () => { closes++; close(); };
      return dir;
    }) as typeof fs.opendirSync);
    try {
      expect(() => applyReasoningRetention([reasoningItem("new")], {
        archiveDir, maxTokens: 1, archiveMaxFiles: 2,
      })).toThrow(ReasoningArchiveQuotaError);
      expect(open).toHaveBeenCalledTimes(1);
      expect(reads).toBe(2);
      expect(closes).toBe(1);
    } finally { open.mockRestore(); }
    expect(readdirSync(archiveDir)).toHaveLength(12);
  });

  test.each(["bytes", "unsafe", "read-error", "vanished", "close-error"] as const)(
    "streaming scan closes on %s refusal without reading beyond its budget", kind => {
      const archiveDir = setup();
      for (let i = 0; i < 12; i++) writeFileSync(join(archiveDir, `${i}.md`), "data");
      const openDirectory = fs.opendirSync.bind(fs);
      const originalStat = fs.lstatSync.bind(fs);
      let reads = 0;
      let closes = 0;
      const stat = kind === "vanished" ? spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike) => {
        if (String(path).endsWith(".md")) throw Object.assign(new Error("vanished"), { code: "ENOENT" });
        return originalStat(path);
      }) as typeof fs.lstatSync) : undefined;
      const open = spyOn(fs, "opendirSync").mockImplementation(((path: fs.PathLike) => {
        const dir = openDirectory(path, { bufferSize: 1 });
        const read = dir.readSync.bind(dir);
        const close = dir.closeSync.bind(dir);
        dir.readSync = () => {
          reads++;
          if (kind === "read-error") throw new Error("fixture EIO");
          const entry = read();
          if (kind === "unsafe" && entry) entry.isFile = () => false;
          return entry;
        };
        dir.closeSync = () => { closes++; close(); if (kind === "close-error") throw new Error("fixture EIO"); };
        return dir;
      }) as typeof fs.opendirSync);
      try {
        expect(() => applyReasoningRetention([reasoningItem("new")], {
          archiveDir, maxTokens: 1, archiveMaxFiles: 2, archiveMaxBytes: 1,
        })).toThrow(kind === "bytes" ? ReasoningArchiveQuotaError : ReasoningArchiveError);
        expect(reads).toBe(kind === "vanished" ? 2 : 1);
        expect(closes).toBe(1);
      } finally { open.mockRestore(); stat?.mockRestore(); }
      expect(readdirSync(archiveDir)).toHaveLength(12);
    },
  );

  test.each(["read", "stat", "undefined", "success"] as const)("scan and close failure priority (%s)", kind => {
    const archiveDir = setup();
    const prior = join(archiveDir, "prior.md");
    writeFileSync(prior, "preserve");
    const primary = kind === "undefined" ? undefined : new Error(`fixture primary ${kind}`);
    const secondary = new Error("fixture close failure");
    const openDirectory = fs.opendirSync.bind(fs);
    const originalStat = fs.lstatSync.bind(fs);
    let closes = 0;
    const stat = kind === "stat" ? spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, ...args: unknown[]) => {
      if (String(path) === prior) throw primary;
      return (originalStat as (...args: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.lstatSync) : undefined;
    const open = spyOn(fs, "opendirSync").mockImplementation(((path: fs.PathLike) => {
      const dir = openDirectory(path, { bufferSize: 1 });
      const read = dir.readSync.bind(dir);
      const close = dir.closeSync.bind(dir);
      dir.readSync = () => {
        if (kind === "read" || kind === "undefined") throw primary;
        return read();
      };
      dir.closeSync = () => { closes++; close(); throw secondary; };
      return dir;
    }) as typeof fs.opendirSync);
    const input = [reasoningItem("original reasoning")];
    const before = structuredClone(input);
    let rejected = false;
    let failure: unknown;
    try {
      try { applyReasoningRetention(input, { archiveDir, maxTokens: 1, archiveMaxFiles: 1 }); }
      catch (error) { rejected = true; failure = error; }
      expect(rejected).toBe(true);
      expect(failure).toBeInstanceOf(ReasoningArchiveError);
      expect(Object.hasOwn(failure as object, "cause")).toBe(true);
      expect((failure as Error).cause).toBe(kind === "success" ? secondary : primary);
      expect((failure as Error).message).toContain(kind === "success" ? "could not be closed"
        : kind === "stat" ? "not inspectable" : "cannot be scanned");
      expect(closes).toBe(1);
      expect(input).toEqual(before);
      expect(readdirSync(archiveDir)).toEqual(["prior.md"]);
      expect(readFileSync(prior, "utf8")).toBe("preserve");
    } finally { open.mockRestore(); stat?.mockRestore(); }
  });

  test("byte cap admits an exactly fitting archive and refuses one byte over", () => {
    const archiveDir = setup();
    const input = [reasoningItem("x".repeat(100))];
    const allowed = applyReasoningRetention(input, { archiveDir, maxTokens: 1, archiveMaxBytes: 100 });
    expect(allowed.archived).toBeDefined();
    expect(statSync(allowed.archived!.path).size).toBe(100);

    const denied = setup();
    expect(() => applyReasoningRetention(input, { archiveDir: denied, maxTokens: 1, archiveMaxBytes: 99 }))
      .toThrow(ReasoningArchiveQuotaError);
    expect(readdirSync(denied)).toEqual([]);
  });

  test("UTF-8 text and separator bytes are charged exactly before the join exists", () => {
    const archiveDir = setup();
    // "한"(3) + separator "\n\n---\n\n"(7) + "가"(3) = 13 bytes on disk.
    const input = [reasoningItem("한"), reasoningItem("가")];
    expect(() => applyReasoningRetention(input, { archiveDir, maxTokens: 1, archiveMaxBytes: 12 }))
      .toThrow(ReasoningArchiveQuotaError);
    expect(readdirSync(archiveDir)).toEqual([]);

    const allowed = applyReasoningRetention(input, { archiveDir, maxTokens: 1, archiveMaxBytes: 13 });
    expect(allowed.archived).toBeDefined();
    expect(statSync(allowed.archived!.path).size).toBe(13);
  });

  test("file-count cap refuses a new archive without touching existing files", () => {
    const archiveDir = setup();
    const prior = join(archiveDir, "reasoning-old.md");
    writeFileSync(prior, "keep me");
    const before = sha256(prior);

    expect(() => applyReasoningRetention([reasoningItem("new")], { archiveDir, maxTokens: 1, archiveMaxFiles: 1 }))
      .toThrow(ReasoningArchiveQuotaError);
    expect(sha256(prior)).toBe(before);
    expect(readdirSync(archiveDir)).toEqual(["reasoning-old.md"]);
  });

  test("boundary: the file landing exactly at the count cap is archived, the next is refused", () => {
    const archiveDir = setup();
    const first = applyReasoningRetention([reasoningItem("first")], { archiveDir, maxTokens: 1, archiveMaxFiles: 1 });
    expect(first.archived).toBeDefined();
    expect(readdirSync(archiveDir)).toHaveLength(1);
    expect(() => applyReasoningRetention([reasoningItem("second")], { archiveDir, maxTokens: 1, archiveMaxFiles: 1 }))
      .toThrow(ReasoningArchiveQuotaError);
    expect(readdirSync(archiveDir)).toHaveLength(1);
  });

  test("legacy over-capacity contents are preserved and only refuse new archives", () => {
    const archiveDir = setup();
    const heavy = join(archiveDir, "reasoning-heavy.md");
    const other = join(archiveDir, "unrelated.bin");
    writeFileSync(heavy, "h".repeat(50));
    writeFileSync(other, "o".repeat(30));
    const beforeHeavy = sha256(heavy);
    const beforeOther = sha256(other);

    const input = [reasoningItem("small")];
    const snapshot = JSON.stringify(input);
    expect(() => applyReasoningRetention(input, { archiveDir, maxTokens: 1, archiveMaxBytes: 10 }))
      .toThrow(ReasoningArchiveQuotaError);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(sha256(heavy)).toBe(beforeHeavy);
    expect(sha256(other)).toBe(beforeOther);
  });

  test("a non-regular archive entry refuses closed instead of being ignored", () => {
    const archiveDir = setup();
    mkdirSync(join(archiveDir, "foreign-subdir"));
    expect(() => applyReasoningRetention([reasoningItem("x")], { archiveDir, maxTokens: 1 }))
      .toThrow(ReasoningArchiveError);
    expect(readdirSync(archiveDir)).toEqual(["foreign-subdir"]);
  });

  test("a non-inspectable archive entry refuses closed", () => {
    const archiveDir = setup();
    const blocked = join(archiveDir, "blocked.md");
    writeFileSync(blocked, "data");
    const original = fs.lstatSync.bind(fs);
    const stat = spyOn(fs, "lstatSync").mockImplementation(((path: string, options?: unknown) => {
      if (String(path) === blocked) {
        const denied = new Error("denied") as NodeJS.ErrnoException;
        denied.code = "EACCES";
        throw denied;
      }
      return (original as (...args: unknown[]) => unknown)(path, options);
    }) as typeof fs.lstatSync);
    try {
      expect(() => applyReasoningRetention([reasoningItem("x")], { archiveDir, maxTokens: 1 }))
        .toThrow(ReasoningArchiveError);
    } finally {
      stat.mockRestore();
    }
  });

  test("a symlinked archive directory refuses closed", () => {
    const archiveDir = setup();
    const real = mkdtempSync(join(tmpdir(), "reasoning-quota-real-"));
    extraPaths.push(real);
    const link = join(tmpdir(), "reasoning-quota-link-" + Math.random().toString(36).slice(2, 8));
    extraPaths.push(link);
    try {
      symlinkSync(real, link, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "ENOTSUP") return;
      throw error;
    }
    expect(() => applyReasoningRetention([reasoningItem("x")], { archiveDir: link, maxTokens: 1 }))
      .toThrow(ReasoningArchiveError);
    expect(readdirSync(real)).toEqual([]);
    expect(archiveDir && existsSync(archiveDir)).toBe(true);
  });

  test("a lock path that is not a regular file refuses closed", () => {
    const archiveDir = setup();
    mkdirSync(archiveDir + ".lock");
    expect(() => applyReasoningRetention([reasoningItem("x")], { archiveDir, maxTokens: 1 }))
      .toThrow(ReasoningArchiveError);
    expect(readdirSync(archiveDir)).toEqual([]);
  });

  test("a lock held by another process fails busy, writes nothing, and the retry archives", async () => {
    const archiveDir = setup();
    const lockPath = archiveDir + ".lock";
    const marker = archiveDir + ".held";
    extraPaths.push(marker);
    const child = Bun.spawn([
      process.execPath,
      "-e",
      "import { Database } from \"bun:sqlite\";"
      + "import { writeFileSync } from \"node:fs\";"
      + "const db = new Database(" + JSON.stringify(lockPath) + ", { create: true });"
      + "db.exec(\"PRAGMA busy_timeout = 0; BEGIN IMMEDIATE\");"
      + "writeFileSync(" + JSON.stringify(marker) + ", \"held\");"
      + "await Bun.sleep(30000);",
    ], { stdout: "ignore", stderr: "ignore" });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error("child did not acquire the archive lock");
        await Bun.sleep(20);
      }
      const input = [reasoningItem("queued reasoning")];
      const snapshot = JSON.stringify(input);
      expect(() => applyReasoningRetention(input, { archiveDir, maxTokens: 1 }))
        .toThrow(ReasoningArchiveBusyError);
      expect(JSON.stringify(input)).toBe(snapshot);
      expect(readdirSync(archiveDir)).toEqual([]);
    } finally {
      child.kill();
      await child.exited;
    }
    // The OS released the killed child's transaction; a same-request retry archives normally.
    const result = applyReasoningRetention([reasoningItem("queued reasoning")], { archiveDir, maxTokens: 1 });
    expect(result.archived).toBeDefined();
    expect(readdirSync(archiveDir)).toHaveLength(1);
  }, 15_000);
});
