import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import * as systemEnv from "../src/server/system-env";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

let testDir = "";
let previousHome: string | undefined;
let previousClaudeConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

const originalPlatform = process.platform;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-mgmt-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-mgmt-"));
  process.env.OPENCODEX_HOME = testDir;
  // These API tests intentionally toggle agent injection off. Never let that
  // prune the developer's real ~/.claude/agents directory.
  process.env.CLAUDE_CONFIG_DIR = join(testDir, "claude");
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

test("GET /api/claude-code returns defaults + available + aliases", async () => {
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.enabled).toBe(true);
    expect(d.model).toBe("");
    expect(d.smallFastModel).toBe("");
    expect(d.modelMap).toEqual({});
    expect(d.available).toContain("mock/test-model");
    // Aliases preview uses the readable CLI-surface family (devlog 050 / audit 051 #2).
    expect(d.aliases.some((a: { id: string }) => a.id === "claude-ocx-mock--test-model")).toBe(true);
    expect(typeof d.port).toBe("number");
  } finally {
    server.stop(true);
  }
});

test("PUT round-trips settings and persists to config", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        model: "mock/test-model",
        smallFastModel: " mock/test-model ",
        modelMap: { "claude-sonnet-4-5": "mock/test-model" },
      }),
    });
    expect(put.status).toBe(200);
    const putBody = await put.json() as Record<string, unknown>;
    expect(putBody.ok).toBe(true);
    expect(putBody.enabled).toBe(false);

    const persisted = loadConfig();
    expect(persisted.claudeCode).toEqual({
      enabled: false,
      model: "mock/test-model",
      smallFastModel: "mock/test-model",
      modelMap: { "claude-sonnet-4-5": "mock/test-model" },
    });

    // Clearing a slot with "" deletes it; partial PUT leaves other fields alone.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "" }),
    });
    expect(clear.status).toBe(200);
    const after = loadConfig();
    expect(after.claudeCode?.model).toBeUndefined();
    expect(after.claudeCode?.smallFastModel).toBe("mock/test-model");
    expect(after.claudeCode?.enabled).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("PUT round-trips authMode (proxy persists, subscription clears — devlog 260720)", async () => {
  const server = startServer(0);
  try {
    // Default: absent config key reads back as subscription.
    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("subscription");

    // proxy persists to config and reads back.
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "proxy" }),
    });
    expect(put.status).toBe(200);
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("proxy");
    expect(loadConfig().claudeCode?.authMode).toBe("proxy");

    // subscription clears the stored key (type only allows "proxy").
    const back = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "subscription" }),
    });
    expect(back.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("PUT rejects invalid authMode values (invalid string + non-string)", async () => {
  const server = startServer(0);
  try {
    for (const bad of ["x", 42]) {
      const r = await fetch(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authMode: bad }),
      });
      expect(r.status).toBe(400);
    }
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("authMode-only PUT triggers system-env reconciliation (audit R2 #1)", async () => {
  const applySpy = spyOn(systemEnv, "applySystemEnvToggle").mockResolvedValue({ reverted: false, reason: "test" });
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "proxy" }), // no systemEnv field in the body
    });
    expect(r.status).toBe(200);
    expect(applySpy).toHaveBeenCalled();
  } finally {
    applySpy.mockRestore();
    server.stop(true);
  }
});

