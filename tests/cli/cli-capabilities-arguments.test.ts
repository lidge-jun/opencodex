import { describe, expect, spyOn, test } from "bun:test";
import { runCapabilities } from "../../src/cli/capabilities-command";

describe("capabilities argument validation", () => {
  test.each([
    ["--mutating-onyl"], ["extra"], ["--json", "--json"],
    ["--route", "/api/logs", "--route", "/api/usage"],
    ["--route", "/not-a-route", "--typo"], ["--route", ""],
  ].map(args => [args]))("rejects %j without a successful payload", async args => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCapabilities(args)).toBe(64);
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  test("keeps valid no-match distinct from invalid usage", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runCapabilities(["--route", "/not-a-route", "--json"])).toBe(4);
      expect(JSON.parse(String(out.mock.calls[0]![0])).capabilities).toEqual([]);
    } finally { out.mockRestore(); }
  });
});
