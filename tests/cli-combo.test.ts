import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleComboCommand } from "../src/cli/combo";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  // eslint-disable-next-line no-process-exit
  process.exitCode = 0;
});

function fakeRuntime(responder?: (req: Request, body: unknown) => unknown) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      const custom = responder?.(req, body);
      if (custom !== undefined) return Response.json(custom);
      return Response.json({ ok: true, combos: [{ id: "bulk", model: "combo/bulk" }] });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

describe("ocx combo explain", () => {
  test("missing id returns 2 without request", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["explain"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("missing id with --json returns 2", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["explain", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("malformed input-tokens returns 2", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["explain", "bulk", "--input-tokens", "not-a-number"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("unknown flag returns 2", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["explain", "bulk", "--unknown"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("explain default tokens hits exact runtime path", async () => {
    const runtime = fakeRuntime(() => ({ selectedTarget: "a/m1", reason: "test" }));
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(String(args[0]));
    });
    try {
      const code = await handleComboCommand(["explain", "bulk-code"], runtime.deps);
      expect(code).toBe(0);
      expect(runtime.requests[0]).toEqual({
        path: "/api/combos/bulk-code/explain?inputTokens=0&outputTokens=1024",
        method: "GET",
        body: null,
      });
      expect(logs.join("\n")).toContain("selectedTarget");
    } finally {
      spy.mockRestore();
    }
  });

  test("explain with custom tokens encodes id and query", async () => {
    const runtime = fakeRuntime(() => ({ ok: true }));
    const code = await handleComboCommand(["explain", "bulk/code", "--input-tokens", "2000", "--output-tokens", "500"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.path).toBe("/api/combos/bulk%2Fcode/explain?inputTokens=2000&outputTokens=500");
  });

  test("explain --json remains output-only and prints structured JSON", async () => {
    const payload = { selectedTarget: "payg/m", strategy: "economy", candidates: [] };
    const runtime = fakeRuntime(() => payload);
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(String(args[0]));
    });
    try {
      const code = await handleComboCommand(["explain", "bulk", "--input-tokens", "10", "--output-tokens", "20", "--json"], runtime.deps);
      expect(code).toBe(0);
      expect(runtime.requests[0]?.path).toBe("/api/combos/bulk/explain?inputTokens=10&outputTokens=20");
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed).toEqual(payload);
    } finally {
      spy.mockRestore();
    }
  });

  test("explain human also prints JSON (no lines provided)", async () => {
    const payload = { selectedTarget: "a/m1" };
    const runtime = fakeRuntime(() => payload);
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(String(args[0]));
    });
    try {
      const code = await handleComboCommand(["explain", "bulk"], runtime.deps);
      expect(code).toBe(0);
      const parsed = JSON.parse(logs.join("\n"));
      expect(parsed).toEqual(payload);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ocx combo set economy", () => {
  test("legacy --targets preserves failover/round-robin", async () => {
    const runtime = fakeRuntime();
    let code = await handleComboCommand(["set", "fast", "--targets", "ark/model-a:2,openai/gpt-5.5", "--strategy", "failover", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.body).toEqual({
      id: "fast",
      combo: {
        strategy: "failover",
        stickyLimit: 1,
        targets: [
          { provider: "ark", model: "model-a", weight: 2 },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    });

    const rr = fakeRuntime();
    code = await handleComboCommand(["set", "rr", "--targets", "a/m1,b/m2", "--strategy", "round-robin", "--sticky", "3", "--json"], rr.deps);
    expect(code).toBe(0);
    expect(rr.requests[0]?.body).toMatchObject({
      id: "rr",
      combo: { strategy: "round-robin", stickyLimit: 3 },
    });
  });

  test("--combo-json configures full economy combo without hand-edit", async () => {
    const runtime = fakeRuntime();
    const comboJson = JSON.stringify({
      strategy: "economy",
      stickyLimit: 1,
      economy: { unknownQuota: "deprioritize", maxMarginalUsd: 0.1 },
      targets: [
        { provider: "included", model: "m", allowances: ["promo"] },
        { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.8 } },
      ],
    });
    const code = await handleComboCommand(["set", "bulk-code", "--combo-json", comboJson, "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.method).toBe("PUT");
    expect(runtime.requests[0]?.path).toBe("/api/combos");
    expect(runtime.requests[0]?.body).toEqual({
      id: "bulk-code",
      combo: {
        strategy: "economy",
        stickyLimit: 1,
        economy: { unknownQuota: "deprioritize", maxMarginalUsd: 0.1 },
        targets: [
          { provider: "included", model: "m", allowances: ["promo"] },
          { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.8 } },
        ],
      },
    });
  });

  test("--targets-json plus --economy-json round-trips economy policy, allowance refs, and pricing", async () => {
    const runtime = fakeRuntime();
    const targetsJson = JSON.stringify([
      { provider: "included", model: "m", allowances: ["promo", "extra"] },
      { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1 } },
    ]);
    const economyJson = JSON.stringify({ unknownQuota: "reject", maxMarginalUsd: 1 });
    const code = await handleComboCommand([
      "set",
      "bulk",
      "--strategy",
      "economy",
      "--targets-json",
      targetsJson,
      "--economy-json",
      economyJson,
      "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.body).toEqual({
      id: "bulk",
      combo: {
        strategy: "economy",
        stickyLimit: 1,
        targets: [
          { provider: "included", model: "m", allowances: ["promo", "extra"] },
          { provider: "payg", model: "m", pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1 } },
        ],
        economy: { unknownQuota: "reject", maxMarginalUsd: 1 },
      },
    });
  });

  test("--targets-json alone with economy strategy", async () => {
    const runtime = fakeRuntime();
    const targetsJson = JSON.stringify([
      { provider: "a", model: "m1", weight: 2, allowances: ["promo"] },
    ]);
    const code = await handleComboCommand(["set", "eco", "--strategy", "economy", "--targets-json", targetsJson, "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]?.body).toMatchObject({
      id: "eco",
      combo: {
        strategy: "economy",
        targets: [{ provider: "a", model: "m1", weight: 2, allowances: ["promo"] }],
      },
    });
  });

  test("malformed --combo-json rejects with 2 and no request", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["set", "bulk", "--combo-json", "{", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("non-object --combo-json rejects with 2", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["set", "bulk", "--combo-json", "[]", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("malformed --targets-json rejects with 2", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["set", "bulk", "--targets-json", "{not json", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("non-array --targets-json rejects with 2", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["set", "bulk", "--targets-json", "{}", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("malformed --economy-json rejects with 2", async () => {
    const runtime = fakeRuntime();
    const targetsJson = JSON.stringify([{ provider: "a", model: "m1" }]);
    const code = await handleComboCommand(["set", "bulk", "--targets-json", targetsJson, "--economy-json", "{", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("non-object --economy-json rejects with 2", async () => {
    const runtime = fakeRuntime();
    const targetsJson = JSON.stringify([{ provider: "a", model: "m1" }]);
    const code = await handleComboCommand(["set", "bulk", "--targets-json", targetsJson, "--economy-json", "[]", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("--combo-json cannot be combined with --targets", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["set", "bulk", "--combo-json", "{}", "--targets", "a/m1", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("--combo-json cannot be combined with --strategy", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["set", "bulk", "--combo-json", "{}", "--strategy", "economy", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("--targets and --targets-json cannot be combined", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand(["set", "bulk", "--targets", "a/m1", "--targets-json", "[]", "--json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);
  });

  test("--json remains output-only with --combo-json", async () => {
    const runtime = fakeRuntime();
    const comboJson = JSON.stringify({
      strategy: "economy",
      targets: [{ provider: "a", model: "m1" }],
      economy: { unknownQuota: "allow" },
    });
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(String(args[0]));
    });
    try {
      const code = await handleComboCommand(["set", "bulk", "--combo-json", comboJson, "--json"], runtime.deps);
      expect(code).toBe(0);
      expect(runtime.requests[0]?.body).toEqual({
        id: "bulk",
        combo: { strategy: "economy", targets: [{ provider: "a", model: "m1" }], economy: { unknownQuota: "allow" } },
      });
      expect(() => JSON.parse(logs.join("\n"))).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  test("PUT contract matches management API expectation", async () => {
    const runtime = fakeRuntime();
    const comboJson = JSON.stringify({
      strategy: "economy",
      economy: { unknownQuota: "deprioritize", maxMarginalUsd: 0.1 },
      targets: [{ provider: "included", model: "m", allowances: ["promo"] }],
    });
    await handleComboCommand(["set", "bulk-code", "--combo-json", comboJson, "--rename-from", "old-id", "--json"], runtime.deps);
    expect(runtime.requests[0]?.method).toBe("PUT");
    expect(runtime.requests[0]?.path).toBe("/api/combos");
    expect(runtime.requests[0]?.body).toEqual({
      id: "bulk-code",
      combo: {
        strategy: "economy",
        economy: { unknownQuota: "deprioritize", maxMarginalUsd: 0.1 },
        targets: [{ provider: "included", model: "m", allowances: ["promo"] }],
      },
      renameFrom: "old-id",
    });
  });
});
