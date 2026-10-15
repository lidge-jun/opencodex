import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";

import {
  bumpConfigGeneration,
  mutatePersistedConfig,
  observeConfigGeneration,
  readConfigGeneration,
  saveConfig,
  saveConfigPreservingClaudeCode,
  withExpectedConfigGenerationSync,
} from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { captureStartupChildOutput, STARTUP_OUTPUT_TAIL_CHARS } from "../helpers/startup-child-output";

const CHILD_TIMEOUT_MS = 10_000;
// Allow both child phases and cleanup to finish before Bun aborts the test.
const CHILD_TEST_TIMEOUT_MS = 3 * CHILD_TIMEOUT_MS;
const configModuleUrl = pathToFileURL(repoPath("src/config.ts")).href;
const generationGuardRaceScript = `
  import { existsSync, writeFileSync } from "node:fs";
  process.stderr.write("generation-race: importing config\\n");
  const { withExpectedConfigGenerationSync } = await import(${JSON.stringify(configModuleUrl)});
  process.stderr.write("generation-race: config imported\\n");

  const payload = JSON.parse(process.env.OCX_TEST_PAYLOAD);
  const waitFor = path => {
    const deadline = Date.now() + ${CHILD_TIMEOUT_MS};
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error(\`timed out waiting for \${path}\`);
      Bun.sleepSync(5);
    }
  };
  writeFileSync(payload.readyPath, "ready");
  process.stderr.write("generation-race: ready\\n");
  waitFor(payload.releasePath);

  const result = withExpectedConfigGenerationSync({ value: 0 }, () => {
    process.stderr.write("generation-race: callback entered\\n");
    writeFileSync(payload.callbackPath, payload.id);
    waitFor(payload.peerOutcomePath);
    return payload.id;
  });
  writeFileSync(payload.outcomePath, JSON.stringify(result));
  process.stderr.write("generation-race: outcome written\\n");
  process.stdout.write(JSON.stringify(result));
`;

let testRoot = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

function config(port = 10100): OcxConfig {
  return { port, providers: {}, defaultProvider: "openai" };
}

type GuardRaceChild = {
  id: string;
  readyPath: string;
  process: ReturnType<typeof Bun.spawn>;
  output: ReturnType<typeof captureStartupChildOutput>;
};

function trackGuardRaceChild(child: ReturnType<typeof Bun.spawn>, id: string, readyPath: string): GuardRaceChild {
  return { id, readyPath, process: child,
    output: captureStartupChildOutput(child.stdout as ReadableStream<Uint8Array>, child.stderr as ReadableStream<Uint8Array>) };
}

function guardRaceDiagnostics(children: readonly GuardRaceChild[]): string {
  return JSON.stringify(children.map(child => {
    const { stdout, stderr, elapsedMs, lastOutputAgoMs } = child.output.snapshot();
    return {
      id: child.id, pid: child.process.pid, exitCode: child.process.exitCode, signalCode: child.process.signalCode,
      ready: existsSync(child.readyPath), stdout, stderr, elapsedMs, lastOutputAgoMs,
    };
  }));
}

async function waitForPaths(paths: readonly string[], children: readonly GuardRaceChild[]): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (!paths.every(existsSync)) {
    const exited = children.find(child => !existsSync(child.readyPath)
      && (child.process.exitCode !== null || child.process.signalCode !== null));
    if (exited) {
      await exited.output.finish();
      throw new Error(`generation child exited before readiness: ${guardRaceDiagnostics(children)}`);
    }
    if (Date.now() >= deadline) {
      const missing = paths.filter(path => !existsSync(path));
      throw new Error(`timed out waiting for ${missing.join(", ")}; children: ${guardRaceDiagnostics(children)}`);
    }
    await Bun.sleep(5);
  }
}

