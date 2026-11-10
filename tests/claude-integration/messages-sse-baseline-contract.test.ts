import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fixturePath, helperPath } from "../helpers/repo-root";
import { messagesSseCases, messagesSseCaseHash, SSE_BASE } from "../helpers/messages-sse-cases";
import { pinnedMessagesObservation } from "../helpers/messages-sse-observer";
const golden = JSON.parse(readFileSync(fixturePath("messages-sse-895a85989.json"), "utf8"));
test("base roster, exact pins, recorder hashes and literal row dispositions", () => {
  expect(golden.baseCommit).toBe(SSE_BASE);
  expect(golden.caseTableSha256).toBe(messagesSseCaseHash());
  expect(golden.sdk).toEqual({ commit: "4f27519", streaming: "d936cbdc53e7e22221d151f66e25b49551ee94af7d474e5e836ba797a6b130cb", error: "36b53ac201abb7b759ddb61061b4de918cc35aff1d20e7f523a913a544b4ce97", claudeCode: "2.1.288" });
  for (const [name, hash] of Object.entries(golden.recorderHashes)) expect(createHash("sha256").update(readFileSync(helperPath(name))).digest("hex")).toBe(hash);
  const expected = ["native", "builtin", "passthrough", "count-tokens", "tap", "fold"].flatMap(lane => messagesSseCases.filter(row => lane === "fold" ? row.fold : !row.fold).map(row => `${lane}/${row.id}`));
  expect(Object.keys(golden.outcomes).sort()).toEqual(expected.sort());
  expect(new Set(expected).size).toBe(expected.length);
  for (const row of messagesSseCases) expect(["error-block", "non-error", "rename", "local", "OVERSIZE-1M", "FOLD-502"]).toContain(row.kind);
  expect(readFileSync(fixturePath("messages-sse-895a85989.json")).byteLength).toBeLessThan(300_000);
});
// Decompress each unique body once; no hook precomputes an endpoint matrix.
for (let offset = 0; offset < golden.dictionaries.bodies.length; offset += 40) test(`recorded raw bytes ${offset}-${offset + 40}`, () => {
  for (const [index, gzip] of golden.dictionaries.bodies.entries()) {
    if (index < offset || index >= offset + 40) continue;
    const bytes = Bun.gunzipSync(Buffer.from(gzip as string, "base64"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const observation = pinnedMessagesObservation(bytes);
    for (const row of Object.values(golden.outcomes) as any[]) if (row[10] === index) {
      expect(row[1]).toBe(sha); expect(row[2]).toBe(bytes.byteLength);
      expect(row[7]).toBe(observation.clientRecognizes); expect(row[8]).toBe(observation.wirePhrase);
    }
  }
});
test("accepted exceptions retain actual base observations", () => {
  for (const lane of ["builtin", "passthrough", "count-tokens", "tap"]) expect(golden.outcomes[`${lane}/limit-1`][7]).toBe(true);
  for (const row of messagesSseCases.filter(row => row.fold)) expect(golden.outcomes[`fold/${row.id}`][0]).toBe(200);
  expect(golden.outcomes["builtin/auditor-padded-debug"][7]).toBe(false);
  expect(golden.outcomes["builtin/auditor-round2-exact"][7]).toBe(false);
});
