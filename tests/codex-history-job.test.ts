import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  describeHistoryJobFailure,
  deriveCodexHistoryOperation,
  runCodexHistoryJob,
} from "../src/codex/history-job";

const sandboxes: string[] = [];
let previousCodexHome: string | undefined;

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  previousCodexHome = undefined;
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly canonicalCodexHome: string;
  readonly canonicalStateDbPath: string;
  readonly canonicalBackupPath: string;
}

function makeFixture(prefix: string): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  sandboxes.push(root);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  chmodSync(codexHome, 0o700);

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
  db.run("INSERT INTO threads VALUES ('thread-1', ?, 'opencodex', 'exec', 1, 'hi')", [rollout]);
  db.close();

  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;

  return {
    canonicalCodexHome: codexHome,
    canonicalStateDbPath: stateDb,
    canonicalBackupPath: join(codexHome, "history-backup.json"),
  };
}

/**
 * The opt-out outranks the direction. An apply that migrated history anyway
 * would be `syncResumeHistory: false` failing silently, which is worse than
 * failing loudly.
 */
test("the operation is derived from admitted intent, not chosen by a caller", () => {
  expect(deriveCodexHistoryOperation({ direction: "apply", resumeHistory: false, legacyMode: false }))
    .toBe("skip");
  expect(deriveCodexHistoryOperation({ direction: "restore", resumeHistory: false, legacyMode: true }))
    .toBe("skip");

  // Legacy mode is the only case that routes history TO opencodex; the ordinary
  // apply migrates to native so a later restore has nothing to undo.
  expect(deriveCodexHistoryOperation({ direction: "apply", resumeHistory: true, legacyMode: true }))
    .toBe("apply-opencodex");
  expect(deriveCodexHistoryOperation({ direction: "apply", resumeHistory: true, legacyMode: false }))
    .toBe("migrate-openai");
  expect(deriveCodexHistoryOperation({ direction: "restore", resumeHistory: true, legacyMode: false }))
    .toBe("restore-openai");
});

test("the failure wording names the real reason instead of always blaming the Codex app", () => {
  const busy = { kind: "blocked", reason: "busy" } as const;
  expect(describeHistoryJobFailure(busy, "apply", false)).toContain("history DB is locked");
  expect(describeHistoryJobFailure(busy, "apply", true)).toContain("Close it and rerun 'ocx start'");
  expect(describeHistoryJobFailure(busy, "restore")).toContain("holding the history database");
  expect(describeHistoryJobFailure(busy, "recover-legacy")).toContain("Close it and rerun this command");

  // A busy SQLite database can also surface as a worker failure once the lock
  // was already acquired; it must keep the same lock guidance, not degrade to
  // a generic worker error.
  const workerBusy = {
    kind: "failed",
    reason: "worker-error",
    message: "database is locked",
    historyFailureReason: "busy",
  } as const;
  expect(describeHistoryJobFailure(workerBusy, "apply", false)).toContain("history DB is locked");
  expect(describeHistoryJobFailure(workerBusy, "apply", false)).toContain("retried automatically");
  expect(describeHistoryJobFailure(workerBusy, "restore")).toContain("holding the history database");
  expect(describeHistoryJobFailure(workerBusy, "recover-legacy")).toContain("locked");

  const unsafe = { kind: "blocked", reason: "unsafe-path" } as const;
  const unsafeText = describeHistoryJobFailure(unsafe, "apply");
  expect(unsafeText).toContain("not a Codex app lock");
  expect(unsafeText).toContain("'ocx doctor'");

  const database = { kind: "blocked", reason: "database" } as const;
  expect(describeHistoryJobFailure(database, "restore")).toContain("coordinator database is unavailable");

  const permission = {
    kind: "failed",
    reason: "worker-error",
    message: "history_transition_failed",
    historyFailureReason: "permission",
  } as const;
  expect(describeHistoryJobFailure(permission, "apply")).toContain("permission was denied");
  expect(describeHistoryJobFailure(permission, "apply")).toContain("'ocx doctor'");

  const workerError = { kind: "failed", reason: "worker-error", message: "unable to open database file" } as const;
  expect(describeHistoryJobFailure(workerError, "apply")).toContain("unable to open database file");
  expect(describeHistoryJobFailure(workerError, "apply")).toContain("'ocx doctor'");

  const died = { kind: "failed", reason: "worker-died", message: "history_worker_closed_early" } as const;
  expect(describeHistoryJobFailure(died, "apply")).toContain("exited unexpectedly");

  const timeout = { kind: "failed", reason: "timeout", message: "history_worker_timeout" } as const;
  expect(describeHistoryJobFailure(timeout, "restore")).toContain("timed out");

  // Callers flag failure as "not converged", which also covers these two
  // kinds; the wording must name them rather than returning undefined.
  const skipped = { kind: "skipped" } as const;
  expect(describeHistoryJobFailure(skipped, "recover-legacy")).toContain("skipped");
  const converged = { kind: "converged", rows: 0, files: 0 } as const;
  expect(describeHistoryJobFailure(converged, "apply")).toContain("no failure");
});

