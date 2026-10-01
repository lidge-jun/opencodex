import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildChatgptShimLauncher,
  chatgptShimLauncherPath,
  resolveChatgptCodexBinary,
  writeChatgptShimLauncher,
} from "../../src/chatgpt/app-server-shim/launcher";
import { selfLaunchArgv } from "../../src/lib/self-launch-argv";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const bashAvailable = process.platform !== "win32"
  && spawnSync("/bin/bash", ["-c", "exit 0"]).status === 0;
const substitutionAvailable = bashAvailable
  && spawnSync("/bin/bash", ["-c", "printf ok > >(cat)"], { encoding: "utf8" }).stdout === "ok";
const executionTest = substitutionAvailable ? test : test.skip;
const executable = (dir: string, name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
function withDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ocx-shim-test-"));
  try { run(dir); } finally { removeTreeWithRetry(dir); }
}
const internalArgs = ["internal", "chatgpt-app-server-filter"];

describe("experimental app-server launcher", () => {
  test("source and compiled argv re-enter the CLI with shell-safe quoting", () => {
    for (const standalone of [false, true]) {
      const argv = ["/runtime with 'quote", ...selfLaunchArgv(internalArgs, {
        isStandaloneExecutable: standalone, sourceEntrypoint: "/source with space/index.ts",
      })];
      const launcher = buildChatgptShimLauncher(argv, "/real with space");
      expect(launcher).toContain("'internal' 'chatgpt-app-server-filter'");
      expect(launcher.includes("'/source with space/index.ts'")).toBe(!standalone);
      expect(launcher).toContain("'\\''");
      expect(launcher).toContain('--self-test >/dev/null 2>&1');
      expect(launcher).toContain('"$(uname -s)" = "Darwin"');
      expect(launcher).toContain('exec "$REAL" "$@" > >(exec "${FILTER[@]}")');
    }
  });

  test("writer creates the launcher under the selected config dir with mode 0755", () => withDir(dir => {
    const path = writeChatgptShimLauncher(dir);
    expect(path).toBe(chatgptShimLauncherPath(dir));
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
  }));

  test("the bundled binary is derived from the discovered bundle root, not the conventional path", () => {
    const root = "/Users/example/Applications/ChatGPT.app";
    const current = `${root}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
    const legacy = `${root}/Contents/Resources/codex`;
    expect(resolveChatgptCodexBinary(root, path => path === current || path === legacy)).toBe(current);
    expect(resolveChatgptCodexBinary(root, path => path === legacy)).toBe(legacy);
    expect(resolveChatgptCodexBinary(root, () => false)).toBeNull();
  });

  test("the writer embeds the binary it is given", () => withDir(dir => {
    const real = "/Volumes/Apps/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    const path = writeChatgptShimLauncher(dir, real);
    expect(readFileSync(path, "utf8")).toContain(`REAL='${real}'`);
  }));

  // Stub uname activates the macOS precondition on Linux without requiring the actual app.
  const environment = (dir: string) => {
    executable(dir, "uname", 'echo Darwin');
    return { ...process.env, PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  };
  for (const scenario of ["missing runtime", "failing self-test", "passing self-test"] as const) {
    const scenarioTest = (scenario === "passing self-test" ? substitutionAvailable : bashAvailable) ? test : test.skip;
    scenarioTest(scenario, () => withDir(dir => {
      const real = executable(dir, "real with 'quote.sh", 'echo "PID:$$ ARGS:$*"\nread -r line\necho "STDIN:$line"\necho "to-stderr" >&2\nexit 7');
      const filter = scenario === "missing runtime" ? join(dir, "missing") : executable(dir, "filter.sh",
        `if [ "$1" = --self-test ]; then exit ${scenario === "failing self-test" ? 1 : 0}; fi\nsed 's/STDIN/FILTERED/'`);
      const launcher = executable(dir, "launcher.sh", buildChatgptShimLauncher([filter], real));
      const out = spawnSync("/bin/bash", [launcher, "app-server", "--flag"], {
        encoding: "utf8", input: "hello\n", env: environment(dir), timeout: 5000,
      });
      expect(out.status).toBe(7);
      expect(out.stdout).toBe(`PID:${out.pid} ARGS:app-server --flag\n${scenario === "passing self-test" ? "FILTERED" : "STDIN"}:hello\n`);
      expect(out.stderr).toBe("to-stderr\n");
    }));
  }

  executionTest("the real hidden CLI filter passes preflight and rewrites the gate", () => withDir(dir => {
    const real = executable(dir, "real.sh", `printf '%s\\n' '{"id":1,"result":{"ordinaryUsageAllowed":false,"rateLimits":{"primary":{"usedPercent":100}}}}'`);
    const argv = [process.execPath, ...selfLaunchArgv(internalArgs, {
      isStandaloneExecutable: false, sourceEntrypoint: repoPath("src/cli/index.ts"),
    })];
    const launcher = executable(dir, "launcher.sh", buildChatgptShimLauncher(argv, real));
    const out = spawnSync("/bin/bash", [launcher, "app-server"], { encoding: "utf8", env: environment(dir), timeout: 10000 });
    expect(out.status).toBe(0);
    const result = JSON.parse(out.stdout).result;
    expect(result.ordinaryUsageAllowed).toBe(true);
    expect(result.rateLimits.primary.usedPercent).toBe(100);
  }));

  executionTest("a filter exit after successful preflight closes the pipe and terminates a mock server", () => withDir(dir => {
    const real = executable(dir, "real.sh", 'trap "exit 23" PIPE\nwhile :; do printf "%s\\n" "mock server stdout" || exit 23; done');
    const filter = executable(dir, "filter.sh", 'if [ "$1" = --self-test ]; then exit 0; fi\nexit 1');
    const launcher = executable(dir, "launcher.sh", buildChatgptShimLauncher([filter], real));
    const out = spawnSync("/bin/bash", [launcher], { encoding: "utf8", env: environment(dir), timeout: 5000 });
    expect(out.error).toBeUndefined();
    expect(out.status).toBe(23);
  }));
});