async function collectGuardRaceChild(
  child: GuardRaceChild,
): Promise<Record<string, unknown>> {
  const timeout = setTimeout(() => { try { child.process.kill(); } catch { /* Exit may race the deadline. */ } }, CHILD_TIMEOUT_MS);
  try {
    const exitCode = await child.process.exited;
    const output = await child.output.finish();
    expect(exitCode, output.stderr.tail).toBe(0);
    return JSON.parse(output.stdout.tail) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

async function stopGuardRaceChildren(children: readonly GuardRaceChild[]): Promise<void> {
  const reaped = await Promise.all(children.map(async child => {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      try { child.process.kill("SIGKILL"); } catch { /* Observe exit/reap below even if exit raced the kill. */ }
    }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      child.process.exited.then(() => true),
      new Promise<boolean>(resolve => { cleanupTimer = setTimeout(() => resolve(false), 1000); }),
    ]);
    clearTimeout(cleanupTimer);
    await child.output.finish();
    return exited;
  }));
  if (reaped.some(exited => !exited)) throw new Error(`generation child could not be reaped: ${guardRaceDiagnostics(children)}`);
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  testRoot = mkdtempSync(join(tmpdir(), "ocx-config-generation-"));
  process.env.CODEX_HOME = testRoot;
  process.env.OPENCODEX_HOME = testRoot;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(testRoot);
});

test("observe-only generation reports a missing database without creating or chmodding paths", () => {
  const absentParent = join(testRoot, "missing-parent");
  const absentHome = join(absentParent, "opencodex-home");
  const rootBefore = statSync(testRoot, { bigint: true });
  process.env.CODEX_HOME = absentHome;
  process.env.OPENCODEX_HOME = absentHome;

  const absentObservation = observeConfigGeneration();
  expect(existsSync(join(absentHome, "config-mutation.sqlite"))).toBeFalse();
  expect(existsSync(absentHome)).toBeFalse();
  expect(existsSync(absentParent)).toBeFalse();
  // Missing storage is now its own state. The original concern behind folding it
  // into `unavailable` — that a look-only caller must not receive something it
  // could mistake for a known-good zero — is unchanged and still honored:
  // `absent` authorizes nothing by itself. Only a caller holding the config
  // transaction may promote it, and only by reading a real zero in there.
  // Refusing outright was not neutral either: it meant refusing every Codex
  // write on any home whose config predates this database.
  expect(absentObservation).toEqual({ kind: "absent" });
  const rootAfter = statSync(testRoot, { bigint: true });
  expect(rootAfter.mode).toBe(rootBefore.mode);

  const existingHome = join(testRoot, "existing-home");
  mkdirSync(existingHome, { mode: 0o751 });
  chmodSync(existingHome, 0o751);
  const existingMode = statSync(existingHome).mode & 0o777;
  process.env.CODEX_HOME = existingHome;
  process.env.OPENCODEX_HOME = existingHome;

  const existingObservation = observeConfigGeneration();
  expect(existsSync(join(existingHome, "config-mutation.sqlite"))).toBeFalse();
  expect(statSync(existingHome).mode & 0o777).toBe(existingMode);
  expect(existingObservation).toEqual({ kind: "absent" });
});

test("observe-only generation reads an existing value without modifying its database", () => {
  saveConfig(config());
  saveConfig(config(20200));
  const databasePath = join(testRoot, "config-mutation.sqlite");
  const before = statSync(databasePath, { bigint: true });

  expect(observeConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 2 },
  });

  const after = statSync(databasePath, { bigint: true });
  expect({ inode: after.ino, mtime: after.mtimeNs, size: after.size }).toEqual({
    inode: before.ino,
    mtime: before.mtimeNs,
    size: before.size,
  });
});

test("observe-only generation returns typed outcomes for malformed and unreadable databases", () => {
  const databasePath = join(testRoot, "config-mutation.sqlite");
  writeFileSync(databasePath, "not sqlite", "utf8");

  expect(observeConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
  expect(observeConfigGeneration()).not.toEqual({ kind: "ready", generation: { value: 0 } });

  rmSync(databasePath);
  mkdirSync(databasePath);
  expect(observeConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
});

test("an initial read creates the singleton generation at zero", () => {
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 0 },
  });
});

