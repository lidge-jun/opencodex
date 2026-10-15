import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cmdPreserveSignedIn } from "../../src/cli/account-preservation";
import type { AccountDeps } from "../../src/cli/account-api";
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>;
beforeEach(() => { log = spyOn(console, "log").mockImplementation(() => {}); error = spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { log.mockRestore(); error.mockRestore(); });
function fixture() {
  const calls: { method: string; body: unknown }[] = [];
  const deps: AccountDeps = { baseUrl: "http://127.0.0.1:10100", loadConfigImpl: () => { throw new Error("No local config reads"); },
    fetchImpl: (async (url, init) => {
      expect(new URL(String(url)).pathname).toBe("/api/codex-auth/preserve-signed-in");
      calls.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ enabled: true, affectedAccountIds: ["__main__", "copy"], nextAccountId: "other", pinnedAccountId: null, bindings: "retained" });
    }) as typeof fetch,
  };
  return { deps, calls };
}
test("bare status only reads runtime and prints affected entries and next choice", async () => {
  const f = fixture(); expect(await cmdPreserveSignedIn(["openai"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ method: "GET", body: undefined }]);
  expect(log.mock.calls.flat().join("\n")).toContain("Next unbound choice: other");
});
test("on and explicit transition send exact API contract", async () => {
  const f = fixture(); expect(await cmdPreserveSignedIn(["openai", "on", "--apply-to-bound", "--json"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ method: "PUT", body: { enabled: true, applyToBound: true } }]);
  expect(JSON.parse(String(log.mock.calls[0]![0])).affectedAccountIds).toEqual(["__main__", "copy"]);
});
test("off leaves custom ordering to the runtime", async () => {
  const f = fixture(); expect(await cmdPreserveSignedIn(["openai", "off"], f.deps)).toBe(0);
  expect(f.calls).toEqual([{ method: "PUT", body: { enabled: false, applyToBound: false } }]);
});
for (const args of [["anthropic", "on"], ["openai", "off", "--apply-to-bound"], ["openai", "status", "--apply-to-bound"], ["openai", "on", "off"], ["openai", "on", "--unknown"], ["openai", "--json", "--json"]]) {
  test(`invalid operands ${args.join(" ")} never reach runtime`, async () => {
    const f = fixture(); expect(await cmdPreserveSignedIn(args, f.deps)).toBe(1); expect(f.calls).toEqual([]);
  });
}
