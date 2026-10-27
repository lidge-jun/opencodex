import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { repoRoot } from "../helpers/repo-root";
import { RolloutCacheRuntime } from "../../src/codex/rollout-cache-runtime";

const thread = "11111111-1111-4111-8111-111111111111";
const turn = "22222222-2222-4222-8222-222222222222";
const event = (type: string, ownTurn = turn) => JSON.stringify({ type: "event_msg", payload: { type, turn_id: ownTurn } }) + "\n";
const large = (type: string) => JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type,
  payload: { text: "synthetic-history".repeat(110000) } }) + "\n";

function fixture() {
  const scratch = join(repoRoot(), ".tmp"); mkdirSync(scratch, { recursive: true });
  const home = mkdtempSync(join(scratch, "cache-runtime-"));
  const rollout = join(home, "rollout.jsonl"), state = join(home, "state.sqlite");
  writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n" + event("task_started"));
  const db = new Database(state);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
  db.query("INSERT INTO threads VALUES (?, ?)").run(thread, rollout); db.close();
  let held = true;
  const reader = new RolloutCacheRuntime(thread, turn, () => {}, {
    home: () => home, statePath: () => state, writerHeld: () => held,
  });
  return { rollout, reader, loseWriter: () => { held = false; },
    close() { reader.close(); rmSync(home, { recursive: true, force: true }); } };
}

for (const type of ["compacted", "turn_context", "response_item", "token_usage_record"]) {
  test(`oversized ${type} preserves the running turn and the following completion is observed`, async () => {
    const f = fixture();
    try {
      appendFileSync(f.rollout, large(type));
      expect((await f.reader.refresh()).running).toBe(true);
      appendFileSync(f.rollout, event("task_complete"));
      expect((await f.reader.refresh()).running).toBe(false);
      appendFileSync(f.rollout, large(type));
      expect((await f.reader.refresh()).running).toBe(false);
    } finally { f.close(); }
  });
}

for (const terminal of ["task_complete", "turn_aborted"]) {
  test(`partial ${terminal} waits for a complete line and never revives the ended turn`, async () => {
    const f = fixture();
    try {
      expect((await f.reader.refresh()).running).toBe(true);
      appendFileSync(f.rollout, event(terminal).trimEnd());
      expect((await f.reader.refresh()).running).toBe(true);
      appendFileSync(f.rollout, "\n" + large("compacted"));
      expect((await f.reader.refresh()).running).toBe(false);
    } finally { f.close(); }
  });
}

test("a different turn, missing writer or unknown large format cannot authorize renewal", async () => {
  for (const reason of ["turn", "writer", "format"]) {
    const f = fixture();
    try {
      expect((await f.reader.refresh()).running).toBe(true);
      if (reason === "turn") appendFileSync(f.rollout, event("task_started", "33333333-3333-4333-8333-333333333333"));
      if (reason === "writer") f.loseWriter();
      if (reason === "format") appendFileSync(f.rollout, large("future_unknown"));
      expect((await f.reader.refresh()).running).toBe(false);
    } finally { f.close(); }
  }
});
