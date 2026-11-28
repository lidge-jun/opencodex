import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyMultiAgentMode, type RawEntry } from "../../src/codex/catalog/parsing";
import { isMultiAgentV2Enabled } from "../../src/codex/features";
import { loadConfig } from "../../src/config";
import {
  MULTI_AGENT_MODE_BY_MODEL_LIMIT,
  isPlaintextV2AgentMessagesEnabled,
  isPlaintextV2AgentMessagesEnabledForModel,
  multiAgentPinsRequireGlobalV2Disabled,
  resolveMultiAgentModeByModel,
  resolveMultiAgentModeForModel,
  unmatchedMultiAgentModelModes,
} from "../../src/config/multi-agent-surface";
import { handleManagementAPI } from "../../src/server/management-api";
import type { MultiAgentModelMode } from "../../src/types/multi-agent";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const modes = (entries: Record<string, MultiAgentModelMode>) => new Map(Object.entries(entries));
const pins = (entries: RawEntry[]) => Object.fromEntries(entries.map(entry => [entry.slug, entry.multi_agent_version ?? null]));

describe("multiAgentModeByModel catalog pins (#8953)", () => {
  // The reporter's setup: native models on plaintext v2, one routed parent that works on v2,
  // and one routed GPT parent whose v2 child tasks arrive encrypted.
  test("a listed model keeps its own pin under every global mode", () => {
    const modelModes = modes({ "ZQ/gpt-6.2-sol": "v1", "opencode-go/deepseek-v4.1-flash": "v2", "gpt-6.2-sol": "v2-plaintext" });
    for (const mode of ["v1", "v2", "v2-plaintext", "default"] as const) {
      const entries: RawEntry[] = [
        { slug: "gpt-6.2-sol" }, { slug: "ZQ/gpt-6.2-sol" }, { slug: "opencode-go/deepseek-v4.1-flash" },
      ];
      applyMultiAgentMode(entries, mode, false, { modelModes });
      expect(pins(entries)).toEqual({ "gpt-6.2-sol": "v2", "ZQ/gpt-6.2-sol": "v1", "opencode-go/deepseek-v4.1-flash": "v2" });
    }
  });

  test("models without an entry follow the global mode", () => {
    const entries: RawEntry[] = [{ slug: "gpt-6.2-sol" }, { slug: "xai/grok-4.7" }, { slug: "ZQ/gpt-6.2-sol" }];
    applyMultiAgentMode(entries, "v2", false, { modelModes: modes({ "ZQ/gpt-6.2-sol": "v1" }) });
    expect(pins(entries)).toEqual({ "gpt-6.2-sol": "v2", "xai/grok-4.7": "v2", "ZQ/gpt-6.2-sol": "v1" });
  });

  test("an entry outranks the native/routed hybrid", () => {
    const entries: RawEntry[] = [{ slug: "gpt-6.2-sol" }, { slug: "gpt-6.1-terra" }, { slug: "xai/grok-4.7" }];
    applyMultiAgentMode(entries, "v2", false, {
      keepNativeChatGptOnV1: true,
      modelModes: modes({ "gpt-6.2-sol": "v2-plaintext", "xai/grok-4.7": "v1" }),
    });
    expect(pins(entries)).toEqual({ "gpt-6.2-sol": "v2", "gpt-6.1-terra": "v1", "xai/grok-4.7": "v1" });
  });

  test("the plaintext literal is never written as a Codex pin", () => {
    const entries: RawEntry[] = [{ slug: "gpt-6.2-sol" }];
    applyMultiAgentMode(entries, "v1", false, { modelModes: modes({ "gpt-6.2-sol": "v2-plaintext" }) });
    expect(entries[0]!.multi_agent_version).toBe("v2");
  });

  test("a routed slug matches in its raw or encoded spelling", () => {
    const entries: RawEntry[] = [{ slug: "openrouter/anthropic-claude-opus" }];
    applyMultiAgentMode(entries, "v1", false, { modelModes: modes({ "openrouter/anthropic/claude-opus": "v2" }) });
    expect(entries[0]!.multi_agent_version).toBe("v2");
  });

  test("removing an entry under default mode restores the row it overrode", () => {
    const pinned: RawEntry[] = [{ slug: "gpt-5.6-luna", multi_agent_version: "v1" }, { slug: "xai/grok-4.7" }];
    const modelModes = modes({ "gpt-5.6-luna": "v2", "xai/grok-4.7": "v2" });
    applyMultiAgentMode(pinned, "default", false, { modelModes });
    // A second sync with the entry still present must not lose the original.
    applyMultiAgentMode(pinned, "default", false, { modelModes });
    expect(pins(pinned)).toEqual({ "gpt-5.6-luna": "v2", "xai/grok-4.7": "v2" });
    applyMultiAgentMode(pinned, "default", false, {});
    expect(pins(pinned)).toEqual({ "gpt-5.6-luna": "v1", "xai/grok-4.7": null });
  });
});

