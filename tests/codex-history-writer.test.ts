import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  withHistoryWriteSerialization,
  type HistoryWritePermit,
} from "../src/codex/history-lock";
import {
  writeHistoryProviderTransition,
  writeLegacyOpenaiHistoryRecovery,
  type HistoryWriteTarget,
} from "../src/codex/internal/history-writer";

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeTarget(prefix: string): { codexHome: string; target: HistoryWriteTarget } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  sandboxes.push(root);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  chmodSync(codexHome, 0o700);

  const canonicalStateDbPath = join(codexHome, "state_5.sqlite");
  const db = new Database(canonicalStateDbPath, { create: true });
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT,
    source TEXT, has_user_event INTEGER, first_user_message TEXT
  )`);
  db.close();

  return {
    codexHome,
    target: {
      canonicalStateDbPath,
      canonicalBackupPath: join(codexHome, "history-backup.json"),
    },
  };
}

/**
 * The whole point of the permit argument: a writer reached without H fails
 * closed instead of racing. A type alone cannot enforce this, because a permit
 * leaked past its callback still type-checks.
 */
test("every history writer refuses a permit that is not live", () => {
  const { codexHome, target } = makeTarget("ocx-history-writer-dead-");

  let leaked!: HistoryWritePermit;
  withHistoryWriteSerialization(codexHome, target.canonicalStateDbPath, permit => {
    leaked = permit;
  });

  expect(() => writeHistoryProviderTransition(leaked, target, "openai"))
    .toThrow(/released acquisition/);
  expect(() => writeLegacyOpenaiHistoryRecovery(leaked, target))
    .toThrow(/released acquisition/);

  // A forged value of the right type is refused for the same reason.
  const forged = {} as HistoryWritePermit;
  expect(() => writeHistoryProviderTransition(forged, target, "openai"))
    .toThrow(/not minted by the serialization owner/);
  expect(() => writeLegacyOpenaiHistoryRecovery(forged, target))
    .toThrow(/not minted by the serialization owner/);
});

test("a live permit for another state database cannot write this one", () => {
  const first = makeTarget("ocx-history-writer-a-");
  const second = makeTarget("ocx-history-writer-b-");

  const outcome = withHistoryWriteSerialization(
    first.codexHome,
    first.target.canonicalStateDbPath,
    permit => {
      // Live, but authorized for a different history database.
      expect(() => writeHistoryProviderTransition(permit, second.target, "openai"))
        .toThrow(/different Codex state database/);
      return writeHistoryProviderTransition(permit, first.target, "openai");
    },
  );
  expect(outcome.kind).toBe("completed");
});

test("a writer holding a live permit performs the real transition", () => {
  const { codexHome, target } = makeTarget("ocx-history-writer-live-");
  const rollout = join(codexHome, "rollout.jsonl");
  writeFileSync(rollout, `${JSON.stringify({
    type: "session_meta",
    payload: { id: "thread-1", model_provider: "opencodex", source: "exec" },
  })}\n`);

  const db = new Database(target.canonicalStateDbPath);
  db.run(
    "INSERT INTO threads (id, rollout_path, model_provider, source, has_user_event, first_user_message) VALUES (?, ?, 'opencodex', 'exec', 1, 'hi')",
    ["thread-1", rollout],
  );
  db.close();

  const outcome = withHistoryWriteSerialization(
    codexHome,
    target.canonicalStateDbPath,
    permit => writeLegacyOpenaiHistoryRecovery(permit, target),
  );

  expect(outcome.kind).toBe("completed");
  if (outcome.kind !== "completed") return;
  // Manifest-independent recovery patches rollout metadata as well as rows, which
  // is why calling it DB-only would be wrong.
  expect(outcome.value.rows).toBeGreaterThan(0);

  const after = new Database(target.canonicalStateDbPath, { readonly: true });
  const row = after.query<{ model_provider: string }, []>(
    "SELECT model_provider FROM threads WHERE id = 'thread-1'",
  ).get();
  after.close();
  expect(row?.model_provider).toBe("openai");
});
