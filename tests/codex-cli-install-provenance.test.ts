import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectCodexCliInstall,
  isAppBundledCodexPath,
  isCodexCliUpdateVersionManagerPath,
  type CodexCliInstallProvenanceDeps,
} from "../src/codex/cli-install-provenance";
import { buildUnixCodexShim } from "../src/codex/shim";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function noFilesystemDeps(onCall: () => void): Pick<
  CodexCliInstallProvenanceDeps,
  "exists" | "lstat" | "stat" | "readFile" | "realpath" | "inspectShim"
> {
  const fail = (): never => {
    onCall();
    throw new Error("Windows lexical inspection must not access the filesystem");
  };
  return {
    exists: fail,
    lstat: fail as CodexCliInstallProvenanceDeps["lstat"],
    stat: fail as CodexCliInstallProvenanceDeps["stat"],
    readFile: fail,
    realpath: fail,
    inspectShim: fail as CodexCliInstallProvenanceDeps["inspectShim"],
  };
}

function createPosixNpmGlobal(prefix: string): { launcher: string; packageRoot: string; entrypoint: string } {
  const launcher = join(prefix, "bin", "codex");
  const packageRoot = join(prefix, "lib", "node_modules", "@openai", "codex");
  const entrypoint = join(packageRoot, "bin", "codex.js");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  writeFileSync(entrypoint, "#!/usr/bin/env node\n", "utf8");
  chmodSync(entrypoint, 0o755);
  symlinkSync(entrypoint, launcher);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex",
    version: "1.2.3",
    bin: { codex: "bin/codex.js" },
  }), "utf8");
  return { launcher, packageRoot, entrypoint };
}

