import { messagesFold502Cases } from "./messages-sse-fold-exceptions";
import { hostedWindowsQuarantine } from "./windows-ci-quarantine";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ANTHROPIC_ERROR_TYPES, ANTHROPIC_ERROR_CODES } from "../../src/lib/client-error-body";
import { fixturePath, helperPath, repoRoot } from "./repo-root";
import { collectOverflowChild, finishOverflowScratch, overflowScratchBase } from "./messages-overflow-child";
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
// Hosted Windows 64-row subprocesses for these network-backed lanes approached
// or exceeded 30s; the pure converter/collector lanes finished in under 1s.
const WINDOWS_SLOW_LANES = new Set<Row["lane"]>(["passthrough", "count_tokens", "native-http", "native-fold", "native-fold-builtin", "translated-http", "translated-fold", "translated-json"]);

// Reviewed #8148 deltas against the immutable #8153 baseline. No runtime classifier
// chooses expectations: only these five fixtures on the two direct-writer paths change.
const DIRECT_OVERFLOW_BASELINE_RECOVERY = new Map<string, boolean>([
  ["shared-8128-2", false],
  ["shared-8128-3", false],
  ["normalization-3", false],
  ["sweep-code-api_error-phrase", true],
  ["sweep-code-upstream_error-phrase", true],
]);

// Reviewed #8129 deltas: the generic 5xx code and the translated plain-text verdict.
// These are fixture identities, not classifications derived from the implementation.
const GENERIC_5XX_LANES = new Set(["converter", "direct-stream", "direct-fold", "translated-http", "translated-fold", "translated-json"]);
const GENERIC_5XX_DIRECT_IDS = new Set(["shared-8128-12", "shared-8128-13"]);

function assertRow(base: Pick<Row, "lane" | "input">, current: Row) {
  const outcome = golden.outcomes[key(base)]!;
  expect(outcome).toBeDefined();
  expect(golden.lanes[outcome[0]]).toBe(base.lane);
  const before = { status: outcome[1], clientRecognizes: outcome[2], internalDecisions: golden.decisions[outcome[3]],
    classification: outcome[4], type: golden.types[outcome[5]] ?? undefined, code: golden.codes[outcome[6]] ?? undefined,
    mediaType: golden.mediaTypes[outcome[7]], clientError: outcome[8], bodySha256: outcome[9], bodyLength: outcome[10] };
  const correctedOverflow = DIRECT_OVERFLOW_BASELINE_RECOVERY.has(base.input.id)
    && (base.lane === "direct-stream" || base.lane === "direct-fold");
  const directGeneric = GENERIC_5XX_DIRECT_IDS.has(base.input.id) && (base.lane === "direct-stream" || base.lane === "direct-fold");
  const genericCode = base.input.id === "sweep-code-upstream_server_error-phrase" && GENERIC_5XX_LANES.has(base.lane);
  const plainText = base.input.id === "shape-plain-text-400" && (base.lane === "translated-http" || base.lane === "translated-json");
  const correctedGeneric = directGeneric || genericCode || plainText;
  if (correctedGeneric) {
    const wasFold = base.lane === "direct-fold";
    expect(before.status).toBe(wasFold || (genericCode && base.lane === "translated-json") ? 502 : ["translated-http", "translated-json", "translated-fold"].includes(base.lane) ? 400 : 200);
    expect(before.type).toBe(directGeneric ? "overloaded_error" : genericCode && base.lane === "translated-json" ? "api_error" : "invalid_request_error");
    expect(before.code).toBeUndefined();
    expect(before.clientRecognizes).toBe(directGeneric ? base.input.id === "shared-8128-13" : true);
    expect(before.internalDecisions).toEqual(base.lane === "translated-json" || base.lane === "translated-http" ? { writer: false }
      : wasFold ? { status: false, writer: false, "direct-collector": false } : { status: false, writer: false });
  }
  const expected = correctedOverflow || correctedGeneric ? {
    ...before,
    status: ["direct-fold", "translated-http", "translated-fold", "translated-json"].includes(base.lane) ? 400 : 200,
    clientRecognizes: true,
    type: "invalid_request_error",
    code: "context_length_exceeded",
    internalDecisions: base.lane === "direct-fold"
      ? { status: true, writer: true, "direct-collector": true }
      : base.lane === "translated-json" || base.lane === "translated-http" ? { writer: true } : { status: true, writer: true },
  } : before;
  if (correctedOverflow) {
    // Keep the original observation explicit; an unrelated baseline change is not a delta.
    expect(before.status).toBe(base.lane === "direct-fold" ? 502 : 200);
    expect(before.type).toBe("invalid_request_error");
    expect(before.code).toBeUndefined();
    expect(before.clientRecognizes).toBe(DIRECT_OVERFLOW_BASELINE_RECOVERY.get(base.input.id));
    expect(before.internalDecisions).toEqual(base.lane === "direct-fold"
      ? { status: true, writer: false, "direct-collector": false }
      : { status: true, writer: false });
  }
  expect(current.input).toEqual(base.input);
  const after = current.head;
  expect(after.text.length).toBeGreaterThan(0);
  const fold502 = (base.lane === "native-fold" || base.lane === "native-fold-builtin") && messagesFold502Cases.has(base.input.id);
  if (fold502) {
    expect(before.status).toBe(200);
    expect(base.input.eventLanes).toContain(base.lane);
  }
  expect(after.status).toBe(fold502 ? 502 : expected.status);
  const classification = base.input.classification[base.lane];
  expect(["error", "success"]).toContain(classification);
  expect(classification).toBe(before.classification);
  if (["native-fold", "native-fold-builtin", "direct-collector"].includes(base.lane)) {
    expect(classification).toBe("error");
    if (!base.input.fault) expect(base.input.eventLanes).toContain(base.lane);
  }
  expect(before.clientRecognizes).toBe(base.input.recovery[base.lane]);
  expect(after.clientRecognizes).toBe(correctedOverflow || correctedGeneric ? true : base.input.recovery[base.lane]);
  expect(after.clientRecognizes).toBe(expected.clientRecognizes);
  expect(after.internalDecisions).toEqual(expected.internalDecisions);
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
  if (before.clientError) expect(after.compactionSentence).toBe(expected.clientRecognizes);
  expect(ANTHROPIC_ERROR_TYPES.has(after.type ?? "")).toBe(true);
  if (ANTHROPIC_ERROR_TYPES.has(expected.type ?? "")) expect(after.type).toBe(expected.type);
  expect(after.code).toBe(typeof expected.code === "string" && expected.code !== "thread_unsupported_request" && ANTHROPIC_ERROR_CODES.has(expected.code) ? expected.code : undefined);
}

