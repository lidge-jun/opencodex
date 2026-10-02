import { describe, expect, spyOn, test } from "bun:test";
import { handleRoutePolicyCommand } from "../../src/cli/route-policy";

describe("routing profile lookup exits", () => {
  test.each([["missing", 4], ["present", 0]] as const)("returns resource status for %s", async (id, expected) => {
    const out = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleRoutePolicyCommand(["show", id, "--json"], { baseUrl: "http://cli.test", fetchImpl: async () => Response.json({ profiles: [{ id: "present", model: "policy/present" }] }) })).toBe(expected);
      if (expected === 4) expect(out).not.toHaveBeenCalled();
    } finally { out.mockRestore(); err.mockRestore(); }
  });
  test("missing input is still a usage error without a request", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleRoutePolicyCommand(["show", "--json"], { baseUrl: "http://cli.test", fetchImpl: async () => { throw new Error("unexpected request"); } })).toBe(2);
    } finally { err.mockRestore(); }
  });
  test("an upstream server failure does not become not-found", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleRoutePolicyCommand(["show", "missing"], { baseUrl: "http://cli.test", fetchImpl: async () => Response.json({ error: "unavailable" }, { status: 503 }) })).toBe(1);
    } finally { err.mockRestore(); }
  });
});
