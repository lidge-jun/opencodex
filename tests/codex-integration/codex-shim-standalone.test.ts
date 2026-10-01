import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim } from "../../src/codex/shim-templates";
import { prependPath } from "../helpers/codex-shim-install-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

describe("standalone shim command generation (#6276)", () => {
  test("Unix invokes the executable directly without a virtual CLI entrypoint", () => {
    const script = buildUnixCodexShim("/bin/codex-real", "/opt/ocx app/ocx", "/$bunfs/root/cli/index.ts", "standalone");
    expect(script).toContain("'/opt/ocx app/ocx' ensure >/dev/null 2>&1");
    expect(script).not.toContain("/$bunfs/");
  });

  test("CMD invokes the executable directly without a virtual CLI entrypoint", () => {
    const script = buildWindowsCodexShim("C:\\codex-real.cmd", "C:\\ocx app\\ocx.exe", "C:\\~BUN\\root\\cli\\index.ts", "standalone");
    expect(script).toContain('"%OCX_BUN%" ensure >nul 2>nul');
    expect(script).not.toContain("~BUN");
  });

  test("PowerShell invokes the executable directly without a virtual CLI entrypoint", () => {
    const script = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\ocx app\\ocx.exe", "C:\\~BUN\\root\\cli\\index.ts", "standalone");
    expect(script).toContain("& 'C:\\ocx app\\ocx.exe' ensure *> $null");
    expect(script).not.toContain("~BUN");
  });
});

describe.skipIf(process.platform === "win32")("compiled Unix shim installation and launch (#6276)", () => {
  let root: string;
  let executable: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "ocx-compiled-shim-"));
    const entry = join(root, "entry.ts");
    executable = join(root, "ocx app's standalone");
    writeFileSync(entry, `
      import { installCodexShim, setCodexShimProbeObservationMsForTests } from ${JSON.stringify(repoPath("src", "codex", "shim.ts"))};
      import { writeFileSync } from "node:fs";
      setCodexShimProbeObservationMsForTests(20);
      if (process.argv[2] === "install") {
        console.log(JSON.stringify(installCodexShim()));
      } else if (process.argv[2] === "ensure" && process.argv.length === 3) {
        writeFileSync(process.env.OCX_TEST_ENSURE_FILE!, JSON.stringify({
          args: process.argv.slice(2), source: process.env.OCX_BUN_RUNTIME_SOURCE,
          path: process.env.OCX_BUN_RUNTIME_PATH, beBun: process.env.BUN_BE_BUN ?? null,
        }));
      } else {
        console.error("Unknown command:", process.argv[2]);
        process.exit(64);
      }
    `);
    const built = await Bun.build({ entrypoints: [entry], compile: { outfile: executable } });
    expect(built.success, built.logs.map(log => log.message).join("\n")).toBe(true);
    if (process.platform === "darwin") {
      const signed = spawnSync("codesign", ["--force", "--sign", "-", executable], { encoding: "utf8", timeout: SPAWN_BUDGET_MS });
      expect(signed.status, signed.stderr).toBe(0);
    }
  }, SPAWN_BUDGET_MS);

  afterAll(() => { if (root) removeTreeWithRetry(root); });

  function installFixture() {
    const dir = mkdtempSync(join(root, "case-"));
    const home = join(dir, "home");
    mkdirSync(home);
    const wrapper = join(dir, "codex");
    const probeEnvFile = join(dir, "probe-env");
    const ensureFile = join(dir, "ensure.json");
    writeFileSync(wrapper, `#!/bin/sh
if [ "\${OCX_SHIM_PROBE:-}" = "1" ]; then
  printf '%s\\n' "\${BUN_BE_BUN:-unset}" > "$OCX_TEST_PROBE_ENV"
  [ "\${BUN_BE_BUN:-}" != "1" ] || exit 64
  exit 0
fi
printf '%s\\n' real-codex "$@"
exit 7
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: prependPath(dir, process.env.PATH), OPENCODEX_HOME: home,
      OCX_TEST_PROBE_ENV: probeEnvFile, OCX_TEST_ENSURE_FILE: ensureFile,
    };
    for (const key of ["BUN_BE_BUN", "OCX_SHIM_ACTIVE_PID", "OCX_SHIM_ACTIVE_DEPTH", "OCX_SHIM_PROBE_ACTIVE", "OCX_SHIM_PROBE", "OCX_SHIM_BYPASS", "OCX_BUN_RUNTIME_SOURCE", "OCX_BUN_RUNTIME_PATH"]) delete env[key];
    const result = spawnSync(executable, ["install"], { env, encoding: "utf8", timeout: SPAWN_BUDGET_MS });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.signal ?? ""}: ${result.stderr}`).toBe(0);
    const installed = JSON.parse(result.stdout);
    expect(installed.installed, installed.message).toBe(true);
    return { wrapper, env, ensureFile, probeEnvFile };
  }

  test("installs through the compiled probe and confines BUN_BE_BUN to its supervisor", () => {
    const fixture = installFixture();
    expect(readFileSync(fixture.probeEnvFile, "utf8").trim()).toBe("unset");
    expect(fixture.env.BUN_BE_BUN).toBeUndefined();
  }, SPAWN_BUDGET_MS);

  test("an installed wrapper runs compiled ensure then preserves Codex args and exit status", () => {
    const fixture = installFixture();
    const result = spawnSync(fixture.wrapper, ["exec", "prompt with spaces"], { env: fixture.env, encoding: "utf8", timeout: SPAWN_BUDGET_MS });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual(["real-codex", "exec", "prompt with spaces"]);
    expect(JSON.parse(readFileSync(fixture.ensureFile, "utf8"))).toEqual({
      args: ["ensure"], source: "standalone", path: realpathSync(executable), beBun: null,
    });
    expect(readFileSync(fixture.wrapper, "utf8")).not.toContain("/$bunfs/");
  }, SPAWN_BUDGET_MS);
});
