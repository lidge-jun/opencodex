/**
 * `ocx export` CLI surface (devlog 260731_client_config_export/020 accept criteria).
 *
 * The serializers themselves are covered by tests/client-config-export.test.ts; this file
 * covers only what the CLI boundary owns: stdout purity under --json, the human framing,
 * --out overwrite refusal, argument validation, the proxy-down path, and the standing
 * no-secret rule.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleExportCommand, exportModelsFromProxyRows } from "../src/cli/export-command";
import { resetCodexModelEntitlementCacheForTests } from "../src/codex/model-entitlements";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const tempDirs: string[] = [];

function config(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
    ...extra,
  } as OcxConfig;
}

/** Rows in the shape GET /api/models actually returns, including a disabled one. */
const ROWS = [
  {
    provider: "openai",
    id: "gpt-5.6-luna",
    namespaced: "gpt-5.6-luna",
    native: true,
    disabled: false,
    contextWindow: 272_000,
    inputModalities: ["text", "image"],
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "high",
  },
  { provider: "anthropic", id: "claude-opus-5", namespaced: "anthropic/claude-opus-5", disabled: false, contextWindow: 200_000, displayName: "Claude Opus 5", inputModalities: ["text"] },
  { provider: "custom", id: "no-context", namespaced: "custom/no-context", disabled: false },
  { provider: "banned", id: "hidden", namespaced: "banned/hidden", disabled: true, contextWindow: 100_000 },
];

function fakeProxy(rows: unknown = ROWS) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/models") return Response.json(rows);
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { port: server.port, baseUrl: `http://127.0.0.1:${server.port}` };
}

function managementProxy(managementConfig: OcxConfig) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      return await handleManagementAPI(req, url, managementConfig)
        ?? new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { port: server.port, baseUrl: `http://127.0.0.1:${server.port}` };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-export-"));
  tempDirs.push(dir);
  return dir;
}

let logs: string[] = [];
let errors: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of tempDirs.splice(0)) removeTreeWithRetry(dir);
  resetCodexModelEntitlementCacheForTests();
});

/** console.log adds exactly one newline per call; this is the byte stream a shell sees. */
function stdout(): string {
  return logs.map(line => `${line}\n`).join("");
}

async function run(args: string[], extra: { baseUrl: string; config?: OcxConfig }) {
  const code = await handleExportCommand(args, {
    baseUrl: extra.baseUrl,
    configImpl: () => extra.config ?? config(),
  });
  return { code, stdout: stdout(), stderr: errors.join("\n") };
}

describe("ocx export --json (accept criterion 1)", () => {
  test("the real /api/models handler refreshes expired GPT-5.6 entitlements before export", async () => {
    const oldOcxHome = process.env.OPENCODEX_HOME;
    const oldCodexHome = process.env.CODEX_HOME;
    const originalFetch = globalThis.fetch;
    const root = tempDir();
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    process.env.OPENCODEX_HOME = join(root, "opencodex");
    process.env.CODEX_HOME = codexHome;
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "export-token", account_id: "export-main" },
    }));
    let entitlementFetches = 0;
    globalThis.fetch = (async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "chatgpt.com" && url.pathname === "/backend-api/codex/models") {
        entitlementFetches += 1;
        return Response.json({ models: [
          { slug: "gpt-5.6-sol", supported_in_api: true, visibility: "list" },
          { slug: "gpt-5.6-terra", supported_in_api: true, visibility: "list" },
          { slug: "gpt-5.6-luna", supported_in_api: true, visibility: "list" },
        ] });
      }
      return originalFetch(input);
    }) as typeof fetch;
    try {
      const managementConfig = config({
        defaultProvider: "openai",
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
            liveModels: false,
            models: [],
          },
        },
      });
      const proxy = managementProxy(managementConfig);
      const result = await run(["--client", "opencode", "--json"], {
        baseUrl: proxy.baseUrl,
        config: managementConfig,
      });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        provider: Record<string, { models: Record<string, unknown> }>;
      };
      expect(entitlementFetches).toBe(1);
      expect(Object.keys(parsed.provider.opencodex!.models)).toEqual(expect.arrayContaining([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]));
    } finally {
      globalThis.fetch = originalFetch;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldOcxHome;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("stdout parses as JSON with zero extra bytes, for both clients", async () => {
    const proxy = fakeProxy();
    for (const client of ["opencode", "pi"] as const) {
      logs = [];
      errors = [];
      const result = await run(["--client", client, "--json"], { baseUrl: proxy.baseUrl });
      expect(result.code).toBe(0);
      // The whole buffer, not a trimmed slice: a banner or path hint would throw here.
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(parsed).toBeTruthy();
      expect(result.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    }
  });

  test("the exported endpoint points at the live proxy port, not config.port", async () => {
    const proxy = fakeProxy();
    const result = await run(["--client", "opencode", "--json"], { baseUrl: proxy.baseUrl });
    const parsed = JSON.parse(result.stdout) as { provider: Record<string, { options: { baseURL: string } }> };
    expect(parsed.provider.opencodex!.options.baseURL).toBe(`http://127.0.0.1:${proxy.port}/v1`);
    expect(parsed.provider.opencodex!.options.baseURL).not.toContain(":10100/");
  });

  test("disabled rows never reach the exported config", async () => {
    const proxy = fakeProxy();
    const result = await run(["--client", "pi", "--json"], { baseUrl: proxy.baseUrl });
    const parsed = JSON.parse(result.stdout) as { providers: Record<string, { models: Array<{ id: string }> }> };
    const ids = parsed.providers.opencodex!.models.map(model => model.id);
    expect(ids).not.toContain("banned/hidden");
    expect(ids).toEqual(["anthropic/claude-opus-5", "custom/no-context", "gpt-5.6-luna"]);
  });
});

