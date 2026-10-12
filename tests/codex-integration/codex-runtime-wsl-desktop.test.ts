import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexHomeDir } from "../../src/codex/home";
import { persistCodexRuntime, resolveCodexRuntime, type RuntimeExecFile } from "../../src/codex/runtime";

/**
 * Issue 5635: Windows Codex Desktop in WSL app-server mode ships its Linux Codex binary
 * under the effective Codex home as bin/wsl/<version-hash>/codex. The Ubuntu service PATH
 * has no codex, so discovery must find that binary without outranking an operator pin or
 * PATH, and must rediscover it after a Desktop update replaces the hash directory.
 */
const NO_CODEX_PATH = "/usr/bin:/bin";
const CODEX_HOME = "/mnt/c/Users/example/.codex";
// Resolved exactly as discovery resolves it, so the fixture holds on a Windows runner too.
const WSL_ROOT = join(resolveCodexHomeDir({ env: { CODEX_HOME } }), "bin", "wsl");

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-runtime-wsl-"));
}

function wslFs(hashes: Record<string, number>) {
  return {
    readdirSync: (path: string) => path === WSL_ROOT ? Object.keys(hashes) : [],
    statSync: (path: string) => {
      for (const [hash, mtimeMs] of Object.entries(hashes)) {
        if (path === join(WSL_ROOT, hash)) return { mtimeMs, isDirectory: () => true };
      }
      return { mtimeMs: 0, isDirectory: () => false };
    },
  };
}

function versions(map: Record<string, string>): RuntimeExecFile {
  return file => {
    const version = map[String(file)];
    if (!version) throw new Error("not found");
    return version;
  };
}

describe("WSL Desktop runtime discovery (#5635)", () => {
  test("finds the Desktop-bundled Linux binary when the service PATH has no codex", () => {
    const binary = join(WSL_ROOT, "hash-a", "codex");
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_HOME, HOME: "/home/example", PATH: NO_CODEX_PATH },
      platform: "linux",
      existsSync: path => path === binary,
      ...wslFs({ "hash-a": 1_000 }),
      execFileSync: versions({ [binary]: "codex-cli 0.155.0-alpha.16" }),
      discoverAlternatives: false,
    });
    expect(result.runtime).toEqual({ command: binary, version: "0.155.0-alpha.16", source: "installed" });
  });

  test("rediscovers the binary after a Desktop update replaces the hash directory", () => {
    const configDir = tempConfigDir();
    const oldBinary = join(WSL_ROOT, "hash-old", "codex");
    const newBinary = join(WSL_ROOT, "hash-new", "codex");
    persistCodexRuntime({ command: oldBinary, version: "0.154.0", source: "installed" }, { configDir }, "discovered");
    const result = resolveCodexRuntime({
      configDir,
      env: { CODEX_HOME, HOME: "/home/example", PATH: NO_CODEX_PATH },
      platform: "linux",
      existsSync: path => path === newBinary,
      ...wslFs({ "hash-new": 2_000 }),
      execFileSync: versions({ [newBinary]: "codex-cli 0.155.0" }),
      discoverAlternatives: false,
    });
    expect(result.runtime.command).toBe(newBinary);
    expect(result.replacedConfigured?.from.command).toBe(oldBinary);
  });

  test("prefers the newest hash directory when several are present", () => {
    const older = join(WSL_ROOT, "hash-older", "codex");
    const newer = join(WSL_ROOT, "hash-newer", "codex");
    const probed: string[] = [];
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_HOME, HOME: "/home/example", PATH: NO_CODEX_PATH },
      platform: "linux",
      existsSync: path => path === older || path === newer,
      ...wslFs({ "hash-older": 1_000, "hash-newer": 2_000 }),
      execFileSync: file => {
        probed.push(String(file));
        return "codex-cli 0.155.0";
      },
      discoverAlternatives: false,
    });
    expect(result.runtime.command).toBe(newer);
    expect(probed).not.toContain(older);
  });

  test("an explicit operator pin still wins over a valid Desktop binary", () => {
    const configDir = tempConfigDir();
    const pinned = "/opt/codex/bin/codex";
    const binary = join(WSL_ROOT, "hash-a", "codex");
    persistCodexRuntime({ command: pinned, version: "0.150.0", source: "configured" }, { configDir }, "pinned");
    const result = resolveCodexRuntime({
      configDir,
      env: { CODEX_HOME, HOME: "/home/example", PATH: NO_CODEX_PATH },
      platform: "linux",
      existsSync: path => path === pinned || path === binary,
      ...wslFs({ "hash-a": 1_000 }),
      execFileSync: versions({ [pinned]: "codex-cli 0.150.0", [binary]: "codex-cli 0.155.0" }),
    });
    expect(result.runtime.command).toBe(pinned);
  });

  test("a codex on PATH still ranks ahead of the Desktop binary", () => {
    const pathDir = "/usr/local/sbin";
    const onPath = join(pathDir, "codex");
    const binary = join(WSL_ROOT, "hash-a", "codex");
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_HOME, HOME: "/home/example", PATH: pathDir },
      platform: "linux",
      existsSync: path => path === onPath || path === binary,
      ...wslFs({ "hash-a": 1_000 }),
      execFileSync: versions({ [onPath]: "codex-cli 0.150.0", [binary]: "codex-cli 0.155.0" }),
      discoverAlternatives: false,
    });
    expect(result.runtime).toMatchObject({ command: onPath, source: "path" });
  });

  test("an unreadable bin/wsl directory degrades to the ordinary fallback", () => {
    const result = resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_HOME, HOME: "/home/example", PATH: NO_CODEX_PATH },
      platform: "linux",
      existsSync: () => false,
      readdirSync: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      statSync: () => ({ mtimeMs: 0, isDirectory: () => false }),
      execFileSync: () => {
        throw new Error("not found");
      },
      discoverAlternatives: false,
    });
    expect(result.runtime).toEqual({ command: "codex", version: null, source: "fallback" });
  });

  test("macOS does not enumerate a WSL layout", () => {
    const listed: string[] = [];
    resolveCodexRuntime({
      configDir: tempConfigDir(),
      env: { CODEX_HOME, HOME: "/Users/example", PATH: NO_CODEX_PATH },
      platform: "darwin",
      existsSync: () => false,
      readdirSync: path => {
        listed.push(path);
        return [];
      },
      statSync: () => ({ mtimeMs: 0, isDirectory: () => false }),
      execFileSync: () => {
        throw new Error("not found");
      },
    });
    expect(listed).not.toContain(WSL_ROOT);
  });
});
