import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdV2, type V2CliDeps } from "../../src/cli/v2";
import { parseV2Command } from "../../src/cli/v2-input";
import { isMultiAgentV2Enabled } from "../../src/codex/features";
import { MULTI_AGENT_MODE_HINT_RECOMMENDATION } from "../../src/codex/multi-agent-mode-policy";
import { SUBAGENT_SURFACE_GUIDE_URL } from "../../src/config/multi-agent-surface";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const acknowledge = "--acknowledge-plaintext-agent-messages";
let home: TempHome, configPath: string, nativePath: string, lines: string[], calls: string[];
let log: ReturnType<typeof spyOn>, error: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
const syncResult = { status: "applied", ok: true, catalogExists: true, catalogWritten: false,
  cacheSynced: false, added: 0, catalogPath: null, message: "fixture", refreshOutcome: "committed" };
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
function deps(fail = false): V2CliDeps {
  return { featuresInvocation: action => ({ file: "fixture-codex", args: ["features", action, "multi_agent_v2"], options: {} }),
    execFile: (_file, args) => { calls.push(args[1]!); if (fail) throw new Error("fixture feature failure");
      writeFileSync(nativePath, readFileSync(nativePath, "utf8").replace(/^enabled = (true|false)$/m, `enabled = ${args[1] === "enable"}`)); },
    sync: async () => syncResult };
}
beforeEach(() => {
  home = createTempHome("ocx-cli-plaintext-v2-"); mkdirSync(home.codexHome);
  process.env.OPENCODEX_HOME = home.path(".opencodex"); mkdirSync(process.env.OPENCODEX_HOME);
  configPath = join(process.env.OPENCODEX_HOME, "config.json"); nativePath = join(home.codexHome, "config.toml");
  writeFileSync(configPath, JSON.stringify({ providers: {}, defaultProvider: "openai", multiAgentMode: "v2",
    keepNativeChatGptOnV1: true, plaintextV2AgentMessages: false }));
  writeFileSync(nativePath, "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 17\n");
  lines = []; calls = [];
  log = spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  error = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network denied"); });
});
afterEach(() => { log.mockRestore(); error.mockRestore(); network.mockRestore(); home.remove(); });

describe("explicit plaintext V2 CLI", () => {
  test("missing acknowledgment changes neither native nor proxy state", async () => {
    const native = readFileSync(nativePath, "utf8"), config = readFileSync(configPath, "utf8");
    expect(await cmdV2(["mode", "v2-plaintext", "--json"], deps())).toBe(1);
    expect(calls).toEqual([]); expect(readFileSync(nativePath, "utf8")).toBe(native);
    expect(readFileSync(configPath, "utf8")).toBe(config);
  });
  test("selects catalog V2 without global override and preserves independent preferences", async () => {
    expect(await cmdV2(["mode", "v2-plaintext", acknowledge, "--json"], deps())).toBe(0);
    expect(isMultiAgentV2Enabled()).toBe(false);
    expect(readConfig()).toMatchObject({ multiAgentMode: "v2-plaintext", keepNativeChatGptOnV1: true, plaintextV2AgentMessages: false });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ ok: true, state: { enabled: false,
      multiAgentMode: "v2-plaintext", plaintextAgentMessagesEnabled: true, supportsPlaintextV2Mode: true,
      maxConcurrentThreadsPerSession: 16, agentsMaxDepthAppliesWhenV2Disabled: false } });
    expect(await cmdV2(["mode", "v2-plaintext", "--json"], deps())).toBe(0);
    expect(await cmdV2(["on", "--json"], deps())).toBe(1);
    expect(isMultiAgentV2Enabled()).toBe(false);
    expect(await cmdV2(["mode", "v1", "--json"], deps())).toBe(0);
    expect(readConfig()).toMatchObject({ multiAgentMode: "v1", keepNativeChatGptOnV1: true, plaintextV2AgentMessages: false });
    expect(JSON.parse(lines.at(-1)!).state.plaintextAgentMessagesEnabled).toBe(false);
  });
  test("failed native transition does not select the new mode", async () => {
    const native = readFileSync(nativePath, "utf8"), config = readFileSync(configPath, "utf8");
    expect(await cmdV2(["mode", "v2-plaintext", acknowledge], deps(true))).toBe(1);
    expect(readFileSync(nativePath, "utf8")).toBe(native); expect(readFileSync(configPath, "utf8")).toBe(config);
  });
  test.each([["on", acknowledge], ["mode", "v1", acknowledge], ["mode", "v2-plaintext", acknowledge, acknowledge],
    ["mode", "v2-plaintext", `${acknowledge}=true`]])("refuses unrelated or ambiguous consent %j", args => {
    expect(() => parseV2Command(args)).toThrow(); expect(calls).toEqual([]);
  });
  test("live request sends scoped acknowledgment and verifies effective state", async () => {
    const sent: unknown[] = [], native = readFileSync(nativePath, "utf8");
    const response = { ok: true, enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "v2-plaintext",
      keepNativeChatGptOnV1: true, supportsPlaintextV2Mode: true, plaintextAgentMessagesEnabled: true,
      agentsMaxDepthAppliesWhenV2Disabled: false, agentsEnabled: null, agentsMaxDepth: null, maxConcurrentThreadsPerSession: 16,
      subagentDeveloperInstructions: null, multiAgentModeHintText: null, multiAgentModeHintRecommendation: MULTI_AGENT_MODE_HINT_RECOMMENDATION,
      multiAgentSurfaceAdvisory: { required: false, mode: "v2-plaintext", recommended: "v1", version: 1, docsUrl: SUBAGENT_SURFACE_GUIDE_URL },
      catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } };
    const runtimeApi = { baseUrl: "http://127.0.0.1:19300",
      fetchImpl: (async (_url: unknown, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return Response.json(response); }) as typeof fetch };
    expect(await cmdV2(["mode", "v2-plaintext", acknowledge, "--live", "--json"], { runtimeApi })).toBe(0);
    expect(sent).toEqual([{ multiAgentMode: "v2-plaintext", plaintextAgentMessagesAcknowledged: true }]);
    expect(readFileSync(nativePath, "utf8")).toBe(native); expect(readConfig().multiAgentMode).toBe("v2");
    response.plaintextAgentMessagesEnabled = false;
    expect(await cmdV2(["mode", "v2-plaintext", acknowledge, "--live"], { runtimeApi })).toBe(1);
    expect(sent).toHaveLength(2);
  });
});
