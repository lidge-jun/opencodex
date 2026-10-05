import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { printProviderReceipt, runProviderAction } from "../../src/cli/provider-result";
import { CliUsageError, RuntimeApiError } from "../../src/cli/runtime-api";

let stdout: ReturnType<typeof spyOn>, stderr: ReturnType<typeof spyOn>;
beforeEach(() => {
  stdout = spyOn(console, "log").mockImplementation(() => {});
  stderr = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { stdout.mockRestore(); stderr.mockRestore(); });
const output = () => stdout.mock.calls.map(args => args.join(" ")).join("\n");
const errors = () => stderr.mock.calls.map(args => args.join(" ")).join("\n");
const secret = "fixture-private-value-without-a-token-prefix";

describe("provider outcomes preserve saved versus converged and numeric exits", () => {
  test("committed and default-only receipts do not invent a client sync", async () => {
    const receipt = { success: true, name: "example", defaultProvider: "example" };
    expect(await runProviderAction(async () => printProviderReceipt(receipt, true, "Default"))).toBe(0);
    expect(JSON.parse(output())).toEqual(receipt);
    stdout.mockClear();
    expect(printProviderReceipt(receipt, false, "Default")).toBe(0);
    expect(output()).toContain("No client catalog refresh was requested");
    expect(output()).not.toContain("synced");
  });
  test.each(["busy", "stale", "refused", "catalog-unavailable"])("saved but %s propagates failure with one JSON receipt", async reason => {
    const receipt = { success: true, catalogRefresh: { status: "skipped", reason, retryable: true } };
    expect(await runProviderAction(async () => printProviderReceipt(receipt, true, "Apply"))).toBe(1);
    expect(JSON.parse(output())).toEqual(receipt);
    expect(stderr.mock.calls).toEqual([]);
  });
  test("failed catalog copies only closed-vocabulary causes", async () => {
    const receipt = { success: true, catalogRefresh: {
      status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite: true,
      cause: { kind: "io", code: "ENOSPC", message: secret }, unexpected: secret,
    } };
    expect(await runProviderAction(async () => printProviderReceipt(receipt, true, "Apply"))).toBe(1);
    expect(JSON.parse(output()).catalogRefresh).toEqual({
      status: "failed", reason: "disk", phase: "commit", retryable: false, partialWrite: true,
      cause: { kind: "io", code: "ENOSPC" },
    });
    expect(output()).not.toContain(secret);
  });
  test.each([null, { status: "skipped", reason: "not-requested", retryable: false },
    { status: "committed", changed: false, degraded: true, notices: ["fallback"] }])("valid explicit catalog disposition is retained", catalogRefresh => {
    const receipt = { success: true, catalogRefresh };
    expect(printProviderReceipt(receipt, true, "Save")).toBe(0);
    expect(JSON.parse(output())).toEqual(receipt);
  });
  test("removal preserves dependency/default/count, escaping only human terminal text", () => {
    const receipt = { success: true, defaultProvider: "other", droppedCustomModels: 2,
      dependentShadowIntercept: { model: "example/model\u001b]8;;fixture\u0007", enabled: true }, catalogRefresh: null };
    expect(printProviderReceipt(receipt, false, "Remove")).toBe(0);
    expect(output()).toContain("Removed custom models: 2");
    expect(output()).not.toContain("\u001b");
    stdout.mockClear();
    expect(printProviderReceipt(receipt, true, "Remove")).toBe(0);
    expect(JSON.parse(output())).toEqual(receipt);
  });
  test.each([
    { success: true, apiKey: secret },
    { success: false, error: secret },
    { success: true, catalogRefresh: { status: "failed", reason: secret } },
    { success: true, dependentShadowIntercept: { model: "model", enabled: true, apiKey: secret } },
    { success: true, droppedCustomModels: -1 },
  ])("unexpected receipt refuses before output without claiming rollback", async receipt => {
    expect(await runProviderAction(async () => printProviderReceipt(receipt, true, "Save"))).toBe(1);
    expect(output()).toBe("");
    expect(errors()).not.toContain(secret);
    expect(errors()).toContain("no rollback is implied");
  });
  test("response accessors are never invoked by receipt projection", async () => {
    let accessed = false;
    const receipt = { success: true, get name() { accessed = true; throw new Error(secret); } };
    expect(await runProviderAction(async () => printProviderReceipt(receipt, true, "Save"))).toBe(1);
    expect(accessed).toBe(false);
    expect(output()).toBe("");
    expect(errors()).not.toContain(secret);
  });
  test.each([404, 409, 400, 503])("HTTP %i keeps exit mapping without echoing nested error values", async status => {
    const body = { error: { code: secret, message: secret, issues: [secret] }, hint: secret };
    expect(await runProviderAction(async () => { throw new RuntimeApiError(secret, status, body); }))
      .toBe(status === 404 ? 4 : status === 409 ? 5 : 1);
    expect(output()).toBe("");
    expect(errors()).not.toContain(secret);
  });
  test("known nested code uses a fixed actionable message and ignores supplied text", async () => {
    expect(await runProviderAction(async () => { throw new RuntimeApiError(secret, 409,
      { error: { code: "stale_provider_editor_baseline", message: secret }, details: secret }); })).toBe(5);
    expect(errors()).toContain("Read a fresh snapshot");
    expect(errors()).not.toContain(secret);
  });
  test("static usage retains exit two; ordinary errors never expose their message", async () => {
    expect(await runProviderAction(async () => { throw new CliUsageError("--yes is required"); })).toBe(2);
    expect(errors()).toContain("--yes is required");
    expect(await runProviderAction(async () => { throw new Error(secret); })).toBe(1);
    expect(errors()).not.toContain(secret);
  });
});
