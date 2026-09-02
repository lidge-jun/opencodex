import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readdirSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import * as systemEnv from "../src/server/system-env";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { MANAGEMENT_JSON_BODY_MAX_BYTES } from "../src/server/management/body";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// Full-suite Windows load: startServer + multi-PUT management flows often exceed bun's
// default 5s per-test budget (same flake class as 810fa115 / kiro-oauth).
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let previousClaudeConfigDir: string | undefined;
let previousDesktopConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-mgmt-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-mgmt-"));
  process.env.OPENCODEX_HOME = testDir;
  // These API tests intentionally toggle agent injection off. Never let that
  // prune the developer's real ~/.claude/agents directory.
  process.env.CLAUDE_CONFIG_DIR = join(testDir, "claude");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
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
    await server.stop(true);
  }
});


test("PUT round-trips classifier routing settings and clears them with null (#1697)", async () => {
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classifierModel: " mock/test-model ",
        classifierFallbacks: [" mock/test-model ", "mock/other"],
      }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(new URL("/api/claude-code", server.url));
    const d = await get.json() as Record<string, any>;
    expect(d.classifierModel).toBe("mock/test-model");
    expect(d.classifierFallbacks).toEqual(["mock/test-model", "mock/other"]);

    // null clears both, which is how the operator turns classifier routing back off.
    const cleared = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classifierModel: "", classifierFallbacks: null }),
    });
    expect(cleared.status).toBe(200);
    const after = await (await fetch(new URL("/api/claude-code", server.url))).json() as Record<string, any>;
    expect(after.classifierModel).toBe("");
    expect(after.classifierFallbacks).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("PUT rejects a malformed classifierFallbacks instead of persisting it (#1697)", async () => {
  const server = startServer(0);
  try {
    for (const body of [{ classifierFallbacks: "mock/test-model" }, { classifierFallbacks: [1] }, { classifierFallbacks: [""] }]) {
      const res = await fetch(new URL("/api/claude-code", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      const err = await res.json() as Record<string, unknown>;
      expect(String(err.error)).toContain("classifierFallbacks");
    }
  } finally {
    await server.stop(true);
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
    // The migration sentinel is stamped on every persist so a post-upgrade block is
    // never mistaken for a pre-upgrade subscriber; its value is a timestamp.
    expect(typeof persisted.claudeCode?.authModeMigratedAt).toBe("string");
    const { authModeMigratedAt, ...settings } = persisted.claudeCode!;
    expect(settings).toEqual({
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
    await server.stop(true);
  }
});

test("a rejected PUT does not apply fastMode in memory", async () => {
  const config = loadConfig();
  config.fastMode = false;
  saveConfig(config);
  const server = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fastMode: true, modelMap: { invalid: "" } }),
    });
    expect(put.status).toBe(400);

    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.fastMode).toBe(false);
    expect(loadConfig().fastMode).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("PUT round-trips three-state authMode (devlog 260720 + 260726_claude_auth_auto)", async () => {
  const server = startServer(0);
  try {
    // An absent config key is AUTO, not subscription: the old coercion turned every
    // save into a sticky manual subscription (devlog 260726_claude_auth_auto/002 §3).
    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");

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

    // subscription now stores the literal so an explicit choice survives auth changes.
    const back = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "subscription" }),
    });
    expect(back.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBe("subscription");
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("subscription");

    // "auto" is the return path: it deletes the key so detection drives the mode again.
    const auto = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "auto" }),
    });
    expect(auto.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");
  } finally {
    await server.stop(true);
  }
});

test("GET exposes the resolved marker mode and its provenance", async () => {
  const server = startServer(0);
  try {
    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(["proxy", "subscription"]).toContain(get.markerMode);
    expect(["manual", "auto-present", "auto-absent", "auto-unknown"]).toContain(get.authModeOrigin);
    expect(typeof get.admissionKeyActive).toBe("boolean");
    // The badge must say it is daemon-side: a terminal-exported key is invisible here.
    expect(get.detectionScope).toBe("daemon");
  } finally {
    await server.stop(true);
  }
});

