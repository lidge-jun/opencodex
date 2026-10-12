import { describe, expect, spyOn, test } from "bun:test";
import { handleObserveCommand } from "../../src/cli/observe";

describe("human logs request identity", () => {
  test("prints persisted request IDs and omits absent IDs", async () => {
    const rows = [{ requestId: "request-42", status: 200 }, { requestId: "request\n42", status: 500 }, { status: 201 }];
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleObserveCommand(["logs"], { baseUrl: "http://cli.test", fetchImpl: async () => Response.json(rows) })).toBe(0);
      expect(String(out.mock.calls[0]![0])).toContain("id=request-42");
      expect(String(out.mock.calls[1]![0])).not.toContain("id=");
      expect(String(out.mock.calls[2]![0])).not.toContain("id=");
    } finally { out.mockRestore(); }
  });
  test.each(["--json", "--jsonl"])("preserves %s data", async flag => {
    const rows = [{ requestId: "request\n42", status: 200 }];
    const out = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleObserveCommand(["logs", flag], { baseUrl: "http://cli.test", fetchImpl: async () => Response.json(rows) })).toBe(0);
      expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(flag === "--json" ? rows : rows[0]);
    } finally { out.mockRestore(); }
  });
});

test.each(["\u0000", "\u001b", "\u0085", "\u2028", "\u2029"])("omits an ID containing control %j", async control => {
  const out = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(await handleObserveCommand(["logs"], { baseUrl: "http://cli.test", fetchImpl: async () => Response.json([{ requestId: "request" + control + "42", status: 200 }]) })).toBe(0);
    expect(String(out.mock.calls[0]![0])).not.toContain("id=");
  } finally { out.mockRestore(); }
});
