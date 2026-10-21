/**
 * A bypassed shim launch (`OCX_SHIM_BYPASS`, native passthrough and the install probe) must not
 * load the service API token into `OPENCODEX_API_AUTH_TOKEN`: the real Codex and every process it
 * spawns would inherit the proxy's data-plane credential for a session that never talks to it.
 *
 * The POSIX case runs the real generated script; CMD and PowerShell cannot execute on every CI
 * host, so their cases check that the bypass gate precedes or guards the token load in the text.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnixCodexShim, buildWindowsCodexShim, buildWindowsPowerShellCodexShim } from "../../src/codex/shim-templates";
import { isolateCodexShimEnvironment } from "../helpers/codex-shim-install-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { INTERNAL_DEADLINE_MS } from "../helpers/test-budget";

isolateCodexShimEnvironment();

const FIXTURE_TOKEN = "ocx_fixture_token_not_a_secret";

function runUnixShim(bypass: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-shim-bypass-token-"));
  try {
    const realCodex = join(dir, "codex-real");
    writeFileSync(realCodex, '#!/bin/sh\nprintf "token=%s\\n" "${OPENCODEX_API_AUTH_TOKEN:-unset}"\n');
    chmodSync(realCodex, 0o755);
    const fakeBun = join(dir, "fake-bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBun, 0o755);
    const tokenFile = join(dir, "service-api-token");
    writeFileSync(tokenFile, FIXTURE_TOKEN);
    const wrapper = join(dir, "codex");
    writeFileSync(wrapper, buildUnixCodexShim(realCodex, fakeBun, join(dir, "cli.ts"), "process", tokenFile));
    chmodSync(wrapper, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, OCX_SHIM_BYPASS: bypass };
    delete env.OPENCODEX_API_AUTH_TOKEN;
    delete env.OCX_SHIM_ACTIVE_PID;
    delete env.OCX_SHIM_ACTIVE_DEPTH;
    delete env.OCX_SHIM_PROBE_ACTIVE;
    delete env.OCX_SHIM_PROBE;
    const result = spawnSync("/bin/sh", [wrapper, "exec", "hello"], { encoding: "utf8", env, timeout: INTERNAL_DEADLINE_MS });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  } finally {
    removeTreeWithRetry(dir);
  }
}

describe("Codex shim bypass never injects the service token", () => {
  test.skipIf(process.platform === "win32")("POSIX shim: bypass launches Codex without the token", () => {
    expect(runUnixShim("1")).toBe("token=unset");
  });

  test.skipIf(process.platform === "win32")("POSIX shim: a routed launch still loads the token (control)", () => {
    expect(runUnixShim("")).toBe(`token=${FIXTURE_TOKEN}`);
  });

  test("CMD shim: the bypass jump precedes the token read", () => {
    const cmd = buildWindowsCodexShim("C:\\codex-real.exe", "C:\\bun.exe", "C:\\cli.ts", "process");
    const bypass = cmd.indexOf('if not "%OCX_SHIM_BYPASS%"=="" goto run_codex');
    const tokenRead = cmd.indexOf("set /p OPENCODEX_API_AUTH_TOKEN=");
    expect(bypass).toBeGreaterThan(-1);
    expect(tokenRead).toBeGreaterThan(bypass);
    expect(cmd.match(/set \/p OPENCODEX_API_AUTH_TOKEN=/g)).toHaveLength(1);
  });

  test("PowerShell shim: the token load is gated on bypass being unset", () => {
    const ps = buildWindowsPowerShellCodexShim("C:\\codex-real.ps1", "C:\\bun.exe", "C:\\cli.ts", "process");
    const assignments = ps.split("\n").filter(line => line.includes("$env:OPENCODEX_API_AUTH_TOKEN = (Get-Content"));
    expect(assignments).toHaveLength(1);
    const guard = ps.slice(0, ps.indexOf(assignments[0]!)).split("\n").reverse().find(line => line.startsWith("if ("));
    expect(guard).toContain("-not $env:OCX_SHIM_BYPASS");
  });
});
