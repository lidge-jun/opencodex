import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { handleComboCommand } from "../../src/cli/combo";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

function fakeRuntime(combos: Record<string, unknown>[] = []) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      return Response.json(req.method === "GET" ? { combos } : { ok: true });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

const levels = {
  trivial: { candidates: [{ provider: "openai", model: "gpt-6-luna", effort: "low" }] },
  hard: { candidates: [{ provider: "openai", model: "gpt-6-astra", effort: "xhigh" }] },
};
const base = ["set", "jev-local", "--targets", "openai/gpt-6-astra,openai/gpt-6-luna", "--strategy", "jev"];

describe("ocx combo set level mode", () => {
  test("sends decisionMode, decisionLevels and decisionFallbackLevel, and clears each with -", async () => {
    const runtime = fakeRuntime();
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleComboCommand([
        ...base, "--decision-mode", "level", "--decision-levels", JSON.stringify(levels),
        "--decision-fallback-level", "trivial", "--json",
      ], runtime.deps)).toBe(0);
      expect(await handleComboCommand([
        ...base, "--decision-mode", "-", "--decision-levels", "-", "--decision-fallback-level", "-", "--json",
      ], runtime.deps)).toBe(0);
      expect(await handleComboCommand([...base, "--decision-mode", "route", "--json"], runtime.deps)).toBe(0);
      expect(await handleComboCommand([...base, "--json"], runtime.deps)).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
    const puts = runtime.requests.filter(request => request.method === "PUT").map(request => (request.body as { combo: Record<string, unknown> }).combo);
    expect(puts[0]).toMatchObject({ decisionMode: "level", decisionLevels: levels, decisionFallbackLevel: "trivial" });
    expect(puts[1]).toMatchObject({ decisionMode: null, decisionLevels: null, decisionFallbackLevel: null });
    expect(puts[2]).toMatchObject({ decisionMode: "route" });
    // Omission lets the server keep what is stored.
    for (const field of ["decisionMode", "decisionLevels", "decisionFallbackLevel"]) expect(puts[3]).not.toHaveProperty(field);
  });

  test("rejects bad values and non-jev strategies before any request", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const args of [
        ["--strategy", "jev", "--decision-mode", "auto"],
        ["--strategy", "jev", "--decision-levels", "{not json"],
        ["--strategy", "jev", "--decision-levels", "[]"],
        ["--strategy", "jev", "--decision-fallback-level", "expert"],
        ["--decision-mode", "level"],
        ["--strategy", "failover", "--decision-levels", JSON.stringify(levels)],
        ["--strategy", "round-robin", "--decision-fallback-level", "hard"],
      ]) {
        const rejected = fakeRuntime();
        expect(await handleComboCommand(["set", "demo", "--targets", "a/m1", ...args], rejected.deps)).toBe(2);
        expect(rejected.requests).toEqual([]);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("partial combo updates", () => {
  test("preserves target settings and unmentioned fields, and clears decision fields", async () => {
    const targets = [{ provider: "a", model: "m", reasoningEfforts: ["low", "high"], modelProfile: { description: "Profile" }, weight: 3, lastResort: true }];
    const runtime = fakeRuntime([{ id: "existing", strategy: "jev", targets, stickyLimit: 7, alias: "kept", defaultEffort: "high", defaultEffortMode: "force", decisionPrompt: { levelInstructions: "Custom" }, decisionMode: "level" }]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleComboCommand(["set", "existing", "--decision-levels", JSON.stringify(levels), "--json"], runtime.deps)).toBe(0);
      expect(await handleComboCommand(["set", "existing", "--effort", "-", "--decision-mode", "-", "--alias", "-", "--json"], runtime.deps)).toBe(0);
    } finally { log.mockRestore(); }
    const puts = runtime.requests.filter(row => row.method === "PUT").map(row => (row.body as { combo: Record<string, unknown> }).combo);
    expect(puts[0]).toMatchObject({ strategy: "jev", targets, stickyLimit: 7, alias: "kept", decisionLevels: levels, decisionMode: "level", decisionPrompt: { levelInstructions: "Custom" } });
    expect(puts[0]).not.toHaveProperty("id");
    expect(puts[1]).toMatchObject({ targets, defaultEffort: null, defaultEffortMode: "fallback", decisionPrompt: { levelInstructions: "Custom" }, decisionMode: null, alias: "" });
  });
  test("drops null fields the GET listing reports for unset options", async () => {
    // Real /api/combos rows carry alias/displayName/defaultEffort/decision* as null when unset; PUT rejects a null alias.
    const targets = [{ provider: "a", model: "m", reasoningEfforts: ["low", "xhigh"], weight: 1, lastResort: false }];
    const runtime = fakeRuntime([{ id: "row", model: "combo/row", strategy: "jev", stickyLimit: 1, targets, alias: null, displayName: null, defaultEffort: null, decisionProvider: "tev", decisionPrompt: null, decisionMode: "level", decisionLevels: levels }]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleComboCommand(["set", "row", "--decision-quota", "on", "--json"], runtime.deps)).toBe(0);
    } finally { log.mockRestore(); }
    const put = runtime.requests.find(row => row.method === "PUT")!.body as { combo: Record<string, unknown> };
    expect(Object.values(put.combo)).not.toContain(null);
    expect(put.combo).toMatchObject({ targets, decisionProvider: "tev", decisionMode: "level", decisionLevels: levels, decisionQuotaSignals: true });
    expect(put.combo).not.toHaveProperty("decisionPrompt");
    expect(put.combo).not.toHaveProperty("alias");
    expect(put.combo).not.toHaveProperty("model");
  });
  test("clearing levels also clears a stored fallback level the listing would resend", async () => {
    const targets = [{ provider: "a", model: "m", weight: 1, lastResort: false }];
    const runtime = fakeRuntime([{ id: "row", strategy: "jev", targets, decisionMode: "level", decisionLevels: levels, decisionFallbackLevel: "trivial" }]);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleComboCommand(["set", "row", "--decision-mode", "-", "--decision-levels", "-", "--json"], runtime.deps)).toBe(0);
    } finally { log.mockRestore(); }
    const put = runtime.requests.find(row => row.method === "PUT")!.body as { combo: Record<string, unknown> };
    expect(put.combo).toMatchObject({ decisionMode: null, decisionLevels: null, decisionFallbackLevel: null });
  });
  test("create without targets gives a clear error and never writes", async () => {
    const runtime = fakeRuntime();
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleComboCommand(["set", "new", "--strategy", "jev"], runtime.deps)).toBe(2);
      expect(error.mock.calls.flat().join(" ")).toContain("--targets is required when creating a combo");
    } finally { error.mockRestore(); }
    expect(runtime.requests.map(row => row.method)).toEqual(["GET"]);
  });
});

