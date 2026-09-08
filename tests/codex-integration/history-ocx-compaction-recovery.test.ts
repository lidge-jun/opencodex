import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recoverOcxCompactionHistory,
  rewriteOcxCompactionsForNativeReplay,
} from "../../src/codex/ocx-compaction-history";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../../src/responses/compaction";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("OpenCodeX compaction history recovery", () => {
  test("lowers only proxy-owned compactions in compacted replacement history", () => {
    const source = [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-fixture" } }),
      JSON.stringify({
        type: "compacted",
        payload: {
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "keep" }] },
            {
              type: "compaction",
              id: "cmp_fixture",
              encrypted_content: encodeCompactionSummary("fixture summary"),
            },
            { type: "compaction", id: "cmp_native", encrypted_content: "native-opaque" },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "compaction", encrypted_content: encodeCompactionSummary("historical output") },
      }),
      "",
    ].join("\n");

    const result = rewriteOcxCompactionsForNativeReplay(source);

    expect(result.replaced).toBe(1);
    const lines = result.content.trimEnd().split("\n").map(line => JSON.parse(line));
    expect(lines[1].payload.replacement_history).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "keep" }] },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nfixture summary` }],
      },
      { type: "compaction", id: "cmp_native", encrypted_content: "native-opaque" },
    ]);
    expect(lines[2].payload.encrypted_content).toStartWith("ocx1:");
    expect(result.content.endsWith("\n")).toBe(true);
  });

  test("is byte-stable when no repairable compaction exists", () => {
    const source = `${JSON.stringify({
      type: "compacted",
      payload: { replacement_history: [{ type: "compaction", encrypted_content: "native-opaque" }] },
    })}\nnot-json\n`;

    expect(rewriteOcxCompactionsForNativeReplay(source)).toEqual({ content: source, replaced: 0 });
  });

  test("backs up and atomically repairs one database-selected rollout", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-compaction-recovery-"));
    try {
      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions", "2026", "09", "07");
      const backupRoot = join(root, "backups");
      mkdirSync(rolloutDir, { recursive: true });
      const threadId = "01a018e6-242f-7801-81b8-ffc0a5c6d589";
      const rolloutPath = join(rolloutDir, `rollout-fixture-${threadId}.jsonl`);
      const original = `${JSON.stringify({
        type: "compacted",
        payload: {
          replacement_history: [{
            type: "compaction",
            id: "cmp_fixture",
            encrypted_content: encodeCompactionSummary("recover me"),
          }],
        },
      })}\n`;
      writeFileSync(rolloutPath, original, "utf8");
      const stateDbPath = join(codexHome, "state_5.sqlite");
      const db = new Database(stateDbPath, { create: true });
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
      db.query("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(threadId, rolloutPath);
      db.close();

      const result = recoverOcxCompactionHistory({
        threadId,
        codexHome,
        stateDbPath,
        backupRoot,
        now: () => new Date("2026-09-07T00:00:00.000Z"),
      });

      expect(result.replaced).toBe(1);
      expect(result.backupPath).not.toBeNull();
      expect(readFileSync(result.backupPath!, "utf8")).toBe(original);
      expect(readFileSync(rolloutPath, "utf8")).toContain(`${SUMMARY_PREFIX}\\nrecover me`);
      expect(readFileSync(rolloutPath, "utf8")).not.toContain("ocx1:");
    } finally {
      removeTreeWithRetry(root);
    }
  });
});
