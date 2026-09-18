import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  detectInstallFromPath,
} from "../../src/update/install-detection.mjs";
import {
  pnpmInvocation,
  pnpmInvocations,
  resolvePnpmCommand,
  resolvePnpmCommands,
} from "../../src/update/pnpm-invocation.mjs";
import {
  pnpmGlobalCommandArgs,
  pnpmOwnerEnvironment,
  readPnpmGlobalPackage,
  resolvePnpmGlobalOwner,
  runPnpmGlobalUpdate,
  verifyPnpmGlobalShims,
  type PnpmGlobalOwner,
  type PnpmRunResult,
} from "../../src/update/pnpm-global-install.mjs";
import { checkRegistryPackageIntegrity } from "../../src/update/registry-integrity.mjs";
import { verifyPnpmInstallTree } from "../../src/update/transactional-install.mjs";
import { updateCommand, updateCommandStr } from "../../src/update/index";

const PKG = "@bitkyc08/opencodex";

describe("pnpm installation detection", () => {
  test("requires strong evidence for legacy global/vN paths", () => {
    expect(detectInstallFromPath("/work/opencodex/src/update")).toBe("source");
    expect(detectInstallFromPath("/usr/lib/node_modules/@bitkyc08/opencodex/bin")).toBe("npm");
    expect(detectInstallFromPath("/tmp/test-user/.bun/install/global/node_modules/@bitkyc08/opencodex/bin")).toBe("bun");
    expect(detectInstallFromPath("/tmp/test-user/.bun/node_modules/@bitkyc08/opencodex/bin")).toBe("npm");
    expect(detectInstallFromPath("/opt/global/v11/node_modules/@bitkyc08/opencodex/bin")).toBe("npm");
    expect(detectInstallFromPath("/opt/pnpm/global/v11/node_modules/@bitkyc08/opencodex/bin", {
      exists: path => path === "/opt/pnpm/global/v11/node_modules/.pnpm",
    })).toBe("pnpm");
  });

  test("recognises isolated, store-link, and preserved-symlink layouts", () => {
    expect(detectInstallFromPath("/tmp/test-user/.local/share/pnpm/global/v11/node_modules/.pnpm/@bitkyc08+opencodex@2.49.0/node_modules/@bitkyc08/opencodex/bin")).toBe("pnpm");
    expect(detectInstallFromPath("/tmp/test-user/.local/share/pnpm/store/v11/links/@bitkyc08/opencodex/2.49.0/node_modules/@bitkyc08/opencodex/bin")).toBe("pnpm");
    expect(detectInstallFromPath("/tmp/test-user/.local/share/pnpm/global/11/group/node_modules/@bitkyc08/opencodex/bin", {
      exists: path => path === "/tmp/test-user/.local/share/pnpm/global/11/group/node_modules/.pnpm",
    })).toBe("pnpm");
    expect(detectInstallFromPath("C:\\work\\node_modules\\.pnpm\\@bitkyc08+opencodex@2.49.0\\node_modules\\@bitkyc08\\opencodex\\bin")).toBe("pnpm");
  });

  test("follows a preserved npm-looking symlink to the pnpm package target", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-detect-link-"));
    try {
      const target = join(root, "pnpm", "global", "v11", "node_modules", ".pnpm", "pkg", "node_modules", PKG, "bin");
      const exposed = join(root, "prefix", "node_modules", PKG, "bin");
      mkdirSync(target, { recursive: true });
      mkdirSync(dirname(exposed), { recursive: true });
      symlinkSync(target, exposed, "dir");
      expect(detectInstallFromPath(exposed)).toBe("pnpm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recognises pnpm metadata for a hoisted group without a virtual-store directory", () => {
    const path = "/opt/pnpm/global/v11/node_modules/@bitkyc08/opencodex/bin";
    expect(detectInstallFromPath(path, {
      exists: candidate => candidate === "/opt/pnpm/global/v11/node_modules/.modules.yaml",
    })).toBe("pnpm");
  });
});

describe("pnpm executable selection", () => {
  test("retains every absolute candidate so ownership can be matched", () => {
    const env = { PATH: "/first:/second:/third" };
    const existing = new Set(["/first/pnpm", "/second/pnpm"]);
    expect(resolvePnpmCommands("linux", env, { exists: path => existing.has(path) })).toEqual([
      "/first/pnpm", "/second/pnpm",
    ]);
    expect(pnpmInvocations(["--version"], "linux", env, { exists: path => existing.has(path) })).toHaveLength(2);
  });

  test("uses the trusted Windows pnpm shim through cmd.exe", () => {
    const cwd = "C:\\work\\untrusted-project";
    const trustedPnpm = "C:\\Program Files\\pnpm\\pnpm.cmd";
    const systemCmd = "C:\\Windows\\System32\\cmd.exe";
    const env = {
      PATH: `${cwd};C:\\Program Files\\pnpm`,
      PATHEXT: ".CMD",
      SystemRoot: "C:\\Windows",
    };
    const existing = new Set([`${cwd}\\pnpm.cmd`, trustedPnpm]);

    expect(resolvePnpmCommand("win32", env, {
      cwd,
      exists: path => existing.has(path),
    })).toBe(trustedPnpm);

    const invocation = pnpmInvocation(["add", "-g", "--allow-build=bun", `${PKG}@2.50.0`], "win32", env, {
      cwd,
      exists: path => existing.has(path),
    });
    expect(invocation).toMatchObject({
      file: systemCmd,
      args: ["/d", "/s", "/c", expect.stringContaining("pnpm\\pnpm.cmd")],
      options: { windowsVerbatimArguments: true },
    });
    expect(String(invocation?.args.at(-1) ?? "").includes(cwd)).toBe(false);
  });
});

const ownerFor = (version = "1.0.0"): PnpmGlobalOwner => ({
  commandPath: "/pnpm/owner/bin/pnpm",
  packagePath: `/pnpm/owner/global/v11/node_modules/@bitkyc08/opencodex-${version}`,
  globalDir: "/pnpm/owner/global",
  globalRoot: "/pnpm/owner/global/v11",
  globalBinDir: "/pnpm/owner/bin",
});

describe("pnpm global owner binding", () => {
  test("selects the candidate whose global listing owns the running package", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-owner-"));
    const packagePath = join(root, "home-b", "global", "v11", "node_modules", "@bitkyc08", "opencodex");
    const groupB = join(root, "home-b", "global", "v11");
    const baseB = join(root, "home-b", "global");
    const binB = join(root, "home-b", "bin");
    mkdirSync(packagePath, { recursive: true });
    try {
      const calls: { command: string; args: string[] }[] = [];
      const run = (command: string, args: readonly string[], capture = false): PnpmRunResult => {
        calls.push({ command, args: [...args] });
        if (args[0] === "list") {
          const listed = command === "/pnpm/a/bin/pnpm"
            ? join(root, "home-a", "global", "v11", "node_modules", "@bitkyc08", "opencodex")
            : packagePath;
          const group = command === "/pnpm/a/bin/pnpm" ? join(root, "home-a", "global", "v11") : groupB;
          return {
            status: 0,
            stdout: JSON.stringify([{ path: group, dependencies: { [PKG]: { version: "1.0.0", path: listed } } }]),
          };
        }
        if (args[0] === "root") {
          return { status: 0, stdout: `${groupB}\n` };
        }
        if (args[0] === "config" && args[2] === "global-dir") {
          return { status: 0, stdout: `${baseB}\n` };
        }
        if (args[0] === "config" && args[2] === "global-bin-dir") {
          return { status: 0, stdout: `${binB}\n` };
        }
        return { status: 1 };
      };

      const result = resolvePnpmGlobalOwner({
        packageName: PKG,
        packagePath,
        commandPaths: ["/pnpm/a/bin/pnpm", "/pnpm/b/bin/pnpm"],
        runPnpm: run,
        verify: () => ({ ok: true }),
      });

      expect(result).toEqual({
        ok: true,
        owner: {
          commandPath: "/pnpm/b/bin/pnpm",
          packagePath,
          version: "1.0.0",
          globalDir: baseB,
          globalRoot: groupB,
          globalBinDir: binB,
        },
      });
      expect(calls.some(call => call.command === "/pnpm/a/bin/pnpm")).toBe(true);
      expect(calls.filter(call => call.command === "/pnpm/b/bin/pnpm" && call.args[0] === "list").at(-1)?.args).toContain(`--global-dir=${baseB}`);
      expect(calls.filter(call => call.command === "/pnpm/b/bin/pnpm" && call.args[0] === "list").at(-1)?.args).toContain(`--config.global-bin-dir=${binB}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the running shim to disambiguate same-version pnpm homes", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-shim-owner-"));
    const packagePath = join(root, "shared", "node_modules", PKG);
    const groupA = join(root, "home-a", "global", "v11");
    const groupB = join(root, "home-b", "global", "v11");
    const baseA = join(root, "home-a", "global");
    const baseB = join(root, "home-b", "global");
    const binA = join(root, "home-a", "bin");
    const binB = join(root, "home-b", "bin");
    const runningShim = join(binB, "ocx");
    mkdirSync(packagePath, { recursive: true });
    try {
      const run = (command: string, args: readonly string[]): PnpmRunResult => {
        if (args[0] === "list") {
          const group = command === "/pnpm/a" ? groupA : groupB;
          return {
            status: 0,
            stdout: JSON.stringify([{ path: group, dependencies: { [PKG]: { version: "1.0.0", path: packagePath } } }]),
          };
        }
        if (args[0] === "root") {
          return { status: 0, stdout: `${command === "/pnpm/a" ? groupA : groupB}\n` };
        }
        if (args[0] === "config" && args[2] === "global-dir") {
          return { status: 0, stdout: `${command === "/pnpm/a" ? baseA : baseB}\n` };
        }
        if (args[0] === "config" && args[2] === "global-bin-dir") {
          return { status: 0, stdout: `${command === "/pnpm/a" ? binA : binB}\n` };
        }
        return { status: 1 };
      };
      const result = resolvePnpmGlobalOwner({
        packageName: PKG,
        packagePath,
        commandPaths: ["/pnpm/a", "/pnpm/b"],
        runningShimPath: runningShim,
        runPnpm: run,
        verify: () => ({ ok: true }),
      });
      expect(result).toMatchObject({ ok: true, owner: { commandPath: "/pnpm/b", globalDir: baseB, globalRoot: groupB, globalBinDir: binB } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("derives pnpm's default global-dir base when config get is undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-default-owner-"));
    const base = join(root, "global");
    const group = join(base, "v11");
    const bin = join(root, "bin");
    const packagePath = join(group, "node_modules", PKG);
    mkdirSync(packagePath, { recursive: true });
    try {
      const calls: string[][] = [];
      const run = (_command: string, args: readonly string[]): PnpmRunResult => {
        calls.push([...args]);
        if (args[0] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify([{ path: group, dependencies: { [PKG]: { version: "1.0.0", path: packagePath } } }]),
          };
        }
        if (args[0] === "root") return { status: 0, stdout: `${group}\n` };
        if (args[0] === "bin") return { status: 0, stdout: `${bin}\n` };
        if (args[0] === "config" && args[2] !== undefined) return { status: 0, stdout: "undefined\n" };
        return { status: 1 };
      };
      const result = resolvePnpmGlobalOwner({
        packageName: PKG,
        packagePath,
        commandPaths: ["/pnpm/default"],
        runPnpm: run,
        verify: () => ({ ok: true }),
      });

      expect(result).toEqual({
        ok: true,
        owner: { commandPath: "/pnpm/default", packagePath, version: "1.0.0", globalDir: base, globalRoot: group, globalBinDir: bin },
      });
      const pinnedList = calls.find(args => args[0] === "list" && args.includes(`--global-dir=${base}`));
      expect(pinnedList).toBeDefined();
      expect(pinnedList).not.toContain(`--global-dir=${group}`);
      expect(pinnedList).not.toContain(`${group}/v11`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pins both global group and bin directory and preserves the selected PATH", () => {
    const owner = ownerFor();
    expect(pnpmGlobalCommandArgs(["add", "-g", "--allow-build=bun", `${PKG}@2.0.0`], owner)).toEqual([
      "add",
      `--global-dir=${owner.globalDir}`,
      `--config.global-bin-dir=${owner.globalBinDir}`,
      "-g",
      "--allow-build=bun",
      `${PKG}@2.0.0`,
    ]);
    const env = pnpmOwnerEnvironment(owner, { PATH: "/usr/bin" }, "linux");
    expect(env.PATH).toBe(`${owner.globalBinDir}:/usr/bin`);
    expect(pnpmGlobalCommandArgs([
      "list", "-g", `--global-dir=${owner.globalDir}/wrong`, "--config.global-bin-dir", "/wrong/bin", PKG,
    ], owner)).toEqual([
      "list",
      `--global-dir=${owner.globalDir}`,
      `--config.global-bin-dir=${owner.globalBinDir}`,
      "-g", PKG,
    ]);
  });

  test("rejects a pinned verification when pnpm omits the group root", () => {
    const owner = ownerFor();
    const result = readPnpmGlobalPackage(
      PKG,
      () => ({
        status: 0,
        stdout: JSON.stringify([{ dependencies: { [PKG]: { version: "1.0.0", path: owner.packagePath } } }]),
      }),
      () => ({ ok: true }),
      { owner, expectedGlobalDir: owner.globalDir, globalBinDir: owner.globalBinDir, verifyShims: () => ({ ok: true }) },
    );
    expect(result).toEqual({ ok: false, reason: "pnpm did not report the selected global group" });
  });
});

function makePackageFixture(
  root: string,
  dependencyRoot: string,
  options: { packageDir?: string; linkDependenciesInside?: boolean } = {},
) {
  const packageDir = options.packageDir ?? join(root, "package");
  const bunDir = join(dependencyRoot, "bun");
  const zodDir = join(dependencyRoot, "zod");
  mkdirSync(join(packageDir, "bin", "nested"), { recursive: true });
  mkdirSync(join(packageDir, "node_modules"), { recursive: true });
  mkdirSync(join(bunDir, "bin"), { recursive: true });
  mkdirSync(zodDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: PKG,
    version: "2.0.0",
    dependencies: { bun: "1", zod: "1" },
  }));
  writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n" + "x".repeat(2048));
  writeFileSync(join(bunDir, "package.json"), JSON.stringify({ name: "bun" }));
  writeFileSync(join(bunDir, "bin", "bun.exe"), Buffer.alloc(10 * 1024 * 1024 + 1));
  writeFileSync(join(zodDir, "package.json"), JSON.stringify({ name: "zod" }));
  if (options.linkDependenciesInside !== false) {
    symlinkSync(bunDir, join(packageDir, "node_modules", "bun"), "dir");
    symlinkSync(zodDir, join(packageDir, "node_modules", "zod"), "dir");
  }
  return packageDir;
}

describe("pnpm package tree verification", () => {
  test("resolves dependencies through a custom virtual store and hoisted-style links", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-tree-"));
    try {
      const packageDir = makePackageFixture(root, join(root, "custom-virtual-store", "node_modules"));
      expect(verifyPnpmInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves a genuinely hoisted package from an ancestor node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-hoisted-"));
    try {
      const hoistedRoot = join(root, "global", "node_modules");
      const packageDir = makePackageFixture(root, hoistedRoot, {
        packageDir: join(hoistedRoot, "@bitkyc08", "opencodex"),
        linkDependenciesInside: false,
      });
      // A hoisted group is owned by pnpm only when pnpm's own bookkeeping says so; a bare
      // ancestor node_modules is somebody else's installation (#4203 review, Ingwannu).
      writeFileSync(join(hoistedRoot, ".modules.yaml"), "nodeLinker: hoisted\n");
      expect(verifyPnpmInstallTree(packageDir, "2.0.0")).toEqual({ ok: true, failures: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves dependencies through a pnpm package-root symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-linked-tree-"));
    try {
      const target = makePackageFixture(root, join(root, "store", "node_modules"));
      const exposed = join(root, "global", "v11", "node_modules", PKG);
      mkdirSync(dirname(exposed), { recursive: true });
      symlinkSync(target, exposed, "dir");
      expect(verifyPnpmInstallTree(exposed, "2.0.0")).toEqual({ ok: true, failures: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not accept a package tree whose runtime dependency cannot resolve", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-tree-missing-"));
    try {
      const packageDir = makePackageFixture(root, join(root, "deps"));
      rmSync(join(packageDir, "node_modules", "zod"), { force: true });
      expect(verifyPnpmInstallTree(packageDir, "2.0.0").ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pnpm generated shims", () => {
  function writeHostShims(globalBinDir: string, targetPackageDir: string, commands = ["ocx", "opencodex"]): void {
    const target = relative(globalBinDir, join(targetPackageDir, "bin", "ocx.mjs"));
    for (const command of commands) {
      if (process.platform === "win32") {
        const windowsTarget = target.replaceAll("/", "\\");
        writeFileSync(join(globalBinDir, `${command}.cmd`), `@echo off\r\nnode "%~dp0\\${windowsTarget}" %*\r\n`);
        writeFileSync(join(globalBinDir, `${command}.ps1`),
          `$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "$basedir\\${windowsTarget}" @args\n`);
      } else {
        writeFileSync(join(globalBinDir, command), `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/${target}" "$@"\n`);
        chmodSync(join(globalBinDir, command), 0o755);
      }
    }
  }

  test("verifies host-native shims point at the active package", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-shims-"));
    try {
      const packageDir = join(root, "global", "v11", "node_modules", PKG);
      const globalBinDir = join(root, "bin");
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      mkdirSync(globalBinDir, { recursive: true });
      writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n");
      writeHostShims(globalBinDir, packageDir);
      expect(verifyPnpmGlobalShims(packageDir, globalBinDir)).toEqual({ ok: true });
      writeHostShims(globalBinDir, join(root, "global", "v11", "node_modules", "old"), ["opencodex"]);
      expect(verifyPnpmGlobalShims(packageDir, globalBinDir).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts a pnpm group alias when it resolves to the active package", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-shim-alias-"));
    try {
      const activeGroup = join(root, "global", "v11", "active");
      const aliasGroup = join(root, "global", "v11", "stable-link");
      const packageDir = join(activeGroup, "node_modules", PKG);
      const globalBinDir = join(root, "bin");
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      mkdirSync(globalBinDir, { recursive: true });
      writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n");
      symlinkSync(activeGroup, aliasGroup, "dir");
      writeHostShims(globalBinDir, join(aliasGroup, "node_modules", PKG));
      expect(verifyPnpmGlobalShims(packageDir, globalBinDir)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Windows does not expose POSIX execute bits; target/alias coverage above still runs there.
  test.skipIf(process.platform === "win32")("requires executable permissions on POSIX shims", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-posix-mode-"));
    try {
      const packageDir = join(root, "node_modules", PKG);
      const globalBinDir = join(root, "bin");
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      mkdirSync(globalBinDir, { recursive: true });
      writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n");
      writeHostShims(globalBinDir, packageDir);
      expect(verifyPnpmGlobalShims(packageDir, globalBinDir)).toEqual({ ok: true });
      chmodSync(join(globalBinDir, "ocx"), 0o644);
      expect(verifyPnpmGlobalShims(packageDir, globalBinDir)).toEqual({
        ok: false, reason: "pnpm generated shim verification failed (ocx)",
      });
      chmodSync(join(globalBinDir, "ocx"), 0o755);
      expect(verifyPnpmGlobalShims(packageDir, globalBinDir)).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verifies Windows cmd and PowerShell shim forms", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-pnpm-win-shims-"));
    try {
      const packageDir = join(root, "global", "v11", "node_modules", PKG);
      const globalBinDir = join(root, "bin");
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      mkdirSync(globalBinDir, { recursive: true });
      writeFileSync(join(packageDir, "bin", "ocx.mjs"), "#!/usr/bin/env node\n");
      const target = relative(globalBinDir, join(packageDir, "bin", "ocx.mjs")).replaceAll("/", "\\");
      for (const name of ["ocx.cmd", "ocx.ps1", "opencodex.cmd", "opencodex.ps1"]) {
        const body = name.endsWith(".cmd")
          ? `@echo off\r\nnode "%~dp0\\${target}" %*\r\n`
          : `$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "$basedir\\${target}" @args\n`;
        writeFileSync(join(globalBinDir, name), body);
      }
      expect(verifyPnpmGlobalShims(packageDir, globalBinDir, "win32")).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface FakePnpmState {
  activeVersion: string;
  invalidVersions?: Set<string>;
  failVersions?: Set<string>;
  invalidShimVersions?: Set<string>;
  calls: { args: string[]; capture: boolean }[];
}

function fakePnpm(state: FakePnpmState, owner = ownerFor()): (args: readonly string[], capture?: boolean) => PnpmRunResult {
  return (args, capture = false) => {
    const normalized = [...args];
    state.calls.push({ args: normalized, capture });
    if (normalized[0] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([{
          path: owner.globalRoot,
          dependencies: {
            [PKG]: {
              version: state.activeVersion,
              path: state.activeVersion === "1.0.0"
                ? owner.packagePath
                : `/virtual/pnpm/${state.activeVersion}`,
            },
          },
        }]),
      };
    }
    if (normalized[0] !== "add") return { status: 1 };
    const spec = normalized.at(-1) ?? "";
    const requested = spec.slice(spec.lastIndexOf("@") + 1);
    if (state.failVersions?.has(requested)) return { status: 1 };
    state.activeVersion = requested;
    return { status: 0 };
  };
}

function fakeVerify(state: FakePnpmState, owner = ownerFor()) {
  return (path: string, expectedVersion?: string) => ({
    ok: (path === owner.packagePath || path === `/virtual/pnpm/${state.activeVersion}`)
      && expectedVersion === state.activeVersion
      && !state.invalidVersions?.has(state.activeVersion),
  });
}

function fakeShims(state: FakePnpmState) {
  return (_path: string, _bin: string, _platform?: string) => ({
    ok: !state.invalidShimVersions?.has(state.activeVersion),
  });
}

describe("pnpm global update", () => {
  test("updates through the selected pnpm owner and verifies the new active group", () => {
    const owner = ownerFor();
    const state: FakePnpmState = { activeVersion: "1.0.0", calls: [] };
    const result = runPnpmGlobalUpdate({
      packageName: PKG,
      currentVersion: "1.0.0",
      targetVersion: "2.0.0",
      tag: "latest",
      owner,
      runPnpm: fakePnpm(state, owner),
      verify: fakeVerify(state, owner),
      verifyShims: fakeShims(state),
    });

    expect(result).toMatchObject({ ok: true, phase: "done", version: "2.0.0", path: "/virtual/pnpm/2.0.0" });
    expect(state.calls.map(call => call.args)).toContainEqual([
      "add",
      `--global-dir=${owner.globalDir}`,
      `--config.global-bin-dir=${owner.globalBinDir}`,
      "-g", "--allow-build=bun", `${PKG}@2.0.0`,
    ]);
    expect(state.calls.every(call => call.args[0] !== "list" || call.args.includes(`--global-dir=${owner.globalDir}`))).toBe(true);
  });

  test("does not block on a stale pre-existing shim, but requires fresh shims after update", () => {
    const owner = ownerFor();
    const state: FakePnpmState = {
      activeVersion: "1.0.0",
      invalidShimVersions: new Set(["1.0.0"]),
      calls: [],
    };
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest", owner,
      runPnpm: fakePnpm(state, owner), verify: fakeVerify(state, owner), verifyShims: fakeShims(state),
    });
    expect(result).toMatchObject({ ok: true, phase: "done", version: "2.0.0" });
  });

  test("does not run a second transaction when a failed command leaves the verified old group active", () => {
    const owner = ownerFor();
    const state: FakePnpmState = { activeVersion: "1.0.0", failVersions: new Set(["2.0.0"]), calls: [] };
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest", owner,
      runPnpm: fakePnpm(state, owner), verify: fakeVerify(state, owner), verifyShims: fakeShims(state),
    });
    expect(result).toMatchObject({ ok: false, phase: "install", rolledBack: true, activePath: owner.packagePath });
    expect(state.calls.filter(call => call.args[0] === "add")).toHaveLength(1);
  });

  test("rolls back when a zero-exit install leaves an invalid tree or stale shim", () => {
    const owner = ownerFor();
    const state: FakePnpmState = {
      activeVersion: "1.0.0",
      invalidVersions: new Set(["2.0.0"]),
      invalidShimVersions: new Set(["2.0.0"]),
      calls: [],
    };
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest", owner,
      runPnpm: fakePnpm(state, owner), verify: fakeVerify(state, owner), verifyShims: fakeShims(state),
    });
    expect(result).toMatchObject({
      ok: false, phase: "rollback", rolledBack: true, activePath: owner.packagePath,
    });
    expect(state.calls.filter(call => call.args[0] === "add").map(call => call.args.at(-1))).toEqual([
      `${PKG}@2.0.0`, `${PKG}@1.0.0`,
    ]);
  });

  test("does not claim rollback when the restored group cannot be verified", () => {
    const owner = ownerFor();
    const state: FakePnpmState = {
      activeVersion: "1.0.0",
      invalidVersions: new Set(["2.0.0"]),
      failVersions: new Set(["1.0.0"]),
      calls: [],
    };
    const result = runPnpmGlobalUpdate({
      packageName: PKG, currentVersion: "1.0.0", targetVersion: "2.0.0", tag: "latest", owner,
      runPnpm: fakePnpm(state, owner), verify: fakeVerify(state, owner), verifyShims: fakeShims(state),
    });
    expect(result).toMatchObject({ ok: false, phase: "rollback", rolledBack: false });
    expect((result as { activePath?: string }).activePath).toBeUndefined();
  });
});

describe("shared registry integrity pre-flight", () => {
  test("fails closed only for successful metadata without sha512 and skips query failures", () => {
    expect(checkRegistryPackageIntegrity(PKG, "2.0.0", () => ({
      status: 0,
      stdout: '"sha512-abc="',
    }))).toEqual({ ok: true, integrity: "sha512-abc=" });
    expect(checkRegistryPackageIntegrity(PKG, "2.0.0", () => ({ status: 0, stdout: "sha1-deprecated" })).ok).toBe(false);
    expect(checkRegistryPackageIntegrity(PKG, "2.0.0", () => ({ status: 1 })).ok).toBe("skipped");
  });

  test("both launcher and Bun worker use the shared helper before stopping", () => {
    const launcher = readFileSync(join(dirname(import.meta.dir), "..", "bin", "ocx.mjs"), "utf8");
    const update = readFileSync(join(dirname(import.meta.dir), "..", "src", "update", "index.ts"), "utf8");
    expect(launcher).toContain("checkRegistryPackageIntegrity");
    expect(launcher.indexOf("checkRegistryPackageIntegrity")).toBeLessThan(launcher.indexOf("Stopping the running proxy"));
    expect(update).toContain("checkRegistryPackageIntegrity");
  });
});

describe("pnpm update command", () => {
  test("uses pnpm's native global build approval and pins resolved versions", () => {
    expect(updateCommand("pnpm", "latest", "2.50.0")).toEqual({
      bin: "pnpm",
      args: ["add", "-g", "--allow-build=bun", `${PKG}@2.50.0`],
    });
    expect(updateCommandStr("pnpm", "latest", "2.50.0")).toContain("pnpm add -g --allow-build=bun");
    expect(updateCommand("pnpm", "latest").args.at(-1)).toBe(`${PKG}@latest`);
  });
});
