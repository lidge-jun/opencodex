import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";

const DEFAULT_BATCH_SIZE = 96;
const TEST_FILE_PATTERN = /(?:\.(?:test|spec)|_(?:test|spec))\.(?:js|jsx|ts|tsx)$/;

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
  if (process.platform === "win32") {
    // A Windows sandbox has to look like a real profile, because the known-folder APIs
    // resolve relative to USERPROFILE and .NET returns an EMPTY STRING — not an error —
    // when the folder it computes does not exist. `resolveWindowsRuntimeRoot` asks
    // PowerShell for `GetFolderPath(LocalApplicationData)`, so without these directories
    // every Codex coordinator lookup refuses with "Windows effective-account lookup
    // returned an empty value" and each refusal surfaces as an unrelated assertion in
    // whichever suite happened to touch a Codex home.
    mkdirSync(join(root, "AppData", "Local"), { recursive: true });
    mkdirSync(join(root, "AppData", "Roaming"), { recursive: true });
  }

  return {
    root,
    env: {
      ...baseEnv,
      // Captured BEFORE HOME is overwritten: once the child starts with a rewritten
      // HOME, `homedir()` returns the sandbox, so this hand-off is the only way the
      // real-home write guard can still know which path to protect.
      // (devlog 260730_codex_rs_upstream_v2_live_handoff/070.)
      OCX_REAL_HOME: baseEnv.OCX_REAL_HOME ?? homedir(),
      // Pin git's global config to the developer's real one before HOME moves.
      //
      // git resolves ~/.gitconfig from HOME, so a sandboxed HOME makes it invisible.
      // That silently drops `safe.directory`, and on a checkout whose directory owner
      // differs from the running account -- ordinary on Windows when a tool or
      // installer created the tree -- every `git` call a test makes then fails with
      // "detected dubious ownership". The test reads that as "this is not a git
      // repository" and asserts against a fallback, which looks like a product bug in
      // whichever adapter collected the metadata. Naming the file keeps the sandbox
      // (git still writes nothing here) while leaving git's own trust decisions intact.
      GIT_CONFIG_GLOBAL: baseEnv.GIT_CONFIG_GLOBAL ?? join(homedir(), ".gitconfig"),
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

export function collectTestFiles(root = "tests"): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) files.push(relative(process.cwd(), path).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

export function partitionTestFiles(files: readonly string[], batchSize: number): string[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("test batch size must be a positive integer");
  const batches: string[][] = [];
  for (let index = 0; index < files.length; index += batchSize) batches.push(files.slice(index, index + batchSize));
  return batches;
}

function configuredBatchSize(value: string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_BATCH_SIZE;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("OCX_TEST_BATCH_SIZE must be an integer between 1 and 500");
  }
  return parsed;
}

export async function acquireTestRunLock(
  lockPath = join(tmpdir(), "opencodex-full-test.lock"),
  options: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<() => void> {
  if (process.env.OCX_TEST_NO_QUEUE === "1") return () => {};
  const pollMs = options.pollMs ?? 5_000;
  const maxWaitMs = options.maxWaitMs ?? 45 * 60_000;
  const startedAt = Date.now();
  const token = crypto.randomUUID();
  const ownerPath = join(lockPath, "owner.json");
  let announced = false;
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: unknown; token?: unknown } | null = null;
      let oldEnoughToReclaim = false;
      try {
        owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown; token?: unknown };
      } catch {
        try { oldEnoughToReclaim = Date.now() - statSync(lockPath).mtimeMs > 30_000; } catch { /* lock changed; retry */ }
      }
      let ownerAlive = true;
      if (typeof owner?.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (probeError) {
          ownerAlive = (probeError as NodeJS.ErrnoException).code === "EPERM";
        }
      } else if (oldEnoughToReclaim) ownerAlive = false;
      if (!ownerAlive) {
        const stalePath = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
        try {
          renameSync(lockPath, stalePath);
          rmSync(stalePath, { recursive: true, force: true });
        } catch { /* another waiter won the stale-lock race */ }
        continue;
      }
      if (Date.now() - startedAt > maxWaitMs) throw new Error("timed out waiting for the exclusive test-runner lock");
      if (!announced) {
        announced = true;
        console.warn(`[test] another full suite owns ${lockPath}; waiting for it to finish.`);
      }
      await Bun.sleep(pollMs);
    }
  }
  return () => {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: unknown };
      if (owner.token !== token) return;
      const releasedPath = `${lockPath}.released-${process.pid}-${crypto.randomUUID()}`;
      renameSync(lockPath, releasedPath);
      rmSync(releasedPath, { recursive: true, force: true });
    } catch { /* ownership already ended or changed */ }
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

