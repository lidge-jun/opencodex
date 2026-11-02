import { describe, expect, spyOn, test } from "bun:test";
import { runCapabilities } from "../../src/cli/capabilities-command";

describe("capabilities argument validation", () => {
  test.each([
    ["--mutating-onyl"], ["extra"], ["--json", "--json"],
    ["--route", "/api/logs", "--route", "/api/usage"],
    ["--route", "/not-a-route", "--typo"], ["--route", ""],
    ["--contracts", "--route", "/api/logs"], ["--contracts", "--mutating-only"],
  ].map(args => [args]))("rejects %j without a successful payload", async args => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runCapabilities(args)).toBe(64);
      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  test("exposes the contract list in every JSON form", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const args of [["--json"], ["--json", "--mutating-only"], ["--json", "--route", "/not-a-route"], ["--json", "--contracts"]]) {
        out.mockClear();
        expect(await runCapabilities(args)).toBe(args.includes("/not-a-route") ? 4 : 0);
        const payload = JSON.parse(String(out.mock.calls[0]![0]));
        expect(payload.contracts).toContain("sync.home-fanout/1");
        if (args.includes("--contracts")) expect(Object.keys(payload)).toEqual(["schemaVersion", "contracts"]);
      }
      out.mockClear();
      expect(await runCapabilities(["--contracts"])).toBe(0);
      expect(out.mock.calls.map(call => call[0])).toContain("sync.home-fanout/1");
    } finally { out.mockRestore(); }
  });
  test("keeps valid no-match distinct from invalid usage", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runCapabilities(["--route", "/not-a-route", "--json"])).toBe(4);
      expect(JSON.parse(String(out.mock.calls[0]![0])).capabilities).toEqual([]);
    } finally { out.mockRestore(); }
  });
});
