/**
 * OCX-12: `ocx provider list --json|--jsonl` marks each configured row `active`. A device linked
 * to a Home (Remote Link Child or Hub-mode client) routes through the Home, so its local rows are
 * shadowed (`active: false`); a standalone device or a Hub serves them (`active: true`). No row
 * may carry a credential value, including one hand-edited into a baseUrl.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localProvidersActive, providerListBaseUrl } from "../../src/cli/provider";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

setDefaultTimeout(SPAWN_BUDGET_MS);

const KEY = `ocx_data_${"f".repeat(40)}`;
// Assembled so the privacy scan does not read the fixture as a real key.
const PROVIDER_SECRET = ["fixture", "provider", "credential", "value"].join("-");
const URL_SECRET = "fixture-url-secret-value";
const LINK_ID = `lnk_${"a".repeat(16)}`;

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-provider-list-active-"));
  for (const dir of ["ocx", "home", "claude", "codex"]) mkdirSync(join(root, dir));
});

afterEach(() => {
  if (root) removeTreeWithRetry(root);
});

const providers = {
  openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
  fixture: {
    adapter: "openai-chat",
    baseUrl: "https://models.example.test/v1",
    apiKey: PROVIDER_SECRET,
    defaultModel: "fixture-model",
    models: ["fixture-model"],
  },
};

function clientBlock(transport: "link" | "hub") {
  return {
    serverUrl: transport === "link" ? "http://127.0.0.1:23458" : "https://hub.example.test",
    managementUrl: transport === "link" ? "http://127.0.0.1:23458" : "https://hub.example.test",
    managementTransport: "direct",
    ...(transport === "link" ? { transport: "link", link: { tunnelPort: 23458, linkId: LINK_ID } } : {}),
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "link-key-1",
    tokenFingerprint: serviceApiTokenFingerprint(KEY),
    protocolVersion: 1,
    connectedAt: "2026-10-01T00:00:00.000Z",
  };
}

function writeConfig(role: "standalone" | "hub" | "link" | "hub-client", extra: Record<string, unknown> = {}): void {
  const linked = role === "link" || role === "hub-client";
  writeFileSync(join(root, "ocx", "config.json"), JSON.stringify({
    port: 10100,
    providers,
    defaultProvider: "openai",
    ...(role === "hub" ? { runtimeRole: "hub" } : {}),
    ...(linked ? { runtimeRole: "client", client: clientBlock(role === "link" ? "link" : "hub") } : {}),
    ...extra,
  }));
  if (linked) writeFileSync(join(root, "ocx", "service-api-token"), `${KEY}\n`, { mode: 0o600 });
}

function runList(flag: "--json" | "--jsonl") {
  const preload = join(root, "no-proxy.ts");
  writeFileSync(preload, `
    import { mock } from "bun:test";
    const path = ${JSON.stringify(repoPath("src/server/proxy-liveness.ts"))};
    const original = await import(path);
    mock.module(path, () => ({ ...original, findLiveProxy: async () => null }));
    globalThis.fetch = () => { throw new Error("fixture network forbidden"); };
  `);
  return spawnSync(process.execPath, ["--preload", preload, repoPath("src/cli/index.ts"), "provider", "list", flag], {
    cwd: repoPath(),
    env: {
      ...process.env,
      OPENCODEX_HOME: join(root, "ocx"),
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CODEX_HOME: join(root, "codex"),
    },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
}

function activeFlags(flag: "--json" | "--jsonl"): Record<string, unknown> {
  const result = runList(flag);
  expect(result.status).toBe(0);
  const rows = flag === "--json"
    ? (JSON.parse(result.stdout) as { configured: Array<Record<string, unknown>> }).configured
    : result.stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return Object.fromEntries(rows.map(row => [row.name, row.active]));
}

describe("ocx provider list active", () => {
  test.each(["--json", "--jsonl"] as const)("a Remote Link Child's rows are shadowed (%s)", flag => {
    writeConfig("link");
    expect(activeFlags(flag)).toEqual({ openai: false, fixture: false });
  });

  test("a Hub-mode client's rows are shadowed", () => {
    writeConfig("hub-client");
    expect(activeFlags("--json")).toEqual({ openai: false, fixture: false });
  });

  test.each(["--json", "--jsonl"] as const)("a standalone device's rows serve (%s)", flag => {
    writeConfig("standalone");
    expect(activeFlags(flag)).toEqual({ openai: true, fixture: true });
  });

  test("a Hub's own rows serve", () => {
    writeConfig("hub");
    expect(activeFlags("--json")).toEqual({ openai: true, fixture: true });
  });

  test("rows carry no credential values", () => {
    writeConfig("link");
    const result = runList("--json");
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(PROVIDER_SECRET);
    expect(result.stdout).not.toContain(KEY);
    expect(JSON.parse(result.stdout).configured).toEqual([
      {
        name: "openai", adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward", defaultModel: null, isDefault: true, source: "registry", models: [], active: false,
      },
      {
        name: "fixture", adapter: "openai-chat", baseUrl: "https://models.example.test/v1",
        authMode: "key", defaultModel: "fixture-model", isDefault: false, source: "custom", models: ["fixture-model"], active: false,
      },
    ]);
  });
});

describe("provider list projections", () => {
  test("baseUrl drops userinfo and masks credential-shaped query values only", () => {
    expect(providerListBaseUrl(`https://user:${URL_SECRET}@models.example.test/v1?api-version=2026-01-01&key=${URL_SECRET}&access_token=${URL_SECRET}`))
      .toBe("https://models.example.test/v1?api-version=2026-01-01&key=redacted&access_token=redacted");
    expect(providerListBaseUrl("https://models.example.test/v1")).toBe("https://models.example.test/v1");
    expect(providerListBaseUrl("not a url")).toBe("not a url");
  });

  test("only a connected client state shadows local rows", () => {
    expect(localProvidersActive(() => ({ kind: "disconnected" }))).toBe(true);
    expect(localProvidersActive(() => ({ kind: "invalid", reason: "fixture" }))).toBe(true);
    expect(localProvidersActive(() => ({ kind: "mismatched", reason: "fixture" }))).toBe(true);
    expect(localProvidersActive(() => { throw new Error("fixture"); })).toBe(true);
    expect(localProvidersActive(() => ({ kind: "connected", value: clientBlock("hub") as never }))).toBe(false);
  });
});

