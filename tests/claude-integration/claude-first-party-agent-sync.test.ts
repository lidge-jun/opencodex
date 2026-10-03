import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectClaudeAgentDefs } from "../../src/claude/agents-inject";
import * as desktopFirstParty from "../../src/claude/desktop-first-party";
import { reconcileClaudeFirstPartySettings } from "../../src/claude/first-party-settings";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let claudeDir = "";
let config: OcxConfig;
const previous: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR"] as const;
const agentFile = "ocx-test-model.md";
type ManagementDeps = Parameters<typeof handleManagementAPI>[3];

function persist(): void {
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
}

function agentFiles(): Record<string, Buffer> {
  const dir = join(claudeDir, "agents");
  return Object.fromEntries(readdirSync(dir).sort().map(file => [file, readFileSync(join(dir, file))]));
}

function seedExistingAgents(): Record<string, Buffer> {
  // A sync would prune the stale owned file, but must never change the unowned one.
  writeFileSync(join(claudeDir, "agents", "ocx-stale.md"), "<!-- generated-by: opencodex -->\nold roster\n");
  writeFileSync(join(claudeDir, "agents", "ocx-user.md"), "---\nname: my-agent\n---\nUser-owned bytes\n");
  return agentFiles();
}

function expectRegistered(): void {
  expect(existsSync(join(claudeDir, "agents", agentFile))).toBe(true);
  const body = readFileSync(join(claudeDir, "agents", agentFile), "utf8");
  expect(body).toContain("<!-- generated-by: opencodex -->");
  expect(body).toContain("<!-- ocx-route: ocx-claude-mock--test-model -->");
}

async function dispatch(target: "cli" | "desktop", enabled = true, deps: ManagementDeps = {}) {
  const url = new URL(`http://127.0.0.1:10100${target === "cli" ? "/api/claude-code" : "/api/claude-desktop/apply"}`);
  const state = { proxyPort: 10200, caCertPath: join(root, "claude-intercept", "ca.pem"), pickerProxyPort: null };
  const response = await handleManagementAPI(new Request(url, {
    method: target === "cli" ? "PUT" : "POST",
    headers: { Host: url.host, "Content-Type": "application/json" },
    body: JSON.stringify(target === "cli" ? { cliFirstParty: enabled } : { mode: "first-party" }),
  }), url, config, {
    fetchAllModels: async () => [],
    claudeAgentConfigDir: claudeDir,
    getClaudeInterceptState: () => state,
    ensureClaudeIntercept: async () => ({ ok: true, state }),
    ...deps,
  }, "admin-token", undefined, { trustedLoopback: true });
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, unknown> };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-first-party-agents-"));
  claudeDir = join(root, "claude");
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  process.env.OPENCODEX_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "desktop");
  mkdirSync(join(claudeDir, "agents"), { recursive: true });
  config = {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", liveModels: false, models: ["test-model"] } },
    subagentModels: ["mock/test-model"],
    claudeCode: { desktopMode: "gateway" },
  } as OcxConfig;
  persist();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  removeTreeWithRetry(root);
});

test.each(["cli", "desktop"] as const)("%s first-party success registers the routed roster before responding", async target => {
  expect(agentFiles()).toEqual({});
  const result = await dispatch(target);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject(target === "cli"
    ? { ok: true, cliFirstParty: true }
    : { ok: true, mode: "first-party", applied: true, saved: true });
  expectRegistered();
});

test("repeated CLI enable repairs a missing owned definition", async () => {
  expect((await dispatch("cli")).status).toBe(200);
  expectRegistered();
  unlinkSync(join(claudeDir, "agents", agentFile));
  expect((await dispatch("cli")).status).toBe(200);
  expectRegistered();
});

test.each(["cli", "desktop"] as const)("%s first-party with injection disabled prunes only marker-owned definitions", async target => {
  const before = seedExistingAgents();
  config.claudeCode!.injectAgents = false;
  persist();
  expect((await dispatch(target)).status).toBe(200);
  expect(agentFiles()).toEqual({ "ocx-user.md": before["ocx-user.md"] });
});

test("CLI first-party disable retains the enabled roster and repairs it on repeated saves", async () => {
  config.claudeCode!.cliFirstParty = true;
  persist();
  expect(reconcileClaudeFirstPartySettings(config, { desktop: false, cli: true }).ok).toBe(true);
  injectClaudeAgentDefs(config, {}, claudeDir);
  const before = agentFiles();
  const result = await dispatch("cli", false);
  expect(result).toMatchObject({ status: 200, body: { ok: true, enabled: true, cliFirstParty: false } });
  expect(agentFiles()).toEqual(before);
  unlinkSync(join(claudeDir, "agents", agentFile));
  expect((await dispatch("cli", false)).status).toBe(200);
  expectRegistered();
});

test.each(["cli", "desktop"] as const)("%s refused first-party enable preserves every existing agent byte", async target => {
  const before = seedExistingAgents();
  const path = join(claudeDir, "settings.json");
  const settings = JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } });
  writeFileSync(path, settings);
  const result = await dispatch(target);
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject(target === "cli" ? { code: "foreign_env" } : { reason: "foreign_env" });
  expect(agentFiles()).toEqual(before);
  expect(readFileSync(path, "utf8")).toBe(settings);
});

test("rolled-back CLI enable preserves agent bytes and restores settings", async () => {
  const before = seedExistingAgents();
  const path = join(claudeDir, "settings.json");
  const settings = '{ "theme": "dark" }\n';
  writeFileSync(path, settings);
  const result = await dispatch("cli", true, {
    reconcileClaudeFirstPartySettings: (current, desired) => {
      expect(reconcileClaudeFirstPartySettings(current, desired).ok).toBe(true);
      return { ok: false, reason: "write_failed", path };
    },
  });
  expect(result).toMatchObject({ status: 500, body: { code: "write_failed" } });
  expect(result.body.warnings).toBeUndefined();
  expect(agentFiles()).toEqual(before);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(settings));
  expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).claudeCode.cliFirstParty).toBeUndefined();
});

test("Desktop saved:false partial success does not reconcile agent definitions", async () => {
  const before = seedExistingAgents();
  const apply = desktopFirstParty.applyDesktopFirstParty;
  const spy = spyOn(desktopFirstParty, "applyDesktopFirstParty").mockImplementation((...args) => {
    const result = apply(...args);
    // Lose config persistence after the real settings write, before the mode commit.
    writeFileSync(join(root, "config.json"), "{");
    return result;
  });
  try {
    const result = await dispatch("desktop");
    expect(result).toMatchObject({ status: 200, body: { ok: true, applied: true, saved: false } });
    expect(result.body.warning).toContain("mode marker was not saved");
    expect(JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")).env.HTTPS_PROXY)
      .toMatch(/^http:\/\/opencodex:[^@/]+@127\.0\.0\.1:10200$/);
    expect(agentFiles()).toEqual(before);
  } finally {
    spy.mockRestore();
  }
});
