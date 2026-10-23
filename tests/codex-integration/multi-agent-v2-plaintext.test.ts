import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyMultiAgentMode, MULTI_AGENT_ORIGIN_FIELD, type RawEntry } from "../../src/codex/catalog/parsing";
import { isMultiAgentV2Enabled } from "../../src/codex/features";
import { loadConfig, saveConfig } from "../../src/config";
import {
  isPlaintextV2AgentMessagesEnabled,
  resolveMultiAgentMode,
} from "../../src/config/multi-agent-surface";
import { warnPlaintextV2AgentMessagesStartup } from "../../src/server/index/startup-warnings";
import { handleManagementAPI } from "../../src/server/management-api";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { OcxConfig } from "../../src/types";

let home: TempHome | undefined;

afterEach(() => {
  home?.remove();
  home = undefined;
});

function isolateHomes(): void {
  home = createTempHome("ocx-v2-plaintext-");
  mkdirSync(home.codexHome, { recursive: true });
}

function getV2(): Request {
  return new Request("http://localhost/api/v2", { headers: { Host: "localhost" } });
}

function putV2(body: unknown): Request {
  return new Request("http://localhost/api/v2", {
    method: "PUT",
    headers: { "content-type": "application/json", Host: "localhost" },
    body: JSON.stringify(body),
  });
}

function liveConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  return { providers: {}, hostname: "127.0.0.1", port: 10100, defaultProvider: "openai", ...extra } as OcxConfig;
}

function writeCodexFlag(enabled: boolean): string {
  const codexConfig = join(process.env.CODEX_HOME!, "config.toml");
  writeFileSync(codexConfig, `[features.multi_agent_v2]\nenabled = ${enabled}\n`);
  return codexConfig;
}

describe("v2-plaintext catalog pin", () => {
  test("stamps every row v2, ChatGPT-native rows included, and records origins", () => {
    const entries: RawEntry[] = [
      { slug: "gpt-5.6-sol" },
      { slug: "gpt-5.6-terra" },
      { slug: "xai/grok-4.6" },
      { slug: "anthropic/claude-fable-5" },
    ];
    applyMultiAgentMode(entries, "v2-plaintext");
    for (const entry of entries) {
      expect(entry.multi_agent_version).toBe("v2");
      expect(entry.multi_agent_version).not.toBe("v2-plaintext");
      expect(Object.hasOwn(entry, MULTI_AGENT_ORIGIN_FIELD)).toBe(true);
    }
  });

  test("a v2-plaintext -> default round trip uses the same recorded-origin contract as other forced modes", () => {
    // Native row absent from the baseline restores its recorded origin; a routed row
    // keeps default-mode normalization (same contract multi-agent-origin.test.ts asserts).
    const baseline = new Map<string, string | null>([["gpt-5.4", "v2"]]);
    const entries: RawEntry[] = [
      { slug: "gpt-6-luna", multi_agent_version: "v1" },
      { slug: "xai/grok-4.7", multi_agent_version: "v1" },
    ];
    applyMultiAgentMode(entries, "v2-plaintext");
    expect(entries[0]!.multi_agent_version).toBe("v2");
    expect(entries[1]!.multi_agent_version).toBe("v2");
    applyMultiAgentMode(entries, "default", false, { nativeDefaults: baseline });
    expect(entries[0]!.multi_agent_version).toBe("v1");
    expect(entries[0]).not.toHaveProperty(MULTI_AGENT_ORIGIN_FIELD);
    expect(entries[1]).not.toHaveProperty("multi_agent_version");
    expect(entries[1]).not.toHaveProperty(MULTI_AGENT_ORIGIN_FIELD);
  });

  test("keepNativeChatGptOnV1 does not split the v2-plaintext pass", () => {
    const entries: RawEntry[] = [{ slug: "gpt-5.6-sol" }];
    applyMultiAgentMode(entries, "v2-plaintext", false, { keepNativeChatGptOnV1: true });
    expect(entries[0]!.multi_agent_version).toBe("v2");
  });
});

describe("isPlaintextV2AgentMessagesEnabled", () => {
  test("the mode alone is an opt-in; the flag stays an independent opt-in", () => {
    expect(resolveMultiAgentMode({ multiAgentMode: "v2-plaintext" })).toBe("v2-plaintext");
    expect(resolveMultiAgentMode({ multiAgentMode: "bogus" as never })).toBe("default");

    expect(isPlaintextV2AgentMessagesEnabled({ multiAgentMode: "v2-plaintext" })).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabled({ multiAgentMode: "v2-plaintext", plaintextV2AgentMessages: false })).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabled({ plaintextV2AgentMessages: true })).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabled({ multiAgentMode: "v2", plaintextV2AgentMessages: true })).toBe(true);
    expect(isPlaintextV2AgentMessagesEnabled({ multiAgentMode: "v2" })).toBe(false);
    expect(isPlaintextV2AgentMessagesEnabled({})).toBe(false);
  });
});