/**
 * Wait until this machine has no other full-suite runner, then proceed.
 *
 * Warning about contention was not enough: the warning scrolls past, the run still
 * starts, and four concurrent suites drove load average to 10 and turned a ~210s
 * suite into a 13-minute one that read as a hang. Agents in parallel worktrees each
 * think they are the only runner, so the serialization has to live here rather than
 * in anyone's discipline.
 *
 * Queue rather than refuse: a failed `bun run test` invites `bun test` directly,
 * which bypasses this file entirely. Waiting is the behavior that survives being
 * worked around. `OCX_TEST_NO_QUEUE=1` opts out for anyone who really wants overlap.
 */
async function waitForExclusiveRun(selfPid: number): Promise<void> {
  if (process.env.OCX_TEST_NO_QUEUE === "1") return;
  const pollMs = 5_000;
  // Long enough for a full suite plus slack; past this, assume the holder is wedged
  // rather than working and let this run start anyway.
  const maxWaitMs = 45 * 60 * 1000;
  const startedAt = Date.now();
  let announced = false;
  for (;;) {
    const competing = findCompetingTestRunners(selfPid);
    if (competing.length === 0) {
      if (announced) {
        console.warn(`[test] the other runner(s) finished after ${Math.round((Date.now() - startedAt) / 1000)}s; starting.`);
      }
      return;
    }
    if (Date.now() - startedAt > maxWaitMs) {
      console.warn(
        `[test] still waiting on pid ${competing.join(", ")} after ${Math.round(maxWaitMs / 60000)} minutes. `
        + "Assuming they are stuck and starting anyway; expect a slow run.",
      );
      return;
    }
    if (!announced) {
      announced = true;
      console.warn(
        `[test] ${competing.length} other bun test runner(s) already running (pid ${competing.join(", ")}). `
        + "Waiting for them to finish so the suites do not fight over the CPU. "
        + "Set OCX_TEST_NO_QUEUE=1 to run concurrently anyway.",
      );
    }
    await Bun.sleep(pollMs);
  }
}

if (import.meta.main) {
  let releaseLock = () => {};
  try {
    const requestedTests = process.argv.slice(2);
    if (requestedTests.length === 0) releaseLock = await acquireTestRunLock();
    await waitForExclusiveRun(process.pid);
    const startedAt = Date.now();
    const batches = requestedTests.length > 0
      ? [requestedTests]
      : partitionTestFiles(collectTestFiles(), configuredBatchSize(process.env.OCX_TEST_BATCH_SIZE));
    if (batches.length === 0) throw new Error("no test files found");
    if (requestedTests.length === 0) console.warn(`[test] running ${batches.flat().length} files in ${batches.length} fresh Bun processes.`);
    let exitCode = 0;
    for (const [index, batch] of batches.entries()) {
      const isolated = createIsolatedTestEnvironment();
      try {
        if (batches.length > 1) console.warn(`[test] batch ${index + 1}/${batches.length} (${batch.length} files)`);
        const child = Bun.spawnSync([process.execPath, "test", "--isolate", ...batch], {
          env: isolated.env,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        if (!child.success) {
          exitCode = child.exitCode ?? 1;
          break;
        }
      } finally {
        isolated.cleanup();
      }
    }
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    if (requestedTests.length === 0 && elapsedSeconds > 600) {
      console.warn(
        `[test] the suite took ${elapsedSeconds}s; it normally runs in about 210s on an idle machine. `
        + "Check for another test runner, a busy CPU, or a test that started polling something real.",
      );
    }
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`[test] ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}