test("a cooperating save bumps once and an unchanged save does not bump", () => {
  saveConfig(config());
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });

  saveConfig(config());
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });

  saveConfig(config(20200));
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 2 },
  });
});

test("every cooperating writer bumps only when its committed bytes change", () => {
  saveConfig(config());

  expect(mutatePersistedConfig(persisted => {
    persisted.port = 20200;
    return { changed: true, value: persisted.port };
  })).toEqual({ status: "committed", value: 20200 });
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 2 } });

  expect(mutatePersistedConfig(persisted => (
    { changed: false, value: persisted.port }
  ))).toEqual({ status: "unchanged", value: 20200 });
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 2 } });

  saveConfigPreservingClaudeCode(config(30300));
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 3 } });
  saveConfigPreservingClaudeCode(config(30300));
  expect(readConfigGeneration()).toMatchObject({ generation: { value: 3 } });
});

test("a stale expected value conflicts without changing the winner", () => {
  const admitted = readConfigGeneration();
  expect(admitted.kind).toBe("ready");
  if (admitted.kind !== "ready") throw new Error("generation unavailable");

  saveConfig(config());
  expect(bumpConfigGeneration(admitted.generation)).toEqual({
    kind: "conflict",
    current: { value: 1 },
  });
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });
});

test("the generation guard joins the existing mutation transaction", () => {
  const result = withExpectedConfigGenerationSync({ value: 0 }, () => {
    saveConfig(config());
    return "committed-with-nested-writer";
  });

  expect(result).toEqual({
    kind: "matched",
    generation: { value: 0 },
    value: "committed-with-nested-writer",
  });
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });
});

test("the generation guard never invokes its callback on a mismatch", () => {
  saveConfig(config());
  let callbackRuns = 0;

  expect(withExpectedConfigGenerationSync({ value: 0 }, () => {
    callbackRuns += 1;
    return "must-not-run";
  })).toEqual({ kind: "conflict", current: { value: 1 } });
  expect(callbackRuns).toBe(0);
});

test("two real processes racing one generation run exactly one callback", async () => {
  const releasePath = join(testRoot, "race-release");
  const ids = ["a", "b"] as const;
  const children = ids.map((id, index) => {
    const peerId = ids[1 - index]!;
    const payload = {
      id,
      readyPath: join(testRoot, `${id}.ready`),
      releasePath,
      callbackPath: join(testRoot, `${id}.callback`),
      outcomePath: join(testRoot, `${id}.outcome`),
      peerOutcomePath: join(testRoot, `${peerId}.outcome`),
    };
    return trackGuardRaceChild(Bun.spawn([process.execPath, "--eval", generationGuardRaceScript], {
      cwd: repoRoot(),
      env: {
        ...process.env,
        HOME: testRoot,
        OPENCODEX_HOME: testRoot,
        OCX_TEST_PAYLOAD: JSON.stringify(payload),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }), id, payload.readyPath);
  });

  try {
    await waitForPaths([join(testRoot, "a.ready"), join(testRoot, "b.ready")], children);
    writeFileSync(releasePath, "go");
    const results = await Promise.all(children.map(collectGuardRaceChild));

    expect(results.filter(result => result.kind === "matched")).toHaveLength(1);
    expect(results.filter(result => (
      result.kind === "conflict"
      || (result.kind === "unavailable" && result.reason === "busy")
    ))).toHaveLength(1);
    expect(["a", "b"].filter(id => existsSync(join(testRoot, `${id}.callback`)))).toHaveLength(1);
    expect(readConfigGeneration()).toEqual({
      kind: "ready",
      generation: { value: 0 },
    });
  } finally { await stopGuardRaceChildren(children); }
}, CHILD_TEST_TIMEOUT_MS);

test("generation-race readiness reports a child's early exit and stderr", async () => {
  const readyPath = join(testRoot, "exited.ready");
  const child = trackGuardRaceChild(Bun.spawn([process.execPath, "--eval",
    "console.error('fixture generation startup error'); process.exit(7);"],
  { stdin: "ignore", stdout: "pipe", stderr: "pipe" }), "exited", readyPath);
  try {
    await child.process.exited;
    await expect(waitForPaths([readyPath], [child])).rejects.toThrow("generation child exited before readiness");
    expect(guardRaceDiagnostics([child])).toContain("fixture generation startup error");
    expect(child.process.exitCode).toBe(7);
  } finally { await stopGuardRaceChildren([child]); }
}, CHILD_TEST_TIMEOUT_MS);

test("generation-race diagnostics drain both pipes with bounded tails", async () => {
  const readyPath = join(testRoot, "output.ready");
  const script = `import { writeFileSync } from 'node:fs';
    await Bun.write(Bun.stdout, 'x'.repeat(256 * 1024) + 'stdout-tail');
    await Bun.write(Bun.stderr, 'y'.repeat(256 * 1024) + 'stderr-tail');
    writeFileSync(${JSON.stringify(readyPath)}, 'ready');`;
  const child = trackGuardRaceChild(Bun.spawn([process.execPath, "--eval", script],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }), "output", readyPath);
  try {
    await waitForPaths([readyPath], [child]);
    await child.process.exited;
    const output = await child.output.finish();
    expect(output.stdout.tail.length).toBeLessThanOrEqual(STARTUP_OUTPUT_TAIL_CHARS);
    expect(output.stderr.tail.length).toBeLessThanOrEqual(STARTUP_OUTPUT_TAIL_CHARS);
    expect(output.stdout.tail).toEndWith("stdout-tail");
    expect(output.stderr.tail).toEndWith("stderr-tail");
  } finally { await stopGuardRaceChildren([child]); }
}, CHILD_TEST_TIMEOUT_MS);

