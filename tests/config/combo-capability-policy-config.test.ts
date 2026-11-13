import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comboConfigIssues } from "../../src/combos";
import { saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousHome = process.env.OPENCODEX_HOME;
const previousClaude = process.env.CLAUDE_CONFIG_DIR;
let home: string | undefined;

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  if (home) removeTreeWithRetry(home);
  home = undefined;
});

function freshConfig(): OcxConfig {
  home = mkdtempSync(join(tmpdir(), "ocx-capability-policy-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "a",
    providers: { a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"], liveModels: false } },
  };
  saveConfig(config);
  return config;
}

async function comboApi(config: OcxConfig, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const req = new Request("http://localhost/api/combos", {
    method,
    headers: { host: "localhost", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  if (response?.status !== 200) throw new Error(`${response?.status} ${await response?.text()}`);
  return response!.json() as Promise<Record<string, unknown>>;
}

const targets = [{ provider: "a", model: "m1" }];
const providers: OcxConfig["providers"] = {
  a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"], liveModels: false },
};

describe("combo capabilityPolicy config", () => {
  test("rejects values outside the closed sets", () => {
    expect(comboConfigIssues("u", { targets, capabilityPolicy: "primary" }, providers).map(issue => issue.path[0]))
      .toContain("capabilityPolicy");
    expect(comboConfigIssues("u", { targets, onUnservable: "drop" }, providers).map(issue => issue.path[0]))
      .toContain("onUnservable");
    expect(comboConfigIssues("u", { targets, capabilityPolicy: "union", onUnservable: "reject" }, providers)).toEqual([]);
  });

  test("survives a management round trip and stays sparse at the defaults", async () => {
    const config = freshConfig();
    const saved = await comboApi(config, "PUT", { id: "u", combo: { targets, capabilityPolicy: "union", onUnservable: "reject" } });
    expect(saved.combo).toMatchObject({ capabilityPolicy: "union", onUnservable: "reject" });
    expect(config.combos?.u).toMatchObject({ capabilityPolicy: "union", onUnservable: "reject" });
    const listed = await comboApi(config, "GET");
    expect(listed.combos).toEqual([expect.objectContaining({ id: "u", capabilityPolicy: "union", onUnservable: "reject" })]);

    // A whole-combo PUT that omits both (the CLI, an older dashboard) carries them forward.
    await comboApi(config, "PUT", { id: "u", combo: { targets, strategy: "round-robin" } });
    expect(config.combos?.u).toMatchObject({ strategy: "round-robin", capabilityPolicy: "union", onUnservable: "reject" });

    // Explicit defaults clear the stored keys instead of pinning them.
    await comboApi(config, "PUT", { id: "u", combo: { targets, capabilityPolicy: "intersection", onUnservable: "degrade" } });
    expect(config.combos?.u).not.toHaveProperty("capabilityPolicy");
    expect(config.combos?.u).not.toHaveProperty("onUnservable");
  });
});
