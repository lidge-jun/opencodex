import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath, repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const marker = "oauth-cli-provider-response-marker";
const moduleUrl = (...name: string[]) => JSON.stringify(pathToFileURL(repoPath("src", ...name)).href);
const publicMessage = "OAuth authentication failed. Check the OpenCodex account status and retry.";

/** Run one `ocx login` in a child process: the failure path ends in process.exit. */
async function runLoginChild(script: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const home = mkdtempSync(join(tmpdir(), "ocx-login-errors-"));
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot(),
    env: { ...process.env, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex") },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    child.kill();
    await child.exited;
    removeTreeWithRetry(home);
  }
}

for (const scenario of [
  { provider: "anthropic", status: 400, body: JSON.stringify({ error: marker }), diagnostic: "HTTP 400" },
  { provider: "anthropic", status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: marker }), diagnostic: "HTTP 400 invalid_grant" },
  { provider: "anthropic", status: 503, body: marker, diagnostic: "HTTP 503" },
  { provider: "xai", status: 400, body: JSON.stringify({ error: marker, error_description: marker }), diagnostic: "HTTP 400" },
  { provider: "xai", status: 400, body: JSON.stringify({ error: "invalid_grant", error_description: marker }), diagnostic: "HTTP 400 invalid_grant" },
  { provider: "anthropic", status: 200, body: marker, diagnostic: "oauth_authentication_failed" },
  { provider: "anthropic", status: 0, body: marker, diagnostic: "network_error" },
  { provider: "xai", status: 0, body: marker, diagnostic: "network_error" },
]) {
  const label = scenario.status === 0 ? "an unreachable token endpoint" : `token HTTP ${scenario.status} (${scenario.diagnostic})`;
  test(`${scenario.provider} login prints a fixed error for ${label}`, async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => {
        requests++;
        return new Response(scenario.body, { status: scenario.status });
      },
    });
    const endpoint = JSON.stringify(`http://127.0.0.1:${server.port}/token`);
    // A stopped listener leaves a port that refuses connections.
    if (scenario.status === 0) await server.stop(true);
    try {
      const { stdout, stderr, code } = await runLoginChild(`
        import { handleLogin } from ${moduleUrl("oauth", "login-cli.ts")};
        import { OAUTH_PROVIDERS } from ${moduleUrl("oauth", "index.ts")};
        import { AnthropicOAuthFlow } from ${moduleUrl("oauth", "anthropic.ts")};
        import { postXaiToken } from ${moduleUrl("oauth", "xai.ts")};
        const localFetch = globalThis.fetch;
        globalThis.fetch = (_input, init) => localFetch(${endpoint}, init);
        OAUTH_PROVIDERS[${JSON.stringify(scenario.provider)}].login = async ctrl => {
          if (${JSON.stringify(scenario.provider)} === "xai") {
            return await postXaiToken(${endpoint}, { grant_type: "authorization_code", code: "test-code" }, undefined, { sleep: async () => {}, random: () => 0 });
          }
          return await new AnthropicOAuthFlow(ctrl).exchangeToken("test-code", "test-state", "http://127.0.0.1/callback");
        };
        await handleLogin(${JSON.stringify(scenario.provider)}, { ask: async () => "" });
      `);
      expect(requests).toBe(scenario.status === 0 ? 0 : 1);
      expect(stderr).not.toContain(marker);
      expect(stderr.trim()).toBe(`❌ OAuth login failed (${scenario.diagnostic}): ${publicMessage}`);
      expect(code).toBe(1);
      expect(stdout).not.toContain("Logged in");
    } finally {
      await server.stop(true);
    }
  });
}

test("a non-Error login rejection prints fixed text and exits unsuccessfully", async () => {
  const { stdout, stderr, code } = await runLoginChild(`
    import { handleLogin } from ${moduleUrl("oauth", "login-cli.ts")};
    await handleLogin("anthropic", {
      ask: async () => "",
      runLogin: async () => { throw ${JSON.stringify(marker)}; },
    });
  `);
  expect(stderr).not.toContain(marker);
  expect(stderr.trim()).toBe(`❌ OAuth login failed (oauth_authentication_failed): ${publicMessage}`);
  expect(code).toBe(1);
  expect(stdout).not.toContain("Logged in");
});

test("a Codex account namespace collision is reported as configuration before any login starts", async () => {
  const { stdout, stderr, code } = await runLoginChild(`
    import { handleLogin } from ${moduleUrl("oauth", "login-cli.ts")};
    import { OAUTH_PROVIDERS } from ${moduleUrl("oauth", "index.ts")};
    import { loadConfig, saveConfig } from ${moduleUrl("config.ts")};
    const config = loadConfig();
    config.codexAccountNamespaces = { anthropic: "pool-a" };
    saveConfig(config);
    if (!loadConfig().codexAccountNamespaces?.anthropic) throw new Error("fixture namespace was not persisted");
    OAUTH_PROVIDERS.anthropic.login = async () => { console.log("login started"); throw new Error(${JSON.stringify(marker)}); };
    await handleLogin("anthropic", { ask: async () => "" });
  `);
  expect(stderr.trim()).toBe(
    "❌ OAuth login failed (configuration_error): provider name must not collide with a configured Codex account namespace",
  );
  expect(stdout).not.toContain("login started");
  expect(code).toBe(1);
});

for (const scenario of [
  {
    label: "an existing custom anthropic2 row",
    setup: `writeFileSync(configPath, JSON.stringify({ providers: { anthropic2: { adapter: "openai", baseUrl: "https://example.invalid/v1", apiKey: ${JSON.stringify(marker)} } } }));`,
    message: "anthropic2 is already configured as a custom provider; rename the custom provider before logging in to Pool 2.",
  },
  {
    label: "malformed config",
    setup: `writeFileSync(configPath, ${JSON.stringify(`{ "providers": ${marker}`)});`,
    message: publicMessage,
  },
  {
    label: "unreadable config",
    setup: "mkdirSync(configPath);",
    message: publicMessage,
  },
]) {
  test(`anthropic2 preflight reports configuration_error for ${scenario.label} before prompting`, async () => {
    const { stdout, stderr, code } = await runLoginChild(`
      import { mkdirSync, writeFileSync } from "node:fs";
      import { dirname } from "node:path";
      import { handleLogin } from ${moduleUrl("oauth", "login-cli.ts")};
      import { getConfigPath } from ${moduleUrl("config", "paths.ts")};
      const configPath = getConfigPath();
      mkdirSync(dirname(configPath), { recursive: true });
      ${scenario.setup}
      await handleLogin("anthropic2", {
        ask: async () => { console.log("prompt started"); return ""; },
        runLogin: async () => { console.log("login started"); throw new Error(${JSON.stringify(marker)}); },
        openUrl: async () => { console.log("browser started"); return { status: "started" }; },
      });
    `);
    expect(code).toBe(1);
    expect(stderr.trim()).toBe(`❌ OAuth login failed (configuration_error): ${scenario.message}`);
    expect(stdout.trim()).toBe("");
    expect(stderr).not.toContain(marker);
  });
}
