import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { historyBackupPathFor, setBeforeHistoryBackupConsumeForTests, setHistoryDbBusyTimeoutForTests } from "../src/codex/history-provider";
import {
  isHistoryWorkerRunMessage,
  runHistoryUnitUnderLock,
  type HistoryWorkerRunMessage,
} from "../src/codex/history-worker";

// A held write lock otherwise costs the full production 5s busy timeout per
// attempt, tripping bun's 5s default per-test timeout.
setHistoryDbBusyTimeoutForTests(250);
setDefaultTimeout(30_000);

const repoRoot = resolve(import.meta.dir, "..");
const sandboxes: string[] = [];
const backupArtifacts: string[] = [];

afterEach(() => {
  setBeforeHistoryBackupConsumeForTests(undefined);
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const path of backupArtifacts.splice(0)) rmSync(path, { force: true });
});

interface Fixture {
  readonly codexHome: string;
  readonly stateDb: string;
  readonly backup: string;
  readonly rollout: string;
  readonly env: Record<string, string>;
}

function makeFixture(prefix: string): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  sandboxes.push(root);
  const codexHome = join(root, "codex-home");
  const home = join(root, "user-home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, home, runtime]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o700);
  }

  const stateDb = join(codexHome, "state_5.sqlite");
  const rollout = join(codexHome, "rollout.jsonl");
  writeFileSync(rollout, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "thread-1", model_provider: "opencodex", source: "exec" },
  })}\n`);

  const db = new Database(stateDb, { create: true });
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT,
    source TEXT, has_user_event INTEGER, first_user_message TEXT
  )`);
  db.run(
    "INSERT INTO threads VALUES ('thread-1', ?, 'opencodex', 'exec', 1, 'hi')",
    [rollout],
  );
  db.close();

  return {
    codexHome,
    stateDb,
    backup: join(codexHome, "history-backup.json"),
    rollout,
    env: {
      ...Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CODEX_HOME: codexHome,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: runtime,
      TEMP: runtime,
      TMP: runtime,
      XDG_RUNTIME_DIR: runtime,
    },
  };
}

function runMessage(fixture: Fixture, overrides: Partial<HistoryWorkerRunMessage> = {}): HistoryWorkerRunMessage {
  return {
    type: "run",
    requestId: "req-1",
    jobId: "job-1",
    operation: "recover-legacy-openai",
    canonicalCodexHome: fixture.codexHome,
    canonicalStateDbPath: fixture.stateDb,
    canonicalBackupPath: fixture.backup,
    ...overrides,
  } as HistoryWorkerRunMessage;
}

/**
 * The message must survive structured clone, which is what "Worker boundary" is
 * really asserting: no function, no class instance, no handle, no path that
 * resolves differently in another process.
 */
test("the run message is structured-clone safe and fully explicit", () => {
  const fixture = makeFixture("ocx-history-worker-clone-");
  const message = runMessage(fixture);

  const cloned = structuredClone(message);
  expect(cloned).toEqual(message);
  expect(isHistoryWorkerRunMessage(cloned)).toBe(true);

  // Every path is carried, because a Worker does not inherit the module-load
  // CODEX_HOME that history-provider resolves at import time.
  for (const field of ["canonicalCodexHome", "canonicalStateDbPath", "canonicalBackupPath"] as const) {
    const { [field]: _omitted, ...without } = message;
    expect(isHistoryWorkerRunMessage(without)).toBe(false);
    expect(isHistoryWorkerRunMessage({ ...message, [field]: "  " })).toBe(false);
  }

  // A direction is not part of the protocol at all: the operation is the only
  // thing that decides which way history moves.
  expect(Object.keys(message)).not.toContain("targetProvider");
  expect(Object.keys(message)).not.toContain("direction");

  // An unknown operation is refused rather than coerced.
  expect(isHistoryWorkerRunMessage({ ...message, operation: "delete-everything" })).toBe(false);
});

test("skip is a recorded outcome, not an absence, and writes nothing", () => {
  const fixture = makeFixture("ocx-history-worker-skip-");
  const before = readFileSync(fixture.rollout, "utf8");

  const result = runHistoryUnitUnderLock(runMessage(fixture, { operation: "skip" }));

  expect(result).toMatchObject({ type: "done", outcome: "skipped", rows: 0, files: 0 });
  expect(readFileSync(fixture.rollout, "utf8")).toBe(before);
  expect(existsSync(fixture.backup)).toBe(false);
});

test("the unit runs the real transition under H", () => {
  const fixture = makeFixture("ocx-history-worker-run-");

  const result = runHistoryUnitUnderLock(runMessage(fixture));
  expect(result).toMatchObject({ type: "done", outcome: "converged" });

  const db = new Database(fixture.stateDb, { readonly: true });
  const row = db.query<{ model_provider: string }, []>(
    "SELECT model_provider FROM threads WHERE id = 'thread-1'",
  ).get();
  db.close();
  expect(row?.model_provider).toBe("openai");
});

