import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendLabEvent,
  assertNotUnderUserRepo,
  assertSafeRelativePosixPath,
  assignEventId,
  buildTaskSubjectV1,
  correctSyntheticPatch,
  createLabDestination,
  createSyntheticScratch,
  fabricDeclaredSandboxPolicy,
  FABRIC_VERIFIER_ID,
  LAB_EVENT_SCHEMA_VERSION,
  LAB_PRODUCER,
  observationFromFabricOutcome,
  persistFabricRunResult,
  queryLabCatalog,
  readVerdictSnapshot,
  rebuildLabProjection,
  replayLabLedger,
  runFabricSyntheticPatchTaskForRoute,
  runFabricSyntheticPatchTaskHarness,
  sandboxProfileDigest,
  subjectIdForSubject,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
  taskFixtureDigest,
  taskFixtureObject,
  taskSubjectId,
  verifierManifestDigest,
  verifierManifestObject,
  type RouteSubjectV1,
} from "../src/lab";
import { FabricTaskError } from "../src/lab/fabric/types";
import { writeScratchFileUtf8, readScratchFileUtf8 } from "../src/lab/fabric/scratch";
import { routingProfileIssues } from "../src/routing/profile";
import { buildInvalidationIndex } from "../src/lab/ledger/invalidation";
import { createArtifactStore } from "../src/lab/artifacts/store";
import { ensureLabDirs, ensureRestrictedDir } from "../src/lab/paths";
import { verifyExactTreeDiffV1 } from "../src/lab/fabric/verifier";
import { parseSyntheticPatchV1 } from "../src/lab/fabric/patch";
import { FABRIC_LIMITS } from "../src/lab/fabric/constants";
import { minimalFabricChildEnv, setFabricProducerIsolationLimitsForTests } from "../src/lab/fabric/producer-isolate";
import { taskSubjectApplicableToRequirements } from "../src/lab/projection/verification";
import { createHostIssuedFabricPatchExecutor } from "../src/lib/fabric-task-host";
import type { TrustedFabricPatchExecutor } from "../src/lab/fabric/types";
import { watchdogMs } from "./helpers/ci-watchdog";
import {
  fabricCorrectPatchExecutor,
  fabricMockRoute,
  fabricOversizedPatchExecutor,
  fabricRouteBoundPatchExecutor,
  runTrustedFabricTask,
} from "./helpers/fabric-task-test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD_REAP_GRACE_MS = 2_000;

