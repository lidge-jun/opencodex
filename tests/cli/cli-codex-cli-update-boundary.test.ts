import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { initializeNodeLauncherContext, NODE_LAUNCH_CONTEXT_ENV, NODE_LAUNCH_PROOF_PREFIX } from "../../src/cli/launcher-context";
import { inspectCodexCliInstall } from "../../src/codex/cli-install-provenance";

const roots: string[] = [];
afterEach(() => {
  initializeNodeLauncherContext(["bun", "cli"], {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex CLI selection inspection boundary", () => {
  (process.platform === "win32" ? test : test.skip)("Windows never resolves a captured remote candidate", async () => {
    const proof = "W".repeat(43);
    initializeNodeLauncherContext(["bun", "cli", `${NODE_LAUNCH_PROOF_PREFIX}${proof}`], {
      [NODE_LAUNCH_CONTEXT_ENV]: JSON.stringify({ version: 1, proof, anthropicEnvSlots: [],
        codexCliInspectionEnv: { codexCliPath: "\\\\fixture.invalid\\share\\codex.exe", path: "", pathExt: ".EXE", managerRoots: {}, configDir: "C:\\fixture" },
      }),
    });
    let resolutions = 0;
    expect(await handleCodexCliUpdateCommand(["check", "--json"], {
      resolveSelectedRuntime: () => { resolutions++; throw new Error("must not resolve on Windows"); },
      inspectInstall: async deps => {
        expect(deps.selectedCommand).toBeNull();
        return inspectCodexCliInstall({ ...deps, exists: () => { throw new Error("must not read a Windows candidate"); } });
      },
    })).toBe(0);
    expect(resolutions).toBe(0);
  });

  (process.platform === "win32" ? test.skip : test).each(["codex-runtime.json", "codex-shim.json"])(
    "published check cannot block on a FIFO %s before bounded provenance inspection", state => {
      const root = mkdtempSync(join(tmpdir(), "ocx-selection-boundary-"));
      roots.push(root);
      const home = join(root, "home");
      mkdirSync(home);
      const candidate = join(root, "codex");
      writeFileSync(candidate, "#!/bin/sh\nexit 91\n");
      chmodSync(candidate, 0o755);
      expect(spawnSync("mkfifo", [join(home, state)]).status).toBe(0);
      const result = spawnSync("node", [repoPath("bin", "ocx.mjs"), "system", "codex-cli-update", "check", "--json"], {
        cwd: repoRoot(), encoding: "utf8", timeout: 15_000,
        env: { ...process.env, OPENCODEX_HOME: home, CODEX_CLI_PATH: candidate },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).managed).toBe(false);
    },
  );
});
