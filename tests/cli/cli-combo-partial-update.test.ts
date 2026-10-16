import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleComboCommand } from "../../src/cli/combo";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";

const original = { id: "auto", model: "combo/auto", strategy: "jev", stickyLimit: 1,
  targets: [{ provider: "a", model: "m1", modelProfile: "description", reasoningEfforts: ["high"] }],
  alias: null, displayName: null, defaultEffort: null, cooldownWaitPolicy: null,
  decisionProvider: "decision", decisionModel: null, decisionTimeoutMs: 6000, imageInput: "disabled" };
function runtime(row: Record<string, unknown> | undefined = original) {
  const requests: Array<{ method: string; body?: { id: string; combo: Record<string, unknown>; renameFrom?: string } }> = [];
  const deps: RuntimeApiDeps = { baseUrl: "http://localhost:10100", fetchImpl: (async (_input, init) => {
    const method = init?.method ?? "GET";
    requests.push({ method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === "GET") return Response.json({ combos: row ? [row] : [] });
    const saved = JSON.parse(String(init?.body)) as { id: string; combo: Record<string, unknown> };
    const combo = Object.fromEntries(Object.entries(saved.combo).filter(([key, value]) => value !== null || key === "defaultEffort"));
    return Response.json({ success: true, id: saved.id, model: typeof combo.alias === "string" && combo.alias.trim() ? combo.alias.trim() : `combo/${saved.id}`, combo,
      catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } });
  }) as typeof fetch };
  return { requests, deps, body: () => requests.find(request => request.method === "PUT")?.body };
}
afterEach(() => { consoleSpies.forEach(spy => spy.mockRestore()); consoleSpies.length = 0; });
const consoleSpies: Array<ReturnType<typeof spyOn<typeof console, "log">>> = [];
function quiet() {
  consoleSpies.push(spyOn(console, "log").mockImplementation(() => {}));
  consoleSpies.push(spyOn(console, "error").mockImplementation(() => {}));
}

describe("combo partial update and decision selector CLI", () => {
  test("creating with explicit targets sends the model selector and preserves target order and weights", async () => {
    quiet();
    const r = runtime();
    expect(await handleComboCommand(["set", "new", "--strategy", "jev", "--targets", "a/m1:2,b/m2", "--decision-model", "a/judge"], r.deps)).toBe(0);
    expect(r.body()).toEqual({ id: "new", combo: {
      strategy: "jev", stickyLimit: 1, targets: [{ provider: "a", model: "m1", weight: 2 }, { provider: "b", model: "m2" }],
      decisionProvider: null, decisionModel: "a/judge",
    } });
  });

  test("without targets fetches once, keeps targets and configured fields, drops listing identity and nulls", async () => {
    quiet();
    const r = runtime();
    expect(await handleComboCommand(["set", "auto", "--decision-timeout", "8000"], r.deps)).toBe(0);
    expect(r.requests.map(request => request.method)).toEqual(["GET", "PUT"]);
    expect(r.body()).toEqual({ id: "auto", combo: {
      strategy: "jev", stickyLimit: 1, targets: original.targets, decisionProvider: "decision",
      decisionTimeoutMs: 8000, imageInput: "disabled",
    } });
  });

  test("setting a model sends null for the carried provider; setting provider clears carried model", async () => {
    quiet();
    const r = runtime();
    expect(await handleComboCommand(["set", "auto", "--decision-model", "a/m1"], r.deps)).toBe(0);
    expect(r.body()?.combo).toMatchObject({ decisionModel: "a/m1", decisionProvider: null, targets: original.targets });
    const p = runtime({ ...original, decisionProvider: null, decisionModel: "a/m1" });
    expect(await handleComboCommand(["set", "auto", "--decision-provider", "decision"], p.deps)).toBe(0);
    expect(p.body()?.combo).toMatchObject({ decisionModel: null, decisionProvider: "decision" });
  });

  test("- clears the model and explicit opposite clears permit selecting either backend", async () => {
    quiet();
    for (const args of [
      ["--decision-model", "-"],
      ["--decision-provider", "decision", "--decision-model", "-"],
    ]) {
      const r = runtime({ ...original, decisionProvider: null, decisionModel: "a/m1" });
      expect(await handleComboCommand(["set", "auto", ...args], r.deps)).toBe(0);
      expect(r.body()?.combo.decisionModel).toBeNull();
    }
    const r = runtime();
    expect(await handleComboCommand(["set", "auto", "--decision-provider", "-", "--decision-model", "a/m1"], r.deps)).toBe(0);
    expect(r.body()?.combo).toMatchObject({ decisionProvider: null, decisionModel: "a/m1" });
  });

  test("rejects simultaneous selectors and a model outside JEV without PUT", async () => {
    quiet();
    for (const args of [
      ["--strategy", "jev", "--decision-provider", "decision", "--decision-model", "a/m1"],
      ["--strategy", "failover", "--decision-model", "a/m1"],
    ]) {
      const r = runtime();
      expect(await handleComboCommand(["set", "auto", "--targets", "a/m1", ...args], r.deps)).toBe(2);
      expect(r.requests).toHaveLength(0);
    }
  });

  test("strategy change removes all carried JEV settings", async () => {
    quiet();
    const r = runtime({ ...original, decisionModel: "a/m1" });
    expect(await handleComboCommand(["set", "auto", "--strategy", "failover"], r.deps)).toBe(0);
    expect(r.body()?.combo.strategy).toBe("failover");
    for (const field of ["decisionProvider", "decisionModel", "decisionTimeoutMs"]) expect(r.body()?.combo).not.toHaveProperty(field);
    expect(r.body()?.combo.targets).toEqual(original.targets);
  });

  test("partial rename fetches the source and preserves targets", async () => {
    quiet();
    const r = runtime();
    expect(await handleComboCommand(["set", "auto2", "--rename-from", "auto", "--decision-model", "a/m1"], r.deps)).toBe(0);
    expect(r.body()).toMatchObject({ id: "auto2", renameFrom: "auto", combo: { targets: original.targets } });
  });

  test("creating still requires targets and explicit empty targets reject", async () => {
    quiet();
    const r = runtime({ id: "different" });
    expect(await handleComboCommand(["set", "new"], r.deps)).toBe(2);
    expect(r.requests.map(request => request.method)).toEqual(["GET"]);
    const empty = runtime();
    expect(await handleComboCommand(["set", "auto", "--targets", ""], empty.deps)).toBe(2);
    expect(empty.requests).toHaveLength(0);
  });

  test("partial clear flags support sticky and effort-mode from carried rows", async () => {
    quiet();
    const r = runtime({ ...original, strategy: "round-robin", stickyLimit: 4, defaultEffort: "high", defaultEffortMode: "force" });
    expect(await handleComboCommand(["set", "auto", "--sticky", "-", "--effort-mode", "-"], r.deps)).toBe(0);
    expect(r.body()?.combo).toMatchObject({ stickyLimit: 1, defaultEffortMode: "fallback" });
  });

  test("clearing a forced effort in a partial update also restores fallback policy", async () => {
    quiet();
    const r = runtime({ ...original, defaultEffort: "high", defaultEffortMode: "force" });
    expect(await handleComboCommand(["set", "auto", "--effort", "-"], r.deps)).toBe(0);
    expect(r.body()?.combo).toMatchObject({ defaultEffort: null, defaultEffortMode: "fallback" });
  });
});

