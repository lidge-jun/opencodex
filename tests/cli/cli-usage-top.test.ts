import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import * as observe from "../../src/cli/observe";
import { parseCliHead } from "../../src/cli/root";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const report = { range: "30d", summary: { requests: 12, totalTokens: 120 },
  models: Array.from({ length: 12 }, (_, i) => ({ model: "model-" + String(i).padStart(2, "0"), provider: "local", requests: 1, totalTokens: 10 })) };
/** Build an offline fetch stub that also satisfies Bun's connection-warmup shape. */
function fakeFetch(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): typeof fetch {
  return Object.assign(impl, { preconnect() {} });
}
describe("usage human model limit", () => {
  test.each(["usage", "observe"])("forwards --top through %s dispatch", async command => {
    const args = command === "usage" ? ["usage", "--top", "2"] : ["observe", "usage", "--top", "2"];
    const head = parseCliHead(args);
    const handler = spyOn(observe, "handleObserveCommand").mockResolvedValue(0);
    try {
      expect(await dispatchCommand(head, { args, command, head } as CliDispatchDeps)).toBe(0);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(["usage", "--top", "2"]);
    } finally { handler.mockRestore(); }
  });
  test.each([["usage", "--help"], ["help", "usage"], ["help"]].map(args => ({ args })))("documents --top in real CLI help %j", ({ args }) => {
    const result = spawnSync(process.execPath, [repoPath("src", "cli", "index.ts"), ...args], {
      cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/ocx usage [^\n]*\[--top <1-1000>\]/);
  }, SPAWN_BUDGET_MS);
  test.each([[[], 10], [["--top", "1"], 1], [["--top", "2"], 2], [["--top", "12"], 12], [["--top", "1000"], 12]] as [string[], number][])("applies %j locally", async (flags, expected) => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    let url = "";
    try {
      expect(await observe.handleObserveCommand(["usage", ...flags], { baseUrl: "http://cli.test", fetchImpl: fakeFetch(async input => { url = String(input); return Response.json(report); }) })).toBe(0);
      const text = out.mock.calls.map(call => String(call[0])).join("\n");
      expect((text.match(/model-\d\d/g) ?? []).length).toBe(expected);
      expect(text).toContain("Requests   12");
      expect(url).not.toContain("top");
    } finally { out.mockRestore(); }
  });
  test.each(["0", "1001", "1.5", "NaN"])("rejects invalid top %s without fetching", async value => {
    let calls = 0;
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await observe.handleObserveCommand(["usage", "--top", value], { baseUrl: "http://cli.test", fetchImpl: fakeFetch(async () => { calls++; return Response.json(report); }) })).toBe(2);
      expect(calls).toBe(0);
    } finally { err.mockRestore(); }
  });
  test("does not silently apply a human limit to JSON", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await observe.handleObserveCommand(["usage", "--top", "2", "--json"], { baseUrl: "http://cli.test", fetchImpl: fakeFetch(async () => { throw new Error("unexpected fetch"); }) })).toBe(2);
      const message = err.mock.calls.map(call => String(call[0])).join("\n");
      expect(message).toContain("--top cannot be combined with --json");
      expect(message).not.toContain("--top must be");
    } finally { err.mockRestore(); }
  });
  test("reports an out-of-range limit before the JSON combination", async () => {
    let calls = 0;
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await observe.handleObserveCommand(["usage", "--top", "1001", "--json"], { baseUrl: "http://cli.test", fetchImpl: fakeFetch(async () => { calls++; return Response.json(report); }) })).toBe(2);
      expect(calls).toBe(0);
      const message = err.mock.calls.map(call => String(call[0])).join("\n");
      expect(message).toContain("--top must be an integer 1-1000");
      expect(message).not.toContain("--top cannot be combined");
    } finally { err.mockRestore(); }
  });
});
