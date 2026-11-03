import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_ERROR_TYPES, ANTHROPIC_ERROR_CODES } from "../../src/lib/client-error-body";
import { fixturePath, helperPath, repoRoot } from "../helpers/repo-root";
import { applicableMessagesOverflowFixtures, messagesOverflowLanes, type MessagesOverflowFixture } from "../helpers/messages-overflow-cases";

type Observation = { status: number; success: boolean; mediaType: string | null; type?: string; code?: string | null; text: string; clientRecognizes: boolean; compactionSentence: boolean; internalDecisions: Record<string, boolean> };
type Row = { lane: string; input: MessagesOverflowFixture; base?: Observation; head?: Observation };
const golden = JSON.parse(readFileSync(fixturePath("messages-overflow-decisions.json"), "utf8")) as { schemaVersion: number; baseCommit: string; rows: Row[] };
const head = new Map<string, Row>();
const key = (row: Row) => `${row.lane}/${row.input.id}`;
beforeAll(async () => {
  expect(golden.schemaVersion).toBe(3);
  expect(golden.baseCommit).toBe("72e80d280d614bdf4f1aada9b233f6732404afec");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-overflow-decisions-"));
  try {
    mkdirSync(join(scratch, "ocx")); mkdirSync(join(scratch, "codex"));
    const output = join(scratch, "head.json");
    const child = Bun.spawn([process.execPath, helperPath("messages-overflow-differential.ts"), "head", scratch, output], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(scratch, "ocx"), CODEX_HOME: join(scratch, "codex") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Head fixture exited ${exit}\n${stdout}\n${stderr}`);
    const result = JSON.parse(readFileSync(output, "utf8")) as { rows: Row[] };
    expect(golden.rows).toHaveLength(messagesOverflowLanes.reduce((count, lane) => count + applicableMessagesOverflowFixtures(lane).length, 0));
    expect(result.rows).toHaveLength(golden.rows.length);
    for (const row of result.rows) { expect(head.has(key(row))).toBe(false); head.set(key(row), row); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 60000);
for (const base of golden.rows) test(`${key(base)}: origin/dev client recovery`, () => {
  const current = head.get(key(base))!;
  expect(current).toBeDefined(); expect(current.input).toEqual(base.input);
  const before = base.base!; const after = current.head!;
  expect(after.text.length).toBeGreaterThan(0);
  expect(after.status).toBe(before.status);
  expect(after.success).toBe(before.success);
  if (before.success) {
    expect(after.text).toBe(before.text);
    expect(after.mediaType).toBe(before.mediaType);
    expect(after.internalDecisions).toEqual(before.internalDecisions);
    expect(after.clientRecognizes).toBe(before.clientRecognizes);
    return;
  }
  expect(after.text).not.toContain("zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e");
  expect(after.status).toBe(before.status);
  expect(after.clientRecognizes).toBe(before.clientRecognizes);
  expect(after.compactionSentence).toBe(before.clientRecognizes);
  expect(after.internalDecisions).toEqual(before.internalDecisions);
  expect(ANTHROPIC_ERROR_TYPES.has(after.type ?? "")).toBe(true);
  if (ANTHROPIC_ERROR_TYPES.has(before.type ?? "")) expect(after.type).toBe(before.type);
  expect(after.code).toBe(typeof before.code === "string" && ANTHROPIC_ERROR_CODES.has(before.code) ? before.code : undefined);
});
