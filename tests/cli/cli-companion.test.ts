import { describe, expect, test } from "bun:test";
import { handleCompanionCommand } from "../../src/cli/companion";

describe("ocx companion", () => {
  test("set parses JSON values and reset sends the matching management payload", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const deps = {
      baseUrl: "http://proxy.test",
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body });
        return Response.json({ settings: {}, defaults: {}, updatedAt: null });
      },
    };
    expect(await handleCompanionCommand(["set", "showChart=false", "chartHours=6", "menuBarTemplate=null", "--json"], deps)).toBe(0);
    expect(requests[0]).toEqual({
      path: "/api/companion/settings",
      method: "PUT",
      body: { settings: { showChart: false, chartHours: 6, menuBarTemplate: null } },
    });
    expect(await handleCompanionCommand(["reset"], deps)).toBe(0);
    expect(requests[1]).toEqual({
      path: "/api/companion/settings",
      method: "PUT",
      body: { reset: true },
    });
  });
});