test("skip resolves without spawning a thread and writes nothing", async () => {
  const fixture = makeFixture("ocx-history-job-skip-");

  const outcome = await runCodexHistoryJob({ ...fixture, operation: "skip" });
  expect(outcome).toEqual({ kind: "skipped" });

  const db = new Database(fixture.canonicalStateDbPath, { readonly: true });
  const row = db.query<{ model_provider: string }, []>(
    "SELECT model_provider FROM threads WHERE id = 'thread-1'",
  ).get();
  db.close();
  expect(row?.model_provider).toBe("opencodex");
});

/**
 * The real round trip: a Worker thread runs the unit and the parent joins it
 * before returning, so the caller never observes a half-applied transition.
 */
test("a real Worker performs the transition and the parent joins it", async () => {
  const fixture = makeFixture("ocx-history-job-run-");

  const outcome = await runCodexHistoryJob({ ...fixture, operation: "recover-legacy-openai" });
  expect(outcome.kind).toBe("converged");

  // Already committed by the time the promise settles — that is what joining buys.
  const db = new Database(fixture.canonicalStateDbPath, { readonly: true });
  const row = db.query<{ model_provider: string }, []>(
    "SELECT model_provider FROM threads WHERE id = 'thread-1'",
  ).get();
  db.close();
  expect(row?.model_provider).toBe("openai");
}, 30_000);

test("the history job does not resolve before its Worker closes", async () => {
  const fixture = makeFixture("ocx-history-job-close-");
  const NativeWorker = globalThis.Worker;
  let workerClosed = false;

  class ObservedWorker extends NativeWorker {
    constructor(specifier: string | URL, options?: WorkerOptions) {
      super(specifier, options);
      this.addEventListener("close", () => {
        workerClosed = true;
      }, { once: true });
    }
  }

  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    value: ObservedWorker,
    writable: true,
  });
  try {
    const outcome = await runCodexHistoryJob({
      ...fixture,
      operation: "recover-legacy-openai",
    });
    expect(outcome.kind).toBe("converged");
    expect(workerClosed).toBe(true);
  } finally {
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: NativeWorker,
      writable: true,
    });
  }
}, 30_000);

/**
 * A Worker that overruns must not become the caller's stall. The caller here is
 * a route that has already persisted its own mutation; an exception crossing
 * back would turn a successful change into a 500.
 */
test("an overrun Worker returns a typed timeout rather than hanging", async () => {
  const fixture = makeFixture("ocx-history-job-timeout-");

  const started = Date.now();
  const outcome = await runCodexHistoryJob(
    { ...fixture, operation: "recover-legacy-openai" },
    { timeoutMs: 1 },
  );

  // Either the unit beat the 1ms watchdog or the watchdog fired; both are typed,
  // and neither throws.
  expect(["converged", "failed"]).toContain(outcome.kind);
  if (outcome.kind === "failed") expect(outcome.reason).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(20_000);
}, 30_000);

