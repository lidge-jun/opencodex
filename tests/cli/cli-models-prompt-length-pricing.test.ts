import { describe, expect, test } from "bun:test";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";

const BASE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const CUSTOM = {
  mode: "custom", thresholdTokens: 1000, comparison: "gt",
  rates: { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3.75 },
};
const STORED = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, promptLengthPricing: CUSTOM };

type RunOptions = {
  getProvider?: string;
  reorderPut?: boolean;
  receiptCost?: (cost: Record<string, unknown>) => unknown;
};

async function setPrice(args: string[], modelCosts: Record<string, unknown>, options: RunOptions = {}) {
  const calls: Array<{ method: string; body: any }> = [];
  const log = console.log;
  console.log = () => {};
  try {
    const code = await handleModelsRuntimeCommand("set-price", args, {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async (_url, init) => {
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, body });
        if (method === "GET") return Response.json({ provider: options.getProvider ?? "custom-price", modelCosts });
        const reordered = options.reorderPut && body.cost?.promptLengthPricing
          ? { ...body.cost, promptLengthPricing: Object.fromEntries(Object.entries(body.cost.promptLengthPricing).reverse()) }
          : body.cost;
        const cost = options.receiptCost ? options.receiptCost(reordered) : reordered;
        return Response.json({ ok: true, provider: "custom-price", modelId: body.modelId, cost });
      },
    });
    return { code, calls, put: calls.find(call => call.method === "PUT") };
  } finally {
    console.log = log;
  }
}

test("price accepts complete stored prompt-length policies and rejects malformed API policy rows", async () => {
  const base = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  const policies = [{ mode: "automatic" }, { mode: "flat" }, {
    mode: "custom", thresholdTokens: 1, comparison: "gt", rates: base,
  }, { mode: "custom", thresholdTokens: 0, comparison: "gt", rates: base },
  { mode: "custom", thresholdTokens: 1, comparison: "gt", rates: { input: 1 } }];
  for (const [index, promptLengthPricing] of policies.entries()) {
    const cost = { ...base, promptLengthPricing };
    const output: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args) => { output.push(args.join(" ")); };
    console.error = () => {};
    try {
      const code = await handleModelsRuntimeCommand("price", ["acme/org/model", "--json"], {
        baseUrl: "http://127.0.0.1:1", fetchImpl: async () => Response.json({ provider: "acme", modelCosts: { "org/model": cost } }),
      });
      expect(code).toBe(index < 3 ? 0 : 1);
      if (index < 3) {
        const result = JSON.parse(output.join("\n"));
        expect(result.cost).toEqual(cost);
        expect(result.effectiveCost).toEqual(base);
        expect(Object.keys(result.effectiveCost).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
      }
    } finally { console.log = log; console.error = error; }
  }
});

test("legacy set-price accepts absent/automatic receipts and rejects policies it did not send", async () => {
  const policies = [undefined, { mode: "automatic" }, { mode: "flat" }, {
    mode: "custom", thresholdTokens: 1, comparison: "gte", rates: BASE,
  }];
  for (const [index, promptLengthPricing] of policies.entries()) {
    const cost = { ...BASE, ...(promptLengthPricing ? { promptLengthPricing } : {}) };
    const output: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args) => { output.push(args.join(" ")); };
    console.error = (...args) => { errors.push(args.join(" ")); };
    let writes = 0;
    try {
      const code = await handleModelsRuntimeCommand("set-price", ["acme/org/model", "--input", "1", "--output", "2", "--json"], {
        baseUrl: "http://127.0.0.1:1", fetchImpl: async (_url, init) => {
          if ((init?.method ?? "GET") === "GET") return Response.json({ provider: "acme", modelCosts: {} });
          writes += 1;
          expect(JSON.parse(String(init?.body))).toEqual({ modelId: "org/model", cost: BASE });
          return Response.json({ ok: true, provider: "acme", modelId: "org/model", cost });
        },
      });
      expect(code).toBe(index < 2 ? 0 : 1);
      expect(writes).toBe(1);
      if (index < 2) expect(JSON.parse(output.join("\n")).cost).toEqual(BASE);
      else {
        expect(output).toEqual([]);
        expect(errors.join("\n")).toContain("Invalid model price persistence receipt");
      }
    } finally { console.log = log; console.error = error; }
  }
});

describe("models set-price keeps the nested promptLengthPricing policy", () => {
  test("a custom policy survives a rate change on the same row", async () => {
    const result = await setPrice(["custom-price/org/model", "--input", "2", "--output", "6", "--json"], { "org/model": STORED });
    expect(result.code).toBe(0);
    expect(result.put!.body).toEqual({
      modelId: "org/model",
      cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0, promptLengthPricing: CUSTOM },
    });
  });

  test("a flat policy is carried forward as well", async () => {
    const flat = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, promptLengthPricing: { mode: "flat" } };
    const result = await setPrice(["custom-price/org/model", "--input", "2", "--output", "6", "--json"], { "org/model": flat });
    expect(result.put!.body.cost.promptLengthPricing).toEqual({ mode: "flat" });
  });

  test("a policy on a sibling model is never carried onto a new row", async () => {
    const result = await setPrice(["custom-price/org/model", "--input", "2", "--output", "6", "--json"], { other: STORED });
    expect(result.code).toBe(0);
    expect(result.put!.body.cost).not.toHaveProperty("promptLengthPricing");
  });

  test("--auto reset sends a null cost without reading a policy", async () => {
    const result = await setPrice(["custom-price/org/model", "--auto", "--json"], { "org/model": STORED });
    expect(result.code).toBe(0);
    expect(result.calls.map(call => call.method)).toEqual(["PUT"]);
    expect(result.put!.body).toEqual({ modelId: "org/model", cost: null });
  });

  test("a current-row read for another provider is rejected before any write", async () => {
    const result = await setPrice(["custom-price/org/model", "--input", "2", "--output", "6", "--json"],
      { "org/model": STORED }, { getProvider: "other-price" });
    expect(result.code).toBe(1);
    expect(result.put).toBeUndefined();
  });

  test("a receipt whose promptLengthPricing keys arrive reordered is accepted", async () => {
    const result = await setPrice(["custom-price/org/model", "--input", "2", "--output", "6", "--json"],
      { "org/model": STORED }, { reorderPut: true });
    expect(result.code).toBe(0);
    expect(result.put!.body.cost.promptLengthPricing).toEqual(CUSTOM);
  });

  test("an absent receipt policy equals the automatic one that was sent", async () => {
    const stored = { ...STORED, promptLengthPricing: { mode: "automatic" } };
    const result = await setPrice(["custom-price/org/model", "--input", "2", "--output", "6", "--json"],
      { "org/model": stored }, { receiptCost: (cost) => { const copy = { ...cost }; delete copy.promptLengthPricing; return copy; } });
    expect(result.code).toBe(0);
    expect(result.put!.body.cost.promptLengthPricing).toEqual({ mode: "automatic" });
  });

  test("an automatic receipt policy equals the absent policy that was sent", async () => {
    const result = await setPrice(["custom-price/org/model", "--input", "2", "--output", "6", "--json"],
      {}, { receiptCost: (cost) => ({ ...cost, promptLengthPricing: { mode: "automatic" } }) });
    expect(result.code).toBe(0);
    expect(result.put!.body.cost).not.toHaveProperty("promptLengthPricing");
  });
});