test("generation-race cleanup reaps a child still waiting after readiness", async () => {
  const readyPath = join(testRoot, "held.ready");
  const script = `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(readyPath)}, 'ready'); await Bun.sleep(60_000);`;
  const child = trackGuardRaceChild(Bun.spawn([process.execPath, "--eval", script],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }), "held", readyPath);
  try { await waitForPaths([readyPath], [child]); }
  finally { await stopGuardRaceChildren([child]); }
  expect(child.process.exitCode !== null || child.process.signalCode !== null).toBe(true);
}, CHILD_TEST_TIMEOUT_MS);

test("a throwing guard callback rolls back and releases the transaction", () => {
  expect(() => withExpectedConfigGenerationSync({ value: 0 }, () => {
    throw new Error("guard callback failed");
  })).toThrow("guard callback failed");

  expect(() => saveConfig(config())).not.toThrow();
  expect(readConfigGeneration()).toEqual({
    kind: "ready",
    generation: { value: 1 },
  });
});

test("busy and unavailable databases return typed outcomes instead of throwing", () => {
  expect(readConfigGeneration().kind).toBe("ready");
  const databasePath = join(testRoot, "config-mutation.sqlite");
  const holder = new Database(databasePath, { readwrite: true, create: false });
  holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    expect(readConfigGeneration()).toEqual({ kind: "unavailable", reason: "busy" });
    expect(bumpConfigGeneration({ value: 0 })).toEqual({ kind: "unavailable", reason: "busy" });
    expect(withExpectedConfigGenerationSync({ value: 0 }, () => "must-not-run"))
      .toEqual({ kind: "unavailable", reason: "busy" });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }

  // A file used as the home can retain a failed-open handle on Windows and
  // prevent teardown. A directory at the database path is equally unavailable.
  const unavailableHome = join(testRoot, "unavailable-home");
  mkdirSync(join(unavailableHome, "config-mutation.sqlite"), { recursive: true });
  process.env.CODEX_HOME = unavailableHome;
  process.env.OPENCODEX_HOME = unavailableHome;
  expect(readConfigGeneration()).toEqual({ kind: "unavailable", reason: "database" });
  expect(bumpConfigGeneration({ value: 0 })).toEqual({ kind: "unavailable", reason: "database" });
  expect(withExpectedConfigGenerationSync({ value: 0 }, () => "must-not-run"))
    .toEqual({ kind: "unavailable", reason: "database" });
});
