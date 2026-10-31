import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  inspectCodexCliInstall,
  isAppBundledCodexPath,
  MAX_NATIVE_BACKING_BYTES,
  isCodexCliUpdateVersionManagerPath,
  type CodexCliInstallProvenanceDeps,
} from "../../src/codex/cli-install-provenance";
import { buildUnixCodexShim } from "../../src/codex/shim";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  VIRTUAL_BACKING_BINARY,
  VIRTUAL_BACKING_MANIFEST,
  VIRTUAL_ENTRYPOINT,
  VIRTUAL_LAUNCHER,
  VIRTUAL_MANIFEST,
  VIRTUAL_PACKAGE_ROOT,
  VIRTUAL_VENDOR_BINARY,
  virtualInspectionDeps,
  virtualManagedNpmGlobal,
  virtualPosixFs,
  VIRTUAL_MANIFEST_TEXT,
  VIRTUAL_ENTRYPOINT_TEXT,
  VIRTUAL_BACKING_TEXT,
} from "../helpers/codex-cli-content-fs";

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

  test("Windows defers without reading persisted candidate state", async () => {
    let calls = 0;
    const report = await inspectCodexCliInstall({
      ...noFilesystemDeps(() => { calls += 1; }),
      platform: "win32",
      configDir: "C:\\OpenCodex",
      env: { PATH: "C:\\Tools" },
    });
    // Persisted state is still never read on Windows, so the command cannot
    // know whether a candidate exists. It must not claim that none does.
    expect(report.reason).toBe("windows_inspection_deferred");
    expect(report.candidateAvailable).toBe(false);
    expect(report.candidateSource).toBeNull();
    expect(report.candidateVersion).toBeNull();
    expect(report.location).toBeNull();
    expect(report.provenance).toBe("unknown");
    expect(report.managed).toBe(false);
    expect(report.selectionAttested).toBe(false);
    expect(report.versionEvidence.kind).toBe("unavailable");
    expect(report.shim.status).toBe("unknown");
    expect(report.evidence).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a POSIX run with no observed candidate retains candidate_unavailable", async () => {
    let calls = 0;
    const report = await inspectCodexCliInstall({
      ...noFilesystemDeps(() => { calls += 1; }),
      platform: "linux",
      configDir: "relative-config-dir",
      env: { PATH: "" },
    });
    // The relative configuration path is rejected without I/O. This control
    // preserves the existing POSIX reason when no candidate is observed.
    expect(report.reason).toBe("candidate_unavailable");
    expect(report.candidateAvailable).toBe(false);
    expect(report.shim.status).toBe("not-tracked");
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

  test.skipIf(process.platform === "win32")("a proof-bound selection makes an npm-global install managed", async () => {
    const prefix = tempRoot("ocx-codex-managed-");
    const { launcher } = createPosixNpmGlobal(prefix);
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      selectionAttested: true,
      selectedCommand: launcher,
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report).toMatchObject({
      candidateSource: "environment",
      selectionAttested: true,
      provenance: "npm-global",
      managed: true,
      reason: "managed_npm_global",
      packageVersion: "1.2.3",
      versionEvidence: { kind: "package-manifest" },
    });
    // The attestation flag changes only the caller's assertion; paths stay redacted.
    expect(JSON.stringify(report)).not.toContain(prefix);
  });

  test.skipIf(process.platform === "win32")("a resolver pick on another path clears the attestation", async () => {
    const prefix = tempRoot("ocx-codex-resolver-mismatch-");
    const { launcher } = createPosixNpmGlobal(prefix);
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      env: { CODEX_CLI_PATH: launcher, PATH: "" },
      selectionAttested: true,
      // The resolver would settle on a different executable, so the snapshot's
      // installation must not become managed even though the caller asserts it.
      selectedCommand: join(prefix, "elsewhere", "codex"),
      inspectShim: () => ({ status: "not-tracked" }),
    });
    expect(report.selectionAttested).toBe(false);
    expect(report.managed).toBe(false);
    expect(report.reason).toBe("selection_unattested");
  });

  test.skipIf(process.platform === "win32")("attestation never rescues an install that is not manifest-owned", async () => {
    const prefix = tempRoot("ocx-codex-unmanaged-");
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
      selectionAttested: true,
      selectedCommand: launcher,
      inspectShim: () => ({ status: "not-tracked" }),
    });
    // The selection is attested but the layout is not a global npm install, so
    // ownership stays unproven and nothing becomes managed.
    expect(report.selectionAttested).toBe(true);
    expect(report.managed).toBe(false);
    expect(report.provenance).not.toBe("npm-global");
    expect(report.reason).toBe("npm_global_unverified");
  });

  test.skipIf(process.platform === "win32")("a persisted selection stays unmanaged even when the caller asserts it", async () => {
    const root = tempRoot("ocx-codex-persisted-unmanaged-");
    const { launcher } = createPosixNpmGlobal(root);
    writeFileSync(join(root, "codex-runtime.json"), `${JSON.stringify({
      version: 1,
      command: launcher,
      source: "path",
      selectedVersion: "1.2.3",
      updatedAt: "2026-08-28T00:00:00.000Z",
    })}\n`, "utf8");
    const report = await inspectCodexCliInstall({
      platform: process.platform,
      configDir: root,
      env: { PATH: "" },
      selectionAttested: true,
      inspectShim: () => ({ status: "not-tracked" }),
    });
    // The flag attests the environment channel only; a persisted candidate records
    // the configured intent, not the resolved runtime.
    expect(report.selectionAttested).toBe(false);
    expect(report.managed).toBe(false);
    expect(report.reason).toBe("selection_unattested");
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
      // The manifest proves the on-disk version even though an environment
      // candidate reports no advisory version of its own.
      versionEvidence: { kind: "package-manifest" },
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

describe("install content binding", () => {
  test("a manifest path identity change above numeric precision refuses", async () => {
    const fs = virtualManagedNpmGlobal();
    let changed = false;
    const deps = virtualInspectionDeps(fs, {
      lstat: (path: string, options?: { bigint?: boolean }) => {
        const value = fs.lstat(path, options) as object;
        return path === VIRTUAL_MANIFEST
          ? { ...value, ino: options?.bigint ? 9007199254740992n + BigInt(changed) : 9007199254740992 }
          : value;
      },
      stat: (path: string, options?: { bigint?: boolean }) => {
        const value = fs.stat(path, options) as object;
        return path === VIRTUAL_MANIFEST ? { ...value, ino: options?.bigint ? 9007199254740992n : 9007199254740992 } : value;
      },
      readFile: (path: string) => {
        const value = fs.readFile(path);
        if (path === VIRTUAL_MANIFEST) changed = true;
        return value;
      },
    });
    expect((await inspectCodexCliInstall(deps)).managed).toBe(false);
    expect(changed).toBe(true);
  });

  test("an ownership-only read never opens the backing bytes", async () => {
    const fs = virtualManagedNpmGlobal();
    const probed: string[] = [];
    const deps = virtualInspectionDeps(fs, {
      lstat: (path: string, options?: { bigint?: boolean }) => {
        if (path.includes("@openai/codex-")) probed.push(path);
        return fs.lstat(path, options);
      },
      readFile: (path: string) => {
        if (path === VIRTUAL_BACKING_BINARY) {
          throw new Error("must not read the native backing on a plain inspection");
        }
        return fs.readFile(path);
      },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.managed).toBe(true);
    expect(report.installContentDigest).toBeNull();
    expect(report.evidence).not.toContain("install_content_digest");
    expect(probed).toEqual([]);
  });

  test("a managed npm-global report binds the observed manifest, entrypoint and backing bytes", async () => {
    const fs = virtualManagedNpmGlobal();
    const report = await inspectCodexCliInstall(virtualInspectionDeps(fs, { observeInstallContent: true }));
    expect(report.managed).toBe(true);
    expect(report.reason).toBe("managed_npm_global");
    expect(report.installContentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.evidence).toContain("install_content_digest");
  });

  test("the same bytes observed again produce the same digest", async () => {
    const first = await inspectCodexCliInstall(virtualInspectionDeps(virtualManagedNpmGlobal(), { observeInstallContent: true }));
    const second = await inspectCodexCliInstall(virtualInspectionDeps(virtualManagedNpmGlobal(), { observeInstallContent: true }));
    expect(first.installContentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(second.installContentDigest).toBe(first.installContentDigest);
    expect(second.installDigest).toBe(first.installDigest);
  });

  test.each([
    ["manifest", VIRTUAL_MANIFEST, VIRTUAL_MANIFEST_TEXT.replace("1.2.3", "1.2.4")],
    ["entrypoint", VIRTUAL_ENTRYPOINT, "#!/usr/bin/env node\n// synthetic fixture altered!!!\n"],
    ["backing manifest", VIRTUAL_BACKING_MANIFEST, JSON.stringify({ name: "@openai/codex-linux-x64", version: "9.9.9" }) + "\n"],
    ["backing binary", VIRTUAL_BACKING_BINARY, "synthetic-native-backing-v2\n"],
  ])("a same-length change to the %s changes the content digest but keeps the location digest", async (_role, path, replacement) => {
    const original = virtualManagedNpmGlobal();
    const before = await inspectCodexCliInstall(virtualInspectionDeps(original, { observeInstallContent: true }));
    expect(before.installContentDigest).not.toBeNull();
    const mutated = virtualManagedNpmGlobal();
    const prior = (mutated.readFile(path)).length;
    mutated.setBytes(path, replacement);
    expect(mutated.readFile(path).length).toBe(prior);
    const after = await inspectCodexCliInstall(virtualInspectionDeps(mutated, { observeInstallContent: true }));
    expect(after.installContentDigest).not.toBeNull();
    expect(after.installContentDigest).not.toBe(before.installContentDigest);
    expect(after.installDigest).toBe(before.installDigest);
  });

  test("a missing platform backing package is refused, not bound as absent", async () => {
    const fs = virtualManagedNpmGlobal();
    fs.remove(VIRTUAL_BACKING_MANIFEST);
    fs.remove(VIRTUAL_BACKING_BINARY);
    // With no resolve hit and no modelable fallback globals, the lane is ambiguous.
    const report = await inspectCodexCliInstall(virtualInspectionDeps(fs, { observeInstallContent: true }));
    expect(report.managed).toBe(true);
    expect(report.installContentDigest).toBeNull();
  });

  test("a backing manifest resolving outside the npm prefix is refused", async () => {
    const fs = virtualManagedNpmGlobal({
      "/outside/codex-linux-x64/package.json": {
        data: JSON.stringify({ name: "@openai/codex-linux-x64", version: "1.2.3" }) + "\n",
      },
    });
    fs.redirect(VIRTUAL_BACKING_MANIFEST, "/outside/codex-linux-x64/package.json");
    const report = await inspectCodexCliInstall(virtualInspectionDeps(fs, { observeInstallContent: true }));
    expect(report.managed).toBe(true);
    expect(report.installContentDigest).toBeNull();
  });

  test("a backing read failure is never treated as absent backing", async () => {
    const fs = virtualManagedNpmGlobal();
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      readFile: (path: string) => {
        if (path === VIRTUAL_BACKING_MANIFEST) throw new Error("synthetic read denial");
        return fs.readFile(path);
      },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.installContentDigest).toBeNull();
  });

  test("an identity change between observations refuses", async () => {
    const fs = virtualManagedNpmGlobal();
    const backingStats = { count: 0 };
    const stat = fs.stat;
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      stat: (path: string, options?: { bigint?: boolean }) => {
        const result = stat(path, options);
        if (path === VIRTUAL_BACKING_BINARY) {
          backingStats.count += 1;
          if (backingStats.count === 1) fs.bumpIdentity(path);
        }
        return result;
      },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.installContentDigest).toBeNull();
  });

  test("a backing identity change above numeric precision refuses", async () => {
    const fs = virtualManagedNpmGlobal();
    let count = 0;
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      stat: (path: string, options?: { bigint?: boolean }) => {
        const value = fs.stat(path, options) as object;
        if (path !== VIRTUAL_BACKING_BINARY) return value;
        const changed = count++ > 0;
        return { ...value, ino: options?.bigint ? 9007199254740992n + BigInt(changed) : 9007199254740992 };
      },
    });
    expect((await inspectCodexCliInstall(deps)).installContentDigest).toBeNull();
    expect(count).toBeGreaterThan(1);
  });

  test("the package-vendor fallback binds when no resolve hit exists and globals are fully probed", async () => {
    const fs = virtualPosixFs({
      [VIRTUAL_LAUNCHER]: { link: VIRTUAL_ENTRYPOINT },
      [VIRTUAL_MANIFEST]: { data: VIRTUAL_MANIFEST_TEXT },
      [VIRTUAL_ENTRYPOINT]: { data: VIRTUAL_ENTRYPOINT_TEXT, mode: 0o755 },
      [VIRTUAL_VENDOR_BINARY]: { data: VIRTUAL_BACKING_TEXT, mode: 0o755 },
      "/virtual-npm/bin/node": { data: "synthetic-node\n", mode: 0o755 },
      "/virtual-home/.keep": { data: "" },
    });
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      env: { CODEX_CLI_PATH: VIRTUAL_LAUNCHER, PATH: "/virtual-npm/bin", HOME: "/virtual-home" },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.managed).toBe(true);
    expect(report.installContentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the vendor fallback refuses when the Node global lookup cannot be modeled", async () => {
    const fs = virtualPosixFs({
      [VIRTUAL_LAUNCHER]: { link: VIRTUAL_ENTRYPOINT },
      [VIRTUAL_MANIFEST]: { data: VIRTUAL_MANIFEST_TEXT },
      [VIRTUAL_ENTRYPOINT]: { data: VIRTUAL_ENTRYPOINT_TEXT, mode: 0o755 },
      [VIRTUAL_VENDOR_BINARY]: { data: VIRTUAL_BACKING_TEXT, mode: 0o755 },
    });
    // PATH is empty: node cannot be resolved, so <node-prefix>/lib/node cannot be
    // probed and the require.resolve failure the fallback needs is unproven.
    const report = await inspectCodexCliInstall(virtualInspectionDeps(fs, { observeInstallContent: true }));
    // Selection stays intact; only the content observation is refused.
    expect(report.managed).toBe(true);
    expect(report.installContentDigest).toBeNull();
  });

  test("missing lookup seeds refuse a global backing hit while preserving a local hit", async () => {
    const fs = virtualManagedNpmGlobal({
      "/virtual-npm/bin/node": { data: "synthetic-node\n", mode: 0o755 },
    });
    const env = { CODEX_CLI_PATH: VIRTUAL_LAUNCHER, PATH: "/virtual-npm/bin" };
    const deps = virtualInspectionDeps(fs, { observeInstallContent: true, env });
    // Missing HOME/NODE_PATH does not affect a local optional-package hit.
    expect((await inspectCodexCliInstall(deps)).installContentDigest).toMatch(/^[0-9a-f]{64}$/);

    fs.remove(VIRTUAL_BACKING_MANIFEST);
    fs.remove(VIRTUAL_BACKING_BINARY);
    const globalRoot = "/virtual-npm/lib/node/@openai/codex-linux-x64";
    fs.create(globalRoot + "/package.json", {
      data: JSON.stringify({ name: "@openai/codex-linux-x64", version: "1.2.3" }) + "\n",
    });
    fs.create(globalRoot + "/vendor/x86_64-unknown-linux-musl/bin/codex", {
      data: VIRTUAL_BACKING_TEXT, mode: 0o755,
    });
    // This same in-prefix Node-global backing binds with complete lookup seeds.
    expect((await inspectCodexCliInstall({ ...deps, env: { ...env, HOME: "/virtual-home" } }))
      .installContentDigest).toMatch(/^[0-9a-f]{64}$/);
    // Without them, unknown earlier global lanes can shadow the observed hit.
    const report = await inspectCodexCliInstall(deps);
    expect(report.managed).toBe(true);
    expect(report.installContentDigest).toBeNull();
  });

  test("a backing package appearing in an earlier lookup lane mid-observation refuses", async () => {
    const fs = virtualManagedNpmGlobal();
    const earlierManifest = VIRTUAL_PACKAGE_ROOT + "/bin/node_modules/@openai/codex-linux-x64/package.json";
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      readFile: (path: string) => {
        const bytes = fs.readFile(path);
        if (path === VIRTUAL_BACKING_BINARY) {
          // The modeled selector already resolved the nested optional package;
          // a package.json materializing in an earlier lane changes the answer.
          fs.create(earlierManifest, {
            data: JSON.stringify({ name: "@openai/codex-linux-x64", version: "1.2.3" }) + "\n",
          });
        }
        return bytes;
      },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.installContentDigest).toBeNull();
  });

  test("a backing package disappearing after selection refuses", async () => {
    const fs = virtualManagedNpmGlobal();
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      readFile: (path: string) => {
        const bytes = fs.readFile(path);
        if (path === VIRTUAL_BACKING_MANIFEST) fs.remove(VIRTUAL_BACKING_MANIFEST);
        return bytes;
      },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.installContentDigest).toBeNull();
  });

  test("a selected launcher retargeted while the backing is read refuses", async () => {
    const fs = virtualManagedNpmGlobal({
      "/elsewhere/codex.js": { data: "// swapped-in entrypoint\n", mode: 0o755 },
    });
    expect((await inspectCodexCliInstall(virtualInspectionDeps(fs, { observeInstallContent: true })))
      .installContentDigest).toMatch(/^[0-9a-f]{64}$/);
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      readFile: (path: string) => {
        const bytes = fs.readFile(path);
        // Canonical-path checks cannot see this: the entrypoint file itself is
        // untouched; only the selected launcher's lexical->canonical link moved.
        if (path === VIRTUAL_BACKING_BINARY) fs.redirect(VIRTUAL_LAUNCHER, "/elsewhere/codex.js");
        return bytes;
      },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.installContentDigest).toBeNull();
  });

  test("a backing package symlink retargeted while its binary is read refuses", async () => {
    const fs = virtualManagedNpmGlobal({
      "/elsewhere/codex-linux-x64/package.json": {
        data: JSON.stringify({ name: "@openai/codex-linux-x64", version: "9.9.9" }) + "\n",
      },
    });
    expect((await inspectCodexCliInstall(virtualInspectionDeps(fs, { observeInstallContent: true })))
      .installContentDigest).toMatch(/^[0-9a-f]{64}$/);
    const deps = virtualInspectionDeps(fs, {
      observeInstallContent: true,
      readFile: (path: string) => {
        const bytes = fs.readFile(path);
        if (path === VIRTUAL_BACKING_BINARY) {
          fs.redirect(VIRTUAL_BACKING_MANIFEST, "/elsewhere/codex-linux-x64/package.json");
        }
        return bytes;
      },
    });
    const report = await inspectCodexCliInstall(deps);
    expect(report.installContentDigest).toBeNull();
  });

  test("content observation is independent of the caller's selection attestation", async () => {
    const fs = virtualManagedNpmGlobal();
    const report = await inspectCodexCliInstall(virtualInspectionDeps(fs, { selectionAttested: false, observeInstallContent: true }));
    expect(report.managed).toBe(false);
    expect(report.reason).toBe("selection_unattested");
     // The digest binds the bytes that were read; ownership and selection stay separate.
     expect(report.installContentDigest).toMatch(/^[0-9a-f]{64}$/);
   });

  // Linux only: descriptor counting uses /proc/self/fd, and the held-read seam
  // is the native O_NOFOLLOW/O_NONBLOCK path. A refused file once leaked the
  // descriptor it had just opened, so each refusal is repeated enough times to
  // make a surviving leak impossible to miss.
  test.skipIf(process.platform !== "linux")("a refused content file never leaks its descriptor", async () => {
    const triples: Record<string, string> = {
      "linux:x64": "x86_64-unknown-linux-musl",
      "linux:arm64": "aarch64-unknown-linux-musl",
    };
    const packages: Record<string, string> = {
      "linux:x64": "@openai/codex-linux-x64",
      "linux:arm64": "@openai/codex-linux-arm64",
    };
    const triple = triples[process.platform + ":" + process.arch];
    const backingName = packages[process.platform + ":" + process.arch];
    expect(triple).toBeDefined();
    expect(backingName).toBeDefined();

    const root = tempRoot("ocx-cli-content-fd-");
    const prefix = join(root, "npm-prefix");
    const pkgRoot = join(prefix, "lib", "node_modules", "@openai", "codex");
    const backingPkg = join(pkgRoot, "node_modules", "@openai", backingName!.split("/")[1]);
    const backingBin = join(backingPkg, "vendor", triple!, "bin", "codex");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(pkgRoot, "bin"), { recursive: true });
    mkdirSync(join(backingPkg, "vendor", triple!, "bin"), { recursive: true });
    writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({
      name: "@openai/codex",
      version: "1.2.3",
      description: "synthetic fixture package - not a published artifact",
      bin: { codex: "bin/codex.js" },
    }, null, 2) + "\n");
    writeFileSync(join(pkgRoot, "bin", "codex.js"), "#!/usr/bin/env node\n// synthetic fixture\n");
    chmodSync(join(pkgRoot, "bin", "codex.js"), 0o755);
    writeFileSync(join(backingPkg, "package.json"), JSON.stringify({
      name: backingName,
      version: "1.2.3",
    }) + "\n");
    const launcher = join(prefix, "bin", "codex");
    symlinkSync(join("..", "lib", "node_modules", "@openai", "codex", "bin", "codex.js"), launcher);

    const deps: CodexCliInstallProvenanceDeps = {
      platform: "linux",
      arch: process.arch as NodeJS.Architecture,
      configDir: join(root, "config"),
      env: { CODEX_CLI_PATH: launcher, PATH: "", HOME: join(root, "home") },
      selectionAttested: true,
      selectedCommand: launcher,
      observeInstallContent: true,
      inspectShim: () => ({ status: "not-tracked" }),
    };
    const fdCount = () => readdirSync("/proc/self/fd").length;

    // A healthy install must bind before the refusal checks: without this the
    // loops below could pass while never reaching the descriptor path at all.
    writeFileSync(backingBin, "#!/bin/sh\n# synthetic fixture backing\n");
    const healthy = await inspectCodexCliInstall(deps);
    expect(healthy.installContentDigest).toMatch(/^[0-9a-f]{64}$/);

    // A directory at the backing-binary slot opens fine under O_RDONLY and is
    // then refused by the type check — the path that used to leak the fd.
    rmSync(backingBin);
    mkdirSync(backingBin);
    const beforeNonregular = fdCount();
    for (let i = 0; i < 25; i += 1) {
      const report = await inspectCodexCliInstall(deps);
      expect(report.installContentDigest).toBeNull();
    }
    expect(fdCount()).toBe(beforeNonregular);

    // A sparse oversize regular file takes the size check instead; same rule.
    rmSync(backingBin, { recursive: true, force: true });
    const fd = openSync(backingBin, "w");
    try {
      ftruncateSync(fd, MAX_NATIVE_BACKING_BYTES + 1);
    } finally {
      closeSync(fd);
    }
    const beforeOversize = fdCount();
    for (let i = 0; i < 25; i += 1) {
      const report = await inspectCodexCliInstall(deps);
      expect(report.installContentDigest).toBeNull();
    }
    expect(fdCount()).toBe(beforeOversize);
  });

  // POSIX only: exercises the native held-fd path and the end-of-observation
  // lexical->canonical re-resolution. The launcher swap happens at its final
  // resolution; Linux additionally verifies the backing descriptor is still
  // open at that boundary. No held descriptor prevents the symlink mutation.
  test.skipIf(process.platform === "win32")("a launcher retargeted during the native observation refuses", async () => {
    const backing: Record<string, { triple: string; pkg: string }> = {
      "linux:x64": { triple: "x86_64-unknown-linux-musl", pkg: "@openai/codex-linux-x64" },
      "linux:arm64": { triple: "aarch64-unknown-linux-musl", pkg: "@openai/codex-linux-arm64" },
      "darwin:x64": { triple: "x86_64-apple-darwin", pkg: "@openai/codex-darwin-x64" },
      "darwin:arm64": { triple: "aarch64-apple-darwin", pkg: "@openai/codex-darwin-arm64" },
    };
    const selected = backing[process.platform + ":" + process.arch];
    expect(selected).toBeDefined();

    const root = tempRoot("ocx-cli-content-retarget-");
    const prefix = join(root, "npm-prefix");
    const { launcher, packageRoot } = createPosixNpmGlobal(prefix);
    const backingPkg = join(packageRoot, "node_modules", "@openai", selected!.pkg.split("/")[1]);
    const backingBin = join(backingPkg, "vendor", selected!.triple, "bin", "codex");
    mkdirSync(join(backingPkg, "vendor", selected!.triple, "bin"), { recursive: true });
    writeFileSync(join(backingPkg, "package.json"), JSON.stringify({
      name: selected!.pkg,
      version: "1.2.3",
    }) + "\n");
    writeFileSync(backingBin, "#!/bin/sh\n# synthetic fixture backing\n");
    // realpath reports canonical paths; macOS temp roots sit behind /var -> /private/var.
    const canonicalBackingBin = realpathSync.native(backingBin);
    const swapped = join(root, "elsewhere", "codex.js");
    mkdirSync(dirname(swapped), { recursive: true });
    writeFileSync(swapped, "// swapped-in entrypoint\n");

    const baseDeps: CodexCliInstallProvenanceDeps = {
      platform: process.platform,
      arch: process.arch,
      configDir: join(root, "config"),
      env: { CODEX_CLI_PATH: launcher, PATH: "", HOME: join(root, "home") },
      selectionAttested: true,
      selectedCommand: launcher,
      observeInstallContent: true,
      inspectShim: () => ({ status: "not-tracked" }),
    };
    // Positive control first: without the seam the same fixture must bind, or
    // the refusal below proves nothing about the retarget path.
    const healthy = await inspectCodexCliInstall(baseDeps);
    expect(healthy.installContentDigest).toMatch(/^[0-9a-f]{64}$/);

    let backingSeen = false;
    let flipped = false;
    const report = await inspectCodexCliInstall({
      ...baseDeps,
      realpath: (path: string) => {
        if (backingSeen && !flipped && path === launcher) {
          if (process.platform === "linux") {
            const backingHeld = readdirSync("/proc/self/fd").some(fd => {
              try { return readlinkSync("/proc/self/fd/" + fd) === canonicalBackingBin; }
              catch { return false; }
            });
            expect(backingHeld).toBe(true);
          }
          flipped = true;
          rmSync(launcher);
          symlinkSync(swapped, launcher);
        }
        const resolved = realpathSync.native(path);
        if (resolved === canonicalBackingBin) backingSeen = true;
        return resolved;
      },
    });
    expect(flipped).toBe(true);
    // Selection still classified; only the content observation refused.
    expect(report.managed).toBe(true);
    expect(report.installContentDigest).toBeNull();
  });

  // POSIX only (the native held-descriptor reader). Sparse files keep this
  // cheap: the accepted size streams holes, and the over-limit size is refused
  // by fstat before any read.
  test.skipIf(process.platform === "win32")("a published-size native backing binds and one past the finite bound refuses", async () => {
    const backing: Record<string, { triple: string; pkg: string }> = {
      "linux:x64": { triple: "x86_64-unknown-linux-musl", pkg: "@openai/codex-linux-x64" },
      "linux:arm64": { triple: "aarch64-unknown-linux-musl", pkg: "@openai/codex-linux-arm64" },
      "darwin:x64": { triple: "x86_64-apple-darwin", pkg: "@openai/codex-darwin-x64" },
      "darwin:arm64": { triple: "aarch64-apple-darwin", pkg: "@openai/codex-darwin-arm64" },
    };
    const selected = backing[process.platform + ":" + process.arch];
    expect(selected).toBeDefined();

    const root = tempRoot("ocx-cli-content-large-");
    const { launcher, packageRoot } = createPosixNpmGlobal(join(root, "npm-prefix"));
    const backingPkg = join(packageRoot, "node_modules", "@openai", selected!.pkg.split("/")[1]);
    const backingBin = join(backingPkg, "vendor", selected!.triple, "bin", "codex");
    mkdirSync(dirname(backingBin), { recursive: true });
    writeFileSync(join(backingPkg, "package.json"), JSON.stringify({ name: selected!.pkg, version: "1.2.3" }) + "\n");
    const deps: CodexCliInstallProvenanceDeps = {
      platform: process.platform,
      arch: process.arch,
      configDir: join(root, "config"),
      env: { CODEX_CLI_PATH: launcher, PATH: "", HOME: join(root, "home") },
      selectionAttested: true,
      selectedCommand: launcher,
      observeInstallContent: true,
      inspectShim: () => ({ status: "not-tracked" }),
    };

    // The size of @openai/codex@0.163.0-linux-x64's binary, above the former 256 MiB bound.
    const publishedSize = 296_865_480;
    expect(publishedSize).toBeGreaterThan(256 * 1024 * 1024);
    writeFileSync(backingBin, "");
    truncateSync(backingBin, publishedSize);
    const published = await inspectCodexCliInstall(deps);
    expect(published.managed).toBe(true);
    expect(published.installContentDigest).toMatch(/^[0-9a-f]{64}$/);

    truncateSync(backingBin, MAX_NATIVE_BACKING_BYTES + 1);
    const oversized = await inspectCodexCliInstall(deps);
    expect(oversized.managed).toBe(true);
    expect(oversized.installContentDigest).toBeNull();
  });
});
