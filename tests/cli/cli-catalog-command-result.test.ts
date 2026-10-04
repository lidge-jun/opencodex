import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { printCatalogResult, runCatalogAction } from "../../src/cli/catalog-command-result";
import { CliUsageError, RuntimeApiError } from "../../src/cli/runtime-api";

let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { output.mockRestore(); errors.mockRestore(); });
const secret = "fixture-value-with-no-recognizable-secret-prefix";

test.each([
  { refresh: { status: "committed", changed: false, degraded: false, notices: [] }, code: 0 },
  { refresh: { status: "committed", changed: true, degraded: true, notices: ["fallback"] }, code: 1 },
  { refresh: { status: "skipped", reason: "stale", retryable: true }, code: 1 },
  { refresh: { status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite: true }, code: 1 },
])("catalog outcome retains the saved identity and numeric result", async ({ refresh, code }) => {
  expect(await runCatalogAction(async () => printCatalogResult({ saved: true, id: "fixture" }, refresh, true, ["Saved."]))).toBe(code);
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual({ saved: true, id: "fixture", catalogRefresh: refresh });
  expect(errors.mock.calls).toEqual([]);
});

test.each([null, undefined, {}, { status: "failed", reason: secret }])("malformed refresh never prints a fabricated successful write", async refresh => {
  expect(await runCatalogAction(async () => printCatalogResult({ saved: true }, refresh, true, []))).toBe(1);
  expect(output.mock.calls).toEqual([]);
  expect(errors.mock.calls.flat().join(" ")).not.toContain(secret);
  expect(errors.mock.calls.flat().join(" ")).toContain("no rollback is implied");
});

test.each([404, 409, 503, 400])("HTTP status preserves its exit without error-body leakage", async status => {
  expect(await runCatalogAction(async () => { throw new RuntimeApiError(secret, status,
    { error: { code: secret, message: secret }, issues: [secret] }); })).toBe(status === 404 ? 4 : status === 409 ? 5 : 1);
  expect(output.mock.calls).toEqual([]);
  expect(errors.mock.calls.flat().join(" ")).not.toContain(secret);
});

test("known nested codes are mapped to trusted prose, not server text", async () => {
  expect(await runCatalogAction(async () => { throw new RuntimeApiError(secret, 409,
    { error: { code: "profile_revision_conflict", message: secret, currentRevision: secret } }); },
  { profile_revision_conflict: "Read a fresh profile and review the edit." })).toBe(5);
  expect(errors.mock.calls.flat().join(" ")).toBe("Error: Read a fresh profile and review the edit.");
});

test("static usage and human output escape terminal controls", async () => {
  expect(await runCatalogAction(async () => { throw new CliUsageError("Missing option\u001b[31m"); })).toBe(2);
  expect(errors.mock.calls.flat().join(" ")).not.toContain("\u001b");
  expect(printCatalogResult({ ok: true }, { status: "committed", changed: false, degraded: false, notices: [] }, false, ["name\u001b[31m"])).toBe(0);
  expect(output.mock.calls.flat().join(" ")).not.toContain("\u001b");
});