/** Each test owns one bounded child run; no shared hook computes the full matrix. */
export function registerMessagesOverflowRows(lanes: readonly Row["lane"][]) {
  expect(golden.schemaVersion).toBe(8);
  expect(golden.columns).toEqual(["lane", "status", "clientRecognizes", "decisions", "class", "type", "code", "mediaType", "clientError", "bodySha256?", "bodyLength?"]);
  expect(golden.lanes).toEqual(messagesOverflowLanes);
  expect(new Set(cases.map(key)).size).toBe(cases.length);
  expect(Object.keys(golden.outcomes).sort()).toEqual(cases.map(key).sort());
  expect(golden.baseCommit).toBe("72e80d280d614bdf4f1aada9b233f6732404afec");
  for (const lane of lanes) {
    const rows = cases.filter(row => row.lane === lane);
    const sliceSize = process.platform === "win32" && WINDOWS_SLOW_LANES.has(lane) ? 16 : 64;
    const slices = Array.from({ length: Math.ceil(rows.length / sliceSize) }, (_, index) => rows.slice(index * sliceSize, (index + 1) * sliceSize));
    expect(slices.flat().map(key)).toEqual(rows.map(key));
    for (const [index, selected] of slices.entries()) {
      const offset = index * sliceSize;
      // #8262 hosted-Windows quarantine stays until a Windows lane=all run passes with it removed.
      test.skipIf(hostedWindowsQuarantine && WINDOWS_SLOW_LANES.has(lane))(`${lane}: origin/dev rows ${offset + 1}-${offset + selected.length}`, async () => {
        const started = performance.now();
        const scratch = mkdtempSync(join(overflowScratchBase(), "ocx-overflow-slice-"));
        let safeToRemove = true;
        let failure: { error: unknown } | undefined;
        try {
          mkdirSync(join(scratch, "ocx")); mkdirSync(join(scratch, "codex")); mkdirSync(join(scratch, "tmp"));
          const output = join(scratch, "head.json");
          const child = Bun.spawn([process.execPath, helperPath("messages-overflow-differential.ts"), "head", scratch, output, lane, String(offset), String(sliceSize)], { cwd: repoRoot(), env: { ...process.env, HOME: scratch, USERPROFILE: scratch, TEMP: join(scratch, "tmp"), TMP: join(scratch, "tmp"), TMPDIR: join(scratch, "tmp"), OPENCODEX_HOME: join(scratch, "ocx"), CODEX_HOME: join(scratch, "codex"), CODEX_SQLITE_HOME: join(scratch, "codex"), OCX_OWNER_REGISTRY_DIR: join(scratch, "ocx", "ocx-homes"), CLAUDE_CONFIG_DIR: join(scratch, "claude"), GROK_HOME: join(scratch, "grok") }, stdout: "pipe", stderr: "pipe" });
          safeToRemove = false;
          const { exit, stdout, stderr } = await collectOverflowChild(child, process.platform === "win32" ? started + 25_000 : null);
          if (exit !== 0) throw new Error(`Head slice exited ${exit}\n${stdout}\n${stderr}`);
          const result = JSON.parse(readFileSync(output, "utf8")) as { rows: Row[]; fixtureAsyncSpawnsDrained?: boolean };
          if (result.fixtureAsyncSpawnsDrained !== true) throw new Error("Head slice did not confirm fixture subprocess cleanup");
          safeToRemove = true;
          expect(result.rows).toHaveLength(selected.length);
          for (const [index, row] of result.rows.entries()) { expect(key(row)).toBe(key(selected[index]!)); assertRow(selected[index]!, row); }
          console.info(`MESSAGES_OVERFLOW_ROWS ${lane} ${offset} ${selected.length} ${Math.round(performance.now() - started)}ms`);
        } catch (error) { failure = { error }; }
        finally { finishOverflowScratch(scratch, safeToRemove, failure); }
      }, 30000);
    }
  }
}
