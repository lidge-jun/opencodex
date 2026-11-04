import { messagesFold502Cases } from "./messages-sse-fold-exceptions";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_ERROR_TYPES, ANTHROPIC_ERROR_CODES } from "../../src/lib/client-error-body";
import { fixturePath, helperPath, repoRoot } from "./repo-root";
import { applicableMessagesOverflowFixtures, messagesOverflowLanes, messagesOverflowCaseId, messagesOverflowCaseTableHash, type MessagesOverflowFixture } from "./messages-overflow-cases";

type Observation = { status: number; bodySha256: string; bodyLength: number; clientError: boolean; envelopeType?: string; mediaType: string | null; type?: string; code?: string | null; text: string; clientRecognizes: boolean; compactionSentence: boolean; internalDecisions: Record<string, boolean> };
type Row = { lane: typeof messagesOverflowLanes[number]; input: MessagesOverflowFixture; head: Observation };
// Dictionary indexes retain every comparison without repeating input data or error bodies.
type Outcome = [lane: number, status: number, clientRecognizes: boolean, decisions: number, classification: "error" | "success",
  type: number, code: number, mediaType: number, clientError: boolean, bodySha256?: string, bodyLength?: number];
type Golden = { schemaVersion: number; baseCommit: string; caseTableSha256: string; columns: string[];
  lanes: typeof messagesOverflowLanes; decisions: Record<string, boolean>[]; types: (string | null)[];
  codes: (string | null)[]; mediaTypes: (string | null)[]; outcomes: Record<string, Outcome> };
export const golden = JSON.parse(readFileSync(fixturePath("messages-overflow-decisions.json"), "utf8")) as Golden;
if (golden.caseTableSha256 !== messagesOverflowCaseTableHash()) {
  throw new Error("Messages overflow case table changed without baseline regeneration; run messages-overflow-differential.ts --generate-base <scratch> tests/fixtures/messages-overflow-decisions.json with base 72e80d280 available.");
}
export const cases = messagesOverflowLanes.flatMap(lane => applicableMessagesOverflowFixtures(lane).map(input => ({ lane, input })));
export const key = (row: Pick<Row, "lane" | "input">) => messagesOverflowCaseId(row.lane, row.input);

function assertRow(base: Pick<Row, "lane" | "input">, current: Row) {
  const outcome = golden.outcomes[key(base)]!;
  expect(outcome).toBeDefined();
  expect(golden.lanes[outcome[0]]).toBe(base.lane);
  const before = { status: outcome[1], clientRecognizes: outcome[2], internalDecisions: golden.decisions[outcome[3]],
    classification: outcome[4], type: golden.types[outcome[5]] ?? undefined, code: golden.codes[outcome[6]] ?? undefined,
    mediaType: golden.mediaTypes[outcome[7]], clientError: outcome[8], bodySha256: outcome[9], bodyLength: outcome[10] };
  expect(current.input).toEqual(base.input);
  const after = current.head;
  expect(after.text.length).toBeGreaterThan(0);
  const fold502 = (base.lane === "native-fold" || base.lane === "native-fold-builtin") && messagesFold502Cases.has(base.input.id);
  if (fold502) {
    expect(before.status).toBe(200);
    expect(base.input.eventLanes).toContain(base.lane);
  }
  expect(after.status).toBe(fold502 ? 502 : before.status);
  const classification = base.input.classification[base.lane];
  expect(["error", "success"]).toContain(classification);
  expect(classification).toBe(before.classification);
  if (["native-fold", "native-fold-builtin", "direct-collector"].includes(base.lane)) {
    expect(classification).toBe("error");
    if (!base.input.fault) expect(base.input.eventLanes).toContain(base.lane);
  }
  expect(before.clientRecognizes).toBe(base.input.recovery[base.lane]);
  expect(after.clientRecognizes).toBe(base.input.recovery[base.lane]);
  expect(after.clientRecognizes).toBe(before.clientRecognizes);
  expect(after.internalDecisions).toEqual(before.internalDecisions);
  const passthrough = base.lane === "passthrough" || base.lane === "count_tokens";
  if (classification === "success" || base.input.fixedLocal) {
    expect(before.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(after.bodySha256).toBe(before.bodySha256);
    expect(after.bodyLength).toBe(before.bodyLength);
  }
  if (classification === "success") {
    expect(after.mediaType).toBe(before.mediaType);
    if (passthrough) expect(after.clientRecognizes).toBe(false);
    return;
  }
  // Every error row, including HTTP-200 records, checks the live owned body.
  expect(after.text.length).toBeGreaterThan(0);
  expect(after.text).not.toContain("zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e");
  if (base.input.fixedLocal) return;
  expect(after.envelopeType).toBe("error");
  if (before.clientError) expect(after.compactionSentence).toBe(before.clientRecognizes);
  expect(ANTHROPIC_ERROR_TYPES.has(after.type ?? "")).toBe(true);
  if (ANTHROPIC_ERROR_TYPES.has(before.type ?? "")) expect(after.type).toBe(before.type);
  expect(after.code).toBe(typeof before.code === "string" && before.code !== "thread_unsupported_request" && ANTHROPIC_ERROR_CODES.has(before.code) ? before.code : undefined);
}

/** Each test owns only one 64-row child run; no shared hook computes the full matrix. */
export function registerMessagesOverflowRows(lanes: readonly Row["lane"][]) {
  expect(golden.schemaVersion).toBe(8);
  expect(golden.columns).toEqual(["lane", "status", "clientRecognizes", "decisions", "class", "type", "code", "mediaType", "clientError", "bodySha256?", "bodyLength?"]);
  expect(golden.lanes).toEqual(messagesOverflowLanes);
  expect(new Set(cases.map(key)).size).toBe(cases.length);
  expect(Object.keys(golden.outcomes).sort()).toEqual(cases.map(key).sort());
  expect(golden.baseCommit).toBe("72e80d280d614bdf4f1aada9b233f6732404afec");
  for (const lane of lanes) {
    const rows = cases.filter(row => row.lane === lane);
    for (let offset = 0; offset < rows.length; offset += 64) {
      const selected = rows.slice(offset, offset + 64);
      test(`${lane}: origin/dev rows ${offset + 1}-${offset + selected.length}`, async () => {
        const started = performance.now();
        const scratch = mkdtempSync(join(tmpdir(), "ocx-overflow-slice-"));
        try {
          mkdirSync(join(scratch, "ocx")); mkdirSync(join(scratch, "codex"));
          const output = join(scratch, "head.json");
          const child = Bun.spawn([process.execPath, helperPath("messages-overflow-differential.ts"), "head", scratch, output, lane, String(offset), "64"], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(scratch, "ocx"), CODEX_HOME: join(scratch, "codex") }, stdout: "pipe", stderr: "pipe" });
          const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
          if (exit !== 0) throw new Error(`Head slice exited ${exit}\n${stdout}\n${stderr}`);
          const result = JSON.parse(readFileSync(output, "utf8")) as { rows: Row[] };
          expect(result.rows).toHaveLength(selected.length);
          for (const [index, row] of result.rows.entries()) { expect(key(row)).toBe(key(selected[index]!)); assertRow(selected[index]!, row); }
          console.info(`MESSAGES_OVERFLOW_ROWS ${lane} ${offset} ${selected.length} ${Math.round(performance.now() - started)}ms`);
        } finally { rmSync(scratch, { recursive: true, force: true }); }
      }, 30000);
    }
  }
}
