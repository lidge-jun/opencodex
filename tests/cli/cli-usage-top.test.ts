import { describe, expect, spyOn, test } from "bun:test";
import { handleObserveCommand } from "../../src/cli/observe";

const report = { range: "30d", summary: { requests: 12, totalTokens: 120 },
  models: Array.from({ length: 12 }, (_, i) => ({ model: "model-" + String(i).padStart(2, "0"), provider: "local", requests: 1, totalTokens: 10 })) };
describe("usage human model limit", () => {
  test.each([[[], 10], [["--top", "1"], 1], [["--top", "2"], 2], [["--top", "12"], 12], [["--top", "1000"], 12]] as [string[], number][])("applies %j locally", async (flags, expected) => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    let url = "";
    try {
      expect(await handleObserveCommand(["usage", ...flags], { baseUrl: "http://cli.test", fetchImpl: async input => { url = String(input); return Response.json(report); } })).toBe(0);
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
      expect(await handleObserveCommand(["usage", "--top", value], { baseUrl: "http://cli.test", fetchImpl: async () => { calls++; return Response.json(report); } })).toBe(2);
      expect(calls).toBe(0);
    } finally { err.mockRestore(); }
  });
  test("does not silently apply a human limit to JSON", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleObserveCommand(["usage", "--top", "2", "--json"], { baseUrl: "http://cli.test", fetchImpl: async () => { throw new Error("unexpected fetch"); } })).toBe(2);
    } finally { err.mockRestore(); }
  });
});