describe("multiAgentModeByModel resolution", () => {
  const config = (value: unknown, rest: Partial<OcxConfig> = {}) => ({ ...rest, multiAgentModeByModel: value }) as OcxConfig;

  test("unusable keys and values drop only their own entry", () => {
    const resolved = resolveMultiAgentModeByModel(config({
      "gpt-6.2-sol": "v2-plaintext", "xai/grok-4.7": "default", " padded": "v1", "": "v1", "ZQ/gpt-6.2-sol": 1,
      "opencode-go/deepseek-v4.1-flash": "v2",
    }));
    expect([...resolved]).toEqual([["gpt-6.2-sol", "v2-plaintext"], ["opencode-go/deepseek-v4.1-flash", "v2"]]);
    for (const malformed of [null, [], "v1", 3]) expect(resolveMultiAgentModeByModel(config(malformed)).size).toBe(0);
  });

  test("the map is bounded", () => {
    const many = Object.fromEntries(Array.from({ length: MULTI_AGENT_MODE_BY_MODEL_LIMIT + 5 }, (_, i) => [`p/m-${i}`, "v1"]));
    expect(resolveMultiAgentModeByModel(config(many)).size).toBe(MULTI_AGENT_MODE_BY_MODEL_LIMIT);
  });

  test("a model resolves to its entry, else to the global mode", () => {
    const stored = config({ "ZQ/gpt-6.2-sol": "v1" }, { multiAgentMode: "v2-plaintext" });
    expect(resolveMultiAgentModeForModel(stored, "ZQ/gpt-6.2-sol")).toBe("v1");
    expect(resolveMultiAgentModeForModel(stored, "gpt-6.2-sol")).toBe("v2-plaintext");
    expect(resolveMultiAgentModeForModel(stored, undefined)).toBe("v2-plaintext");
  });

  test("an entry that names no catalog row is reported, in either slug spelling", () => {
    const catalog = ["gpt-6.2-sol", "openrouter/anthropic-claude-opus"];
    expect(unmatchedMultiAgentModelModes(["gpt-6.2-sol", "openrouter/anthropic/claude-opus", "gpt-6.2-so1", "xai/grok-4.7"], catalog))
      .toEqual(["gpt-6.2-so1", "xai/grok-4.7"]);
  });

  test("only a v1 entry needs the global override off", () => {
    expect(multiAgentPinsRequireGlobalV2Disabled(config({ "xai/grok-4.7": "v2", "gpt-6.2-sol": "v2-plaintext" }, { multiAgentMode: "v2" }))).toBe(false);
    for (const multiAgentMode of ["v1", "v2", undefined] as const) {
      expect(multiAgentPinsRequireGlobalV2Disabled(config({ "ZQ/gpt-6.2-sol": "v1" }, { multiAgentMode }))).toBe(true);
    }
  });
});

describe("plaintext delivery per model", () => {
  const config = (overrides: Partial<OcxConfig>) => overrides as OcxConfig;

  test("one model can opt in while the global mode stays v1", () => {
    const stored = config({ multiAgentMode: "v1", multiAgentModeByModel: { "gpt-6.2-sol": "v2-plaintext" } });
    expect(isPlaintextV2AgentMessagesEnabled(stored)).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, "gpt-6.2-sol")).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, "gpt-6.2-terra")).toBe(false);
  });

  test("a model moved off plaintext is not compiled under the plaintext mode", () => {
    const stored = config({ multiAgentMode: "v2-plaintext", multiAgentModeByModel: { "gpt-6.2-terra": "v2", "gpt-5.6-luna": "v1" } });
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, "gpt-6.2-sol")).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, "gpt-6.2-terra")).toBe(false);
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, "gpt-5.6-luna")).toBe(false);
  });

  test("the legacy flag still covers every model", () => {
    const stored = config({ multiAgentMode: "v1", plaintextV2AgentMessages: true, multiAgentModeByModel: { "gpt-6.2-terra": "v2" } });
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, "gpt-6.2-terra")).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, undefined)).toBe(true);
  });

  test("no entry and no plaintext mode leaves plaintext off", () => {
    const stored = config({ multiAgentMode: "v2", multiAgentModeByModel: { "xai/grok-4.7": "v1" } });
    expect(isPlaintextV2AgentMessagesEnabled(stored)).toBe(false);
    expect(isPlaintextV2AgentMessagesEnabledForModel(stored, "gpt-6.2-sol")).toBe(false);
  });
});

