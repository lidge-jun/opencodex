import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deferServiceChildToNewerRuntime,
  deferToNewerServiceRuntime,
  probeServedRuntimeVersion,
  readServingRuntimes,
  recordServingRuntime,
  selectNewerServingRuntime,
  servingRuntimeCommandKey,
  servingRuntimesPath,
  type ServedRuntimeRecord,
} from "../../src/config/serving-runtimes";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-serving-runtimes-"));
  dirs.push(dir);
  return dir;
}

function fakeBinary(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, "fake");
  return path;
}

function record(command: string[], version: string, servedAt = "2026-09-28T00:00:00.000Z"): ServedRuntimeRecord {
  return { command, version, servedAt };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("serving runtime census", () => {
  test("round-trips a recorded runtime", () => {
    const dir = freshDir();
    const exe = fakeBinary(dir, "ocx.exe");
    recordServingRuntime(record([exe], "2.68.0"), dir);
    expect(readServingRuntimes(dir)).toEqual([
      { command: [exe], version: "2.68.0", servedAt: "2026-09-28T00:00:00.000Z" },
    ]);
  });

  test("re-recording the same command replaces rather than duplicates", () => {
    const dir = freshDir();
    const exe = fakeBinary(dir, "ocx.exe");
    recordServingRuntime(record([exe], "2.67.0", "2026-09-27T00:00:00.000Z"), dir);
    recordServingRuntime(record([exe], "2.68.0", "2026-09-28T00:00:00.000Z"), dir);
    const runtimes = readServingRuntimes(dir);
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]!.version).toBe("2.68.0");
  });

  test("distinct installs coexist and prune keeps the most recent sixteen", () => {
    const dir = freshDir();
    for (let i = 0; i < 20; i++) {
      recordServingRuntime(record([fakeBinary(dir, `ocx-${i}.exe`)], `2.${i}.0`), dir);
    }
    const runtimes = readServingRuntimes(dir);
    expect(runtimes).toHaveLength(16);
    expect(runtimes[0]!.version).toBe("2.19.0");
  });

  test("rejects records a relaunch could never run", () => {
    const dir = freshDir();
    const exe = fakeBinary(dir, "ocx.exe");
    for (const bad of [
      record([], "2.68.0"),
      record(["relative\\path\\ocx.exe"], "2.68.0"),
      record(["ocx.exe"], "2.68.0"),
      record([exe], "not-a-version"),
    ]) {
      recordServingRuntime(bad, dir);
    }
    expect(readServingRuntimes(dir)).toEqual([]);
  });

  test("a malformed file reads as an empty census", () => {
    const dir = freshDir();
    writeFileSync(servingRuntimesPath(dir), "{not json");
    expect(readServingRuntimes(dir)).toEqual([]);
  });
});

describe("selectNewerServingRuntime", () => {
  const selfCommand = [join("/", "npm", "bun.exe"), join("/", "npm", "index.ts")];

  test("returns the strictly newer sibling that still exists and re-verifies", () => {
    const dir = freshDir();
    const exe = fakeBinary(dir, "ocx-newer.exe");
    recordServingRuntime(record([exe], "2.68.0"), dir);
    const selected = selectNewerServingRuntime("2.67.0", selfCommand, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
    });
    expect(selected).not.toBeNull();
    expect(selected!.command).toEqual([exe]);
    expect(selected!.version).toBe("2.68.0");
  });

  test("a probe reporting a downgraded binary revokes the record's claim", () => {
    const dir = freshDir();
    const exe = fakeBinary(dir, "ocx-newer.exe");
    recordServingRuntime(record([exe], "2.68.0"), dir);
    expect(selectNewerServingRuntime("2.67.0", selfCommand, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.67.0", stderr: "" }),
    })).toBeNull();
  });

  test("older, equal-version, and missing-path records are not candidates", () => {
    const dir = freshDir();
    recordServingRuntime(record([fakeBinary(dir, "old.exe")], "2.60.0"), dir);
    recordServingRuntime(record([fakeBinary(dir, "same.exe")], "2.67.0"), dir);
    recordServingRuntime(record([join(dir, "gone.exe")], "2.99.0"), dir);
    expect(selectNewerServingRuntime("2.67.0", selfCommand, {
      dir,
      exists: existsSync,
      run: () => ({ status: 0, stdout: "opencodex 2.99.0", stderr: "" }),
    })).toBeNull();
  });

  test("self is excluded by command identity even when recorded newer", () => {
    const dir = freshDir();
    recordServingRuntime(record([...selfCommand], "2.99.0"), dir);
    expect(selectNewerServingRuntime("2.67.0", selfCommand, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.99.0", stderr: "" }),
    })).toBeNull();
  });

  test("a dead top candidate falls through to the next newer install", () => {
    const dir = freshDir();
    const stale = fakeBinary(dir, "ocx-rolled-back.exe");
    const good = fakeBinary(dir, "ocx-newer.exe");
    recordServingRuntime(record([stale], "2.69.0"), dir);
    recordServingRuntime(record([good], "2.68.0"), dir);
    const selected = selectNewerServingRuntime("2.67.0", selfCommand, {
      dir,
      exists: () => true,
      // The top-recorded binary was rolled back; the lower one still verifies.
      run: (file) => file === stale
        ? { status: 0, stdout: "opencodex 2.60.0", stderr: "" }
        : { status: 0, stdout: "opencodex 2.68.0", stderr: "" },
    });
    expect(selected).not.toBeNull();
    expect(selected!.command).toEqual([good]);
    expect(selected!.version).toBe("2.68.0");
  });

  test("an unprobed candidate never authorizes a handoff", () => {
    const dir = freshDir();
    for (let i = 0; i < 8; i++) {
      recordServingRuntime(record([fakeBinary(dir, `ocx-${i}.exe`)], `2.${68 + i}.0`), dir);
    }
    let probes = 0;
    expect(selectNewerServingRuntime("2.67.0", selfCommand, {
      dir,
      exists: () => true,
      run: () => { probes += 1; return { status: 1, stdout: "", stderr: "dead" }; },
    })).toBeNull();
    expect(probes).toBeLessThan(8);
  });
});

