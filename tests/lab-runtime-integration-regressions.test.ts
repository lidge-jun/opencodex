import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OcxConfig } from "../src/types";
import { readConfigDiagnostics, saveConfigPreservingClaudeCode } from "../src/config";
import { handleLabCommand } from "../src/cli/lab";
import {
  requestLabAutomationShutdown,
  resetLabAutomationSchedulerStateForTests,
  stopLabAutomationScheduler,
} from "../src/lab/automation/orchestrator";
import { loadLabAutomationConfig } from "../src/lab/automation/config-persistence";
import { readInstallationSalt } from "../src/lab/subject/installation-salt";
import {
  resetCompatibilityVersionCacheForTests,
  setCompatibilityVersionOverrideForTests,
} from "../src/routing/compatibility/version";
import { handleManagementAPI } from "../src/server/management-api";
import { resetLabAutomationRuntimeForTests } from "../src/server/lab-automation-runtime";
import { ManagementRequest } from "./helpers/management-auth";

const HOMES: string[] = [];
const COMPAT_VERSION = "e".repeat(64);

function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-runtime-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  process.env.OPENCODEX_HOME = dir;
  return dir;
}

function emptyConfig(): OcxConfig {
  return { providers: {}, labIntegrationEnabled: false } as OcxConfig;
}

function persistedLiveConfig(home: string): OcxConfig {
  readInstallationSalt(home);
  setCompatibilityVersionOverrideForTests(COMPAT_VERSION);
  const base = readConfigDiagnostics().config;
  const config = {
    ...base,
    defaultProvider: "fixture-provider",
    labIntegrationEnabled: false,
    providers: {
      ...base.providers,
      "fixture-provider": {
        adapter: "openai-responses",
        baseUrl: "https://example.com/v1",
        models: ["fixture-model"],
        defaultModel: "fixture-model",
      },
    },
  } as OcxConfig;
  saveConfigPreservingClaudeCode(config);
  return config;
}

afterEach(() => {
  resetLabAutomationRuntimeForTests();
  requestLabAutomationShutdown();
  stopLabAutomationScheduler();
  resetLabAutomationSchedulerStateForTests();
  resetCompatibilityVersionCacheForTests();
  delete process.env.OPENCODEX_HOME;
  for (const dir of HOMES.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Compatibility Lab runtime integration regressions", () => {
  test("explicit live management run lazily installs production dispatch while integration is off", async () => {
    const home = tempHome();
    const config = persistedLiveConfig(home);
    const req = new ManagementRequest("http://127.0.0.1/api/lab/automation/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidenceLayer: "live_route_compatibility",
        scenarioId: "responses-core.live.basic-turn",
        providerName: "fixture-provider",
        modelId: "fixture-model",
      }),
    });
    const res = await handleManagementAPI(req, new URL(req.url), config);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.run.state).not.toBe("queued");
    expect(body.run.state).not.toBe("running");
    expect(body.run.terminalCode).not.toBe("route_ineligible");
  });

  test("management automation enable persists the server runtime gate", async () => {
    tempHome();
    const config = emptyConfig();
    let savedConfig: OcxConfig | undefined;
    const req = new ManagementRequest("http://127.0.0.1/api/lab/automation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        policy: {
          enabled: true,
          layers: {
            protocolConformance: true,
            liveRouteCompatibility: false,
            taskEffectiveness: false,
          },
        },
      }),
    });
    const res = await handleManagementAPI(req, new URL(req.url), config, {
      saveConfigPreservingClaudeCode: (next) => {
        savedConfig = next;
      },
    });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(savedConfig?.labIntegrationEnabled).toBe(true);
    expect(loadLabAutomationConfig().policy.enabled).toBe(true);
  });

  test("CLI automation enable persists the server runtime gate", async () => {
    const home = tempHome();
    const config = emptyConfig();
    let savedConfig: OcxConfig | undefined;
    expect(await handleLabCommand(["automation", "enable", "--protocol", "--json"], {
      configDir: home,
      loadConfig: () => config,
      saveConfig: (next) => {
        savedConfig = next;
      },
    })).toBe(0);
    expect(savedConfig?.labIntegrationEnabled).toBe(true);
    expect(loadLabAutomationConfig(home).policy.enabled).toBe(true);
  });
});