describe("/api/v2 multiAgentModeByModel", () => {
  let home: TempHome | undefined;
  afterEach(() => {
    home?.remove();
    home = undefined;
  });

  const url = () => new URL("http://localhost/api/v2");
  const put = (body: unknown) => new Request("http://localhost/api/v2", {
    method: "PUT", headers: { "content-type": "application/json", Host: "localhost" }, body: JSON.stringify(body),
  });
  const get = () => new Request("http://localhost/api/v2", { headers: { Host: "localhost" } });
  const liveConfig = (extra: Partial<OcxConfig> = {}) =>
    ({ providers: {}, hostname: "127.0.0.1", port: 10100, defaultProvider: "openai", ...extra }) as OcxConfig;

  /** A Codex home whose global override starts in the given state, and a toggle that flips it. */
  function codexHome(enabled: boolean) {
    home = createTempHome("ocx-mode-by-model-");
    mkdirSync(home.codexHome, { recursive: true });
    const codexConfig = join(process.env.CODEX_HOME!, "config.toml");
    writeFileSync(codexConfig, `[features.multi_agent_v2]\nenabled = ${enabled}\n`);
    const toggles: boolean[] = [];
    return {
      codexConfig, toggles,
      deps: {
        createManagementConvergeCodex: catalogConvergenceFactory(),
        toggleCodexMultiAgentV2: (next: boolean) => {
          toggles.push(next);
          writeFileSync(codexConfig, readFileSync(codexConfig, "utf8").replace(`enabled = ${!next}`, `enabled = ${next}`));
        },
      },
    };
  }
  const refusing = {
    createManagementConvergeCodex: catalogConvergenceFactory(() => { throw new Error("must not converge"); }),
    toggleCodexMultiAgentV2: () => { throw new Error("must not toggle"); },
  };

  test("a patch sets, replaces and removes entries, and GET reports them", async () => {
    const { deps } = codexHome(false);
    const config = liveConfig({ multiAgentMode: "v1" });
    const set = await handleManagementAPI(put({ multiAgentModeByModel: { "opencode-go/deepseek-v4.1-flash": "v2", "xai/grok-4.7": "v2" } }), url(), config, deps);
    expect(set?.status).toBe(200);
    expect(await set?.json()).toMatchObject({
      multiAgentMode: "v1", multiAgentModeByModel: { "opencode-go/deepseek-v4.1-flash": "v2", "xai/grok-4.7": "v2" },
    });
    const patched = await handleManagementAPI(put({ multiAgentModeByModel: { "xai/grok-4.7": null, "ZQ/gpt-6.2-sol": "v1" } }), url(), config, deps);
    expect(patched?.status).toBe(200);
    const expected = { "opencode-go/deepseek-v4.1-flash": "v2", "ZQ/gpt-6.2-sol": "v1" };
    expect((await (await handleManagementAPI(get(), url(), config, deps))?.json() as Record<string, unknown>).multiAgentModeByModel).toEqual(expected);
    expect(loadConfig().multiAgentModeByModel).toEqual(expected);

    const cleared = await handleManagementAPI(put({ multiAgentModeByModel: null }), url(), config, deps);
    expect(cleared?.status).toBe(200);
    expect(Object.hasOwn(loadConfig(), "multiAgentModeByModel")).toBe(false);
  });

  test("a v1 entry under mode v2 turns the global override off, like the native hybrid", async () => {
    const { codexConfig, toggles, deps } = codexHome(true);
    const config = liveConfig({ multiAgentMode: "v2" });
    const response = await handleManagementAPI(put({ multiAgentModeByModel: { "ZQ/gpt-6.2-sol": "v1" } }), url(), config, deps);
    expect(response?.status).toBe(200);
    expect(toggles).toEqual([false]);
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(false);
    expect(await response?.json()).toMatchObject({ enabled: false, multiAgentMode: "v2", multiAgentModeByModel: { "ZQ/gpt-6.2-sol": "v1" } });

    // The override cannot come back while the entry is stored, in either request shape.
    for (const body of [{ enabled: true }, { multiAgentMode: "v2", enabled: true }]) {
      const conflict = await handleManagementAPI(put(body), url(), config, refusing);
      expect(conflict?.status).toBe(400);
      expect(await conflict?.json()).toEqual({
        error: "body.enabled=true conflicts with a 'v1' entry in multiAgentModeByModel: Codex's global multi_agent_v2 override outranks catalog pins",
      });
    }
    // Re-selecting v2 keeps the surface pin-driven instead of re-enabling the override.
    const reselect = await handleManagementAPI(put({ multiAgentMode: "v2" }), url(), config, deps);
    expect(reselect?.status).toBe(200);
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(false);
  });

  test("v2 and v2-plaintext entries leave the global override alone", async () => {
    const { codexConfig, toggles, deps } = codexHome(true);
    const config = liveConfig({ multiAgentMode: "v2" });
    const response = await handleManagementAPI(
      put({ multiAgentModeByModel: { "xai/grok-4.7": "v2", "gpt-6.2-sol": "v2-plaintext" }, plaintextAgentMessagesAcknowledged: true }),
      url(), config, deps,
    );
    expect(response?.status).toBe(200);
    expect(toggles).toEqual([]);
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(true);
  });

  test("base mode refuses a v1 entry while the operator's override is on, and accepts it with enabled=false", async () => {
    const { codexConfig, toggles, deps } = codexHome(true);
    const config = liveConfig();
    const refused = await handleManagementAPI(put({ multiAgentModeByModel: { "ZQ/gpt-6.2-sol": "v1" } }), url(), config, refusing);
    expect(refused?.status).toBe(400);
    expect(await refused?.json()).toEqual({
      error: "body.multiAgentModeByModel 'v1' needs Codex's global multi_agent_v2 override off, and base mode leaves that override to you: send enabled=false with it, or select multiAgentMode 'v1', 'v2' or 'v2-plaintext' first",
    });
    expect(config.multiAgentModeByModel).toBeUndefined();
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(true);

    const accepted = await handleManagementAPI(put({ multiAgentModeByModel: { "ZQ/gpt-6.2-sol": "v1" }, enabled: false }), url(), config, deps);
    expect(accepted?.status).toBe(200);
    expect(toggles).toEqual([false]);
    expect(loadConfig().multiAgentModeByModel).toEqual({ "ZQ/gpt-6.2-sol": "v1" });
  });

  test("a new v2-plaintext entry needs the plaintext acknowledgement; re-saving it does not", async () => {
    const { deps } = codexHome(false);
    const config = liveConfig({ multiAgentMode: "v1" });
    const refused = await handleManagementAPI(put({ multiAgentModeByModel: { "gpt-6.2-sol": "v2-plaintext" } }), url(), config, refusing);
    expect(refused?.status).toBe(400);
    expect(await refused?.json()).toEqual({
      error: "body.multiAgentModeByModel 'v2-plaintext' requires plaintextAgentMessagesAcknowledged === true: that model's native v2 collaboration messages are delivered as plaintext on the canonical ChatGPT route",
    });
    expect(config.multiAgentModeByModel).toBeUndefined();

    const entered = await handleManagementAPI(
      put({ multiAgentModeByModel: { "gpt-6.2-sol": "v2-plaintext" }, plaintextAgentMessagesAcknowledged: true }), url(), config, deps);
    expect(entered?.status).toBe(200);
    expect(await entered?.json()).toMatchObject({ multiAgentMode: "v1", plaintextAgentMessagesEnabled: true });
    const resaved = await handleManagementAPI(put({ multiAgentModeByModel: { "gpt-6.2-sol": "v2-plaintext", "xai/grok-4.7": "v2" } }), url(), config, deps);
    expect(resaved?.status).toBe(200);
  });

  test("a malformed patch is rejected before anything is written", async () => {
    codexHome(false);
    const config = liveConfig({ multiAgentMode: "v1", multiAgentModeByModel: { "xai/grok-4.7": "v2" } });
    for (const [patch, error] of [
      [["xai/grok-4.7"], "body.multiAgentModeByModel must be an object or null"],
      [{ "xai/grok-4.7": "default" }, "body.multiAgentModeByModel values must be 'v1', 'v2', 'v2-plaintext', or null"],
      [{ " xai/grok-4.7": "v1" }, "body.multiAgentModeByModel keys must be trimmed, non-empty model ids"],
    ] as const) {
      const response = await handleManagementAPI(put({ multiAgentModeByModel: patch }), url(), config, refusing);
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error });
    }
    expect(config.multiAgentModeByModel).toEqual({ "xai/grok-4.7": "v2" });
  });
});