test("migrate-openai returns a verified no-op only after entering H", () => {
  const fixture = makeFixture("ocx-history-worker-noop-");
  const backup = historyBackupPathFor(fixture.stateDb);
  backupArtifacts.push(backup);
  const databaseBefore = readFileSync(fixture.stateDb);
  const rolloutBefore = readFileSync(fixture.rollout);

  const result = runHistoryUnitUnderLock(runMessage(fixture, {
    operation: "migrate-openai",
    canonicalBackupPath: backup,
  }));

  expect(result).toMatchObject({
    type: "done",
    outcome: "converged",
    rows: 0,
    files: 0,
    proof: {
      kind: "verified-noop",
      pendingRows: 0,
      backupEntries: 0,
      canonicalStateDbPath: fixture.stateDb,
      stateDbPresent: true,
      canonicalBackupPath: backup,
      backupPresent: false,
    },
  });
  expect(readFileSync(fixture.stateDb).equals(databaseBefore)).toBe(true);
  expect(readFileSync(fixture.rollout).equals(rolloutBefore)).toBe(true);
  expect(existsSync(backup)).toBe(false);
});

test("restore-openai leaves bare routed history byte-identical", () => {
  const fixture = makeFixture("ocx-history-worker-restore-noop-");
  const databaseBefore = readFileSync(fixture.stateDb);
  const rolloutBefore = readFileSync(fixture.rollout);

  const result = runHistoryUnitUnderLock(runMessage(fixture, { operation: "restore-openai" }));

  expect(result).toMatchObject({ type: "done", outcome: "converged", rows: 0, files: 0 });
  expect(readFileSync(fixture.stateDb).equals(databaseBefore)).toBe(true);
  expect(readFileSync(fixture.rollout).equals(rolloutBefore)).toBe(true);
  expect(existsSync(fixture.backup)).toBe(false);
});

