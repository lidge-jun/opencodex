import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_ERROR_TYPES, ANTHROPIC_ERROR_CODES } from "../../src/lib/client-error-body";
import { fixturePath, helperPath, repoRoot } from "../helpers/repo-root";
import { messagesOverflowFixtures, messagesOverflowLanes, type MessagesOverflowFixture } from "../helpers/messages-overflow-cases";

type Row = { lane: string; input: MessagesOverflowFixture; status: number; type?: string; code?: string | null; text: string; decision: boolean; clientRecognizes: boolean; compactionSentence: boolean };
const golden = JSON.parse(readFileSync(fixturePath("messages-overflow-decisions.json"), "utf8")) as { baseCommit: string; rows: Row[] };
const head = new Map<string, Row>();
const key = (row: Row) => `${row.lane}/${row.input.id}`;
beforeAll(async () => {
  expect(golden.baseCommit).toBe("72e80d280d614bdf4f1aada9b233f6732404afec");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-overflow-decisions-"));
  try {
    mkdirSync(join(scratch, "ocx")); mkdirSync(join(scratch, "codex"));
    const output = join(scratch, "head.json");
    const child = Bun.spawn([process.execPath, helperPath("messages-overflow-differential.ts"), "head", scratch, output], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(scratch, "ocx"), CODEX_HOME: join(scratch, "codex") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Head fixture exited ${exit}\n${stdout}\n${stderr}`);
    const result = JSON.parse(readFileSync(output, "utf8")) as { rows: Row[] };
    expect(golden.rows).toHaveLength(messagesOverflowLanes.length * messagesOverflowFixtures.length);
    expect(result.rows).toHaveLength(golden.rows.length);
    for (const row of result.rows) { expect(head.has(key(row))).toBe(false); head.set(key(row), row); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 60000);
for (const base of golden.rows) test(`${key(base)}: origin/dev overflow decision`, () => {
  const current = head.get(key(base))!;
  expect(current).toBeDefined(); expect(current.input).toEqual(base.input);
  expect(current.text.length).toBeGreaterThan(0);
  expect(current.text).not.toContain("zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e");
  expect(current.compactionSentence).toBe(base.decision);
  expect(current.status).toBe(base.status);
  expect(ANTHROPIC_ERROR_TYPES.has(current.type ?? "")).toBe(true);
  if (ANTHROPIC_ERROR_TYPES.has(base.type ?? "")) expect(current.type).toBe(base.type);
  expect(current.code).toBe(typeof base.code === "string" && ANTHROPIC_ERROR_CODES.has(base.code) ? base.code : undefined);
});