describe("combo decision probe and discovery verbs", () => {
  function recorder(reply: Record<string, unknown>, combos: unknown[] = [original]) {
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const deps: RuntimeApiDeps = { baseUrl: "http://localhost:10100", fetchImpl: (async (input, init) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      requests.push({ url, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return Response.json(url.endsWith("/api/combos") ? { combos } : reply);
    }) as typeof fetch };
    return { requests, deps };
  }

  test("test probes the saved method of a combo and an explicit model override", async () => {
    quiet();
    const saved = recorder({ ok: true, backend: "systemone", gate: "apply", latencyMs: 12 });
    expect(await handleComboCommand(["test", "--combo", "auto"], saved.deps)).toBe(0);
    expect(saved.requests.at(-1)).toMatchObject({
      method: "POST",
      body: { comboId: "auto", decisionProvider: "decision", decisionTimeoutMs: 6000 },
    });
    const model = recorder({ ok: false, backend: "model", gate: "timeout", latencyMs: 4000 });
    expect(await handleComboCommand(["test", "--decision-model", "a/judge", "--decision-timeout", "2000"], model.deps)).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ method: "POST", body: { decisionModel: "a/judge", decisionTimeoutMs: 2000 } });
  });

  test("test refuses both selectors and an out-of-range timeout without a request", async () => {
    quiet();
    const r = recorder({});
    expect(await handleComboCommand(["test", "--decision-model", "a/j", "--decision-provider", "decision"], r.deps)).not.toBe(0);
    expect(await handleComboCommand(["test", "--decision-timeout", "5"], r.deps)).not.toBe(0);
    expect(r.requests).toHaveLength(0);
  });

  test("discover forwards the query", async () => {
    quiet();
    const r = recorder({ configured: [], discovered: [{ provider: "zen", model: "jev-1.13", endpoint: "https://x/v1/systemone" }] });
    expect(await handleComboCommand(["discover", "--query", "jev"], r.deps)).toBe(0);
    expect(r.requests[0]!.url).toContain("/api/combos/decision-discovery?q=jev");
  });
});
