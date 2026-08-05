import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
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
 * The async restore wrapper owns history; the synchronous body must not also do
 * it, or every restore would run the transition twice — once unserialized on the
 * caller thread, which is the path this phase exists to remove.
 *
 * Asserted against the SOURCE rather than by running it. The synchronous body
 * resolves its state database from a module-load constant
 * (`history-provider.ts:16`), so a test that moves `CODEX_HOME` cannot observe
 * which database it would have touched — a behavioural version of this passed
 * with `skipHistory` ignored entirely, which is worse than no test. Removing the
 * guard changes this text, and that is something a check can actually see.
 */
test("the synchronous restore body is gated on skipHistory", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "codex", "inject.ts"), "utf8");
  const body = source.slice(source.indexOf("export function restoreNativeCodex("));
  const historyCall = body.indexOf("syncCodexHistoryProvider(\"openai\"");
  expect(historyCall).toBeGreaterThan(-1);

  // The inline call is reachable only through the gate.
  const gate = body.indexOf("options.skipHistory");
  expect(gate).toBeGreaterThan(-1);
  expect(gate).toBeLessThan(historyCall);

  // And the async wrapper is the thing that sets it.
  expect(source).toContain("restoreNativeCodex({ skipHistory: true })");
});
