import { describe, expect, spyOn, test } from "bun:test";
import { runCapabilities } from "../../src/cli/capabilities-command";

describe("capabilities argument validation", () => {
  test("contracts are present in every JSON shape and can be queried alone", async () => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const args of [["--json"], ["--json", "--route", "/api/logs"], ["--json", "--mutating-only"], ["--json", "--route", "/missing"]]) {
        out.mockClear();
        expect(await runCapabilities(args)).toBe(args.includes("/missing") ? 4 : 0);
        expect(JSON.parse(String(out.mock.calls[0]![0])).contracts).toEqual(["update.orchestrated/1"]);
      }
      out.mockClear();
      expect(await runCapabilities(["--contracts", "--json"])).toBe(0);
      expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ schemaVersion: 1, contracts: ["update.orchestrated/1"] });
      out.mockClear();
      expect(await runCapabilities(["--contracts"])).toBe(0);
      expect(out.mock.calls.map(call => call[0])).toEqual(["update.orchestrated/1"]);
      for (const args of [["--contracts", "--mutating-only"], ["--contracts", "--route", "/api/logs"]]) expect(await runCapabilities(args)).toBe(64);
    } finally { out.mockRestore(); err.mockRestore(); }
  });
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