describe("probeServedRuntimeVersion", () => {
  test("parses the printed version and tolerates prefixes", () => {
    const probed = probeServedRuntimeVersion(["ocx.exe"], () => ({
      status: 0,
      stdout: "opencodex 2.68.0-preview.1",
      stderr: "",
    }));
    expect(probed).toBe("2.68.0-preview.1");
  });

  test("a failing or unparsable probe cannot authorize a handoff", () => {
    expect(probeServedRuntimeVersion(["ocx.exe"], () => ({ status: 1, stdout: "", stderr: "boom" }))).toBeNull();
    expect(probeServedRuntimeVersion(["ocx.exe"], () => ({ status: 0, stdout: "no version here", stderr: "" }))).toBeNull();
    expect(probeServedRuntimeVersion(["ocx.exe"], () => { throw new Error("spawn failed"); })).toBeNull();
  });
});

describe("deferToNewerServiceRuntime", () => {
  const selfCommand = [join("/", "npm", "bun.exe"), join("/", "npm", "index.ts")];

  function candidateSetup(dir: string): { exe: string } {
    const exe = fakeBinary(dir, "ocx-newer.exe");
    recordServingRuntime(record([exe], "2.68.0"), dir);
    return { exe };
  }

  test("hands the serve to the newer install and propagates its exit code", async () => {
    const dir = freshDir();
    const { exe } = candidateSetup(dir);
    const inherited: string[][] = [];
    const lines: string[] = [];
    const exit = await deferToNewerServiceRuntime("2.67.0", selfCommand, 10100, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
      runInherited: async (command, args) => { inherited.push([...command, ...args]); return 42; },
      log: line => lines.push(line),
    });
    expect(exit).toBe(42);
    expect(inherited).toEqual([[exe, "start", "--port", "10100"]]);
    expect(lines.join("\n")).toContain("2.68.0");
  });

  test("a delegatee that cannot launch leaves this install serving itself", async () => {
    const dir = freshDir();
    candidateSetup(dir);
    const exit = await deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
      runInherited: async () => { throw new Error("ENOENT"); },
      log: () => {},
    });
    expect(exit).toBeNull();
  });

  test("serves itself when nothing newer is recorded", async () => {
    const dir = freshDir();
    const exit = await deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      runInherited: async () => { throw new Error("must not run"); },
      log: () => {},
    });
    expect(exit).toBeNull();
  });

  test("command key canonicalizes Windows spellings of one binary", () => {
    const dir = freshDir();
    const exe = fakeBinary(dir, "OcX-Newer.EXE");
    // A distinct spelling of the same file must collide with the canonical key.
    expect(servingRuntimeCommandKey([join(dir, ".", "OcX-Newer.EXE")])).toBe(servingRuntimeCommandKey([exe]));
    if (process.platform === "win32") {
      expect(servingRuntimeCommandKey([exe.toLowerCase()])).toBe(servingRuntimeCommandKey([exe]));
    }
  });

  test("a delegated child receives the parent's SIGTERM and its status survives", async () => {
    const dir = freshDir();
    const script = join(dir, "sleeper.ts");
    writeFileSync(script, 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);\n');
    recordServingRuntime(record([process.execPath, script], "2.68.0"), dir);
    const deferred = deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
      log: () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    process.emit("SIGTERM");
    // Either the child's SIGTERM handler exits gracefully (0) or the default termination is
    // preserved as 128+SIGTERM (143): both prove the parent forwarded the signal.
    expect(await deferred).toBeOneOf([0, 128 + 15]);
  });
});

describe("deferServiceChildToNewerRuntime", () => {
  const selfCommand = [join("/", "npm", "bun.exe"), join("/", "npm", "index.ts")];

  test("only a non-sibling service child defers", async () => {
    const dir = freshDir();
    recordServingRuntime(record([fakeBinary(dir, "ocx-newer.exe")], "2.68.0"), dir);
    const deps = {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
      runInherited: async () => { throw new Error("must not run"); },
      log: () => {},
    };
    const base = { selfVersion: "2.67.0", selfCommand, deps };
    expect(await deferServiceChildToNewerRuntime({ ...base, sibling: true, env: { OCX_SERVICE: "1" } })).toBeNull();
    expect(await deferServiceChildToNewerRuntime({ ...base, sibling: false, env: {} })).toBeNull();
    expect(await deferServiceChildToNewerRuntime({
      ...base,
      sibling: false,
      env: { OCX_SERVICE: "1" },
      deps: { ...deps, runInherited: async () => 42 },
    })).toBe(42);
  });
});