test("manifest-backed restore preserves routed provenance and the next migrate is a verified no-op", () => {
  const fixture = makeFixture("ocx-history-worker-exact-");
  const backup = historyBackupPathFor(fixture.stateDb);
  backupArtifacts.push(backup);
  mkdirSync(dirname(backup), { recursive: true });
  const db = new Database(fixture.stateDb);
  db.run("UPDATE threads SET source = 'cli', has_user_event = 1 WHERE id = 'thread-1'");
  db.close();
  appendFileSync(fixture.rollout, `${JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { id: "thread-1", model_provider: "opencodex", source: "cli" },
  })}\n`);
  writeFileSync(backup, JSON.stringify({
    version: 1,
    stateDbPath: fixture.stateDb,
    entries: {
      "thread-1": {
        id: "thread-1",
        rolloutPath: fixture.rollout,
        modelProvider: "opencodex",
        source: "exec",
        hasUserEvent: 0,
      },
    },
  }));

  const restored = runHistoryUnitUnderLock(runMessage(fixture, {
    operation: "restore-openai",
    canonicalBackupPath: backup,
  }));
  expect(restored).toMatchObject({ type: "done", outcome: "converged", rows: 1, files: 1 });
  const restoredDb = new Database(fixture.stateDb, { readonly: true });
  expect(restoredDb.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-1'").get())
    .toEqual({ model_provider: "opencodex", source: "exec", has_user_event: 0 });
  restoredDb.close();
  expect(JSON.parse(readFileSync(fixture.rollout, "utf8").trim().split("\n").at(-1)!).payload)
    .toMatchObject({ id: "thread-1", model_provider: "opencodex", source: "exec" });
  expect(existsSync(backup)).toBe(false);

  const again = runHistoryUnitUnderLock(runMessage(fixture, {
    operation: "migrate-openai",
    canonicalBackupPath: backup,
  }));
  expect(again).toMatchObject({
    type: "done",
    outcome: "converged",
    rows: 0,
    files: 0,
    proof: { kind: "verified-noop", pendingRows: 0, backupEntries: 0 },
  });
});

test("a late permission failure reports already-applied row and file progress", () => {
  const fixture = makeFixture("ocx-history-worker-partial-");
  const backup = historyBackupPathFor(fixture.stateDb);
  backupArtifacts.push(backup);
  mkdirSync(dirname(backup), { recursive: true });
  const db = new Database(fixture.stateDb);
  db.run("UPDATE threads SET source = 'cli', has_user_event = 1 WHERE id = 'thread-1'");
  db.close();
  appendFileSync(fixture.rollout, `${JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-05T00:00:00.000Z",
    payload: { id: "thread-1", model_provider: "opencodex", source: "cli" },
  })}\n`);
  writeFileSync(backup, JSON.stringify({
    version: 1,
    stateDbPath: fixture.stateDb,
    entries: {
      "thread-1": {
        id: "thread-1",
        rolloutPath: fixture.rollout,
        modelProvider: "opencodex",
        source: "exec",
        hasUserEvent: 0,
      },
    },
  }));
  setBeforeHistoryBackupConsumeForTests(() => {
    throw Object.assign(new Error("manifest finalization denied"), { code: "EPERM" });
  });

  const result = runHistoryUnitUnderLock(runMessage(fixture, {
    operation: "restore-openai",
    canonicalBackupPath: backup,
  }));

  expect(result).toMatchObject({
    type: "error",
    reason: "permission",
    rows: 1,
    files: 1,
  });
  expect(existsSync(backup)).toBe(true);
});

test("malformed manifest blocks restore without changing the database, rollout, or manifest", () => {
  const fixture = makeFixture("ocx-history-worker-malformed-");
  const backup = historyBackupPathFor(fixture.stateDb);
  backupArtifacts.push(backup);
  mkdirSync(dirname(backup), { recursive: true });
  writeFileSync(backup, JSON.stringify({
    version: 1,
    stateDbPath: fixture.stateDb,
    entries: { "thread-1": { id: "thread-1", rolloutPath: fixture.rollout } },
  }));
  const databaseBefore = readFileSync(fixture.stateDb);
  const rolloutBefore = readFileSync(fixture.rollout);
  const manifestBefore = readFileSync(backup);

  expect(runHistoryUnitUnderLock(runMessage(fixture, {
    operation: "restore-openai",
    canonicalBackupPath: backup,
  }))).toMatchObject({ type: "error", reason: "integrity" });
  expect(readFileSync(fixture.stateDb).equals(databaseBefore)).toBe(true);
  expect(readFileSync(fixture.rollout).equals(rolloutBefore)).toBe(true);
  expect(readFileSync(backup).equals(manifestBefore)).toBe(true);
});

/**
 * The reason the unit lives in a Worker at all: while another process holds H,
 * this one reports a typed block instead of stalling its own thread.
 */
test("a second holder of H makes the unit report blocked rather than wait", async () => {
  const fixture = makeFixture("ocx-history-worker-busy-");
  const ready = join(fixture.codexHome, "..", "held");
  const release = join(fixture.codexHome, "..", "release");

  const holder = Bun.spawn([process.execPath, "--eval", `
    import { existsSync, writeFileSync } from "node:fs";
    const { withHistoryWriteSerialization } = await import("./src/codex/history-lock.ts");
    const outcome = withHistoryWriteSerialization(
      ${JSON.stringify(fixture.codexHome)},
      ${JSON.stringify(fixture.stateDb)},
      () => {
        writeFileSync(${JSON.stringify(ready)}, "held");
        const waiter = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(${JSON.stringify(release)})) Atomics.wait(waiter, 0, 0, 10);
      },
    );
    if (outcome.kind !== "completed") throw new Error(JSON.stringify(outcome));
  `], { cwd: repoRoot, env: fixture.env, stdout: "pipe", stderr: "pipe" });

  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("holder never acquired H");
      await Bun.sleep(5);
    }

    const started = Date.now();
    const result = runHistoryUnitUnderLock(runMessage(fixture));
    expect(result).toMatchObject({ type: "blocked", reason: "busy" });
    // Fail-fast, not a stall: blocking here is the freeze this phase removes.
    expect(Date.now() - started).toBeLessThan(2_000);

    // Nothing was written while the other process held the lock.
    const db = new Database(fixture.stateDb, { readonly: true });
    const row = db.query<{ model_provider: string }, []>(
      "SELECT model_provider FROM threads WHERE id = 'thread-1'",
    ).get();
    db.close();
    expect(row?.model_provider).toBe("opencodex");
  } finally {
    writeFileSync(release, "release");
    expect(await holder.exited).toBe(0);
  }
}, 30_000);

/**
 * The reason the parent can tell a false "app holds the DB" from a real one:
 * a transition that survives retries reports WHY it failed, not a fixed code
 * that reads as "locked" everywhere.
 */
test("a failed transition reports the failure reason, not a fixed lock claim", () => {
  const fixture = makeFixture("ocx-history-worker-error-");
  const holder = new Database(fixture.stateDb);
  holder.exec("BEGIN IMMEDIATE");
  try {
    const result = runHistoryUnitUnderLock(runMessage(fixture, { operation: "recover-legacy-openai" }));
    expect(result).toMatchObject({ type: "error", reason: "busy" });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});
