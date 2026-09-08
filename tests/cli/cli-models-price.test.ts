import { describe, expect, test } from "bun:test";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { MANAGEMENT_ROUTES } from "../../src/server/management/route-registry";

const COST = { input: 1.25, output: 5, cacheRead: 0.125, cacheWrite: 2 };

async function invoke(sub: string, args: string[], response?: unknown, status = 200) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  try {
    const code = await handleModelsRuntimeCommand(sub, args, {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({
          path,
          method: init?.method ?? "GET",
          body,
        });
        if (response instanceof Response) return response;
        return Response.json(response === undefined
          ? { ok: true, provider: path.split("/")[3], modelId: body?.modelId, cost: body?.cost }
          : response, { status });
      },
    });
    return { code, calls, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("models manual price commands", () => {
  test("price reads the map and selects the exact ID after the first slash", async () => {
    const result = await invoke("price", ["custom-price/org/model--fast", "--json"], {
      provider: "custom-price",
      modelCosts: { "org/model--fast": COST, "org--model--fast": { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } },
    });
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([{ path: "/api/providers/custom-price/model-costs", method: "GET", body: undefined }]);
    expect(JSON.parse(result.stdout)).toEqual({ provider: "custom-price", modelId: "org/model--fast", cost: COST });
  });

  test("missing own keys read as automatic, including prototype-shaped selectors", async () => {
    for (const modelId of ["missing", "__proto__", "constructor", "toString"]) {
      const result = await invoke("price", [`custom-price/${modelId}`, "--json"], { provider: "custom-price", modelCosts: {} });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ provider: "custom-price", modelId, cost: null });
    }
    const automatic = await invoke("price", ["custom-price/missing"], { provider: "custom-price", modelCosts: {} });
    expect(automatic.stdout).toContain("automatic pricing");
  });

  test("set-price sends four numeric rates with omitted cache rates defaulted to zero", async () => {
    const result = await invoke("set-price", ["custom-price/org/model", "--input", "1.25", "--output", "5", "--json"]);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([{
      path: "/api/providers/custom-price/model-costs", method: "PUT",
      body: { modelId: "org/model", cost: { input: 1.25, output: 5, cacheRead: 0, cacheWrite: 0 } },
    }]);
  });

  test("explicit cache rates, all-zero pricing, and the maximum rate are transmitted unchanged", async () => {
    const explicit = await invoke("set-price", ["custom-price/org/model", "--input", "1.25", "--output", "5", "--cache-read", "0.125", "--cache-write", "2"]);
    expect(explicit.code).toBe(0);
    expect(explicit.calls[0]!.body).toEqual({ modelId: "org/model", cost: COST });
    const zero = await invoke("set-price", ["custom-price/model", "--input", "0", "--output", "0"]);
    expect(zero.code).toBe(0);
    expect(zero.calls[0]!.body).toEqual({ modelId: "model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const max = await invoke("set-price", ["custom-price/model", "--input", "1000000", "--output", "1e6"]);
    expect(max.code).toBe(0);
    expect(max.calls[0]!.body).toEqual({ modelId: "model", cost: { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } });
  });

  test("--auto sends null and preserves the exact upstream ID", async () => {
    const payload = { ok: true, provider: "custom-price", modelId: "org/model", cost: null };
    const result = await invoke("set-price", ["custom-price/org/model", "--auto", "--json"], payload);
    expect(result.code).toBe(0);
    expect(result.calls).toEqual([{
      path: "/api/providers/custom-price/model-costs", method: "PUT", body: { modelId: "org/model", cost: null },
    }]);
    expect(JSON.parse(result.stdout)).toEqual(payload);
  });

  test("invalid selectors and read options fail before any request", async () => {
    for (const selector of ["", "native-model", "/model", "provider/", " provider/model", "provider/ model", "provider/model ", "provider/bad\nmodel", "provider/" + "x".repeat(1025), "__proto__/model"]) {
      for (const sub of ["price", "set-price"]) {
        const result = await invoke(sub, [selector, ...(sub === "set-price" ? ["--auto"] : [])]);
        expect(result.code).toBe(2);
        expect(result.calls).toHaveLength(0);
      }
    }
    for (const args of [["--auto"], ["--input", "1"], ["extra"], ["--json", "--json"]]) {
      const result = await invoke("price", ["custom-price/model", ...args]);
      expect(result.code).toBe(2);
      expect(result.calls).toHaveLength(0);
    }
  });

  test("missing, conflicting, repeated, unknown and invalid rate arguments make no requests", async () => {
    const cases = [
      [], ["--input", "1"], ["--output", "2"], ["--input"], ["--input", "--output", "2"],
      ["--auto", "--input", "0"], ["--auto", "--cache-read", "0"], ["--auto", "--cache-write", "0"],
      ["--auto", "--auto"], ["--auto", "--unknown"], ["--auto", "extra"],
      ["--input", "1", "--input", "2", "--output", "3"],
      ...["", " ", "NaN", "Infinity", "1e309", "-1", "1000001", "1x", "1,2"].map(rate => ["--input", rate, "--output", "1"]),
      ...["--output", "--cache-read", "--cache-write"].map(flag => flag === "--output"
        ? ["--input", "1", flag, "-1"] : ["--input", "1", "--output", "2", flag, "-1"]),
    ];
    for (const args of cases) {
      const result = await invoke("set-price", ["custom-price/model", ...args]);
      expect(result.code).toBe(2);
      expect(result.calls).toHaveLength(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });

  test("API rejection is reported with a nonzero exit and no success message", async () => {
    const result = await invoke("set-price", ["custom-price/model", "--auto"], { error: "provider not found" }, 404);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("provider not found");
    expect(result.stdout).toBe("");
  });

  test("duplicate, inline and stray price arguments never echo credential-shaped values", async () => {
    const secret = "sk-" + "a".repeat(40);
    for (const extra of [["--input", secret], [`--input=${secret}`], [secret]]) {
      const result = await invoke("set-price", ["custom-price/model", "--input", "1", "--output", "2", ...extra]);
      expect(result.code).toBe(2);
      expect(result.calls).toHaveLength(0);
      expect(result.stderr).not.toContain(secret);
      expect(result.stderr).toContain("Unexpected argument(s)");
      expect(result.stdout).toBe("");
    }
  });

  test("malformed or mismatched success receipts fail without printing response contents", async () => {
    const secret = "sk-" + "a".repeat(40);
    const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
    const receipt = { ok: true, provider: "custom-price", modelId: "model", cost };
    for (const response of [
      null, {}, "malformed", new Response("{"), new Response(null, { status: 204 }),
      { ...receipt, ok: false }, { ...receipt, provider: "other" }, { ...receipt, modelId: "other" },
      { ...receipt, cost: null }, { ...receipt, cost: { input: 1, output: 2 } },
      { ...receipt, cost: { ...cost, output: 3 } }, { ...receipt, cost: { ...cost, apiKey: secret } },
    ]) {
      const result = await invoke("set-price", ["custom-price/model", "--input", "1", "--output", "2"], response);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid model price persistence receipt");
      expect(result.stderr).not.toContain(secret);
    }
    const badReset = await invoke("set-price", ["custom-price/model", "--auto"], receipt);
    expect(badReset.code).toBe(1);
    expect(badReset.stdout).toBe("");
    const projected = await invoke("set-price", ["custom-price/model", "--input", "1", "--output", "2", "--json"], { ...receipt, apiKey: secret });
    expect(projected.code).toBe(0);
    expect(JSON.parse(projected.stdout)).toEqual(receipt);
    expect(projected.stdout).not.toContain(secret);
  });

  test("invalid GET maps fail rather than appearing automatic or leaking extra rate fields", async () => {
    for (const response of [
      null, {}, new Response("{"), { provider: "other", modelCosts: {} },
      { provider: "custom-price", modelCosts: [] },
      { provider: "custom-price", modelCosts: { model: null } },
      { provider: "custom-price", modelCosts: { model: { ...COST, input: -1 } } },
      { provider: "custom-price", modelCosts: { model: { ...COST, extra: "unexpected" } } },
    ]) {
      const result = await invoke("price", ["custom-price/model", "--json"], response);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Invalid model price response");
    }
  });

  test("secret-shaped model selectors fail before request or output for read, set and reset", async () => {
    const modelId = "sk-" + "a".repeat(40);
    for (const [sub, flags] of [
      ["price", []],
      ["set-price", ["--input", "1", "--output", "2"]],
      ["set-price", ["--auto"]],
    ] as const) {
      const result = await invoke(sub, [`custom-price/${modelId}`, ...flags, "--json"]);
      expect(result.code).toBe(2);
      expect(result.calls).toHaveLength(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(modelId);
      expect(result.stderr).toContain("modelId cannot be displayed safely");
    }
  });

  test("capabilities map both CLI verbs onto the registered route methods", () => {
    for (const [sub, method, mutates] of [["price", "GET", false], ["set-price", "PUT", true]] as const) {
      const capability = CAPABILITIES.find(entry => entry.command.join(" ") === `models ${sub}`);
      expect(capability?.routes).toEqual([{ method, path: "/api/providers/{provider}/model-costs" }]);
      expect(capability?.mutates).toBe(mutates);
      expect(MANAGEMENT_ROUTES.find(route => route.method === method && route.path === "/api/providers/{provider}/model-costs")).toMatchObject({
        module: "server/management/model-routes", mutates, mechanism: "regex",
      });
    }
  });
});
