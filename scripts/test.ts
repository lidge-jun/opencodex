import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  return {
    root,
    env: {
      ...baseEnv,
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Other `bun test` runners already on this machine.
 *
 * Two full suites sharing one CPU do not fail — they crawl. A run that normally
 * finishes in about 210s took 26 minutes against a runner an earlier session had
 * left behind, and neither process said anything, so the slowdown read as a hang
 * in this suite. Bun's own timeouts cannot see the contention, so name it here.
 *
 * `pgrep` is absent on Windows and may exit non-zero for "no matches"; both cases
 * mean "nothing to warn about" rather than an error worth failing a test run over.
 */
function findCompetingTestRunners(selfPid: number): number[] {
  try {
    const found = Bun.spawnSync(["pgrep", "-f", "bun.*test --isolate"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!found.success) return [];
    return new TextDecoder().decode(found.stdout)
      .split("\n")
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== selfPid);
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    const competing = findCompetingTestRunners(process.pid);
    if (competing.length > 0) {
      console.warn(
        `[test] ${competing.length} other bun test runner(s) are already running (pid ${competing.join(", ")}). `
        + "They share this machine's CPU, so this run will be much slower than usual and can look hung. "
        + "Stop them first if that is not what you meant.",
      );
    }
    const startedAt = Date.now();
    const child = Bun.spawnSync(
      [process.execPath, "test", "--isolate", ...(requestedTests.length > 0 ? requestedTests : ["./tests/"])],
      {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (requestedTests.length === 0 && elapsedSeconds > 600) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s; it normally runs in about 210s on an idle machine. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = child.exitCode ?? 1;
  } finally {
    isolated.cleanup();
  }
}
