import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getConfigPath, saveConfig } from "../../src/config";
import { handleComboCommand } from "../../src/cli/combo";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { handleComboRoutes } from "../../src/server/management/combo-routes";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

// #7579: `ocx combo set <id> --targets ...` without --strategy used to send a fresh failover body,
// so a JEV combo silently stopped being JEV and lost its decision method, quota policy and pin.
const jevPolicy = {
  strategy: "jev",
  decisionProvider: "tev",
  decisionTimeoutMs: 6000,
  decisionQuotaSignals: true,
  decisionQuotaTiers: { moderate: 40 },
  sessionPin: { ttlMs: 1_200_000 },
};
let home: TempHome;
let config: OcxConfig;
let errors: string[];
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = createTempHome("ocx-combo-set-targets-");
  errors = [];
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation((...parts: unknown[]) => { errors.push(parts.join(" ")); });
  config = {
    port: 10100,
    defaultProvider: "fixture",
    providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["m", "n"] },
      tev: { adapter: "jev-decision", baseUrl: "http://127.0.0.1:11434/v1/systemone", defaultModel: "tev1:4b" },
    },
    combos: {
      auto: { ...jevPolicy, targets: [{ provider: "fixture", model: "m" }] },
      judged: { strategy: "jev", decisionModel: "fixture/n", targets: [{ provider: "fixture", model: "m" }] },
    },
  } as OcxConfig;
  saveConfig(config);
});
afterEach(() => { log.mockRestore(); error.mockRestore(); home.remove(); });

const deps: RuntimeApiDeps = {
  findLiveProxy: async () => ({ pid: null, port: 14000, source: "runtime" }),
  fetchImpl: (async (_input, init) => {
    const req = new Request("http://127.0.0.1/api/combos", { method: init?.method ?? "GET", ...(init?.body ? { headers: { "content-type": "application/json" }, body: String(init.body) } : {}) });
    const response = await handleComboRoutes({ req, url: new URL(req.url), config, deps: {}, version: "fixture", trustedLoopbackIngress: true, guiSessionIssuance: null,
      convergeCodexCatalog: async () => ({ status: "committed", changed: false, degraded: false, notices: [] }), syncClaudeAgentDefsBestEffort: async () => {} });
    if (!response) throw new Error("missing combo response");
    return response;
  }) as typeof fetch,
};
const stored = () => JSON.parse(readFileSync(getConfigPath(), "utf8")).combos as Record<string, Record<string, unknown>>;

describe("ocx combo set --targets keeps the stored strategy (#7579)", () => {
  test("replacing a JEV combo's targets keeps JEV and its whole policy", async () => {
    expect(await handleComboCommand(["set", "auto", "--targets", "fixture/n,fixture/m:2", "--json"], deps)).toBe(0);
    expect(stored().auto).toMatchObject({ ...jevPolicy, targets: [{ provider: "fixture", model: "n" }, { provider: "fixture", model: "m", weight: 2 }] });
    expect(await handleComboCommand(["set", "judged", "--targets", "fixture/n", "--json"], deps)).toBe(0);
    expect(stored().judged).toMatchObject({ strategy: "jev", decisionModel: "fixture/n", targets: [{ provider: "fixture", model: "n" }] });
  });

  test("targets the kept JEV policy rejects fail with a message naming that policy, without writing", async () => {
    const before = readFileSync(getConfigPath(), "utf8");
    expect(await handleComboCommand(["set", "auto", "--targets", "tev/tev1:4b", "--json"], deps)).toBe(1);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(errors.join("\n")).toContain("--targets keeps the stored jev strategy with its decision method, quota policy and session pin");
    // A rejected combo that was not JEV keeps the generic message.
    config.combos!.plain = { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] };
    saveConfig(config);
    errors.length = 0;
    expect(await handleComboCommand(["set", "plain", "--targets", "tev/tev1:4b", "--json"], deps)).toBe(1);
    expect(errors.join("\n")).not.toContain("jev");
  });

  test("the kept-JEV message covers a refused JEV setting and leaves unrelated refusals generic", async () => {
    config.providers!.tev!.disabled = true;
    saveConfig(config);
    const before = readFileSync(getConfigPath(), "utf8");
    expect(await handleComboCommand(["set", "auto", "--targets", "fixture/n", "--json"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("the kept jev settings");
    errors.length = 0;
    // A rename onto an existing combo is refused for its own reason, not for the kept policy.
    expect(await handleComboCommand(["set", "judged", "--rename-from", "auto", "--targets", "fixture/n", "--json"], deps)).toBe(1);
    expect(errors.join("\n")).not.toContain("jev");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
  });

  test("JEV-only flags with replaced targets are checked against the stored strategy", async () => {
    expect(await handleComboCommand(["set", "auto", "--targets", "fixture/n", "--session-pin", "1h", "--json"], deps)).toBe(0);
    expect(stored().auto).toMatchObject({ ...jevPolicy, sessionPin: { ttlMs: 3_600_000 }, targets: [{ provider: "fixture", model: "n" }] });
    config.combos!.plain = { strategy: "failover", targets: [{ provider: "fixture", model: "m" }] };
    saveConfig(config);
    expect(await handleComboCommand(["set", "plain", "--targets", "fixture/n", "--session-pin", "1h", "--json"], deps)).toBe(2);
    expect(stored().plain).toMatchObject({ strategy: "failover", targets: [{ provider: "fixture", model: "m" }] });
  });

  test("an explicit strategy still switches away from JEV, and a new combo still defaults to failover", async () => {
    expect(await handleComboCommand(["set", "auto", "--targets", "fixture/n", "--strategy", "failover", "--json"], deps)).toBe(0);
    expect(stored().auto).toMatchObject({ strategy: "failover", targets: [{ provider: "fixture", model: "n" }] });
    for (const field of ["decisionProvider", "decisionTimeoutMs", "decisionQuotaSignals", "decisionQuotaTiers", "sessionPin"]) expect(stored().auto).not.toHaveProperty(field);
    expect(await handleComboCommand(["set", "fresh", "--targets", "fixture/m", "--json"], deps)).toBe(0);
    expect(stored().fresh).toMatchObject({ strategy: "failover", targets: [{ provider: "fixture", model: "m" }] });
  });
});
