/**
 * Catch-up 010 (G-001, G-002): the read-only Connections view and the Claude first-party
 * preview route. Proves the acceptance list: an external owner is named with its file, a refused
 * Codex switch points at this view, extra Claude homes appear only when registered, the preview
 * names keys and change kinds without values, and neither GET writes a byte. The Codex restore
 * preview is checked against the real restore in a child process with temporary homes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { ConnectionView } from "../../src/integrations/connection-view";
import { displayPath } from "../../src/lib/display-path";
import { codexConfigKeyChanges, displayCodexConfigKey } from "../../src/codex/restore-preview";
import { inspectNativeCodexOwnership, inspectRecordedServiceOwnership } from "../../src/integrations/native/ownership-preflight";
import { CODEX_CONFIG_PATH } from "../../src/codex/paths";
import * as serviceManagerProbe from "../../src/service-manager-probe";
import type { OcxConfig } from "../../src/types";
import { fixturePath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

let root = "";
let codexHome = "";
let claudeHome = "";
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODEX_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR"] as const;
let restoreProbe = () => {};

function baseConfig(extra: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...extra } as OcxConfig;
}

function dispatch(config: OcxConfig, path: string, init?: RequestInit) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return handleManagementAPI(
    new Request(url, { ...init, headers: { Host: url.host, ...(init?.headers ?? {}) } }),
    url,
    config,
    { fetchAllModels: async () => [] as never, getClaudeInterceptState: () => null } as unknown as ManagementApiDeps,
  );
}

async function connections(config: OcxConfig = baseConfig()): Promise<ConnectionView[]> {
  const response = await dispatch(config, "/api/connections");
  expect(response!.status).toBe(200);
  return ((await response!.json()) as { connections: ConnectionView[] }).connections;
}

function snapshot(dir = root): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(out, snapshot(path));
    else out[path] = readFileSync(path, "base64");
  }
  return out;
}

function writeServiceState(codexHomeInState: string): void {
  writeFileSync(join(root, "service-state.json"), JSON.stringify({
    version: 2, codexHome: codexHomeInState, opencodexHome: root, backend: "scheduler",
  }));
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-connections-")));
  codexHome = join(root, "codex");
  claudeHome = join(root, "claude");
  mkdirSync(codexHome);
  process.env.OPENCODEX_HOME = root;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(root, "library");
  writeFileSync(join(root, "config.json"), JSON.stringify(baseConfig(), null, 2));
  writeServiceState(codexHome);
  // The GET must not consult the service manager (it spawns processes); fail loudly if it does.
  const probe = spyOn(serviceManagerProbe, "inspectServiceManagerInstallation").mockImplementation(() => {
    throw new Error("the connections view must not probe the service manager");
  });
  restoreProbe = () => probe.mockRestore();
});

afterEach(() => {
  restoreProbe();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  removeTreeWithRetry(root);
});

describe("Codex row", () => {
  test("a recorded service for another home is external_owner with its state file", async () => {
    writeServiceState(join(root, "someone-elses-codex"));
    const codex = (await connections()).find(row => row.client === "codex")!;
    expect(codex.owner).toBe("external");
    expect(codex.driftReasons).toContain("external_owner");
    expect(codex.ownerPath).toBe(displayPath(join(root, "service-state.json")));
  });

  test("the refused Codex switch-off points at the view, which names the owner", async () => {
    writeServiceState(join(root, "someone-elses-codex"));
    restoreProbe();
    const probe = spyOn(serviceManagerProbe, "inspectServiceManagerInstallation").mockReturnValue({ kind: "absent" });
    const response = await dispatch(baseConfig(), "/api/native-integrations/codex", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }),
    });
    probe.mockRestore();
    const body = await response!.json() as Record<string, unknown>;
    expect(body.connections).toBe("/api/connections");
    expect(body.reason).toBe("restore_incomplete");
    const codex = (await connections()).find(row => row.client === "codex")!;
    expect(codex).toMatchObject({ owner: "external", restorePreview: { outcome: "refused_owner" } });
  });

  // config.toml is the process-lifetime path restore writes through (the preload's sandbox home).
  const withCodexConfig = async (content: string, run: () => Promise<void>) => {
    mkdirSync(dirname(CODEX_CONFIG_PATH), { recursive: true });
    writeFileSync(CODEX_CONFIG_PATH, content);
    try { await run(); } finally { removeTreeWithRetry(CODEX_CONFIG_PATH); }
  };

  test("an external provider in config.toml is foreign and owned by that file", () => withCodexConfig(
    'model_provider = "corp"\n\n[model_providers.corp]\nname = "corp"\nbase_url = "https://gateway.example.test/v1"\n',
    async () => {
      const codex = (await connections()).find(row => row.client === "codex")!;
      expect(codex).toMatchObject({ observed: "foreign", owner: "external", ownerPath: displayPath(CODEX_CONFIG_PATH) });
    },
  ));

  test("wanted but native is file_edited; switched off and native has no drift", () => withCodexConfig('model = "gpt-5.5"\n', async () => {
    expect((await connections()).find(row => row.client === "codex")).toMatchObject({
      desired: "proxy", observed: "native", owner: "none", driftReasons: ["file_edited"],
    });
    const off = baseConfig({ clientIntegrations: { codex: false } });
    writeFileSync(join(root, "config.json"), JSON.stringify(off, null, 2));
    expect((await connections(off)).find(row => row.client === "codex")).toMatchObject({ desired: "native", driftReasons: [] });
  }));

  test("a hub without the loopback listener is hub_gated", async () => {
    const hub = baseConfig({ runtimeRole: "hub" } as Partial<OcxConfig>);
    writeFileSync(join(root, "config.json"), JSON.stringify(hub, null, 2));
    expect((await connections(hub)).find(row => row.client === "codex")).toMatchObject({ owner: "hub", driftReasons: ["hub_gated"] });
  });
});

describe("Claude rows", () => {
  test("extra homes appear only when registered, separately, with masked identity segments", async () => {
    const extra = join(root, "person@example.com", "claude-work");
    const unregistered = join(root, "claude-unregistered");
    mkdirSync(extra, { recursive: true });
    mkdirSync(unregistered, { recursive: true });
    writeFileSync(join(extra, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://proxy.corp:8080", NODE_EXTRA_CA_CERTS: "/corp/ca.pem" } }));
    const config = baseConfig({ claudeCode: { extraConfigDirs: [extra] } } as Partial<OcxConfig>);
    const rows = (await connections(config)).filter(row => row.client === "claude-code");
    expect(rows.map(row => row.homeSource)).toEqual(["default", "extra"]);
    expect(rows[1]).toMatchObject({ desired: "unset", observed: "foreign", owner: "external", driftReasons: [] });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("claude-unregistered");
    expect(serialized).not.toContain("proxy.corp");
    expect(rows[1]!.home).toContain("…");
    expect((await connections()).filter(row => row.client === "claude-code")).toHaveLength(1);
  });

  test("CLI first-party wanted with no settings is file_edited and carries a switch-off preview", async () => {
    const config = baseConfig({ claudeCode: { cliFirstParty: true } } as Partial<OcxConfig>);
    const row = (await connections(config)).find(view => view.client === "claude-code" && view.homeSource === "default")!;
    expect(row).toMatchObject({ desired: "proxy", observed: "missing", driftReasons: ["file_edited"] });
    expect(row.restorePreview).toEqual({ outcome: "restore", changes: [] });
  });
});

describe("GET /api/claude-code/first-party/preview", () => {
  test("names keys and change kinds, never values, and writes nothing", async () => {
    const before = snapshot();
    const response = await dispatch(baseConfig(), "/api/claude-code/first-party/preview?enabled=true");
    expect(response!.status).toBe(200);
    const body = await response!.json() as { path: string; changes: Array<{ key: string; change: string }> };
    expect(body.changes.map(c => `${c.key}:${c.change}`).sort()).toEqual(["env.HTTPS_PROXY:add", "env.NODE_EXTRA_CA_CERTS:add", "env.NO_PROXY:add"]);
    expect(body.path).toBe(displayPath(join(claudeHome, "settings.json")));
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
    expect(snapshot()).toEqual(before);
  });

  test("refusals use the switch's codes; a malformed enabled is a 400", async () => {
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://proxy.corp:8080", NODE_EXTRA_CA_CERTS: "/corp/ca.pem" } }));
    const refused = await dispatch(baseConfig(), "/api/claude-code/first-party/preview?enabled=true");
    expect(refused!.status).toBe(409);
    expect(await refused!.json()).toMatchObject({ code: "foreign_env" });
    const bad = await dispatch(baseConfig(), "/api/claude-code/first-party/preview?enabled=maybe");
    expect(bad!.status).toBe(400);
  });
});

test("GET /api/connections leaves every byte alone, including a corrupt Codex journal", async () => {
  writeFileSync(join(codexHome, "opencodex-journal.json"), "{corrupt");
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  const before = snapshot();
  const rows = await connections();
  expect(rows.find(row => row.client === "codex")?.owner).toBe("unknown");
  expect(snapshot()).toEqual(before);
});

describe("Codex restore preview matches the real restore", () => {
  for (const [scenario, outcome] of [
    ["injected", "restore"], ["edited", "restore"], ["native", "restore"],
    ["external-provider", "restore"], ["foreign-owner", "refused_owner"],
    ["profile-symlink", "refused_profile"],
  ] as const) {
    test(scenario, () => {
      const homes = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-restore-preview-")));
      try {
        for (const dir of ["codex", "ocx", "home"]) mkdirSync(join(homes, dir), { recursive: true });
        writeFileSync(join(homes, "codex", "config.toml"), 'model = "gpt-5.5"\n\n[projects."/fixture/existing"]\ntrust_level = "trusted"\n');
        const result = spawnSync(process.execPath, [fixturePath("connection-restore-preview-runner.ts"), scenario], {
          cwd: repoRoot(),
          env: { ...process.env, CODEX_HOME: join(homes, "codex"), OPENCODEX_HOME: join(homes, "ocx"), HOME: join(homes, "home") },
          encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5_000, killSignal: "SIGKILL",
        });
        if (result.status !== 0) throw new Error(`runner failed: ${result.stderr.slice(-3000)}`);
        const report = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
          preview: { outcome: string; changes: unknown[] }; actual: unknown[]; success: boolean; untouched: boolean;
        };
        expect(report.untouched).toBe(true);
        expect(report.preview.outcome).toBe(outcome);
        expect(report.success).toBe(outcome === "restore");
        expect(report.preview.changes).toEqual(report.actual);
        if (scenario === "injected" || scenario === "edited") expect(report.actual.length).toBeGreaterThan(0);
      } finally {
        removeTreeWithRetry(homes);
      }
    }, SPAWN_BUDGET_MS);
  }
});

describe("restore preview privacy and ownership evidence", () => {
  test("table names that can carry identity are masked; managed keys stay readable", () => {
    const before = [
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      '[projects."/Users/person@example.com/repo"]', 'trust_level = "trusted"',
      "[model_providers.sk-live-0123456789abcdefghijklmnopqrstuvwxyz0123]", 'base_url = "https://x.test"',
      "[model_providers.opencodex]", 'name = "opencodex"',
    ].join("\n");
    const changes = codexConfigKeyChanges(before, "");
    const serialized = JSON.stringify(changes);
    expect(serialized).not.toContain("person@example.com");
    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("/Users/");
    expect(changes.map(change => change.key)).toEqual(expect.arrayContaining([
      "openai_base_url", "model_providers.opencodex.name", "projects.….trust_level", "model_providers.….base_url",
    ]));
    expect(displayCodexConfigKey('hooks.state."plugin:demo:hook".trusted_hash')).toBe("hooks.state.….trusted_hash");
  });

  test("a service manager claim alone never makes restore refuse, so the GET need not probe it", () => {
    // Restore refuses only on ownership "foreign" (restore.ts), and only the recorded service
    // state yields it; a manager definition naming other homes is "unknown". The preview reads
    // the recorded state and therefore agrees with restore without spawning the probe.
    const stateFile = join(root, "service-state.json");
    restoreProbe();
    const probe = spyOn(serviceManagerProbe, "inspectServiceManagerInstallation").mockReturnValue({
      kind: "present",
      claims: [{ backend: "launchd", definitionPath: join(root, "agent.plist"), homes: { codexHome: join(root, "elsewhere"), opencodexHome: join(root, "elsewhere-ocx") } }],
    } as never);
    try {
      const full = inspectNativeCodexOwnership({ statePaths: [stateFile], currentHomes: { codexHome, opencodexHome: root } });
      expect(full.ownership).not.toBe("foreign");
      expect(inspectRecordedServiceOwnership({ statePaths: [stateFile], currentHomes: { codexHome, opencodexHome: root } })).toBeNull();
    } finally {
      probe.mockRestore();
    }
  });
});