test("within-level selection parses, preserves partial updates, clears dependencies, and rejects contradictions", async () => {
  const row = { id: "existing", strategy: "jev", decisionMode: "level", decisionLevels: levels, decisionLevelSelect: "route", targets: [{ provider: "openai", model: "gpt-6-astra" }] };
  const runtime = fakeRuntime([row]);
  const log = spyOn(console, "log").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const flags of [["--decision-timeout", "2000"], ["--decision-level-select", "order"], ["--decision-level-select", "-"], ["--decision-mode", "route"], ["--decision-mode", "-", "--decision-levels", "-"]]) {
      expect(await handleComboCommand(["set", "existing", ...flags, "--json"], runtime.deps)).toBe(0);
    }
    for (const flags of [["--decision-level-select", "true"], ["--decision-mode", "route", "--decision-level-select", "route"], ["--decision-mode", "-", "--decision-levels", "-", "--decision-level-select", "order"]]) {
      expect(await handleComboCommand(["set", "existing", ...flags, "--json"], runtime.deps)).toBe(2);
    }
  } finally { log.mockRestore(); error.mockRestore(); }
  const puts = runtime.requests.filter(r => r.method === "PUT").map(r => (r.body as { combo: Record<string, unknown> }).combo);
  expect(puts.map(p => p.decisionLevelSelect)).toEqual(["route", "order", null, null, null]);
});