test("Claude sidecar overrides round-trip, partially update, clear, and reject unknown backends", async () => {
  const server = startServer(0);
  const put = (body: unknown) => fetch(new URL("/api/claude-code", server.url), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    let response = await put({
      webSearchSidecar: { backend: "anthropic", model: "claude-search" },
      visionSidecar: { backend: "openai", model: "gpt-vision" },
    });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode).toMatchObject({
      webSearchSidecar: { backend: "anthropic", model: "claude-search" },
      visionSidecar: { backend: "openai", model: "gpt-vision" },
    });

    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-search" });
    expect(get.visionSidecar).toEqual({ backend: "openai", model: "gpt-vision" });

    // Nested partial updates preserve omitted fields and omitted sections.
    response = await put({ webSearchSidecar: { model: "claude-search-2" } });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-search-2" });
    expect(loadConfig().claudeCode?.visionSidecar).toEqual({ backend: "openai", model: "gpt-vision" });

    // null backend is the explicit Auto/inherit transition; empty model deletes only model.
    response = await put({
      webSearchSidecar: { backend: null },
      visionSidecar: { backend: null, model: "" },
    });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toEqual({ model: "claude-search-2" });
    expect(loadConfig().claudeCode?.visionSidecar).toBeUndefined();
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.webSearchSidecar).toEqual({ model: "claude-search-2" });
    expect(get.visionSidecar).toBeUndefined();

    // null and empty sections both clear the whole override.
    response = await put({ webSearchSidecar: null, visionSidecar: {} });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toBeUndefined();
    expect(loadConfig().claudeCode?.visionSidecar).toBeUndefined();

    await put({ webSearchSidecar: { backend: "openai", model: "stable" } });
    const beforeInvalid = loadConfig().claudeCode;
    for (const body of [
      { webSearchSidecar: { backend: "other" } },
      { visionSidecar: { backend: "other" } },
      { webSearchSidecar: [] },
    ]) {
      response = await put(body);
      expect(response.status).toBe(400);
      expect(loadConfig().claudeCode).toEqual(beforeInvalid);
    }
  } finally {
    server.stop(true);
  }
});

test("PUT immediately restores generated agents after re-enable and roster changes", async () => {
  const server = startServer(0);
  const agentsDir = join(process.env.CLAUDE_CONFIG_DIR!, "agents");
  try {
    const enable = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ injectAgents: true }),
    });
    expect(enable.status).toBe(200);
    expect(readdirSync(agentsDir).some(name => name === "ocx-gpt-5-6-sol.md")).toBe(true);

    const disable = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ injectAgents: false }),
    });
    expect(disable.status).toBe(200);
    expect(readdirSync(agentsDir)).toEqual([]);

    const reenable = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ injectAgents: true }),
    });
    expect(reenable.status).toBe(200);
    expect(readdirSync(agentsDir).some(name => name === "ocx-gpt-5-6-sol.md")).toBe(true);

    const roster = await fetch(new URL("/api/subagent-models", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: ["gpt-5.6-terra"] }),
    });
    expect(roster.status).toBe(200);
    expect(readdirSync(agentsDir)).toEqual(["ocx-gpt-5-6-terra.md"]);
  } finally {
    server.stop(true);
  }
});

test("PUT/GET round-trips the context/effort levers (devlog 136 B6)", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxContextTokens: 1_000_000, alwaysEnableEffort: true }),
    });
    expect(put.status).toBe(200);
    let persisted = loadConfig();
    expect(persisted.claudeCode?.maxContextTokens).toBe(1_000_000);
    expect(persisted.claudeCode?.alwaysEnableEffort).toBe(true);

    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.maxContextTokens).toBe(1_000_000);
    expect(get.alwaysEnableEffort).toBe(true);

    // null clears the context override; alwaysEnableEffort:false deletes the flag.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxContextTokens: null, alwaysEnableEffort: false }),
    });
    expect(clear.status).toBe(200);
    persisted = loadConfig();
    expect(persisted.claudeCode?.maxContextTokens).toBeUndefined();
    expect(persisted.claudeCode?.alwaysEnableEffort).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("PUT/GET round-trips auto-context (devlog 260712 020)", async () => {
  const server = startServer(0);
  try {
    // Defaults: on, window null (GUI shows the 350000 placeholder).
    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.autoContext).toBe(true);
    expect(get.autoCompactWindow).toBeNull();
    expect(get.blockedSkills).toBeNull(); // null = built-in default (claude-api)

    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoContext: false, autoCompactWindow: 400_000, blockedSkills: ["claude-api", "my-skill"] }),
    });
    expect(put.status).toBe(200);
    let persisted = loadConfig();
    expect(persisted.claudeCode?.autoContext).toBe(false);
    expect(persisted.claudeCode?.autoCompactWindow).toBe(400_000);
    expect(persisted.claudeCode?.blockedSkills).toEqual(["claude-api", "my-skill"]);
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.autoContext).toBe(false);
    expect(get.autoCompactWindow).toBe(400_000);
    expect(get.blockedSkills).toEqual(["claude-api", "my-skill"]);

    // true drops the key (default-on); null resets the window to default.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoContext: true, autoCompactWindow: null, blockedSkills: null }),
    });
    expect(clear.status).toBe(200);
    persisted = loadConfig();
    expect(persisted.claudeCode?.autoContext).toBeUndefined();
    expect(persisted.claudeCode?.autoCompactWindow).toBeUndefined();
    expect(persisted.claudeCode?.blockedSkills).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("PUT/GET round-trips tierModels and GET exposes contextWindows + effectiveModelEnv (devlog 260712 B2)", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierModels: { opus: "mock/test-model", haiku: " mock/other-model " } }),
    });
    expect(put.status).toBe(200);
    const persisted = loadConfig();
    expect(persisted.claudeCode?.tierModels).toEqual({ opus: "mock/test-model", haiku: "mock/other-model" });

    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, any>;
    expect(get.tierModels).toEqual({ opus: "mock/test-model", haiku: "mock/other-model" });
    expect(typeof get.contextWindows).toBe("object");
    expect(get.effectiveModelEnv.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("mock/test-model");
    expect(get.effectiveModelEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("mock/other-model");
    expect(get.effectiveModelEnv.ANTHROPIC_SMALL_FAST_MODEL).toBe("mock/other-model");

    // Clearing with empty strings deletes the block; bad shapes 400.
    const clear = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierModels: { opus: "", haiku: "" } }),
    });
    expect(clear.status).toBe(200);
    expect(loadConfig().claudeCode?.tierModels).toBeUndefined();
    const bad = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierModels: { opus: 5 } }),
    });
    expect(bad.status).toBe(400);
  } finally {
    server.stop(true);
  }
});