// The auto-kill regression: saving an unrelated field must not convert auto into a
// sticky manual mode (devlog 260726_claude_auth_auto/002 §3).
test("an unrelated PUT leaves an auto config on auto", async () => {
  const server = startServer(0);
  try {
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    const put = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(put.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    const get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");
  } finally {
    await server.stop(true);
  }
});

// THE regression the auto mode nearly shipped with: the migration reads "a claudeCode
// block with no authMode" as a pre-upgrade subscriber. Post-upgrade, choosing Auto
// DELETES authMode and merely toggling Claude on creates the block, so without a
// sentinel written on every persist the next start converts Auto into a sticky manual
// subscription — auto would survive exactly one proxy lifetime, with no way back.
test("auto survives a restart instead of being migrated back to subscription", async () => {
  const first = startServer(0);
  try {
    const put = await fetch(new URL("/api/claude-code", first.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "auto", enabled: true }),
    });
    expect(put.status).toBe(200);
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally {
    await first.stop(true);
  }

  // A restart runs the startup migration against what the PUT persisted.
  const second = startServer(0);
  try {
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
    const get = await fetch(new URL("/api/claude-code", second.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.authMode).toBe("auto");
  } finally {
    await second.stop(true);
  }
});

// The same trap by a different door: the GUI's ON toggle PUTs `{enabled}` alone, which
// creates the block for a user who never opened the auth-mode control at all.
test("toggling Claude on does not pin a fresh install to subscription", async () => {
  const first = startServer(0);
  try {
    await fetch(new URL("/api/claude-code", first.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
  } finally {
    await first.stop(true);
  }
  const second = startServer(0);
  try {
    expect(loadConfig().claudeCode?.authMode).toBeUndefined();
  } finally {
    await second.stop(true);
  }
});

test("PUT rejects an unknown authMode value", async () => {
  const server = startServer(0);
  try {
    const bad = await fetch(new URL("/api/claude-code", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ authMode: "passthrough" }),
    });
    expect(bad.status).toBe(400);
  } finally {
    await server.stop(true);
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
    await server.stop(true);
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
    await server.stop(true);
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
      // The web-search override now passes the #2188 membership gate; the
      // Haiku auth slot is always a legal setting regardless of login state.
      webSearchSidecar: { backend: "anthropic", model: "claude-haiku-4-5" },
      visionSidecar: { backend: "openai", model: "gpt-vision" },
    });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode).toMatchObject({
      webSearchSidecar: { backend: "anthropic", model: "claude-haiku-4-5" },
      visionSidecar: { backend: "openai", model: "gpt-vision" },
    });

    let get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-haiku-4-5" });
    expect(get.visionSidecar).toEqual({ backend: "openai", model: "gpt-vision" });

    // A model outside (runnable candidates ∪ auth slots) is refused with the
    // filter named — this route shares the gate with /api/sidecar-settings.
    response = await put({ webSearchSidecar: { model: "claude-search" } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("web-search sidecar candidate");

    // A partial model update is validated against the effective preserved backend.
    response = await put({ webSearchSidecar: { model: "gpt-5.6-luna" } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("backend/model pair");
    expect(loadConfig().claudeCode?.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-haiku-4-5" });
    expect(loadConfig().claudeCode?.visionSidecar).toEqual({ backend: "openai", model: "gpt-vision" });

    // Updating both fields to a runnable pair succeeds and preserves omitted sections.
    response = await put({ webSearchSidecar: { backend: "openai", model: "gpt-5.6-luna" } });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toEqual({ backend: "openai", model: "gpt-5.6-luna" });
    expect(loadConfig().claudeCode?.visionSidecar).toEqual({ backend: "openai", model: "gpt-vision" });

    // null backend is the explicit Auto/inherit transition; empty model deletes only model.
    response = await put({
      webSearchSidecar: { backend: null },
      visionSidecar: { backend: null, model: "" },
    });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toEqual({ model: "gpt-5.6-luna" });
    expect(loadConfig().claudeCode?.visionSidecar).toBeUndefined();
    get = await fetch(new URL("/api/claude-code", server.url)).then(r => r.json()) as Record<string, unknown>;
    expect(get.webSearchSidecar).toEqual({ model: "gpt-5.6-luna" });
    expect(get.visionSidecar).toBeUndefined();

    // null and empty sections both clear the whole override.
    response = await put({ webSearchSidecar: null, visionSidecar: {} });
    expect(response.status).toBe(200);
    expect(loadConfig().claudeCode?.webSearchSidecar).toBeUndefined();
    expect(loadConfig().claudeCode?.visionSidecar).toBeUndefined();

    // Auth-slot id: passes the membership gate regardless of login state, so the
    // known-good snapshot below is real (a non-slot id would silently 400 here).
    const snapshotPut = await put({ webSearchSidecar: { backend: "openai", model: "gpt-5.6-luna" } });
    expect(snapshotPut.status).toBe(200);
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
    await server.stop(true);
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
    await server.stop(true);
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
    await server.stop(true);
  }
});

test("PUT/GET round-trips auto-context (devlog 260712 020)", async () => {
  const server = startServer(0);
  try {
    // Defaults: on, window null — the GUI renders the runtime default as the empty choice.
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
    await server.stop(true);
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
    await server.stop(true);
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
    await server.stop(true);
  }
});

test("GET /api/claude-code reports Auto-connect support on Darwin", async () => {
  const server = startServer(0, { managementApi: { platform: "darwin" } });
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.autoConnectSupported).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("GET /api/claude-code reports Auto-connect unsupported outside Darwin", async () => {
  saveConfig({
    ...loadConfig(),
    claudeCode: { systemEnv: true },
  } as OcxConfig);
  const server = startServer(0, { managementApi: { platform: "linux" } });
  try {
    const r = await fetch(new URL("/api/claude-code", server.url));
    expect(r.status).toBe(200);
    const d = await r.json() as Record<string, any>;
    expect(d.systemEnv).toBe(true);              // raw stored preference
    expect(d.autoConnectSupported).toBe(false);  // effective capability
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop profile GET, PUT and apply round-trip four-family assignments", async () => {
  const server = startServer(0);
  try {
    const initial = await fetch(new URL("/api/claude-desktop", server.url)).then(r => r.json()) as Record<string, any>;
    expect(initial.profile.version).toBe(1);
    expect(initial.models.some((model: { route: string }) => model.route === "mock/test-model")).toBe(true);
    expect(initial.profile.assignments["mock/test-model"].family).toBe("opus");

    const edited = structuredClone(initial.profile);
    edited.assignments["mock/test-model"].family = "sonnet";
    edited.defaults.opus = Object.keys(edited.assignments)
      .filter(route => edited.assignments[route].family === "opus")
      .sort()[0] ?? null;
    edited.defaults.sonnet = "mock/test-model";
    const put = await fetch(new URL("/api/claude-desktop", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: edited }),
    });
    expect(put.status).toBe(200);
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const alias = loadConfig().claudeCode?.desktopProfile?.assignments["mock/test-model"]?.alias;
    const discovery = await fetch(new URL("/v1/models?flavor=anthropic", server.url)).then(r => r.json()) as { data: Array<{ id: string }> };
    expect(discovery.data.some(model => model.id === alias)).toBe(true);

    const apply = await fetch(new URL("/api/claude-desktop/apply", server.url), { method: "POST" });
    expect(apply.status).toBe(200);
    const result = await apply.json() as { path: string; applied: boolean };
    expect(result.applied).toBe(true);
    expect(result.path.startsWith(process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR!)).toBe(true);
    const appliedConfig = JSON.parse(readFileSync(result.path, "utf8")) as { inferenceGatewayBaseUrl: string };
    expect(appliedConfig.inferenceGatewayBaseUrl).toBe(new URL(server.url).origin);
  } finally {
    await server.stop(true);
  }
});

/*
 * Mechanism guard for #859: the apply route must keep building the alias
 * registry in the serving process. (The CLI→daemon delegation half is pinned
 * in tests/claude-desktop-cli.test.ts; this module-global registry is shared
 * in-process, so this test guards the route, not the delegation.)
 */
test("Claude Desktop apply installs the alias registry in the serving process (#859)", async () => {
  const { resolveDesktop3pAlias, activeDesktop3pAlias } = await import("../src/claude/desktop-3p");
  // A provider unique to this test: no prior test can have populated its
  // alias, so resolution proves THIS apply built the registry in-process.
  const seeded = loadConfig();
  seeded.providers = {
    ...seeded.providers,
    unique859: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model-x"] },
  };
  saveConfig(seeded);
  const server = startServer(0);
  try {
    const apply = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "static" }),
    });
    expect(apply.status).toBe(200);
    // Without another /v1/models discovery call, the serving process must now
    // decode the alias the CLI would have generated.
    const alias = activeDesktop3pAlias("unique859", "test-model-x");
    expect(resolveDesktop3pAlias(alias)).toBe("unique859/test-model-x");
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop apply honors the profile in the request body over daemon-stale config (#859)", async () => {
  const server = startServer(0);
  try {
    const current = await fetch(new URL("/api/claude-desktop", server.url)).then(r => r.json()) as Record<string, any>;
    const edited = structuredClone(current.profile);
    edited.assignments["mock/test-model"].family = "sonnet";
    edited.defaults.sonnet = "mock/test-model";
    edited.defaults.opus = Object.keys(edited.assignments)
      .filter(route => edited.assignments[route].family === "opus")
      .sort()[0] ?? null;

    const apply = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "static", profile: edited }),
    });
    expect(apply.status).toBe(200);
    // The delegated profile wins: persisted state shows sonnet, not the stale opus.
    expect(loadConfig().claudeCode?.desktopProfile?.assignments["mock/test-model"]?.family).toBe("sonnet");
    expect(loadConfig().claudeCode?.desktopProfile?.defaults.sonnet).toBe("mock/test-model");

    const badProfile = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "static", profile: { version: 2 } }),
    });
    expect(badProfile.status).toBe(400);
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop apply validates the mode body", async () => {
  const server = startServer(0);
  try {
    const beforeMalformed = structuredClone(loadConfig());
    const malformed = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid JSON body" });
    expect(loadConfig()).toEqual(beforeMalformed);

    const beforeBadMode = structuredClone(loadConfig());
    const bad = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "nonsense" }),
    });
    expect(bad.status).toBe(400);
    expect(loadConfig()).toEqual(beforeBadMode);

    const beforeBadProfile = structuredClone(loadConfig());
    const badProfile = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: { version: 2 } }),
    });
    expect(badProfile.status).toBe(400);
    expect(loadConfig()).toEqual(beforeBadProfile);

    const hybrid = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "hybrid" }),
    });
    expect(hybrid.status).toBe(200);
    const result = await hybrid.json() as { path: string };
    const written = JSON.parse(readFileSync(result.path, "utf8")) as { modelDiscoveryEnabled: boolean };
    expect(written.modelDiscoveryEnabled).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop apply rejects an oversized decompressed body without mutating config", async () => {
  const server = startServer(0);
  try {
    const before = structuredClone(loadConfig());
    const oversized = JSON.stringify({ pad: "x".repeat(MANAGEMENT_JSON_BODY_MAX_BYTES) });
    const response = await fetch(new URL("/api/claude-desktop/apply", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: Bun.gzipSync(new TextEncoder().encode(oversized)),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request body too large" });
    expect(loadConfig()).toEqual(before);
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop PUT rejects invalid JSON profile without mutating saved config", async () => {
  const server = startServer(0);
  try {
    const before = structuredClone(loadConfig());
    const put = await fetch(new URL("/api/claude-desktop", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: { version: 1, assignments: {}, defaults: { opus: "missing", fable: null, sonnet: null, haiku: null } } }),
    });
    expect(put.status).toBe(400);
    expect(loadConfig()).toEqual(before);
  } finally {
    await server.stop(true);
  }
});

