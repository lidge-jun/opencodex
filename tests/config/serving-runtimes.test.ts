import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deferServiceChildToNewerRuntime,
  isManagedServiceEnvironment,
  deferToNewerServiceRuntime,
  probeServedRuntimeVersion,
  readServingRuntimes,
  recordServingRuntime,
  selectNewerServingRuntime,
  servingRuntimeCommandKey,
  servingRuntimesPath,
  type ServedRuntimeRecord,
} from "../../src/config/serving-runtimes";
import { buildWinswXml } from "../../src/lib/winsw";
import { buildWindowsServiceScript } from "../../src/service/windows-taskxml";
import { repoPath } from "../helpers/repo-root";

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
      record(["relative/path/ocx.exe"], "2.68.0"),
      record(["ocx.exe"], "2.68.0"),
      record([exe], "not-a-version"),
    ]) {
      recordServingRuntime(bad, dir);
    }
    expect(readServingRuntimes(dir)).toEqual([]);
  });

  test("concurrent process writers preserve both commands", async () => {
    const dir = freshDir();
    const source = repoPath("src", "config", "serving-runtimes.ts");
    const script = join(dir, "writer.ts");
    writeFileSync(script, `import { recordServingRuntime } from ${JSON.stringify(source)};
recordServingRuntime({ command: [process.argv[3]], version: "2.68.0", servedAt: new Date().toISOString() }, process.argv[2]);
`);
    // Each writer is a cold Bun process importing the census module; the budget covers a busy runner.
    const binaries = Array.from({ length: 4 }, (_, i) => fakeBinary(dir, `writer-${i}`));
    const children = binaries.map(exe => Bun.spawn([process.execPath, script, dir, exe], { stdout: "pipe", stderr: "pipe" }));
    expect(await Promise.all(children.map(child => child.exited))).toEqual(binaries.map(() => 0));
    expect(readServingRuntimes(dir).map(entry => entry.command[0]).sort()).toEqual(binaries.sort());
  }, 30_000);

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

  test("rejects a writable recorded launch target", () => {
    if (process.platform === "win32") return;
    const dir = freshDir();
    const exe = fakeBinary(dir, "mutable-exe");
    chmodSync(exe, 0o666);
    recordServingRuntime(record([exe], "2.68.0"), dir);
    expect(selectNewerServingRuntime("2.67.0", selfCommand, {
      dir, run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
    })).toBeNull();
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

  test("the greatest probed version wins over a higher recorded claim", () => {
    const dir = freshDir();
    const claimed = fakeBinary(dir, "ocx-claims-2.70.exe");
    const verified = fakeBinary(dir, "ocx-verified-2.69.exe");
    recordServingRuntime(record([claimed], "2.70.0"), dir);
    recordServingRuntime(record([verified], "2.69.0"), dir);
    const selected = selectNewerServingRuntime("2.67.0", selfCommand, {
      dir,
      exists: () => true,
      // Rolled back below the other candidate yet still newer than self.
      run: (file) => file === claimed
        ? { status: 0, stdout: "opencodex 2.68.0", stderr: "" }
        : { status: 0, stdout: "opencodex 2.69.0", stderr: "" },
    });
    expect(selected!.command).toEqual([verified]);
    expect(selected!.version).toBe("2.69.0");
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
      runInherited: async (command, args) => { inherited.push([...command, ...args]); return { exitCode: 42, ready: true }; },
      log: line => lines.push(line),
    });
    expect(exit).toBe(42);
    expect(inherited).toEqual([[exe, "start", "--port", "10100"]]);
    expect(lines.join("\n")).toContain("2.68.0");
  });

  test("a child exiting nonzero before bind falls back to this installation", async () => {
    const dir = freshDir();
    candidateSetup(dir);
    const exit = await deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
      runInherited: async () => ({ exitCode: 42, ready: false }),
      log: () => {},
    });
    expect(exit).toBeNull();
  });

  test("any pre-bind exit, including 0 and the stay-out code, falls back to this installation", async () => {
    // Propagating a clean pre-bind exit would end the service with nothing serving. The
    // fallback then runs this install's own start path, whose lease-held bind fence re-applies
    // every stay-out condition, so a deliberate stand-down is still honored there.
    for (const exitCode of [0, 42, 1]) {
      const dir = freshDir();
      candidateSetup(dir);
      const lines: string[] = [];
      const exit = await deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
        dir,
        exists: () => true,
        run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
        runInherited: async () => ({ exitCode, ready: false }),
        env: { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1", OCX_WINDOWS_WRAPPER_PROTOCOL: "1" },
        log: line => lines.push(line),
      });
      expect(exit).toBeNull();
      expect(lines.join("\n")).toContain(`exited before bind (status ${exitCode})`);
    }
  });

  test("a delegate that published its bind owns its exit, including 0", async () => {
    const dir = freshDir();
    candidateSetup(dir);
    expect(await deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
      dir,
      exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
      runInherited: async () => ({ exitCode: 0, ready: true }),
      log: () => {},
    })).toBe(0);
  });

  test("a real child that fails before bind leaves the parent serving", async () => {
    const dir = freshDir();
    const script = join(dir, "early-exit.ts");
    writeFileSync(script, "process.exit(42);\n");
    recordServingRuntime(record([process.execPath, script], "2.68.0"), dir);
    expect(await deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
      dir, run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }), log: () => {},
    })).toBeNull();
  });

  test("a real child that marks bind propagates a later nonzero exit", async () => {
    const dir = freshDir();
    const script = join(dir, "ready-child.ts");
    const source = repoPath("src", "config", "serving-runtimes.ts");
    writeFileSync(script, `import { markDelegatedServiceReady } from ${JSON.stringify(source)};
markDelegatedServiceReady();
process.exit(42);
`);
    recordServingRuntime(record([process.execPath, script], "2.68.0"), dir);
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      expect(await deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
        dir, run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }), log: () => {},
      })).toBe(42);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
    }
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
    const dotted = `${dir}/./OcX-Newer.EXE`;
    expect(dotted).not.toBe(exe);
    expect(servingRuntimeCommandKey([dotted])).toBe(servingRuntimeCommandKey([exe]));
    if (process.platform === "win32") {
      expect(servingRuntimeCommandKey([exe.toLowerCase()])).toBe(servingRuntimeCommandKey([exe]));
      const forwardSlashes = exe.replaceAll("\\", "/");
      expect(forwardSlashes).not.toBe(exe);
      expect(servingRuntimeCommandKey([forwardSlashes])).toBe(servingRuntimeCommandKey([exe]));
    }
  });

  test.each(["force", "graceful"] as const)("repeated signals share an escalation and clean it up on %s exit", async outcome => {
    const dir = freshDir();
    candidateSetup(dir);
    const child = new EventEmitter() as EventEmitter & { kill: (signal?: string) => boolean };
    const sent: string[] = [];
    child.kill = signal => {
      sent.push(signal ?? "SIGTERM");
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      return true;
    };
    const spawn = spyOn(childProcess, "spawn").mockReturnValue(child as never);
    const before = process.listeners("SIGTERM");
    const otherBefore = ["SIGINT", "SIGHUP", "exit"].map(name => process.listenerCount(name));
    const realSetTimeout = globalThis.setTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expire: (() => void) | undefined;
    let scheduled = 0;
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
      if (ms !== 5_000) throw new Error(`unexpected timer ${ms}`);
      scheduled += 1;
      expire = fn;
      timer = realSetTimeout(() => {}, 60_000);
      return timer;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout");
    const pending = deferToNewerServiceRuntime("2.67.0", selfCommand, undefined, {
      dir, exists: () => true,
      run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }), log: () => {},
    });
    try {
      const handler = process.listeners("SIGTERM").find(value => !before.includes(value));
      expect(handler).toBeDefined();
      handler!();
      handler!();
      expect(sent).toEqual(["SIGTERM", "SIGTERM"]);
      expect(scheduled).toBe(1);
      expect(expire).toBeDefined();
      if (outcome === "force") expire!();
      else child.emit("exit", 42, null);
      expect(await pending).toBe(outcome === "force" ? 137 : 42);
      expect(sent).toEqual(outcome === "force" ? ["SIGTERM", "SIGTERM", "SIGKILL"] : ["SIGTERM", "SIGTERM"]);
      expect(clear).toHaveBeenCalledWith(timer);
      expect(process.listeners("SIGTERM")).toEqual(before);
      expect(["SIGINT", "SIGHUP", "exit"].map(name => process.listenerCount(name))).toEqual(otherBefore);
    } finally {
      child.emit("exit", 1, null);
      await pending;
      if (timer) clearTimeout(timer);
      clear.mockRestore();
      timers.mockRestore();
      spawn.mockRestore();
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
    expect(await deferServiceChildToNewerRuntime({ ...base, sibling: true, env: { OCX_SERVICE_MANAGED: "1" } })).toBeNull();
    expect(await deferServiceChildToNewerRuntime({ ...base, sibling: false, env: {} })).toBeNull();
    expect(await deferServiceChildToNewerRuntime({ ...base, sibling: false, env: { OCX_SERVICE: "1" } })).toBeNull();
    expect(await deferServiceChildToNewerRuntime({ ...base, sibling: false, env: { OCX_SERVICE_MANAGED: "1", OCX_DELEGATED_ONCE: "1" } })).toBeNull();
    // The Task Scheduler wrapper's own environment, read back from the batch it generates.
    const batch = buildWindowsServiceScript({ bun: "C:\\ocx\\bun.exe", bunRuntimeSource: "bundled", cli: null }, 10100, []);
    const wrapperEnv = Object.fromEntries([...batch.matchAll(/^set "(OCX_[A-Z_]+)=([^"]*)"$/gm)].map(m => [m[1]!, m[2]!]));
    expect(wrapperEnv.OCX_SERVICE_MANAGED).toBeUndefined();
    expect(isManagedServiceEnvironment(wrapperEnv)).toBe(true);
    expect(isManagedServiceEnvironment({ OCX_WINDOWS_WRAPPER_PROTOCOL: "1" })).toBe(false);
    expect(await deferServiceChildToNewerRuntime({
      ...base,
      sibling: false,
      env: wrapperEnv,
      deps: { ...deps, runInherited: async () => ({ exitCode: 0, ready: true }) },
    })).toBe(0);
    expect(await deferServiceChildToNewerRuntime({
      ...base,
      sibling: false,
      env: { OCX_SERVICE_MANAGED: "1" },
      deps: { ...deps, runInherited: async () => ({ exitCode: 42, ready: true }) },
    })).toBe(42);
  });

  test("a generated WinSW service child delegates to a newer recorded install", async () => {
    const dir = freshDir();
    const newer = fakeBinary(dir, "ocx-newer.exe");
    recordServingRuntime(record([newer], "2.68.0"), dir);
    const xml = buildWinswXml(
      { bun: "C:\\ocx\\bun.exe", bunRuntimeSource: "bundled", cli: "C:\\ocx\\index.ts" },
      { USERDOMAIN: "WORKGROUP", USERNAME: "user", PATH: "C:\\Windows" },
      10100,
    );
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      [...xml.matchAll(/<env name="([^"]+)" value="([^"]*)"\/>/g)].map(match => [match[1]!, match[2]!]),
    );
    expect(env.OCX_SERVICE).toBe("1");
    expect(env.OCX_SERVICE_MANAGED).toBe("1");
    expect(env.OCX_WINDOWS_WRAPPER_PROTOCOL).toBeUndefined();
    expect(isManagedServiceEnvironment(env)).toBe(true);

    expect(await deferServiceChildToNewerRuntime({
      sibling: false,
      env,
      selfVersion: "2.67.0",
      selfCommand: [join("/", "npm", "bun.exe"), join("/", "npm", "index.ts")],
      deps: {
        dir,
        exists: () => true,
        run: () => ({ status: 0, stdout: "opencodex 2.68.0", stderr: "" }),
        runInherited: async (command, args) => {
          expect(command).toEqual([newer]);
          expect(args).toEqual(["start"]);
          return { exitCode: 0, ready: true };
        },
        log: () => {},
      },
    })).toBe(0);
  });
});
