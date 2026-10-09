import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSelectedRuntimeWritable, RuntimePreflightError, RUNTIME_PREFLIGHT_TIMEOUT_MS, type RuntimePreflightFs, type RuntimePreflightOptions, type RuntimePreflightReason } from "../../src/lib/bun-runtime-preflight";
import type { DurableBunRuntime } from "../../src/lib/bun-runtime";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-runtime-preflight-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) removeTreeWithRetry(dir); });
const runtime: DurableBunRuntime = { path: process.execPath, source: "process", overrideEnv: "OPENCODEX_BUN_PATH" };
const standalone: DurableBunRuntime = { ...runtime, source: "standalone" };
const fs: RuntimePreflightFs = { lstatSync, mkdirSync, rmdirSync, readdirSync };
function refusal(run: () => void, reason: RuntimePreflightReason): void {
  try { run(); throw new Error("expected refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(RuntimePreflightError);
    expect(error).toMatchObject({ code: "OCX_RUNTIME_PREFLIGHT_FAILED", reason });
    expect((error as Error).message).toContain("OPENCODEX_BUN_PATH");
    expect((error as Error).message).toContain("npm install -g opencodex");
  }
}
function child(result: Partial<ReturnType<typeof spawnSync>>): typeof spawnSync {
  return (() => ({ status: 0, stdout: "nonce:ok", ...result })) as typeof spawnSync;
}
const windows: RuntimePreflightOptions = { platform: "win32", nonce: () => "nonce" };

describe("selected Bun write preflight", () => {
  test("real child successfully creates and removes only its probe on every host", () => {
    const dir = temporary();
    assertSelectedRuntimeWritable(runtime, dir, { platform: "win32" });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("reuses the blocker-file fixture from #6695 without probing an ancestor", () => {
    const blocker = join(temporary(), "probe-blocker-file");
    writeFileSync(blocker, "x", "utf8");
    refusal(() => assertSelectedRuntimeWritable(runtime, join(blocker, "probe"), windows), "create");
    expect(readFileSync(blocker, "utf8")).toBe("x");
  });

  test("executes the selected lexical path with argv, nonce, hidden window and 5 s timeout on every invocation", () => {
    const dir = temporary();
    const selected = { ...runtime, path: "C:\\trusted bun\\bun.exe", source: "override" as const };
    let calls = 0;
    const spawn = ((path: string, argv: string[], options: unknown) => {
      calls++;
      expect(path).toBe(selected.path);
      expect(argv[0]).toBe("-e");
      expect(argv[1]).toContain(".ocx-runtime-probe-nonce");
      expect(argv[1]).not.toContain("recursive");
      expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: RUNTIME_PREFLIGHT_TIMEOUT_MS });
      return { status: 0, stdout: "nonce:ok" };
    }) as typeof spawnSync;
    for (let i = 0; i < 2; i++) assertSelectedRuntimeWritable(selected, dir, { ...windows, spawnSync: spawn });
    expect(calls).toBe(2);
  });

  test("refuses spawn, timeout, create, remove and bad protocol without leaking child diagnostics", () => {
    const cases: Array<[RuntimePreflightReason, Partial<ReturnType<typeof spawnSync>>]> = [
      ["spawn", { error: Object.assign(new Error("private diagnostic"), { code: "ENOENT" }) }],
      ["timeout", { error: Object.assign(new Error("private diagnostic"), { code: "ETIMEDOUT" }) }],
      ["create", { status: 1, stdout: "nonce:create" }],
      ["remove", { status: 1, stdout: "nonce:remove" }],
      ["protocol", { status: 0, stdout: "another-nonce:ok" }],
      ["protocol", { status: 1, stdout: "nonce:ok" }],
      ["protocol", { status: null, stdout: "" }],
    ];
    for (const [reason, result] of cases) {
      refusal(() => assertSelectedRuntimeWritable(runtime, temporary(), { ...windows, spawnSync: child(result) }), reason);
    }
    refusal(() => assertSelectedRuntimeWritable(runtime, temporary(), {
      ...windows, spawnSync: (() => { throw new Error("private diagnostic"); }) as typeof spawnSync,
    }), "spawn");
  });

  test("concurrent invocations use different nonces and cannot acknowledge each other", async () => {
    const dir = temporary();
    const nonces: string[] = [];
    await Promise.all([1, 2].map(async () => assertSelectedRuntimeWritable(runtime, dir, {
      platform: "win32", spawnSync: ((path: string, argv: string[], options: object) => {
        const match = /process\.stdout\.write\(("[^"]+")/.exec(argv[1]!);
        nonces.push(JSON.parse(match![1]!));
        return spawnSync(path, argv, options);
      }) as typeof spawnSync,
    })));
    expect(new Set(nonces).size).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("non-Windows returns before any spawn, fs read, or fs mutation", () => {
    const unexpected = () => { throw new Error("unexpected I/O"); };
    for (const platform of ["darwin", "linux"] as const) {
      assertSelectedRuntimeWritable(runtime, "unused", {
        platform, spawnSync: unexpected as typeof spawnSync,
        fs: { lstatSync: unexpected, mkdirSync: unexpected, rmdirSync: unexpected, readdirSync: unexpected }, nonce: unexpected,
      });
    }
  });

  test("refuses files, symlinks, dangling roots and unreadable roots before spawning", () => {
    const dir = temporary();
    const file = join(dir, "file");
    writeFileSync(file, "x");
    const link = join(dir, "link");
    const dangling = join(dir, "dangling");
    symlinkSync(dir, link, "junction");
    symlinkSync(join(dir, "absent"), dangling, "junction");
    for (const root of [file, link, dangling]) {
      refusal(() => assertSelectedRuntimeWritable(runtime, root, {
        ...windows, spawnSync: (() => { throw new Error("must not spawn"); }) as typeof spawnSync,
      }), "create");
    }
    refusal(() => assertSelectedRuntimeWritable(runtime, dir, {
      ...windows, fs: { ...fs, lstatSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } },
    }), "create");
    expect(readFileSync(file, "utf8")).toBe("x");
  });

  test("absent root is exclusively created, stays empty on success and refusal", () => {
    const parent = temporary();
    for (const source of ["process", "standalone"] as const) {
      const root = join(parent, source);
      assertSelectedRuntimeWritable({ ...runtime, source }, root, { platform: "win32", rootWasAbsent: true });
      expect(readdirSync(root)).toEqual([]);
    }
    const denied = join(parent, "denied");
    refusal(() => assertSelectedRuntimeWritable(runtime, denied, { ...windows, rootWasAbsent: true, spawnSync: child({ status: 1, stdout: "nonce:create" }) }), "create");
    expect(existsSync(denied)).toBe(true);
    expect(readdirSync(denied)).toEqual([]);
    const missingParent = join(parent, "missing", "root");
    refusal(() => assertSelectedRuntimeWritable(runtime, missingParent, windows), "create");
    expect(existsSync(join(parent, "missing"))).toBe(false);
  });

  test("another invocation's concurrent root and contents survive refusal", () => {
    const root = join(temporary(), "concurrent");
    refusal(() => assertSelectedRuntimeWritable(runtime, root, {
      ...windows, rootWasAbsent: true, spawnSync: child({ status: 1, stdout: "nonce:create" }),
      fs: { ...fs, mkdirSync: (path, mode) => {
        mkdirSync(path, mode); writeFileSync(join(path, "other"), "preserve");
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      } },
    }), "create");
    expect(readFileSync(join(root, "other"), "utf8")).toBe("preserve");
  });

  test("a concurrently created empty root also survives refusal", () => {
    const root = join(temporary(), "empty");
    mkdirSync(root);
    refusal(() => assertSelectedRuntimeWritable(runtime, root, { ...windows, rootWasAbsent: true, spawnSync: child({ status: 1, stdout: "nonce:create" }) }), "create");
    expect(existsSync(root)).toBe(true);
  });

  test("a created root becoming nonempty during the probe survives refusal", () => {
    const root = join(temporary(), "nonempty");
    refusal(() => assertSelectedRuntimeWritable(runtime, root, {
      ...windows, rootWasAbsent: true, spawnSync: (() => {
        writeFileSync(join(root, "new"), "preserve"); return { status: 1, stdout: "nonce:create" };
      }) as typeof spawnSync,
    }), "create");
    expect(readFileSync(join(root, "new"), "utf8")).toBe("preserve");
  });

  test("a replacement empty root with a different inode survives refusal", () => {
    const parent = temporary();
    const root = join(parent, "replaced");
    let originalIno = 0;
    refusal(() => assertSelectedRuntimeWritable(runtime, root, {
      ...windows, rootWasAbsent: true, spawnSync: (() => {
        originalIno = lstatSync(root).ino;
        renameSync(root, join(parent, "old")); mkdirSync(root);
        return { status: 1, stdout: "nonce:create" };
      }) as typeof spawnSync,
    }), "create");
    expect(lstatSync(root).ino).not.toBe(originalIno);
    expect(readdirSync(root)).toEqual([]);
  });

  test("refusal never inspects emptiness or deletes the config root", () => {
    const root = join(temporary(), "root");
    const cleanup: string[] = [];
    refusal(() => assertSelectedRuntimeWritable(runtime, root, {
      ...windows, rootWasAbsent: true, spawnSync: child({ status: 1, stdout: "nonce:create" }),
      fs: { ...fs,
        readdirSync: () => { cleanup.push("read"); return []; },
        rmdirSync: () => { cleanup.push("remove"); },
      },
    }), "create");
    expect(cleanup).toEqual([]);
    expect(existsSync(root)).toBe(true); expect(readdirSync(root)).toEqual([]);
  });

  test("standalone exact executable probes in-process, and failures clean only empty owned probes", () => {
    const root = temporary();
    const noSpawn = (() => { throw new Error("standalone must not spawn"); }) as typeof spawnSync;
    assertSelectedRuntimeWritable(standalone, root, { ...windows, spawnSync: noSpawn });
    refusal(() => assertSelectedRuntimeWritable(standalone, root, {
      ...windows, spawnSync: noSpawn, fs: { ...fs, mkdirSync: () => { throw new Error("denied"); } },
    }), "create");
    let removals = 0;
    refusal(() => assertSelectedRuntimeWritable(standalone, root, {
      ...windows, spawnSync: noSpawn, fs: { ...fs, rmdirSync: path => {
        if (removals++ === 0) throw new Error("denied once"); rmdirSync(path);
      } },
    }), "remove");
    expect(readdirSync(root)).toEqual([]);
    refusal(() => assertSelectedRuntimeWritable({ ...standalone, path: "other.exe" }, join(root, "absent"), windows), "protocol");
    expect(readdirSync(root)).toEqual([]);
  });

  test("remove refusal preserves nonempty leftover entries instead of recursively deleting", () => {
    const root = temporary();
    refusal(() => assertSelectedRuntimeWritable(runtime, root, {
      ...windows, spawnSync: ((path: string, argv: string[], options: object) => {
        const script = argv[1]!.replace('fs.rmdirSync(path); result = "ok";', 'fs.writeFileSync(path + "/leftover", "preserve"); throw new Error("remove blocked");');
        return spawnSync(path, ["-e", script], options);
      }) as typeof spawnSync,
    }), "remove");
    expect(readFileSync(join(root, ".ocx-runtime-probe-nonce", "leftover"), "utf8")).toBe("preserve");
  });
});