describe("Codex CLI install provenance", () => {
  test("Windows ordinary, bare, remote, and device candidates fail closed without filesystem access", async () => {
    let calls = 0;
    const deps = noFilesystemDeps(() => { calls += 1; });
    for (const [command, reason] of [
      ["C:\\Tools\\codex.cmd", "windows_inspection_deferred"],
      ["codex", "candidate_path_unavailable"],
      ["\\Windows\\codex.cmd", "candidate_path_unavailable"],
      ["/Windows/codex.cmd", "candidate_path_unavailable"],
      ["\\\\server\\share\\codex.cmd", "candidate_path_unavailable"],
      ["\\\\?\\C:\\Tools\\codex.cmd", "candidate_path_unavailable"],
    ] as const) {
      const report = await inspectCodexCliInstall({
        ...deps,
        platform: "win32",
        configDir: "\\\\server\\share\\opencodex",
        env: { CODEX_CLI_PATH: command, PATH: "\\\\server\\share", PATHEXT: ".CMD" },
      });
      expect(report.candidateAvailable).toBe(true);
      expect(report.candidateSource).toBe("environment");
      expect(report.selectionAttested).toBe(false);
      expect(report.managed).toBe(false);
      expect(report.reason).toBe(reason);
      expect(report.packageVersion).toBeNull();
      expect(report.shim.status).toBe("unknown");
    }
    const driveRoot = await inspectCodexCliInstall({
      ...deps,
      platform: "win32",
      env: { CODEX_CLI_PATH: "C:\\Tools\\codex.cmd", NVM_HOME: "C:\\", PATH: "" },
    });
    expect(driveRoot.reason).toBe("windows_inspection_deferred");
    for (const [candidate, managerRoot] of [
      ["C:\\Users\\user\\.fnm\\..\\outside\\codex.cmd", undefined],
      ["C:\\custom-store\\..\\Tools\\codex.cmd", "C:\\custom-store"],
    ] as const) {
      const escaped = await inspectCodexCliInstall({
        ...deps,
        platform: "win32",
        env: {
          CODEX_CLI_PATH: candidate,
          PATH: "",
          ...(managerRoot ? { FNM_DIR: managerRoot } : {}),
        },
      });
      expect(escaped.reason).toBe("windows_inspection_deferred");
    }
    expect(calls).toBe(0);
  });

  test("Windows does not read persisted candidate state", async () => {
    let calls = 0;
    const report = await inspectCodexCliInstall({
      ...noFilesystemDeps(() => { calls += 1; }),
      platform: "win32",
      configDir: "C:\\OpenCodex",
      env: { PATH: "C:\\Tools" },
    });
    expect(report.candidateAvailable).toBe(false);
    expect(report.reason).toBe("candidate_unavailable");
    expect(report.shim.status).toBe("unknown");
    expect(calls).toBe(0);
  });

  test("Windows lexical app and version-manager candidates remain report-only", async () => {
    let calls = 0;
    const deps = noFilesystemDeps(() => { calls += 1; });
    for (const [path, provenance] of [
      ["C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.0.0\\codex.exe", "app-bundle"],
      ["C:\\Users\\user\\.fnm\\node-versions\\v22.1.0\\installation\\codex.exe", "version-manager"],
      ["C:\\custom-store\\v22\\codex.cmd", "version-manager"],
    ] as const) {
      const env = path.startsWith("C:\\custom-store")
        ? { CODEX_CLI_PATH: path, PATH: "", FNM_DIR: "C:\\custom-store" }
        : { CODEX_CLI_PATH: path, PATH: "" };
      const report = await inspectCodexCliInstall({ ...deps, platform: "win32", env });
      expect(report.provenance).toBe(provenance);
      expect(report.managed).toBe(false);
      expect(report.selectionAttested).toBe(false);
      expect(report.packageVersion).toBeNull();
      expect(report.shim.status).toBe("unknown");
    }
    expect(calls).toBe(0);
  });

  test("recognizes updater-only version-manager layouts without catching ordinary paths", () => {
    expect(isCodexCliUpdateVersionManagerPath("C:\\Users\\u\\.fnm\\node-versions\\v22\\installation\\codex.exe", "win32")).toBe(true);
    expect(isCodexCliUpdateVersionManagerPath("C:\\Users\\u\\scoop\\apps\\nodejs\\current\\codex.cmd", "win32")).toBe(true);
    expect(isCodexCliUpdateVersionManagerPath("/home/u/.nvm/versions/node/v22.1.0/bin/codex", "linux")).toBe(true);
    expect(isCodexCliUpdateVersionManagerPath("/opt/apps/service/releases/v2/data/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/opt/apps/nodejs/current/bin/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/srv/app/versions/2024/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/opt/node-versions/22/installation/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/srv/installs/node/22/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/opt/tools/image/node/22/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/home/u/.nvm/../outside/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/opt/plain\\.nvm\\bin/codex", "linux")).toBe(false);
    expect(isCodexCliUpdateVersionManagerPath("/opt/scoop/apps/tools/bin/codex", "linux")).toBe(false);
    expect(isAppBundledCodexPath("/opt/plain\\flatpak\\codex", "linux")).toBe(false);
    expect(isAppBundledCodexPath("/opt/flatpak/tools/bin/codex", "linux")).toBe(false);
    expect(isAppBundledCodexPath(
      "/var/lib/flatpak/app/com.openai.Codex/x86_64/stable/active/files/bin/codex",
      "linux",
    )).toBe(true);
    expect(isCodexCliUpdateVersionManagerPath("/usr/local/bin/codex", "linux")).toBe(false);
  });

  test("a POSIX filesystem-root manager setting does not claim unrelated absolute candidates", async () => {
    const fileStat = {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      size: 2,
      dev: 1,
      ino: 1,
      mtimeMs: 0,
    };
    for (const candidate of ["/usr/local/bin/codex", "//usr/local/bin/codex", "///usr/local/bin/codex"]) {
      const report = await inspectCodexCliInstall({
        platform: "linux",
        configDir: "/tmp/opencodex",
        env: { CODEX_CLI_PATH: candidate, N_PREFIX: "/", PATH: "" },
        exists: () => true,
        lstat: (() => fileStat) as never,
        stat: (() => fileStat) as never,
        realpath: path => path,
        readFile: (() => Buffer.from("{}", "utf8")) as never,
        boundedFileReadMode: "injected-test",
        inspectShim: () => ({ status: "not-tracked" }),
      });
      expect(report.provenance).toBe("standalone-unverified");
      expect(report.reason).toBe("unverified_standalone");
    }

    let injectedReads = 0;
    await inspectCodexCliInstall({
      platform: "linux",
      configDir: "/tmp/opencodex",
      env: { CODEX_CLI_PATH: "/virtual/codex", PATH: "" },
      exists: () => true,
      lstat: (() => fileStat) as never,
      stat: (() => fileStat) as never,
      realpath: path => path,
      readFile: (() => { injectedReads += 1; return Buffer.from("{}", "utf8"); }) as never,
      boundedFileReadMode: "invalid" as never,
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(injectedReads).toBe(0);
  });

  test.skipIf(process.platform === "win32")("proves a configured POSIX npm symlink and redacts paths", async () => {
    const prefix = tempRoot("ocx-codex-posix-npm-");
    const { launcher } = createPosixNpmGlobal(prefix);
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report).toMatchObject({
      candidateAvailable: true,
      candidateSource: "environment",
      selectionAttested: false,
      provenance: "npm-global",
      managed: false,
      reason: "selection_unattested",
      packageVersion: "1.2.3",
      location: "<path>/codex.js",
    });
    expect(JSON.stringify(report)).not.toContain(prefix);
    expect(JSON.stringify(report)).not.toContain("authority");
  });

  test.skipIf(process.platform !== "linux")("does not mistake a flatpak path component for an app bundle", async () => {
    const prefix = join(tempRoot("ocx-codex-flatpak-component-"), "flatpak", "tools");
    const { launcher } = createPosixNpmGlobal(prefix);
    const report = await inspectCodexCliInstall({
      platform: "linux",
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });

    expect(report.provenance).toBe("npm-global");
    expect(report.reason).toBe("selection_unattested");
    expect(report.packageVersion).toBe("1.2.3");
    expect(report.evidence).toEqual(expect.arrayContaining([
      "package_manifest",
      "package_manifest_digest",
      "global_npm_layout",
    ]));
  });

  test.skipIf(process.platform !== "linux")("does not mistake a Scoop path component for a version manager", async () => {
    const prefix = join(tempRoot("ocx-codex-scoop-component-"), "scoop", "apps", "tools");
    const { launcher } = createPosixNpmGlobal(prefix);
    const report = await inspectCodexCliInstall({
      platform: "linux",
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });

    expect(report.provenance).toBe("npm-global");
    expect(report.reason).toBe("selection_unattested");
    expect(report.packageVersion).toBe("1.2.3");
    expect(report.evidence).toEqual(expect.arrayContaining([
      "package_manifest",
      "package_manifest_digest",
      "global_npm_layout",
    ]));
  });

  test.skipIf(process.platform === "win32")("proves a POSIX npm global through a symlinked prefix", async () => {
    const prefix = tempRoot("ocx-codex-posix-prefix-");
    const { launcher: physicalLauncher } = createPosixNpmGlobal(prefix);
    const alias = `${prefix}-alias`;
    roots.push(alias);
    symlinkSync(prefix, alias, "dir");
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: join(alias, "bin", "codex"), PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(physicalLauncher).not.toBe(join(alias, "bin", "codex"));
    expect(report.provenance).toBe("npm-global");
    expect(report.reason).toBe("selection_unattested");
    expect(JSON.stringify(report)).not.toContain(prefix);
    expect(JSON.stringify(report)).not.toContain(alias);
  });

  test.skipIf(process.platform === "win32")("does not adopt a project-local POSIX node_modules layout", async () => {
    const prefix = tempRoot("ocx-codex-posix-project-");
    const launcher = join(prefix, "bin", "codex");
    const packageRoot = join(prefix, "node_modules", "@openai", "codex");
    const entrypoint = join(packageRoot, "bin", "codex.js");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(entrypoint, "#!/usr/bin/env node\n", "utf8");
    chmodSync(entrypoint, 0o755);
    symlinkSync(entrypoint, launcher);
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" },
    }), "utf8");
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report.managed).toBe(false);
    expect(report.provenance).not.toBe("npm-global");
    expect(report.reason).toBe("npm_global_unverified");
    expect(report.versionEvidence.kind).toBe("unavailable");

    writeFileSync(join(prefix, "codex-runtime.json"), `${JSON.stringify({
      version: 1,
      command: launcher,
      source: "path",
      selectedVersion: "1.2.3",
      updatedAt: "2026-08-28T00:00:00.000Z",
    })}\n`, "utf8");
    const persisted = await inspectCodexCliInstall({
      platform: process.platform,
      configDir: prefix,
      env: { PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(persisted.reason).toBe("npm_global_unverified");
    expect(persisted.versionEvidence.kind).toBe("advisory-runtime");
  });

  test.skipIf(process.platform === "win32")("fails closed on literal or relative POSIX PATH shadowing", async () => {
    const prefix = tempRoot("ocx-codex-posix-path-");
    createPosixNpmGlobal(prefix);
    for (const path of [`${join(prefix, "bin")} `, `relative:${join(prefix, "bin")}`]) {
      const report = await inspectCodexCliInstall({
        platform: process.platform,
        env: { CODEX_CLI_PATH: "codex", PATH: path },
        inspectShim: () => ({ status: "not-tracked" }),
      });
      expect(report.reason).toBe("candidate_path_unavailable");
    }
  });

  test.skipIf(process.platform === "win32")("rejects a manifest entrypoint redirected outside its package root", async () => {
    const prefix = tempRoot("ocx-codex-external-entry-");
    const packageRoot = join(prefix, "lib", "node_modules", "@openai", "codex");
    const launcher = join(prefix, "bin", "codex");
    const outside = join(prefix, "outside-bin");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const externalEntrypoint = join(outside, "codex.js");
    writeFileSync(externalEntrypoint, "#!/usr/bin/env node\n", "utf8");
    chmodSync(externalEntrypoint, 0o755);
    symlinkSync(outside, join(packageRoot, "bin"), "dir");
    symlinkSync(externalEntrypoint, launcher);
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
      name: "@openai/codex", version: "1.2.3", bin: { codex: "bin/codex.js" },
    }), "utf8");
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report.managed).toBe(false);
    expect(report.provenance).not.toBe("npm-global");
  });

  test("uses canonical POSIX paths instead of escaped manager-looking aliases", async () => {
    const lexical = "/home/u/.nvm/bin/codex";
    const canonical = "/opt/outside/codex";
    const managerRoot = "/home/u/.nvm";
    const fileStat = {
      isFile: () => true,
      isSymbolicLink: () => false,
      mode: 0o755,
      size: 2,
      dev: 1,
      ino: 1,
      mtimeMs: 0,
    };
    const candidatePaths = new Set([lexical, canonical]);
    const report = await inspectCodexCliInstall({
      platform: "linux",
      configDir: "/tmp/opencodex",
      env: { CODEX_CLI_PATH: lexical, NVM_DIR: managerRoot, PATH: "" },
      exists: path => candidatePaths.has(path),
      lstat: (path => {
        if (!candidatePaths.has(path)) throw new Error("absent");
        return fileStat;
      }) as never,
      stat: (path => {
        if (!candidatePaths.has(path)) throw new Error("absent");
        return fileStat;
      }) as never,
      realpath: path => path === lexical ? canonical : path,
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report.provenance).toBe("standalone-unverified");
    expect(report.reason).toBe("unverified_standalone");
  });

  test.skipIf(process.platform === "win32")("does not classify a manager-looking symlink that resolves outside its root", async () => {
    const root = tempRoot("ocx-codex-manager-escape-");
    const managerRoot = join(root, ".nvm");
    const launcher = join(managerRoot, "bin", "codex");
    const outside = join(root, "outside", "codex");
    mkdirSync(join(managerRoot, "bin"), { recursive: true });
    mkdirSync(join(root, "outside"), { recursive: true });
    writeFileSync(outside, "#!/usr/bin/env node\n", "utf8");
    chmodSync(outside, 0o755);
    symlinkSync(outside, launcher);

    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, NVM_DIR: managerRoot, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report.provenance).toBe("standalone-unverified");
    expect(report.reason).toBe("unverified_standalone");
  });

  test.skipIf(process.platform === "win32")("persisted and environment npm candidates remain unattested", async () => {
    const root = tempRoot("ocx-codex-unattested-");
    const { launcher } = createPosixNpmGlobal(root);
    writeFileSync(join(root, "codex-runtime.json"), `${JSON.stringify({
      version: 1,
      command: launcher,
      source: "path",
      selectedVersion: "1.2.3",
      updatedAt: "2026-08-28T00:00:00.000Z",
    })}\n`, "utf8");
    const persisted = await inspectCodexCliInstall({
      platform: process.platform,
      configDir: root,
      env: { PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(persisted).toMatchObject({
      candidateSource: "persisted",
      candidateVersion: "1.2.3",
      selectionAttested: false,
      provenance: "npm-global",
      managed: false,
      reason: "selection_unattested",
      versionEvidence: { kind: "package-manifest" },
    });

    writeFileSync(join(root, "codex-runtime.json"), `${JSON.stringify({
      version: 1,
      command: launcher,
      source: "path",
      selectedVersion: "1.2.4",
      updatedAt: "2026-08-28T00:00:00.000Z",
    })}\n`, "utf8");
    const mismatched = await inspectCodexCliInstall({
      platform: process.platform,
      configDir: root,
      env: { PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(mismatched).toMatchObject({
      candidateVersion: "1.2.4",
      packageVersion: "1.2.3",
      reason: "version_mismatch",
      versionEvidence: { kind: "advisory-runtime" },
    });

    const environment = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(environment).toMatchObject({
      candidateSource: "environment",
      candidateVersion: null,
      packageVersion: "1.2.3",
      selectionAttested: false,
      managed: false,
      reason: "selection_unattested",
      versionEvidence: { kind: "unavailable" },
    });
  });

  test.skipIf(process.platform === "win32")("rejects a symbolic-link persisted-state file before reading", async () => {
    const root = tempRoot("ocx-codex-state-link-");
    let reads = 0;
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      configDir: root,
      env: { PATH: "" },
      lstat: (() => ({ isSymbolicLink: () => true, isFile: () => false })) as never,
      readFile: (() => { reads += 1; throw new Error("must not read"); }) as never,
    });
    expect(report.reason).toBe("candidate_unavailable");
    expect(reads).toBe(0);
  });

  test.skipIf(process.platform === "win32")("a POSIX version-manager candidate remains report-only", async () => {
    const root = tempRoot("ocx-codex-posix-fnm-");
    const launcher = join(root, ".fnm", "codex");
    mkdirSync(join(root, ".fnm"), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(launcher, 0o755);
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report.provenance).toBe("version-manager");
    expect(report.managed).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the real POSIX shim inspector keeps wrapper and backing candidates report-only", async () => {
    const root = tempRoot("ocx-codex-shim-deferred-");
    const wrapper = join(root, "codex");
    const backing = join(root, "codex.real");
    writeFileSync(wrapper, buildUnixCodexShim(
      backing,
      join(root, "bun"),
      join(root, "cli.ts"),
      "bundled",
      join(root, "token"),
    ), "utf8");
    writeFileSync(backing, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(wrapper, 0o755);
    chmodSync(backing, 0o755);
    const file = { wrapperPath: wrapper, originalPath: wrapper, backupPath: backing };
    writeFileSync(join(root, "codex-shim.json"), `${JSON.stringify({
      platform: process.platform,
      ...file,
      wrappers: [file],
    }, null, 2)}\n`, "utf8");
    const backingAlias = join(root, "codex-alias");
    linkSync(backing, backingAlias);
    for (const candidatePath of [wrapper, backing, backingAlias]) {
      const report = await inspectCodexCliInstall({
        platform: process.platform,
        configDir: root,
        env: { CODEX_CLI_PATH: candidatePath, PATH: "" },
      });
      expect(report.reason).toBe("shim_update_deferred");
      expect(report.shim.status).toBe("matched");
      expect(report.managed).toBe(false);
    }
  });
});