async function awaitChildExitWithin(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    child.exited.then(() => true, () => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
}

async function terminateChildWithin(child: Bun.Subprocess): Promise<boolean> {
  if (child.exitCode !== null) return true;
  try { child.kill(); } catch { /* already exited */ }
  if (await awaitChildExitWithin(child, CHILD_REAP_GRACE_MS)) return true;
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
  return await awaitChildExitWithin(child, CHILD_REAP_GRACE_MS);
}

const CREDENTIAL_CANARY = "credential-canary-abcdefghijklmnopqrstuvwxyz1234567890";
const FAST_FABRIC_ISOLATION = Object.freeze({
  totalTimeoutMs: 2_000,
  inactivityTimeoutMs: 750,
});

const HOMES: string[] = [];

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-cl07-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

function repoImport(subpath: string): string {
  return join(REPO_ROOT, subpath).replace(/\\/g, "/");
}

async function fabricDestination(home: string) {
  return createLabDestination({
    baseUrl: "https://api.example.com/v1",
    labRunApproval: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    configDir: home,
  });
}

function fabricActivityPatchExecutor(home: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "activity-patch.ts");
  writeFileSync(modulePath, `
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_AFTER_UTF8, SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";

export async function execute(input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  for (let i = 0; i < 3; i++) {
    input.reportActivity();
    await Bun.sleep(Math.floor(${FAST_FABRIC_ISOLATION.inactivityTimeoutMs} * 0.4));
  }
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async (input) => {
    for (let i = 0; i < 3; i++) {
      input.reportActivity();
      await Bun.sleep(Math.floor(FAST_FABRIC_ISOLATION.inactivityTimeoutMs * 0.4));
    }
    return correctSyntheticPatch();
  });
}

function fabricInactivePatchExecutor(home: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "inactive-patch.ts");
  writeFileSync(modulePath, `
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_AFTER_UTF8, SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";

export async function execute(_input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  await Bun.sleep(${FAST_FABRIC_ISOLATION.inactivityTimeoutMs} + 50);
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async () => {
    await Bun.sleep(FAST_FABRIC_ISOLATION.inactivityTimeoutMs + 50);
    return correctSyntheticPatch();
  });
}

function fabricTraversalPatchExecutor(home: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "traversal-patch.ts");
  writeFileSync(modulePath, `
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";

export async function execute(_input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: "../outside.txt", contentUtf8: "evil\\n" }],
  };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async () => ({
    schemaVersion: 1,
    operations: [{ op: "replace", path: "../outside.txt", contentUtf8: "evil\n" }],
  }));
}

function fabricOutsideScratchWriteExecutor(home: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const outside = join(home, "outside-scratch");
  mkdirSync(outside, { recursive: true });
  const modulePath = join(dir, "outside-write.ts");
  writeFileSync(modulePath, `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_AFTER_UTF8, SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";

const outside = "${outside.replace(/\\/g, "/")}";

export async function execute(_input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  writeFileSync(join(outside, "evil.txt"), "evil\\n");
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async () => correctSyntheticPatch());
}

function fabricTmpdirProbeExecutor(home: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "tmpdir-probe.ts");
  writeFileSync(modulePath, `
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_AFTER_UTF8, SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";

export async function execute(input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  const scratchRoot = resolve(input.scratchRoot);
  const observedTmpdir = resolve(tmpdir());
  const fromScratch = relative(scratchRoot, observedTmpdir);
  if (fromScratch === "" || fromScratch.startsWith("..") || isAbsolute(fromScratch)) {
    throw new Error(\`tmpdir escaped fabric scratch: \${observedTmpdir}\`);
  }
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async () => correctSyntheticPatch());
}

function fabricSymlinkSandboxExecutor(home: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "symlink-sandbox.ts");
  writeFileSync(modulePath, `
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_AFTER_UTF8, SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";

export async function execute(input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  const target = join(input.scratchRoot, "src", "value.txt");
  const link = join(input.scratchRoot, "src", "link.txt");
  try {
    symlinkSync(target, link);
  } catch {
    /* platform may reject symlink creation */
  }
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async (input) => {
    const target = join(input.scratchRoot, "src", "value.txt");
    const link = join(input.scratchRoot, "src", "link.txt");
    try {
      symlinkSync(target, link);
    } catch {
      /* platform may reject symlink creation */
    }
    return correctSyntheticPatch();
  });
}

function linkDirectory(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

const RESTRICTED_LINK_ERROR = /symbolic link|reparse-point substitution/i;

beforeEach(() => {
  setFabricProducerIsolationLimitsForTests(FAST_FABRIC_ISOLATION);
});

afterEach(() => {
  setFabricProducerIsolationLimitsForTests();
  for (const dir of HOMES.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  delete process.env.OPENCODEX_HOME;
});

function routeSubject(overrides: Partial<RouteSubjectV1> = {}): RouteSubjectV1 {
  return {
    subjectSchemaVersion: 1,
    subjectKind: "route",
    providerId: "provider-a",
    providerInstanceFingerprint: "a".repeat(64),
    clientModelId: "model-a",
    upstreamModelId: "model-a",
    effectiveAdapter: "openai-responses",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-responses",
    surface: "responses-http",
    opencodexCompatibilityVersion: "b".repeat(64),
    behaviorFingerprint: "c".repeat(64),
    endpointFingerprint: "d".repeat(64),
    dependencies: [],
    ...overrides,
  };
}

describe("CL-07 task effectiveness producer", () => {
  test("canonical TaskSubjectV1 identity is stable", () => {
    const subject = buildTaskSubjectV1({ routeSubject: routeSubject() });
    expect(subject.subjectKind).toBe("task");
    expect(taskSubjectId(subject)).toBe(subjectIdForSubject(subject));
    expect(taskSubjectId(buildTaskSubjectV1({ routeSubject: routeSubject() }))).toBe(taskSubjectId(subject));
  });

  test("route change changes task subject", () => {
    const a = taskSubjectId(buildTaskSubjectV1({ routeSubject: routeSubject() }));
    const b = taskSubjectId(buildTaskSubjectV1({
      routeSubject: routeSubject({ providerId: "provider-b", endpointFingerprint: "e".repeat(64) }),
    }));
    expect(a).not.toBe(b);
  });

  test("fixture/verifier/sandbox/fabric version changes change task subject", () => {
    const base = taskSubjectId(buildTaskSubjectV1({ routeSubject: routeSubject() }));
    expect(taskSubjectId(buildTaskSubjectV1({
      routeSubject: routeSubject(),
      taskFixtureDigest: "1".repeat(64),
    }))).not.toBe(base);
    expect(taskSubjectId(buildTaskSubjectV1({
      routeSubject: routeSubject(),
      verifierManifestDigest: "2".repeat(64),
    }))).not.toBe(base);
    expect(taskSubjectId(buildTaskSubjectV1({
      routeSubject: routeSubject(),
      sandboxProfileDigest: "3".repeat(64),
    }))).not.toBe(base);
    expect(taskSubjectId(buildTaskSubjectV1({
      routeSubject: routeSubject(),
      fabricCompatibilityVersion: "other-fabric-v1",
    }))).not.toBe(base);
    expect(taskFixtureDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(verifierManifestDigest()).toMatch(/^[0-9a-f]{64}$/);
    expect(sandboxProfileDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("exact synthetic patch passes via trusted route", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runTrustedFabricTask(home);
    expect(result.executionAuthority).toBe("trusted_route");
    expect(result.outcome.outcome).toBe("pass");
    expect(result.outcome.verifier.passed).toBe(true);
  });

  test("deterministic_correct harness passes without trusted authority", async () => {
    const home = tempHome();
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "deterministic_correct",
      configDir: home,
    });
    expect(result.executionAuthority).toBe("harness");
    expect(result.outcome.outcome).toBe("pass");
  });

  test("producer child awaits an async executor before result and clean exit", async () => {
    const childWatchdogMs = watchdogMs(5_000);
    const home = tempHome();
    const childEntry = join(REPO_ROOT, "src", "lab", "fabric", "producer-child.ts");
    const executorModulePath = join(home, "async-producer-executor.mjs");
    const settledMarker = join(home, "async-producer-settled");
    writeFileSync(executorModulePath, `
import { writeFileSync } from "node:fs";

export async function execute() {
  await Bun.sleep(75);
  writeFileSync(${JSON.stringify(settledMarker)}, "settled", "utf8");
  return {
    schemaVersion: 1,
    operations: [{
      op: "replace",
      path: ${JSON.stringify(SYNTHETIC_VALUE_PATH)},
      contentUtf8: ${JSON.stringify(SYNTHETIC_AFTER_UTF8)},
    }],
  };
}
`);

    expect(readFileSync(childEntry, "utf8")).toMatch(/\bawait\s+main\(\)\.catch\(/);

    const child = Bun.spawn([process.execPath, "run", childEntry], {
      cwd: REPO_ROOT,
      // Production's environment, not a literal copy of it. On Windows the
      // three variables alone cannot start a Bun child at all, so a hardcoded
      // copy here asserted against an environment production never uses.
      env: minimalFabricChildEnv(home),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    try {
      child.stdin.write(JSON.stringify({
        executorModulePath,
        executorInput: {},
        scratchRoot: home,
        totalTimeoutMs: 5_000,
        inactivityTimeoutMs: 2_000,
      }));
      child.stdin.end();
    } catch (error) {
      await terminateChildWithin(child);
      void stdoutPromise.catch(() => {});
      void stderrPromise.catch(() => {});
      throw error;
    }

    const completed = await Promise.race([
      child.exited.then((exitCode) => ({ exitCode })),
      Bun.sleep(childWatchdogMs).then(() => null),
    ]);
    if (!completed) {
      const reaped = await terminateChildWithin(child);
      void stdoutPromise.catch(() => {});
      const stderr = await Promise.race([
        stderrPromise.catch(() => "<unavailable>"),
        Bun.sleep(CHILD_REAP_GRACE_MS).then(() => "<unavailable>"),
      ]);
      throw new Error(`timed out waiting for producer child (reaped=${reaped}): ${stderr}`);
    }

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    expect(completed.exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(existsSync(settledMarker)).toBe(true);
    expect(stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))).toEqual([{
      type: "result",
      patch: {
        schemaVersion: 1,
        operations: [{
          op: "replace",
          path: SYNTHETIC_VALUE_PATH,
          contentUtf8: SYNTHETIC_AFTER_UTF8,
        }],
      },
    }]);
  }, { timeout: watchdogMs(5_000) + (3 * CHILD_REAP_GRACE_MS) + 1_000 });

  test("harness execution cannot be persisted as production evidence", async () => {
    const home = tempHome();
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "deterministic_correct",
      configDir: home,
    });
    expect(() => persistFabricRunResult(result, { configDir: home })).toThrow(FabricTaskError);
    try {
      persistFabricRunResult(result, { configDir: home });
    } catch (error) {
      expect((error as FabricTaskError).code).toBe("malformed_producer_outcome");
    }
    const labExports = await import("../src/lab");
    expect("persistFabricOutcome" in labExports).toBe(false);
  });

  test("trusted route execution can be persisted as production evidence", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runTrustedFabricTask(home);
    const persisted = persistFabricRunResult(result, { configDir: home });
    expect(existsSync(join(home, "lab", "compatibility.jsonl"))).toBe(true);
    expect(persisted.event.evidenceLayer).toBe("task_effectiveness");
  });

  test("unchanged / wrong / added / deleted trees fail verifier", () => {
    const home = tempHome();
    const scratch = createSyntheticScratch(home);
    try {
      expect(verifyExactTreeDiffV1(scratch.root).passed).toBe(false);
      expect(verifyExactTreeDiffV1(scratch.root).reason).toBe("unchanged_file");

      writeScratchFileUtf8(scratch.root, SYNTHETIC_VALUE_PATH, "nope\n", FABRIC_LIMITS.maxAggregateIoBytes);
      expect(verifyExactTreeDiffV1(scratch.root).passed).toBe(false);
      expect(verifyExactTreeDiffV1(scratch.root).reason?.startsWith("expected_digest_")).toBe(true);

      writeScratchFileUtf8(scratch.root, SYNTHETIC_VALUE_PATH, SYNTHETIC_AFTER_UTF8, FABRIC_LIMITS.maxAggregateIoBytes);
      writeScratchFileUtf8(scratch.root, "src/extra.txt", "x\n", FABRIC_LIMITS.maxAggregateIoBytes);
      expect(verifyExactTreeDiffV1(scratch.root).passed).toBe(false);
      expect(verifyExactTreeDiffV1(scratch.root).reason).toBe("unexpected_tree_shape");
    } finally {
      scratch.cleanup();
    }

    const deleted = createSyntheticScratch(home);
    try {
      rmSync(join(deleted.root, "src", "value.txt"), { force: true });
      expect(verifyExactTreeDiffV1(deleted.root).passed).toBe(false);
    } finally {
      deleted.cleanup();
    }
  });

  test("renamed file fails verifier", () => {
    const home = tempHome();
    const scratch = createSyntheticScratch(home);
    try {
      writeScratchFileUtf8(scratch.root, "src/renamed.txt", SYNTHETIC_AFTER_UTF8, FABRIC_LIMITS.maxAggregateIoBytes);
      rmSync(join(scratch.root, "src", "value.txt"), { force: true });
      const result = verifyExactTreeDiffV1(scratch.root);
      expect(result.passed).toBe(false);
      expect(result.pathSummaries.some((row) => row.kind === "added" || row.kind === "deleted")).toBe(true);
    } finally {
      scratch.cleanup();
    }
  });

  test("symlink and path traversal are rejected", () => {
    expect(() => assertSafeRelativePosixPath("../etc/passwd")).toThrow();
    expect(() => assertSafeRelativePosixPath("/abs")).toThrow();
    expect(() => assertSafeRelativePosixPath("C:\\windows")).toThrow();

    const home = tempHome();
    const scratch = createSyntheticScratch(home);
    try {
      const target = join(scratch.root, "src", "value.txt");
      const link = join(scratch.root, "src", "link.txt");
      try {
        symlinkSync(target, link);
      } catch {
        return;
      }
      expect(() => verifyExactTreeDiffV1(scratch.root)).toThrow(FabricTaskError);
    } finally {
      scratch.cleanup();
    }
  });

  test("special file is rejected where supported", () => {
    if (process.platform === "win32") return;
    const home = tempHome();
    const scratch = createSyntheticScratch(home);
    try {
      const fifo = join(scratch.root, "src", "fifo");
      const created = Bun.spawnSync(["mkfifo", fifo], { stdout: "pipe", stderr: "pipe" });
      if (created.exitCode !== 0) return;
      expect(() => verifyExactTreeDiffV1(scratch.root)).toThrow(FabricTaskError);
    } finally {
      scratch.cleanup();
    }
  });

  test("intermediate symlink cannot redirect scratch IO", () => {
    if (process.platform === "win32") return;
    const home = tempHome();
    const scratch = createSyntheticScratch(home);
    const outside = join(home, "outside.txt");
    writeFileSync(outside, "secret\n");
    try {
      const srcDir = join(scratch.root, "src");
      rmSync(srcDir, { recursive: true, force: true });
      try {
        symlinkSync(home, srcDir);
      } catch {
        return;
      }
      expect(() => readScratchFileUtf8(scratch.root, SYNTHETIC_VALUE_PATH, FABRIC_LIMITS.maxAggregateIoBytes)).toThrow();
      expect(() => writeScratchFileUtf8(scratch.root, SYNTHETIC_VALUE_PATH, "x\n", FABRIC_LIMITS.maxAggregateIoBytes)).toThrow();
    } finally {
      scratch.cleanup();
    }
  });

  test("oversized patch fails safely", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const huge = "x".repeat(FABRIC_LIMITS.maxAggregateIoBytes + 8);
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricOversizedPatchExecutor(home, huge),
      configDir: home,
    });
    expect(result.outcome.outcome).not.toBe("pass");
    expect(result.outcome.failure?.code).toBe("budget_exhausted");
  });

  test("never_resolve harness terminates on inactivity timeout", async () => {
    const home = tempHome();
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "never_resolve",
      configDir: home,
    });
    expect(["blocked", "inconclusive"]).toContain(result.outcome.outcome);
    expect(result.outcome.failure?.code).toBe("inactivity_timeout");
  }, 20_000);

  test("infinite_sync harness terminates on total timeout", async () => {
    const home = tempHome();
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "infinite_sync",
      configDir: home,
    });
    expect(["blocked", "inconclusive"]).toContain(result.outcome.outcome);
    expect(result.outcome.failure?.code).toBe("timeout");
  }, 40_000);

  test("periodic_activity harness survives inactivity within total budget", async () => {
    const home = tempHome();
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "periodic_activity",
      configDir: home,
    });
    expect(result.outcome.outcome).toBe("pass");
  }, 20_000);

  test("activity_until_total harness terminates on total timeout", async () => {
    const home = tempHome();
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "activity_until_total",
      configDir: home,
    });
    expect(["blocked", "inconclusive"]).toContain(result.outcome.outcome);
    expect(result.outcome.failure?.code).toBe("timeout");
  }, 40_000);

  test("flood_stdout harness terminates on protocol byte limit", async () => {
    const home = tempHome();
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "flood_stdout",
      configDir: home,
    });
    expect(["blocked", "inconclusive"]).toContain(result.outcome.outcome);
    expect(result.outcome.failure?.code).toBe("budget_exhausted");
  }, 20_000);

  test("mutate_after_delay harness kills producer and cleans scratch", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "mutate_after_delay",
      configDir: home,
    });
    expect(["blocked", "inconclusive"]).toContain(result.outcome.outcome);
    expect(["timeout", "inactivity_timeout", "harness_failure"]).toContain(result.outcome.failure?.code ?? "");
    const scratchBase = join(home, "lab", "scratch");
    await Bun.sleep(FAST_FABRIC_ISOLATION.totalTimeoutMs + FAST_FABRIC_ISOLATION.inactivityTimeoutMs + 250);
    if (existsSync(scratchBase)) {
      expect(readdirSync(scratchBase).some((name) => name.startsWith("fabric-"))).toBe(false);
    }
    for (const name of existsSync(scratchBase) ? readdirSync(scratchBase) : []) {
      if (!name.startsWith("fabric-")) continue;
      const latePath = join(scratchBase, name, SYNTHETIC_VALUE_PATH);
      if (existsSync(latePath)) {
        expect(readFileSync(latePath, "utf8")).not.toBe("late\n");
      }
    }
  }, 45_000);

  test("inactivity timeout is bounded for trusted route executors", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricInactivePatchExecutor(home),
      configDir: home,
    });
    expect(["blocked", "inconclusive"]).toContain(result.outcome.outcome);
    expect(result.outcome.failure?.code).toBe("inactivity_timeout");
  }, 20_000);

  test("activity resets inactivity deadline within total budget", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricActivityPatchExecutor(home),
      configDir: home,
    });
    expect(result.outcome.outcome).toBe("pass");
  }, 30_000);

  test("inactiveMs on success is meaningful with controlled clock", async () => {
    const home = tempHome();
    let tick = 10_000;
    const now = () => tick;
    const result = await runFabricSyntheticPatchTaskHarness({
      routeSubject: routeSubject(),
      harnessKind: "deterministic_correct",
      configDir: home,
      now,
    });
    expect(result.outcome.outcome).toBe("pass");
    expect(result.outcome.usage.inactiveMs).toBeGreaterThanOrEqual(0);
    expect(result.outcome.usage.inactiveMs).toBeLessThanOrEqual(result.outcome.usage.elapsedMs);
    tick += 2_500;
    const trusted = await runTrustedFabricTask(home, {}, now);
    expect(trusted.outcome.outcome).toBe("pass");
    expect(trusted.outcome.usage.inactiveMs).toBeGreaterThanOrEqual(0);
    expect(trusted.outcome.usage.inactiveMs).toBeLessThanOrEqual(trusted.outcome.usage.elapsedMs);
  });

  test("sandbox violations do not become behavioral_failure", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricSymlinkSandboxExecutor(home),
      configDir: home,
    });
    if (result.outcome.failure?.code === "sandbox_violation") {
      expect(result.outcome.failure.class).not.toBe("behavioral_failure");
      expect(["blocked", "inconclusive"]).toContain(result.outcome.outcome);
      return;
    }
    const scratch = createSyntheticScratch(home);
    try {
      symlinkSync(join(scratch.root, "src", "value.txt"), join(scratch.root, "src", "link.txt"));
      expect(() => verifyExactTreeDiffV1(scratch.root)).toThrow(FabricTaskError);
      try {
        verifyExactTreeDiffV1(scratch.root);
      } catch (error) {
        expect((error as FabricTaskError).code).toBe("sandbox_violation");
      }
    } catch {
      /* symlink unsupported on this platform */
    } finally {
      scratch.cleanup();
    }
  });

  test("declared sandbox policy denies network MCP shell and user repo", () => {
    expect(fabricDeclaredSandboxPolicy()).toEqual({
      network: false,
      userMcp: false,
      arbitraryShell: false,
      userRepository: false,
    });
  });

  test("untrusted patch executor is rejected before isolation", async () => {
    const home = tempHome();
    const fakeExecutor = {
      executorModulePath: join(home, "evil.ts"),
      execute: async () => correctSyntheticPatch(),
    };
    await expect(runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fakeExecutor as TrustedFabricPatchExecutor,
      configDir: home,
    })).rejects.toThrow(FabricTaskError);
  });

  test("authoritative route subject is bound into trusted outcomes", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const routeContext = fabricMockRoute({ providerId: "provider-bound" });
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext,
      destination: await fabricDestination(home),
      patchExecutor: fabricRouteBoundPatchExecutor(home, "provider-bound"),
      configDir: home,
    });
    expect(result.outcome.routeSubject.providerId).toBe("provider-bound");
    expect(result.outcome.taskSubject.routeSubject.providerId).toBe("provider-bound");
    expect(result.outcome.routeSubject).toEqual(result.outcome.taskSubject.routeSubject);
  });

  test("patch path traversal is rejected at scratch apply boundary", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricTraversalPatchExecutor(home),
      configDir: home,
    });
    expect(result.outcome.outcome).not.toBe("pass");
    expect(result.outcome.failure?.code).toBe("sandbox_violation");
    expect(existsSync(join(home, "outside.txt"))).toBe(false);
  });

  test("adversarial executor direct write outside scratch is not production evidence", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const outside = join(home, "outside-scratch");
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricOutsideScratchWriteExecutor(home),
      configDir: home,
    });
    expect(result.outcome.outcome).toBe("pass");
    expect(existsSync(join(outside, "evil.txt"))).toBe(true);
    expect(() => persistFabricRunResult({
      ...result,
      executionAuthority: "harness",
    }, { configDir: home })).toThrow(FabricTaskError);
  });

  test("isolated executors resolve tmpdir inside their scratch tree", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricTmpdirProbeExecutor(home),
      configDir: home,
    });
    expect(result.outcome.outcome).toBe("pass");
  });

  test("user repository cannot host the scratch root", () => {
    const home = tempHome();
    const repo = join(home, "user-repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "value.txt"), "before\n");
    expect(() => assertNotUnderUserRepo(repo, repo)).toThrow();
    const scratch = createSyntheticScratch(home);
    try {
      expect(existsSync(join(scratch.root, "src", "value.txt"))).toBe(true);
      expect(scratch.root.startsWith(join(home, "lab", "scratch"))).toBe(true);
    } finally {
      scratch.cleanup();
    }
  });

  test("malformed producer result is rejected", () => {
    expect(() => parseSyntheticPatchV1({ schemaVersion: 1, operations: [], extra: true })).toThrow();
    expect(() => parseSyntheticPatchV1({
      schemaVersion: 2,
      operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: "after\n" }],
    })).toThrow();
    expect(() => observationFromFabricOutcome({
      schemaVersion: 1,
      taskSubject: { subjectKind: "route" },
    })).toThrow();
    let incompleteError: unknown;
    try {
      observationFromFabricOutcome({ schemaVersion: 1 });
    } catch (error) {
      incompleteError = error;
    }
    expect((incompleteError as FabricTaskError | undefined)?.name).toBe("FabricTaskError");
  });

  test("fixture and verifier manifests derive from frozen constants", () => {
    const verifier = verifierManifestObject() as {
      verifierId: string;
      requiredChange: { path: string; beforeUtf8: string; afterUtf8: string };
    };
    expect(verifier.verifierId).toBe(FABRIC_VERIFIER_ID);
    expect(verifier.requiredChange).toEqual({
      path: SYNTHETIC_VALUE_PATH,
      beforeUtf8: SYNTHETIC_BEFORE_UTF8,
      afterUtf8: SYNTHETIC_AFTER_UTF8,
    });
    const fixture = taskFixtureObject() as {
      files: Array<{ path: string; contentUtf8: string }>;
      requestedFinal: Array<{ path: string; contentUtf8: string }>;
    };
    expect(fixture.files[0]).toEqual({ path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_BEFORE_UTF8 });
    expect(fixture.requestedFinal[0]).toEqual({ path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 });
  });

  test("task applicability excludes mismatched platform and harness features", () => {
    expect(taskSubjectApplicableToRequirements({
      requiredHarnessFeatures: ["fabric-scratch-v1"],
      platforms: ["linux"],
      routePreconditions: ["exact-route-subject"],
    }, {
      harnessFeatures: ["fabric-scratch-v1"],
      platforms: ["win32"],
      routePreconditions: ["exact-route-subject"],
    })).toBe(false);
    expect(taskSubjectApplicableToRequirements({
      requiredHarnessFeatures: ["fabric-scratch-v1", "missing-feature"],
      platforms: ["*"],
      routePreconditions: ["exact-route-subject"],
    }, {
      harnessFeatures: ["fabric-scratch-v1"],
      platforms: ["win32"],
      routePreconditions: ["exact-route-subject"],
    })).toBe(false);
    expect(taskSubjectApplicableToRequirements({
      requiredHarnessFeatures: ["fabric-scratch-v1"],
      platforms: ["*"],
      routePreconditions: ["exact-route-subject"],
    }, {
      harnessFeatures: ["fabric-scratch-v1"],
      platforms: ["win32"],
      routePreconditions: ["exact-route-subject"],
    })).toBe(true);
    expect(taskSubjectApplicableToRequirements({
      requiredHarnessFeatures: ["fabric-scratch-v1"],
      routePreconditions: ["exact-route-subject"],
    }, {
      harnessFeatures: ["fabric-scratch-v1"],
      platforms: ["win32"],
      routePreconditions: ["exact-route-subject"],
    })).toBe(true);
    expect(taskSubjectApplicableToRequirements({
      requiredHarnessFeatures: [],
      platforms: ["linux"],
      routePreconditions: [],
    }, {
      harnessFeatures: [],
      platforms: ["win32", "*"],
      routePreconditions: [],
    })).toBe(true);
    expect(taskSubjectApplicableToRequirements({
      requiredHarnessFeatures: [],
      platforms: ["linux", "darwin"],
      routePreconditions: [],
    }, {
      harnessFeatures: [],
      platforms: ["linux"],
      routePreconditions: [],
    })).toBe(true);
    expect(taskSubjectApplicableToRequirements({
      requiredHarnessFeatures: [],
      platforms: ["linux", "darwin"],
      routePreconditions: [],
    }, {
      harnessFeatures: [],
      platforms: ["win32"],
      routePreconditions: [],
    })).toBe(false);
  });

  test("malformed nested outcome fields throw FabricTaskError", async () => {
    const home = tempHome();
    const base = (await runTrustedFabricTask(home)).outcome;
    expect(() => observationFromFabricOutcome({ ...base, verifier: {} })).toThrow(FabricTaskError);
    try {
      observationFromFabricOutcome({
        ...base,
        usage: { ...base.usage, inputBytes: -1 },
      });
      throw new Error("expected malformed usage to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FabricTaskError);
      expect((error as FabricTaskError).code).toBe("malformed_producer_outcome");
    }
    try {
      observationFromFabricOutcome({
        ...base,
        routeSubject: routeSubject({ providerId: "other-provider" }),
      });
      throw new Error("expected layer mismatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FabricTaskError);
      expect((error as FabricTaskError).code).toBe("layer_subject_mismatch");
    }
  });

  test("verifier summary artifact omits raw credential diagnostics", async () => {
    const home = tempHome();
    const paths = ensureLabDirs(home);
    const store = createArtifactStore(paths.artifactsDir);
    const base = (await runTrustedFabricTask(home)).outcome;
    try {
      const { artifacts } = observationFromFabricOutcome({
        ...base,
        verifier: {
          ...base.verifier,
          reason: `failed ${CREDENTIAL_CANARY}`,
        },
      }, { configDir: home, artifactStore: store });
      const summaryRef = artifacts.find((row) => row.artifactClass === "verifier_summary");
      expect(summaryRef).toBeDefined();
      const text = new TextDecoder().decode(store.get(summaryRef!.digest));
      expect(text.includes(CREDENTIAL_CANARY)).toBe(false);
      const trustedRun = await runTrustedFabricTask(home);
      persistFabricRunResult({
        ...trustedRun,
        outcome: {
          ...trustedRun.outcome,
          verifier: {
            ...trustedRun.outcome.verifier,
            reason: `failed ${CREDENTIAL_CANARY}`,
          },
        },
      }, { configDir: home });
      const ledger = readFileSync(join(home, "lab", "compatibility.jsonl"), "utf8");
      expect(ledger.includes(CREDENTIAL_CANARY)).toBe(false);
    } finally {
      store.close();
    }
  });

  test("expired ledger lock is recovered before append", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    mkdirSync(join(home, "lab"), { recursive: true, mode: 0o700 });
    const lockPath = join(home, "lab", "compatibility.jsonl.lock");
    writeFileSync(lockPath, JSON.stringify({
      pid: 4_000_000_000,
      createdAt: Date.now() - 120_000,
      token: "stale-lock-token",
    }), { mode: 0o600 });
    const result = await runTrustedFabricTask(home);
    persistFabricRunResult(result, { configDir: home });
    expect(existsSync(join(home, "lab", "compatibility.jsonl"))).toBe(true);
  });

  test("symlinked lab scratch dir is rejected", () => {
    const home = tempHome();
    const outside = join(home, "outside-scratch");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, "lab"), { recursive: true, mode: 0o700 });
    const scratchLink = join(home, "lab", "scratch");
    if (!linkDirectory(outside, scratchLink)) return;
    expect(() => createSyntheticScratch(home)).toThrow();
    expect(readdirSync(outside).some((name) => name.startsWith("fabric-"))).toBe(false);
  });

  test("failed scratch construction removes partial fabric directories", () => {
    const home = tempHome();
    const originalWriteSync = nodeFs.writeSync;
    const writeSpy = spyOn(nodeFs, "writeSync").mockImplementation((...args: Parameters<typeof nodeFs.writeSync>) => {
      const buffer = args[1];
      if (Buffer.isBuffer(buffer) && buffer.toString("utf8") === SYNTHETIC_BEFORE_UTF8) {
        throw new Error("simulated fixture write failure");
      }
      return originalWriteSync(...args);
    });
    try {
      expect(() => createSyntheticScratch(home)).toThrow("simulated fixture write failure");
      const scratchBase = join(home, "lab", "scratch");
      expect(readdirSync(scratchBase).some((name) => name.startsWith("fabric-"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("symlinked lab root rejects directory escape via ensureLabDirs", () => {
    const home = tempHome();
    const outside = join(home, "outside-lab");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    const labLink = join(home, "lab");
    if (!linkDirectory(outside, labLink)) return;
    expect(() => ensureLabDirs(home)).toThrow(RESTRICTED_LINK_ERROR);
    expect(existsSync(join(outside, "scratch"))).toBe(false);
    expect(existsSync(join(outside, "artifacts"))).toBe(false);
  });

  test("symlink under lab boundary is rejected by ensureRestrictedDir", () => {
    const home = tempHome();
    const labDir = join(home, "lab");
    const outside = join(home, "outside-scratch");
    mkdirSync(labDir, { recursive: true, mode: 0o700 });
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    const scratchLink = join(labDir, "scratch");
    if (!linkDirectory(outside, scratchLink)) return;
    expect(() => ensureRestrictedDir(join(labDir, "scratch", "nested"), labDir)).toThrow(RESTRICTED_LINK_ERROR);
  });

  test("duplicate outcome delivery is idempotent; distinct attempts remain distinct", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const firstRun = await runTrustedFabricTask(home, {}, () => 1_000);
    const first = persistFabricRunResult(firstRun, { configDir: home, recordedAt: 1_000, attempt: 1 });
    const second = persistFabricRunResult(firstRun, { configDir: home, recordedAt: 1_000, attempt: 1 });
    expect(second.event.eventId).toBe(first.event.eventId);
    const replay = replayLabLedger(join(home, "lab", "compatibility.jsonl"));
    const ids = replay.events.filter((row) => row.eventKind === "observation").map((row) => row.eventId);
    expect(ids).toEqual([first.event.eventId]);
    expect(replay.corruptions.filter((row) => row.kind === "duplicate_event")).toEqual([]);

    const secondAttempt = await runTrustedFabricTask(home, {}, () => 2_000);
    const third = persistFabricRunResult(secondAttempt, { configDir: home, recordedAt: 2_000, attempt: 2 });
    expect(third.event.eventId).not.toBe(first.event.eventId);
  });

  test("structured result converts to fabric Lab observation", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const outcome = (await runTrustedFabricTask(home)).outcome;
    const { event } = observationFromFabricOutcome(outcome, { configDir: home });
    expect(event.evidenceLayer).toBe("task_effectiveness");
    expect(event.executionMode).toBe("fabric");
    expect(event.subject.subjectKind).toBe("task");
    expect(event.suiteId).toBe("fabric-core");
    const serialized = JSON.stringify(event);
    expect(serialized.includes(CREDENTIAL_CANARY)).toBe(false);
    expect(serialized.includes("OPENAI_API_KEY")).toBe(false);
  });

  test("task layer rejects RouteSubjectV1 mismatches", () => {
    expect(() => observationFromFabricOutcome({
      schemaVersion: 1,
      taskClassId: "x",
      taskClassVersion: "1",
      routeSubject: routeSubject(),
      taskSubject: { subjectSchemaVersion: 1, subjectKind: "route" },
      subjectId: "a".repeat(64),
      taskFixtureDigest: "b".repeat(64),
      verifierManifestDigest: "c".repeat(64),
      fabricCompatibilityVersion: "v",
      sandboxProfileDigest: "d".repeat(64),
      startedAt: 1,
      completedAt: 2,
      limits: FABRIC_LIMITS,
      usage: {
        inputBytes: 0,
        outputBytes: 0,
        patchOperations: 0,
        filesTouched: 0,
        artifactBytes: 0,
        elapsedMs: 1,
        inactiveMs: 0,
      },
      outcome: "pass",
      verifier: {
        verifierId: "exact-tree-diff-v1",
        manifestDigest: "c".repeat(64),
        passed: true,
        pathSummaries: [],
      },
      artifactDigests: [],
    })).toThrow();
  });

  test("projection rebuild and invalidation work for task evidence", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runTrustedFabricTask(home, {}, () => 5_000);
    const persisted = persistFabricRunResult(result, { configDir: home, recordedAt: 5_000 });
    const rebuilt = rebuildLabProjection(home);
    expect(rebuilt.events).toBeGreaterThan(0);
    expect(rebuilt.corruptions).toEqual([]);
    expect(rebuilt.verdicts).toBeGreaterThan(0);
    const snap = readVerdictSnapshot(rebuilt.sqlitePath) as Array<{
      evidence_layer?: string;
      verdict?: string;
    }>;
    const taskRow = snap.find((row) => row.evidence_layer === "task_effectiveness");
    expect(taskRow?.verdict).toBe("VERIFIED");

    const inv = assignEventId({
      schemaVersion: LAB_EVENT_SCHEMA_VERSION,
      eventKind: "invalidation" as const,
      recordedAt: 6_000,
      producer: LAB_PRODUCER,
      producerVersion: "2.10.2",
      targetEventIds: [persisted.event.eventId],
      reason: "manual_correction" as const,
    });
    appendLabEvent(join(home, "lab", "compatibility.jsonl"), inv as never);
    const replay = replayLabLedger(join(home, "lab", "compatibility.jsonl"));
    const index = buildInvalidationIndex(replay.events);
    expect(index.invalidatedBy.has(persisted.event.eventId)).toBe(true);
  });

  test("artifacts are bounded and catalog exposes task evidence", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const outcome = (await runTrustedFabricTask(home)).outcome;
    const { event, artifacts } = observationFromFabricOutcome(outcome, { configDir: home });
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts.every((row) => row.byteCount <= 256 * 1024)).toBe(true);
    expect(event.artifactRefs.every((row) => /^[0-9a-f]{64}$/.test(row.digest))).toBe(true);

    const catalog = queryLabCatalog({ layer: "task_effectiveness" });
    expect(catalog.some((row) => row.suiteId === "fabric-core" && row.scenarioId === "fabric-core.task.synthetic-patch")).toBe(true);
  });

  test("CL-06 routing still rejects task_effectiveness required suites", () => {
    const issues = routingProfileIssues("p", {
      candidates: [{ provider: "a", model: "m" }],
      compatibility: {
        requiredSuites: [{
          suiteId: "fabric-core",
          evidenceLayer: "task_effectiveness" as "live_route_compatibility",
        }],
      },
    }, {
      providers: {
        a: { type: "openai", baseUrl: "http://127.0.0.1:9", models: { m: {} } },
      },
    } as never);
    expect(issues.some((row) => row.message.includes("protocol_conformance or live_route_compatibility"))).toBe(true);
  });

  test("ledger lines omit prompts and credentials", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const result = await runFabricSyntheticPatchTaskForRoute({
      routeContext: fabricMockRoute(),
      destination: await fabricDestination(home),
      patchExecutor: fabricCorrectPatchExecutor(),
      configDir: home,
      sourceRefs: ["routeDecision:abcd1234"],
    });
    persistFabricRunResult(result, { configDir: home });
    const text = readFileSync(join(home, "lab", "compatibility.jsonl"), "utf8");
    expect(text.includes("system prompt")).toBe(false);
    expect(text.includes(CREDENTIAL_CANARY)).toBe(false);
  });

  // Every producer case above runs a real child process, so all of them turn
  // "inconclusive" at once when the child cannot start. On Windows that is what
  // happened: the child env carried three variables, and a CreateProcess child
  // inherits nothing, so the Bun executable could not resolve its system DLLs
  // and died before running its entry module. Fourteen cases went red for one
  // reason, and none of them named it -- they all reported harness_failure.
  //
  // This asserts the environment contract directly, so a regression is one
  // named failure instead of a diffuse cluster. It runs everywhere: the shape
  // is what matters, and the platform branch is inside the function.
  test("the isolated producer env carries what a child needs to start on this platform", () => {
    const home = tempHome();
    const env = minimalFabricChildEnv(home);

    // The sandbox contract, on every platform: scratch is addressed, and no
    // ambient credential or config state is forwarded.
    expect(env.OCX_FABRIC_SCRATCH_ROOT).toBe(home);
    expect(env.TZ).toBe("UTC");
    for (const leaked of ["OPENCODEX_HOME", "CODEX_HOME", "PATH", "HOME", "USERPROFILE", "APPDATA"]) {
      expect(env[leaked]).toBeUndefined();
    }

    const childTempDir = join(home, ".tmp");
    expect(env.TEMP).toBe(childTempDir);
    expect(env.TMP).toBe(childTempDir);
    expect(env.TMPDIR).toBe(childTempDir);
    expect(existsSync(childTempDir)).toBe(true);

    if (process.platform !== "win32") {
      // POSIX needs no ambient loader state; only scratch-owned temp state is added.
      expect(Object.keys(env).sort()).toEqual([
        "NO_COLOR",
        "OCX_FABRIC_SCRATCH_ROOT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "TZ",
      ]);
      return;
    }

    // On Windows the loader itself reads the environment. SystemRoot is the one
    // that decides whether the child runs at all; assert it against the real
    // parent value rather than a literal, since a wrong path fails identically.
    expect(env.SystemRoot).toBe(process.env.SystemRoot);
    expect(env.SystemRoot).toBeTruthy();
  });
});