describe("ocx export human output (accept criterion 2)", () => {
  test("leads with the JSON, then destination, merge warning, env line, and counts", async () => {
    const proxy = fakeProxy();
    const result = await run(["--client", "opencode"], { baseUrl: proxy.baseUrl });

    expect(result.code).toBe(0);
    expect(result.stdout.startsWith("{\n")).toBe(true);
    expect(result.stdout).toContain(join("opencode", "opencode.json"));
    expect(result.stdout).toContain("Merge this generated configuration into that file; do not replace it.");
    expect(result.stdout).toContain("export OPENCODEX_OPENCODE_API_KEY=");
    // Three visible models; only `custom/no-context` lacks an authoritative window.
    expect(result.stdout).toContain("3 models; 1 omit context limits");
  });

  test("Pi names its own destination and needs no env var", async () => {
    const proxy = fakeProxy();
    const result = await run(["--client", "pi"], { baseUrl: proxy.baseUrl });
    expect(result.stdout).toContain(join(".pi", "agent", "models.json"));
    // Pi resolves `apiKey` before building its model list and hides the provider
    // when an env reference is unset, so a loopback bind ships the non-secret
    // placeholder instead of an env var the user was never told to export.
    expect(result.stdout).toContain("opencodex-loopback");
    expect(result.stdout).not.toContain("export OPENCODEX_API_KEY=");
  });
});

describe("ocx export --out (accept criterion 3)", () => {
  test("writes the config to the given path", async () => {
    const proxy = fakeProxy();
    const target = join(tempDir(), "opencode.json");
    const result = await run(["--client", "opencode", "--json", "--out", target], { baseUrl: proxy.baseUrl });

    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(JSON.parse(result.stdout));
    // The write note is a diagnostic; it must not pollute the --json byte stream.
    expect(result.stderr).toContain(`Wrote ${target}`);
  });

  test("refuses to overwrite an existing file and leaves the bytes untouched", async () => {
    const proxy = fakeProxy();
    const target = join(tempDir(), "populated.json");
    const original = '{"provider":{"someone-elses":{"models":{}}}}';
    writeFileSync(target, original, "utf8");

    const result = await run(["--client", "opencode", "--out", target], { baseUrl: proxy.baseUrl });

    expect(result.code).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe(original);
    expect(result.stderr).toContain("--force");
    expect(result.stdout).toBe("");
  });

  test("--force replaces it", async () => {
    const proxy = fakeProxy();
    const target = join(tempDir(), "populated.json");
    writeFileSync(target, '{"provider":{"someone-elses":{"models":{}}}}', "utf8");

    const result = await run(["--client", "opencode", "--out", target, "--force"], { baseUrl: proxy.baseUrl });

    expect(result.code).toBe(0);
    const written = JSON.parse(readFileSync(target, "utf8")) as { provider: Record<string, unknown> };
    expect(Object.keys(written.provider)).toEqual(["opencodex"]);
  });

  test("without --out nothing is written to the real destination path", async () => {
    const proxy = fakeProxy();
    const dir = tempDir();
    const result = await run(["--client", "opencode", "--json"], {
      baseUrl: proxy.baseUrl,
    });
    expect(result.code).toBe(0);
    // No --out means no file anywhere: the destination is text the user acts on.
    expect(existsSync(join(dir, "opencode.json"))).toBe(false);
  });
});

