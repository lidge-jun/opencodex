import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { prepareComboInput } from "../../src/cli/combo-input";
import { handleComboCommand } from "../../src/cli/combo";
import { handleComboRoutes } from "../../src/server/management/combo-routes";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import type { OcxConfig } from "../../src/types";
import type { CatalogDisposition } from "../../src/codex/convergence-types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let token: string | undefined;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-combo-parity-");
  token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  output.mockRestore(); errors.mockRestore(); network.mockRestore();
  if (token === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = token;
  home.remove();
});
function file(value: unknown): string {
  const path = home.path("targets.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}
const target = { provider: "fixture", model: "org/raw/model" };

describe("combo extension input", () => {
  test("omission stays absent and existing scalar options stay for the parent", async () => {
    const args = ["--targets", "fixture/m", "--effort-mode", "force", "--alias", "name", "--json"];
    expect(await prepareComboInput(args)).toEqual({});
    expect(args).toEqual(["--targets", "fixture/m", "--effort-mode", "force", "--alias", "name", "--json"]);
  });
  test("explicit defaults and false survive while defaultEffortMode remains separate", async () => {
    const args = ["--native-alias", "off", "--image-input=auto", "--reasoning-effort-mode", "strict", "--effort-mode", "force"];
    expect(await prepareComboInput(args)).toEqual({ nativeAlias: false, imageInput: "auto", reasoningEffortMode: "strict" });
    expect(args).toEqual(["--effort-mode", "force"]);
  });
  for (const args of [["--native-alias"], ["--native-alias", "on"], ["--native-alias=on"]]) {
    test(`native alias true: ${args.join(" ")}`, async () => {
      expect(await prepareComboInput([...args])).toEqual({ nativeAlias: true });
    });
  }
  test("bare native alias leaves following option intact", async () => {
    const args = ["--native-alias", "--alias", "gpt-fixture"];
    expect(await prepareComboInput(args)).toEqual({ nativeAlias: true });
    expect(args).toEqual(["--alias", "gpt-fixture"]);
  });
  test("nondefault values and inline false", async () => {
    expect(await prepareComboInput(["--native-alias=off", "--image-input", "disabled", "--reasoning-effort-mode=adaptive"]))
      .toEqual({ nativeAlias: false, imageInput: "disabled", reasoningEffortMode: "adaptive" });
  });
  for (const args of [
    ["--native-alias", "false"], ["--native-alias="], ["--native-alias", "off", "--native-alias"],
    ["--native-alias=off", "--native-alias=on"], ["--image-input"], ["--image-input", "yes"],
    ["--image-input=auto", "--image-input=disabled"], ["--reasoning-effort-mode", "force"],
    ["--reasoning-effort-mode=strict", "--reasoning-effort-mode=adaptive"], ["--targets-file"],
    ["--targets-file=a", "--targets-file=b"],
  ]) test(`invalid new option refuses: ${args.join(" ")}`, async () => {
    await expect(prepareComboInput([...args])).rejects.toThrow();
  });
  test("file source conflicts are refused before reading stdin", async () => {
    for (const old of [["--targets", "fixture/m"], ["--targets=fixture/m"]]) {
      const stdin = new Readable({ read() { throw new Error("stdin must not be read"); } });
      await expect(prepareComboInput(["--targets-file", "-", ...old], { stdinImpl: stdin }))
        .rejects.toThrow("cannot be combined");
      expect(stdin.listenerCount("data")).toBe(0);
      stdin.destroy();
    }
  });
  test("validates scalar options before reading the targets file", async () => {
    await expect(prepareComboInput(["--targets-file", "unread-path", "--image-input", "bad"]))
      .rejects.toThrow("--image-input must be");
  });
  test("target files retain ordering, raw slashes, false, effort set and profile", async () => {
    const targets = [{ ...target, lastResort: false, weight: 3, reasoningEfforts: ["ultra", "low"], modelProfile: "Code\nreview\tprofile" }, { provider: "second", model: "raw" }];
    expect(await prepareComboInput(["--targets-file", file(targets)])).toEqual({ targets });
  });
  test("explicit piped JSON input uses the bounded shared reader", async () => {
    const stdin = Readable.from([Buffer.from(JSON.stringify([target]))]);
    expect(await prepareComboInput(["--targets-file=-"], { stdinImpl: stdin })).toEqual({ targets: [target] });
  });
  for (const value of [null, {}, [], [null], [[target]], [{ ...target, extra: "hidden" }],
    [{ ...target, provider: " " }], [{ ...target, model: "" }], [{ ...target, model: "bad\u0000" }],
    [{ ...target, weight: 0 }], [{ ...target, weight: 10001 }], [{ ...target, weight: 1.5 }],
    [{ ...target, weight: "2" }], [{ ...target, lastResort: "false" }], [{ ...target, lastResort: null }],
    [{ ...target, reasoningEfforts: [] }], [{ ...target, reasoningEfforts: ["high", "high"] }],
    [{ ...target, reasoningEfforts: ["none"] }], [{ ...target, reasoningEfforts: ["minimal"] }],
    [{ ...target, reasoningEfforts: "high" }], [{ ...target, modelProfile: " " }],
    [{ ...target, modelProfile: "x".repeat(513) }], [{ ...target, modelProfile: "bad\u0001" }],
  ].entries()) {
    test(`refuses malformed target document ${value[0]}`, async () => {
      await expect(prepareComboInput(["--targets-file", file(value[1])])).rejects.toThrow();
    });
  }
});

function realRuntime(refresh: CatalogDisposition = { status: "committed", changed: false, degraded: false, notices: [] }) {
  const config: OcxConfig = {
    port: 10100, defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", models: ["org/raw/model", "second"] } },
    combos: { saved: { strategy: "failover", targets: [{ ...target, weight: 2, reasoningEfforts: ["high"], modelProfile: "kept profile", lastResort: true }, { provider: "fixture", model: "second" }],
      imageInput: "disabled", reasoningEffortMode: "adaptive", defaultEffortMode: "force", defaultEffort: "high" } },
  };
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  let resolutions = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => ({ pid: null, port: 14000 + ++resolutions, source: "runtime" }),
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      const req = new Request(String(input), init);
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      calls.push({ url: req.url, method: req.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (new URL(req.url).pathname !== "/api/combos") throw new Error("Only combo management requests allowed");
      const result = await handleComboRoutes({ req, url: new URL(req.url), config, deps: {}, version: "fixture",
        trustedLoopbackIngress: true, guiSessionIssuance: null,
        convergeCodexCatalog: async () => refresh,
        syncClaudeAgentDefsBestEffort: async () => {},
      });
      if (!result) throw new Error("Missing combo fixture response");
      return result;
    }) as typeof fetch,
  };
  return { config, calls, deps, resolutions: () => resolutions };
}

describe("integrated combo extension and actual management persistence", () => {
  test("a target-file replacement preserves unrelated strategy and public identity", async () => {
    const f = realRuntime();
    Object.assign(f.config.combos!.saved!, { strategy: "round-robin", stickyLimit: 3, alias: "my-combo", displayName: "My combo" });
    expect(await handleComboCommand(["set", "saved", "--targets-file", file([target]), "--json"], f.deps)).toBe(0);
    expect(f.config.combos!.saved).toMatchObject({ strategy: "round-robin", stickyLimit: 3,
      alias: "my-combo", displayName: "My combo", defaultEffort: "high", defaultEffortMode: "force" });
    expect(f.config.combos!.saved!.targets).toHaveLength(1);
  });
  test("explicit auto/strict reset survives both CLI and server merges without resetting default effort policy", async () => {
    const f = realRuntime();
    expect(await handleComboCommand(["set", "saved", "--image-input", "auto", "--reasoning-effort-mode", "strict", "--json"], f.deps)).toBe(0);
    expect(f.calls.map(call => call.method)).toEqual(["GET", "PUT"]);
    expect(f.resolutions()).toBe(1);
    expect(new Set(f.calls.map(call => new URL(call.url).origin)).size).toBe(1);
    const saved = JSON.parse(readFileSync(home.path("config.json"), "utf8")).combos.saved;
    expect(saved).not.toHaveProperty("imageInput");
    expect(saved).not.toHaveProperty("reasoningEffortMode");
    expect(saved.defaultEffortMode).toBe("force");
    expect(saved.targets[0]).toMatchObject({ model: "org/raw/model", reasoningEfforts: ["high"], modelProfile: "kept profile", lastResort: true });
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).catalogRefresh.status).toBe("committed");
  });
  test("replacement target file preserves explicit lastResort false while omitted flags carry", async () => {
    const f = realRuntime();
    const targets = [{ ...target, lastResort: false, reasoningEfforts: ["low", "ultra"], modelProfile: "new profile" }, { provider: "fixture", model: "second" }];
    expect(await handleComboCommand(["set", "saved", "--targets-file", file(targets), "--json"], f.deps)).toBe(0);
    expect(f.config.combos!.saved!.targets[0]).not.toHaveProperty("lastResort");
    expect(f.config.combos!.saved!.targets[0]).toMatchObject({ reasoningEfforts: ["low", "ultra"], modelProfile: "new profile" });
    expect(f.config.combos!.saved).toMatchObject({ imageInput: "disabled", reasoningEffortMode: "adaptive", defaultEffortMode: "force" });
  });
  test("omitting lastResort in replacement file retains existing server policy", async () => {
    const f = realRuntime();
    expect(await handleComboCommand(["set", "saved", "--targets-file", file([target, { provider: "fixture", model: "second" }]), "--json"], f.deps)).toBe(0);
    expect(f.config.combos!.saved!.targets[0]!.lastResort).toBe(true);
  });
  test("native alias off plus explicit alias clear removes saved native identity", async () => {
    const f = realRuntime();
    f.config.combos!.saved!.nativeAlias = true;
    f.config.combos!.saved!.alias = "gpt-6-astra";
    expect(await handleComboCommand(["set", "saved", "--native-alias", "off", "--alias", "-", "--json"], f.deps)).toBe(0);
    expect(f.config.combos!.saved).not.toHaveProperty("nativeAlias");
    expect(f.config.combos!.saved).not.toHaveProperty("alias");
  });
  test("native alias off with incompatible retained alias is refused without clearing it", async () => {
    const f = realRuntime();
    f.config.combos!.saved!.nativeAlias = true;
    f.config.combos!.saved!.alias = "gpt-6-astra";
    expect(await handleComboCommand(["set", "saved", "--native-alias", "off", "--json"], f.deps)).toBe(1);
    expect(f.config.combos!.saved).toMatchObject({ alias: "gpt-6-astra", nativeAlias: true });
    expect(output).not.toHaveBeenCalled();
  });
  test("invalid extension refuses before liveness or any HTTP read", async () => {
    const f = realRuntime();
    expect(await handleComboCommand(["set", "saved", "--targets-file", "not-read", "--targets", "fixture/m", "--json"], f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
    expect(f.resolutions()).toBe(0);
  });
  test("saved combo with degraded convergence returns a numeric failure and the saved receipt", async () => {
    const f = realRuntime({ status: "committed", changed: true, degraded: true, notices: [] });
    expect(await handleComboCommand(["set", "saved", "--image-input", "auto", "--json"], f.deps)).toBe(1);
    expect(f.config.combos!.saved).not.toHaveProperty("imageInput");
    expect(JSON.parse(String(output.mock.calls[0]?.[0])).catalogRefresh).toMatchObject({ status: "committed", degraded: true });
  });
});
