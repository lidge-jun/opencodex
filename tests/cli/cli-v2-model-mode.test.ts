import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdV2, type V2CliDeps } from "../../src/cli/v2";
import { CliUsageError } from "../../src/cli/runtime-api";
import { parseV2Command } from "../../src/cli/v2-input";
import { isMultiAgentV2Enabled } from "../../src/codex/features";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const acknowledge = "--acknowledge-plaintext-agent-messages";
let home: TempHome, configPath: string, nativePath: string, lines: string[], errors: string[], calls: string[];
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
const syncResult = { status: "applied", ok: true, catalogExists: true, catalogWritten: false,
  cacheSynced: false, added: 0, catalogPath: null, message: "fixture", refreshOutcome: "committed" };
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
const lastJson = () => JSON.parse(lines.at(-1)!);
function deps(): V2CliDeps {
  return { featuresInvocation: action => ({ file: "fixture-codex", args: ["features", action, "multi_agent_v2"], options: {} }),
    execFile: (_file, args) => { calls.push(args[1]!);
      writeFileSync(nativePath, readFileSync(nativePath, "utf8").replace(/^enabled = (true|false)$/m, `enabled = ${args[1] === "enable"}`)); },
    sync: async () => syncResult };
}
function install(config: Record<string, unknown>, globalV2: boolean): void {
  writeFileSync(configPath, JSON.stringify({ providers: {}, defaultProvider: "openai", ...config }));
  writeFileSync(nativePath, `[features.multi_agent_v2]\nenabled = ${globalV2}\n`);
}
beforeEach(() => {
  home = createTempHome("ocx-cli-model-mode-"); mkdirSync(home.codexHome);
  process.env.OPENCODEX_HOME = home.path(".opencodex"); mkdirSync(process.env.OPENCODEX_HOME);
  configPath = join(process.env.OPENCODEX_HOME, "config.json"); nativePath = join(home.codexHome, "config.toml");
  lines = []; errors = []; calls = [];
  log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  error = spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a.join(" ")); });
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network denied"); });
});
afterEach(() => { log.mockRestore(); error.mockRestore(); network.mockRestore(); home.remove(); });

describe("ocx v2 model-mode (#8953)", () => {
  test("parses a model id verbatim and maps default to removal", () => {
    expect(parseV2Command(["model-mode", "ZQ/gpt-6.2-sol", "V1"])).toMatchObject({ verb: "model-mode", model: "ZQ/gpt-6.2-sol", value: "v1" });
    expect(parseV2Command(["model-mode", "gpt-6.2-sol", "default", "--live"])).toMatchObject({ model: "gpt-6.2-sol", value: null, live: true });
    for (const argv of [["model-mode", "gpt-6.2-sol"], ["model-mode", "gpt-6.2-sol", "v3"], ["model-mode", " ", "v1"],
      ["model-mode", "gpt-6.2-sol", "v2", acknowledge], ["mode", "v1", acknowledge]]) {
      expect(() => parseV2Command(argv)).toThrow(CliUsageError);
    }
  });

  test("the reporter's setup: mode v2-plaintext with one routed parent on v1", async () => {
    install({ multiAgentMode: "v2-plaintext" }, false);
    expect(await cmdV2(["model-mode", "ZQ/gpt-6.2-sol", "v1", "--json"], deps())).toBe(0);
    expect(readConfig()).toMatchObject({ multiAgentMode: "v2-plaintext", multiAgentModeByModel: { "ZQ/gpt-6.2-sol": "v1" } });
    expect(lastJson()).toMatchObject({ ok: true, action: "model-mode", changed: true,
      state: { enabled: false, multiAgentMode: "v2-plaintext", multiAgentModeByModel: { "ZQ/gpt-6.2-sol": "v1" } } });

    expect(await cmdV2(["status"], deps())).toBe(0);
    expect(lines).toContain("  ZQ/gpt-6.2-sol: v1");

    expect(await cmdV2(["model-mode", "ZQ/gpt-6.2-sol", "default", "--json"], deps())).toBe(0);
    expect(Object.hasOwn(readConfig(), "multiAgentModeByModel")).toBe(false);
  });

  test("a v1 entry under mode v2 turns the global override off and keeps it off", async () => {
    install({ multiAgentMode: "v2" }, true);
    expect(await cmdV2(["model-mode", "ZQ/gpt-6.2-sol", "v1", "--json"], deps())).toBe(0);
    expect(calls).toEqual(["disable"]);
    expect(isMultiAgentV2Enabled()).toBe(false);

    expect(await cmdV2(["on"], deps())).toBe(1);
    expect(errors.at(-1)).toContain("incompatible with a v1 model-mode entry");
    expect(await cmdV2(["mode", "v2", "--json"], deps())).toBe(0);
    expect(isMultiAgentV2Enabled()).toBe(false);

    // Once the entry is gone the override is the operator's to turn back on.
    expect(await cmdV2(["model-mode", "ZQ/gpt-6.2-sol", "default", "--json"], deps())).toBe(0);
    expect(await cmdV2(["on", "--json"], deps())).toBe(0);
    expect(isMultiAgentV2Enabled()).toBe(true);
  });

  test("base mode refuses a v1 entry while the override is on and writes nothing", async () => {
    install({}, true);
    const before = readFileSync(configPath, "utf8");
    expect(await cmdV2(["model-mode", "ZQ/gpt-6.2-sol", "v1"], deps())).toBe(1);
    expect(errors.at(-1)).toContain("base mode leaves that override to you");
    expect(calls).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(isMultiAgentV2Enabled()).toBe(true);
  });

  test("an id that matches no catalog model is stored and called out", async () => {
    install({ multiAgentMode: "v1" }, false);
    writeFileSync(join(home.codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "xai/grok-4.7" }, { slug: "gpt-6.2-sol" }] }));
    expect(await cmdV2(["model-mode", "xai/grok-4.7", "v2"], deps())).toBe(0);
    expect(lines.join("\n")).not.toContain("No catalog model matches");
    expect(await cmdV2(["model-mode", "xai/grok-47", "v2"], deps())).toBe(0);
    expect(lines.at(-1)).toContain("No catalog model matches 'xai/grok-47'");
    expect(readConfig().multiAgentModeByModel).toEqual({ "xai/grok-4.7": "v2", "xai/grok-47": "v2" });
  });

  test("a v2-plaintext entry needs the acknowledgement once", async () => {
    install({ multiAgentMode: "v1" }, false);
    const before = readFileSync(configPath, "utf8");
    expect(await cmdV2(["model-mode", "gpt-6.2-sol", "v2-plaintext", "--json"], deps())).toBe(1);
    expect(readFileSync(configPath, "utf8")).toBe(before);

    expect(await cmdV2(["model-mode", "gpt-6.2-sol", "v2-plaintext", acknowledge, "--json"], deps())).toBe(0);
    expect(lastJson().state).toMatchObject({ multiAgentMode: "v1", plaintextAgentMessagesEnabled: true,
      multiAgentModeByModel: { "gpt-6.2-sol": "v2-plaintext" } });
    expect(await cmdV2(["model-mode", "gpt-6.2-sol", "v2-plaintext", "--json"], deps())).toBe(0);
    expect(lastJson().changed).toBe(false);
  });
});