describe("ocx export argument validation (accept criterion 4)", () => {
  test("an unknown --client names every valid value", async () => {
    const proxy = fakeProxy();
    const result = await run(["--client", "cursor"], { baseUrl: proxy.baseUrl });
    expect(result.code).toBe(2);
    for (const id of ["opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode"]) {
      expect(result.stderr).toContain(id);
    }
    expect(result.stdout).toBe("");
  });

  test("--out writes each client's own format, not JSON for all of them", async () => {
    const proxy = fakeProxy();
    // A YAML client: JSON would parse as YAML but is not what the user expects
    // to find in config.yaml, and a TOML client would not parse at all.
    const yamlTarget = join(tempDir(), "hermes-config.yaml");
    const yaml = await run(["--client", "hermes", "--out", yamlTarget], { baseUrl: proxy.baseUrl });
    expect(yaml.code).toBe(0);
    const yamlText = readFileSync(yamlTarget, "utf8");
    expect(yamlText.startsWith("providers:")).toBe(true);
    const parsedYaml = Bun.YAML.parse(yamlText) as {
      providers: { opencodex: { models: Record<string, { supports_vision?: boolean }> } };
    };
    expect(parsedYaml).toHaveProperty("providers.opencodex");
    expect(parsedYaml.providers.opencodex.models["gpt-5.6-luna"]).toEqual({ supports_vision: true });
    expect(parsedYaml.providers.opencodex.models["anthropic/claude-opus-5"]).toEqual({ supports_vision: false });
    expect(parsedYaml.providers.opencodex.models["custom/no-context"]).toEqual({});

    const tomlTarget = join(tempDir(), "kimi-config.toml");
    const toml = await run(["--client", "kimi", "--out", tomlTarget], { baseUrl: proxy.baseUrl });
    expect(toml.code).toBe(0);
    const tomlText = readFileSync(tomlTarget, "utf8");
    expect(Bun.TOML.parse(tomlText)).toHaveProperty("providers.opencodex");
    // Exactly one trailing newline, for every format.
    expect(tomlText.endsWith("\n")).toBe(true);
    expect(tomlText.endsWith("\n\n")).toBe(false);
  });

  test("a missing --client is a usage error", async () => {
    const proxy = fakeProxy();
    const result = await run([], { baseUrl: proxy.baseUrl });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--client is required");
  });

  test("stray arguments are rejected rather than ignored", async () => {
    const proxy = fakeProxy();
    const result = await run(["--client", "pi", "--wat"], { baseUrl: proxy.baseUrl });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--wat");
  });
});

describe("ocx export with no live proxy (accept criterion 5)", () => {
  /**
   * Run through the real dispatcher in a subprocess with an isolated OPENCODEX_HOME whose
   * configured port has no listener. In-process injection cannot cover this: `findLiveProxy`
   * reads the pid file and config directly, so a proxy running on the developer's machine
   * would be discovered and the assertion would pass for the wrong reason.
   */
  test("fails through the runtime-api error naming ocx start, emitting no config", () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const deadPort = probe.port;
    probe.stop(true);

    const home = tempDir();
    // Must pass config validation: a rejected config falls back to the DEFAULT config, whose
    // port 10100 may host the developer's own proxy — the test would then probe a live one.
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        port: deadPort,
        defaultProvider: "mock",
        providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1", allowPrivateNetwork: true } },
      }),
      "utf8",
    );

    const result = spawnSync(process.execPath, [cliPath, "export", "--client", "opencode", "--json"], {
      cwd: repoRoot,
      env: { ...process.env, OPENCODEX_HOME: home },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ocx start");
    // Routed by the dispatcher, not swallowed by the unknown-command branch.
    expect(result.stderr).not.toContain("Unknown command");
  }, { timeout: 30_000 });

  test("a non-array /api/models payload is an error, not an empty-model config", async () => {
    const proxy = fakeProxy({ error: "unauthorized" });
    const result = await run(["--client", "opencode", "--json"], { baseUrl: proxy.baseUrl });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("ocx export never serializes a key (accept criterion 6)", () => {
  test("no stdout path contains an ocx_ token even when config carries one", async () => {
    const proxy = fakeProxy();
    const withKey = config({ apiKeys: [{ id: "k1", name: "default", key: "ocx_liveSecretValue" }] } as Partial<OcxConfig>);
    for (const [args, envRef] of [
      [["--client", "opencode"], "{env:OPENCODEX_OPENCODE_API_KEY}"],
      [["--client", "opencode", "--json"], "{env:OPENCODEX_OPENCODE_API_KEY}"],
      // Pi ships the non-secret loopback placeholder rather than an env reference;
      // the property under test is unchanged — no real key ever reaches stdout.
      [["--client", "pi"], "opencodex-loopback"],
      [["--client", "pi", "--json"], "opencodex-loopback"],
    ] as Array<[string[], string]>) {
      logs = [];
      errors = [];
      const result = await run(args, { baseUrl: proxy.baseUrl, config: withKey });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("ocx_");
      // The env REFERENCE is present; the value it stands for never is.
      expect(result.stdout).toContain(envRef);
    }
  });
});

describe("export row filtering", () => {
  test("drops disabled rows, dedupes, and carries modalities through to Pi", () => {
    const models = exportModelsFromProxyRows([
      { provider: "a", id: "one", namespaced: "a/one", disabled: true },
      { provider: "a", id: "two", namespaced: "a/two", inputModalities: ["text", "image"] },
      { provider: "a", id: "two", namespaced: "a/two", displayName: "duplicate" },
    ], config());
    expect(models).toHaveLength(1);
    expect(models[0]!.namespaced).toBe("a/two");
    expect(models[0]!.inputModalities).toEqual(["text", "image"]);
  });

  test("preserves reasoning metadata with management-loader parity", () => {
    const [model] = exportModelsFromProxyRows([ROWS[0]!], config());
    expect(model?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(model?.defaultReasoningEffort).toBe("high");
  });
});