describe("warnPlaintextV2AgentMessagesStartup", () => {
  test("the mode alone activates the same warning as the flag", () => {
    const warnings: string[] = [];
    const spy = console.warn;
    console.warn = (m?: unknown) => { warnings.push(String(m)); };
    try {
      warnPlaintextV2AgentMessagesStartup({});
      warnPlaintextV2AgentMessagesStartup({ plaintextV2AgentMessages: false });
      warnPlaintextV2AgentMessagesStartup({ multiAgentMode: "v2" });
      expect(warnings).toHaveLength(0);
      warnPlaintextV2AgentMessagesStartup({ multiAgentMode: "v2-plaintext" });
      warnPlaintextV2AgentMessagesStartup({ plaintextV2AgentMessages: true });
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.join("\n")).toContain("plaintext V2 agent messages");
    } finally {
      console.warn = spy;
    }
  });
});

describe("/api/v2 v2-plaintext", () => {
  const url = () => new URL("http://localhost/api/v2");

  test("entering the mode requires the per-request acknowledgement and writes nothing without it", async () => {
    isolateHomes();
    const codexConfig = writeCodexFlag(true);
    const config = liveConfig({ multiAgentMode: "v2" });
    const d = {
      createManagementConvergeCodex: catalogConvergenceFactory(() => { throw new Error("must not converge"); }),
      toggleCodexMultiAgentV2: () => { throw new Error("must not toggle"); },
    };

    const refused = await handleManagementAPI(putV2({ multiAgentMode: "v2-plaintext" }), url(), config, d);
    expect(refused?.status).toBe(400);
    expect(await refused?.json()).toEqual({
      error: "body.multiAgentMode 'v2-plaintext' requires plaintextAgentMessagesAcknowledged === true: native v2 collaboration messages are delivered as plaintext on the canonical ChatGPT route",
    });
    expect(config.multiAgentMode).toBe("v2");
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(true);
    expect(loadConfig().multiAgentMode).not.toBe("v2-plaintext");
  });

  test("ack enters the mode: flag disabled, pin-driven v2 saved, response advertises the plaintext contract", async () => {
    isolateHomes();
    const codexConfig = writeCodexFlag(true);
    const config = liveConfig();
    let toggled: boolean | undefined;
    const d = {
      createManagementConvergeCodex: catalogConvergenceFactory(),
      toggleCodexMultiAgentV2: (enabled: boolean) => {
        toggled = enabled;
        writeFileSync(codexConfig, readFileSync(codexConfig, "utf8").replace("enabled = true", "enabled = false"));
      },
    };

    const entered = await handleManagementAPI(
      putV2({ multiAgentMode: "v2-plaintext", plaintextAgentMessagesAcknowledged: true }),
      url(), config, d,
    );
    expect(entered?.status).toBe(200);
    const body = await entered?.json() as Record<string, unknown>;
    expect(toggled).toBe(false);
    expect(isMultiAgentV2Enabled(codexConfig)).toBe(false);
    expect(loadConfig().multiAgentMode).toBe("v2-plaintext");
    expect(body).toMatchObject({
      enabled: false,
      multiAgentMode: "v2-plaintext",
      plaintextAgentMessagesEnabled: true,
      supportsPlaintextV2Mode: true,
      agentsMaxDepthAppliesWhenV2Disabled: false,
    });

    const get = await handleManagementAPI(getV2(), url(), config, d);
    expect(await get?.json()).toMatchObject({
      multiAgentMode: "v2-plaintext",
      plaintextAgentMessagesEnabled: true,
      supportsPlaintextV2Mode: true,
      enabled: false,
      agentsMaxDepthAppliesWhenV2Disabled: false,
    });
  });

  test("a non-boolean acknowledgement is rejected before anything is written", async () => {
    isolateHomes();
    writeCodexFlag(false);
    const config = liveConfig();
    const bad = await handleManagementAPI(
      putV2({ multiAgentMode: "v2-plaintext", plaintextAgentMessagesAcknowledged: "yes" }),
      url(), config,
      { createManagementConvergeCodex: catalogConvergenceFactory() },
    );
    expect(bad?.status).toBe(400);
    expect(await bad?.json()).toEqual({ error: "body.plaintextAgentMessagesAcknowledged must be a boolean" });
    expect(config.multiAgentMode).toBeUndefined();
  });

  test("enabled=true conflicts with the pin-driven mode, in the same request and against stored state", async () => {
    isolateHomes();
    writeCodexFlag(false);
    const config = liveConfig();
    const d = {
      createManagementConvergeCodex: catalogConvergenceFactory(),
      toggleCodexMultiAgentV2: () => { throw new Error("must not toggle"); },
    };

    const combo = await handleManagementAPI(
      putV2({ enabled: true, multiAgentMode: "v2-plaintext", plaintextAgentMessagesAcknowledged: true }),
      url(), config, d,
    );
    expect(combo?.status).toBe(400);
    expect((await combo?.json() as { error: string }).error)
      .toContain("conflicts with multiAgentMode 'v2-plaintext'");

    config.multiAgentMode = "v2-plaintext";
    const stored = await handleManagementAPI(putV2({ enabled: true }), url(), config, d);
    expect(stored?.status).toBe(400);
    expect((await stored?.json() as { error: string }).error)
      .toContain("conflicts with multiAgentMode 'v2-plaintext'");
  });

  test("re-saving the same mode is idempotent and needs no repeated consent", async () => {
    isolateHomes();
    writeCodexFlag(false);
    const config = liveConfig({ multiAgentMode: "v2-plaintext" });
    const d = {
      createManagementConvergeCodex: catalogConvergenceFactory(),
      toggleCodexMultiAgentV2: () => {},
    };
    const again = await handleManagementAPI(putV2({ multiAgentMode: "v2-plaintext" }), url(), config, d);
    expect(again?.status).toBe(200);
    expect(await again?.json()).toMatchObject({ multiAgentMode: "v2-plaintext" });
    expect(loadConfig().multiAgentMode).toBe("v2-plaintext");
  });

  test("a stored keepNativeChatGptOnV1 stays stored but inactive under v2-plaintext", async () => {
    isolateHomes();
    writeCodexFlag(false);
    const config = liveConfig({ multiAgentMode: "v2", keepNativeChatGptOnV1: true });
    const d = {
      createManagementConvergeCodex: catalogConvergenceFactory(),
      toggleCodexMultiAgentV2: () => {},
    };
    const entered = await handleManagementAPI(
      putV2({ multiAgentMode: "v2-plaintext", plaintextAgentMessagesAcknowledged: true }),
      url(), config, d,
    );
    expect(entered?.status).toBe(200);
    const body = await entered?.json() as { keepNativeChatGptOnV1: boolean; warnings: string[] };
    expect(body.keepNativeChatGptOnV1).toBe(true);
    expect(body.warnings.join("\n")).toContain("stored but inactive under 'v2-plaintext'");
    expect(loadConfig().keepNativeChatGptOnV1).toBe(true);
  });

  test("a failed feature transition returns 502 and does not save the mode", async () => {
    isolateHomes();
    writeCodexFlag(true);
    saveConfig({ ...loadConfig(), multiAgentMode: "v2" });
    const config = loadConfig();
    const before = readFileSync(home!.path("config.json"), "utf8");
    const d = {
      createManagementConvergeCodex: catalogConvergenceFactory(() => { throw new Error("must not converge"); }),
      toggleCodexMultiAgentV2: () => { throw new Error("toggle failed"); },
    };
    const failed = await handleManagementAPI(
      putV2({ multiAgentMode: "v2-plaintext", plaintextAgentMessagesAcknowledged: true }),
      url(), config, d,
    );
    expect(failed?.status).toBe(502);
    expect(config.multiAgentMode).toBe("v2");
    expect(readFileSync(home!.path("config.json"), "utf8")).toBe(before);
  });

  test("leaving the mode preserves the standalone plaintext flag untouched", async () => {
    isolateHomes();
    writeCodexFlag(false);
    saveConfig({ ...loadConfig(), multiAgentMode: "v2-plaintext", plaintextV2AgentMessages: true });
    const config = liveConfig({ multiAgentMode: "v2-plaintext", plaintextV2AgentMessages: true });
    const d = {
      createManagementConvergeCodex: catalogConvergenceFactory(),
      toggleCodexMultiAgentV2: () => {},
    };
    const left = await handleManagementAPI(putV2({ multiAgentMode: "v1" }), url(), config, d);
    expect(left?.status).toBe(200);
    const body = await left?.json() as Record<string, unknown>;
    expect(loadConfig().multiAgentMode).toBe("v1");
    expect(loadConfig().plaintextV2AgentMessages).toBe(true);
    // The flag is an independent opt-in: it still reports enabled after the mode leaves.
    expect(body.plaintextAgentMessagesEnabled).toBe(true);
    expect(body.agentsMaxDepthAppliesWhenV2Disabled).toBe(true);
  });
});