test("PUT validation rejects bad shapes", async () => {
  const server = startServer(0);
  try {
    const cases: [Record<string, unknown>, string][] = [
      [{ enabled: "yes" }, "enabled must be a boolean"],
      [{ model: 5 }, "model must be a string"],
      [{ maxContextTokens: 0 }, "maxContextTokens must be a positive integer or null"],
      [{ maxContextTokens: -1 }, "maxContextTokens must be a positive integer or null"],
      [{ maxContextTokens: 1.5 }, "maxContextTokens must be a positive integer or null"],
      [{ maxContextTokens: "1000000" }, "maxContextTokens must be a positive integer or null"],
      [{ alwaysEnableEffort: "on" }, "alwaysEnableEffort must be a boolean"],
      [{ autoContext: "on" }, "autoContext must be a boolean"],
      [{ injectAgents: "on" }, "injectAgents must be a boolean"],
      [{ blockedSkills: "claude-api" }, "blockedSkills must be an array of non-empty strings, or null"],
      [{ blockedSkills: [""] }, "blockedSkills must be an array of non-empty strings, or null"],
      [{ blockedSkills: [1] }, "blockedSkills must be an array of non-empty strings, or null"],
      [{ autoCompactWindow: 50_000 }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ autoCompactWindow: 2_000_000 }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ autoCompactWindow: 350_000.5 }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ autoCompactWindow: "350000" }, "autoCompactWindow must be an integer between 100000 and 1000000, or null"],
      [{ modelMap: ["a"] }, "modelMap must be an object of string->string, or null"],
      [{ modelMap: { "": "x" } }, "modelMap entries must be non-empty strings"],
      [{ modelMap: { a: "" } }, "modelMap entries must be non-empty strings"],
      [{ modelMap: { a: 3 } }, "modelMap entries must be non-empty strings"],
    ];
    for (const [body, error] of cases) {
      const r = await fetch(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe(error);
    }
    expect(loadConfig().claudeCode).toBeUndefined(); // nothing persisted on rejects
  } finally {
    server.stop(true);
  }
});

test("GET /api/claude-code reports Auto-connect support on Darwin", async () => {
  setPlatform("darwin");
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.autoConnectSupported).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("GET /api/claude-code reports Auto-connect unsupported outside Darwin", async () => {
  saveConfig({
    ...loadConfig(),
    claudeCode: { systemEnv: true },
  } as OcxConfig);
  setPlatform("linux");
  const server = startServer(0);
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.systemEnv).toBe(true);              // raw stored preference
    expect(d.autoConnectSupported).toBe(false);  // effective capability
  } finally {
    server.stop(true);
  }
});