/**
 * The false-lock regression (issue #1191) hid every non-busy failure behind
 * "the Codex app is holding the DB". A hard error must reach the caller with
 * its real message so the diagnosis is possible at all.
 */
test("a hard history error reaches the caller with its real message", async () => {
  const fixture = makeFixture("ocx-history-job-hard-error-");
  // A directory at the state-DB path cannot be opened as SQLite.
  rmSync(fixture.canonicalStateDbPath, { force: true });
  mkdirSync(fixture.canonicalStateDbPath);

  const outcome = await runCodexHistoryJob({ ...fixture, operation: "recover-legacy-openai" });
  expect(outcome.kind).toBe("failed");
  if (outcome.kind === "failed") {
    expect(outcome.message).toMatch(/unable to open|not a database|cannot open/i);
  }
}, 30_000);

/**
 * The async restore wrapper owns history; the synchronous body must not also do
 * it when told to stand down, or every restore would run the transition twice —
 * once unserialized on the caller thread, which is the path this phase removed.
 *
 * Proven by BEHAVIOR in a child process. The provider resolves its state
 * database from a module-load constant, so the fixture `CODEX_HOME` must be in
 * the environment before the module loads — a spawned child gives exactly that.
 * The fixture DB holds a restorable opencodex-tagged row; `skipHistory: true`
 * must leave it tagged, and the default must restore it.
 */
test("the synchronous restore body is gated on skipHistory", () => {
  const repoRoot = join(import.meta.dir, "..");
  const root = mkdtempSync(join(tmpdir(), "ocx-restore-skiphistory-"));
  const fixtureCodexHome = join(root, ".codex");
  const fixtureOcxHome = join(root, ".opencodex");
  mkdirSync(fixtureCodexHome, { recursive: true });
  mkdirSync(fixtureOcxHome, { recursive: true });
  try {
    writeFileSync(join(fixtureCodexHome, "config.toml"), 'model = "gpt-5"\n', "utf8");
    const rollout = join(fixtureCodexHome, "rollout.jsonl");
    writeFileSync(rollout, JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-1", model_provider: "opencodex", source: "cli", cwd: fixtureCodexHome },
    }) + "\n");
    const dbPath = join(fixtureCodexHome, "state_5.sqlite");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (
      id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL,
      source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL DEFAULT 0)`);
    db.run(`INSERT INTO threads VALUES ('thread-1', ?, 'opencodex', 'cli', 'hello', 1)`, rollout);
    db.close();

    const runRestore = (optionsLiteral: string) => spawnSync(process.execPath, ["--eval", [
      'const { restoreNativeCodex } = require("./src/codex/inject");',
      `const result = restoreNativeCodex(${optionsLiteral});`,
      'console.log(JSON.stringify({ history: result.artifacts.history.state }));',
    ].join("\n")], {
      cwd: repoRoot,
      env: { ...process.env, CODEX_HOME: fixtureCodexHome, OPENCODEX_HOME: fixtureOcxHome },
      encoding: "utf8",
    });
    const provider = () => {
      const check = new Database(dbPath, { readonly: true });
      const row = check.query<{ model_provider: string }, []>(
        "SELECT model_provider FROM threads WHERE id = 'thread-1'",
      ).get();
      check.close();
      return row?.model_provider;
    };

    // skipHistory: the wrapper owns history, so the synchronous body writes none.
    const skipped = runRestore("{ skipHistory: true }");
    expect(skipped.status).toBe(0);
    expect(JSON.parse(skipped.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}")).toEqual({ history: "skipped" });
    expect(provider()).toBe("opencodex");

    // Default: the same body restores history itself.
    const restored = runRestore("{}");
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}")).toEqual({ history: "ok" });
    expect(provider()).toBe("openai");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
