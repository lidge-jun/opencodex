import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_ERROR_TYPES, ANTHROPIC_ERROR_CODES } from "../../src/lib/client-error-body";
import { fixturePath, helperPath, repoRoot } from "../helpers/repo-root";
import { applicableMessagesOverflowFixtures, messagesOverflowLanes, messagesOverflowCaseId, messagesOverflowCaseTableHash, type MessagesOverflowFixture } from "../helpers/messages-overflow-cases";

type Observation = { status: number; bodySha256: string; bodyLength: number; clientError: boolean; envelopeType?: string; mediaType: string | null; type?: string; code?: string | null; text: string; clientRecognizes: boolean; compactionSentence: boolean; internalDecisions: Record<string, boolean> };
type Row = { lane: typeof messagesOverflowLanes[number]; input: MessagesOverflowFixture; head: Observation };
// Dictionary indexes retain every comparison without repeating input data or error bodies.
type Outcome = [lane: number, status: number, clientRecognizes: boolean, decisions: number, classification: "error" | "success",
  type: number, code: number, mediaType: number, clientError: boolean, bodySha256?: string, bodyLength?: number];
type Golden = { schemaVersion: number; baseCommit: string; caseTableSha256: string; columns: string[];
  lanes: typeof messagesOverflowLanes; decisions: Record<string, boolean>[]; types: (string | null)[];
  codes: (string | null)[]; mediaTypes: (string | null)[]; outcomes: Record<string, Outcome> };
const golden = JSON.parse(readFileSync(fixturePath("messages-overflow-decisions.json"), "utf8")) as Golden;
if (golden.caseTableSha256 !== messagesOverflowCaseTableHash()) {
  throw new Error("Messages overflow case table changed without baseline regeneration; run messages-overflow-differential.ts --generate-base <scratch> tests/fixtures/messages-overflow-decisions.json with base 72e80d280 available.");
}
const cases = messagesOverflowLanes.flatMap(lane => applicableMessagesOverflowFixtures(lane).map(input => ({ lane, input })));
const head = new Map<string, Row>();
const key = (row: Pick<Row, "lane" | "input">) => messagesOverflowCaseId(row.lane, row.input);
beforeAll(async () => {
  expect(golden.schemaVersion).toBe(8);
  expect(golden.columns).toEqual(["lane", "status", "clientRecognizes", "decisions", "class", "type", "code", "mediaType", "clientError", "bodySha256?", "bodyLength?"]);
  expect(golden.lanes).toEqual(messagesOverflowLanes);
  expect(new Set(cases.map(key)).size).toBe(cases.length);
  expect(Object.keys(golden.outcomes).sort()).toEqual(cases.map(key).sort());
  expect(golden.baseCommit).toBe("72e80d280d614bdf4f1aada9b233f6732404afec");
  const scratch = mkdtempSync(join(tmpdir(), "ocx-overflow-decisions-"));
  try {
    mkdirSync(join(scratch, "ocx")); mkdirSync(join(scratch, "codex"));
    const output = join(scratch, "head.json");
    const child = Bun.spawn([process.execPath, helperPath("messages-overflow-differential.ts"), "head", scratch, output], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: join(scratch, "ocx"), CODEX_HOME: join(scratch, "codex") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0) throw new Error(`Head fixture exited ${exit}\n${stdout}\n${stderr}`);
    const result = JSON.parse(readFileSync(output, "utf8")) as { rows: Row[] };
    expect(result.rows).toHaveLength(cases.length);
    for (const row of result.rows) { expect(head.has(key(row))).toBe(false); head.set(key(row), row); }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 60000);
for (const base of cases) test(`${base.lane}/${base.input.id}: origin/dev client recovery`, () => {
  const outcome = golden.outcomes[key(base)]!;
  expect(outcome).toBeDefined();
  expect(golden.lanes[outcome[0]]).toBe(base.lane);
  const before = { status: outcome[1], clientRecognizes: outcome[2], internalDecisions: golden.decisions[outcome[3]],
    classification: outcome[4], type: golden.types[outcome[5]] ?? undefined, code: golden.codes[outcome[6]] ?? undefined,
    mediaType: golden.mediaTypes[outcome[7]], clientError: outcome[8], bodySha256: outcome[9], bodyLength: outcome[10] };
  const current = head.get(key(base))!;
  expect(current).toBeDefined(); expect(current.input).toEqual(base.input);
  const after = current.head;
  expect(after.text.length).toBeGreaterThan(0);
  expect(after.status).toBe(before.status);
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
});

for (const lane of ["passthrough", "count_tokens"] as const) for (const pair of ["id", "utf8"]) test(`${lane}: raw ${pair} outcomes differ`, async () => {
  const left = cases.find(row => row.lane === lane && row.input.id === `raw-parity-${pair}-a`)!;
  const right = cases.find(row => row.lane === lane && row.input.id === `raw-parity-${pair}-b`)!;
  const { observeMessagesOverflowBody } = await import("../helpers/messages-overflow-case");
  const body = (input: MessagesOverflowFixture) => new Response(input.rawBytes ? new Uint8Array(input.rawBytes) : input.rawBody!);
  const a = await observeMessagesOverflowBody(body(left.input), lane, left.input);
  const b = await observeMessagesOverflowBody(body(right.input), lane, right.input);
  expect(a.bodyLength).toBeGreaterThan(0);
  expect(a.bodyLength).toBe(b.bodyLength);
  expect(a.bodySha256).not.toBe(b.bodySha256);
  if (pair === "id") expect(golden.outcomes[key(left)]![9]).not.toBe(golden.outcomes[key(right)]![9]);
  // The baseline proxy already decodes upstream UTF-8; compare its real returned bytes separately.
  else expect(golden.outcomes[key(left)]![9]).toBe(golden.outcomes[key(right)]![9]);
});
