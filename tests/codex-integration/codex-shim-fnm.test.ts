import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findCodexOnPath, installCodexShim, lastCodexDiscoveryError, setCodexShimProbeObservationMsForTests } from "../../src/codex/shim";
import { SHIM_MARKER } from "../../src/codex/shim-templates";
import { isolateCodexShimEnvironment, prependPath } from "../helpers/codex-shim-install-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

isolateCodexShimEnvironment();

describe("fnm Codex shim discovery", () => {
  test.skipIf(process.platform === "win32")(
    "Unix fnm multishell install records only the durable node installation target",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-shim-install-fnm-"));
      const home = join(root, "opencodex-home");
      const multishellDir = join(root, "fnm_multishells", "619109");
      const multishellBin = join(multishellDir, "bin");
      const stableInstallation = join(root, "node-versions", "v24.20.0", "installation");
      const stableBin = join(stableInstallation, "bin");
      const packageBin = join(stableInstallation, "lib", "node_modules", "@openai", "codex", "bin");
      const stableCodex = join(stableBin, "codex");
      const packageCodex = join(packageBin, "codex.js");
      const multishellCodex = join(multishellBin, "codex");
      const oldPath = process.env.PATH;
      const oldHome = process.env.OPENCODEX_HOME;
      try {
        setCodexShimProbeObservationMsForTests(20);
        mkdirSync(home, { recursive: true });
        mkdirSync(join(root, "fnm_multishells"), { recursive: true });
        mkdirSync(stableBin, { recursive: true });
        mkdirSync(packageBin, { recursive: true });
        writeFileSync(packageCodex, "#!/bin/sh\n# fnm-stable-codex\nexit 0\n", "utf8");
        chmodSync(packageCodex, 0o755);
        symlinkSync(stableInstallation, multishellDir);
        symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", stableCodex);
        process.env.PATH = prependPath(multishellBin, oldPath);
        process.env.OPENCODEX_HOME = home;

        const installed = installCodexShim();
        const state = readFileSync(join(home, "codex-shim.json"), "utf8");

        expect(installed.installed).toBe(true);
        expect(installed.message).toContain(stableCodex);
        expect(installed.message).not.toContain("fnm_multishells");
        expect(state).toContain(stableCodex);
        expect(state).not.toContain("fnm_multishells");
        expect(state).not.toContain(packageCodex);
        expect(readFileSync(join(home, "bin", "codex"), "utf8")).toContain(SHIM_MARKER);
        expect(readFileSync(stableCodex, "utf8")).toContain("fnm-stable-codex");
        expect(readFileSync(multishellCodex, "utf8")).toContain("fnm-stable-codex");
        expect(readFileSync(packageCodex, "utf8")).toContain("fnm-stable-codex");
        expect(lstatSync(stableCodex).isSymbolicLink()).toBe(true);
        expect(existsSync(`${stableCodex}.opencodex-real`)).toBe(false);
        removeTreeWithRetry(join(root, "fnm_multishells"));
        expect(JSON.parse(state)).toMatchObject({ schema: 2, launcherPath: join(realpathSync(stableBin), "codex") });
        expect(readFileSync(stableCodex, "utf8")).toContain("fnm-stable-codex");
      } finally {
        setCodexShimProbeObservationMsForTests(null);
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = oldHome;
        removeTreeWithRetry(root);
      }
    },
  );

  test("fnm multishell discovery resolves to the durable node installation", () => {
    const multishell = "/home/u/.local/share/fnm/fnm_multishells/619109/bin";
    const stable = "/home/u/.local/share/fnm/node-versions/v24.20.0/installation/bin";
    const transientCodex = `${multishell}/codex`;
    const stableCodex = `${stable}/codex`;
    const found = findCodexOnPath({
      pathValue: multishell,
      posixPaths: true,
      exists: path => path === transientCodex,
      isShimFile: () => false,
      isDirectory: () => false,
      realpath: path => path === multishell ? stable : path,
    });
    expect(found).toBe(stableCodex);
    expect(found).not.toContain("fnm_multishells");
  });

  test("Windows-style fnm multishell discovery also resolves the durable target", () => {
    const multishell = "C:\\Users\\u\\AppData\\Local\\fnm_multishells\\619109\\bin";
    const stable = "C:\\Users\\u\\AppData\\Local\\fnm\\node-versions\\v24.20.0\\installation\\bin";
    const transientCodex = `${multishell}\\codex`;
    const stableCodex = `${stable}\\codex`;
    const found = findCodexOnPath({
      pathValue: multishell,
      posixPaths: false,
      exists: path => path === transientCodex,
      isShimFile: () => false,
      isDirectory: () => false,
      realpath: path => path === multishell ? stable : path,
    });
    expect(found).toBe(stableCodex);
    expect(found).not.toContain("fnm_multishells");
  });

  test("fnm multishell discovery refuses an unresolved or still-temporary target", () => {
    const multishell = "/home/u/.local/share/fnm/fnm_multishells/619109/bin";
    const transientCodex = `${multishell}/codex`;
    const fallback = "/usr/local/bin/codex";
    const found = findCodexOnPath({
      pathValue: `${multishell}:/usr/local/bin`,
      posixPaths: true,
      exists: path => path === transientCodex || path === fallback,
      isShimFile: () => false,
      isDirectory: () => false,
      realpath: path => path === multishell ? multishell : path,
    });
    expect(found).toBeNull();
    expect(lastCodexDiscoveryError()).toContain("Refusing to install a shim");
    expect(lastCodexDiscoveryError()).toContain("durable Node installation");
    expect(lastCodexDiscoveryError()).not.toContain(fallback);
  });

  test("stable nvm installation paths are not treated as fnm temporary paths", () => {
    const nvmBin = "/home/u/.nvm/versions/node/v24.20.0/bin";
    const nvmCodex = `${nvmBin}/codex`;
    const found = findCodexOnPath({
      pathValue: nvmBin,
      posixPaths: true,
      exists: path => path === nvmCodex,
      isShimFile: () => false,
      isDirectory: () => false,
      realpath: () => { throw new Error("non-fnm paths must not be realpathed"); },
    });
    expect(found).toBe(nvmCodex);
  });
});