test("Claude Desktop PUT retains but cannot move an unavailable route", async () => {
  const seeded = loadConfig();
  seeded.claudeCode = {
    desktopProfile: {
      version: 1,
      assignments: {
        "missing/old-model": { family: "opus", alias: "claude-opus-4-8-20260101" },
      },
      defaults: { opus: "missing/old-model", fable: null, sonnet: null, haiku: null },
    },
  };
  saveConfig(seeded);
  const server = startServer(0);
  try {
    const state = await fetch(new URL("/api/claude-desktop", server.url)).then(r => r.json()) as Record<string, any>;
    expect(state.models.find((model: { route: string }) => model.route === "missing/old-model")?.available).toBe(false);
    const edited = structuredClone(state.profile);
    edited.assignments["missing/old-model"].family = "haiku";
    edited.defaults.opus = Object.keys(edited.assignments).filter(route => edited.assignments[route].family === "opus").sort()[0] ?? null;
    edited.defaults.haiku = "missing/old-model";
    const put = await fetch(new URL("/api/claude-desktop", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: edited }),
    });
    expect(put.status).toBe(400);
    expect((await put.json() as { error: string }).error).toContain("사용할 수 없는 모델");
    expect(loadConfig().claudeCode?.desktopProfile?.assignments["missing/old-model"]?.family).toBe("opus");
  } finally {
    await server.stop(true);
  }
});
