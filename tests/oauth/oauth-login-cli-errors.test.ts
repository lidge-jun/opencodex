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

// Keep the real token exchange, discovery, runLogin and public reporting/settlement paths.
const antigravityFailureSetup = `
  import { OAuthCallbackFlow } from ${moduleUrl("oauth", "callback-server.ts")};
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: ${JSON.stringify(marker)}, refresh_token: ${JSON.stringify(marker)} });
    if (url.includes(":loadCodeAssist")) return Response.json({ [${JSON.stringify(marker)}]: ${JSON.stringify(marker)} });
    if (url.includes(":onboardUser")) return Response.json({ done: true, error: { message: ${JSON.stringify(marker)} } });
    throw new Error("unexpected request");
  };
  OAuthCallbackFlow.prototype.login = async function () {
    const hint = await this.generateAuthUrl("state", "http://127.0.0.1/callback");
    this.ctrl.onAuth?.(hint);
    return this.exchangeToken("code", "state", "http://127.0.0.1/callback");
  };
`;

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

test("Antigravity discovery diagnostics survive CLI reporting without provider text", async () => {
  const { stdout, stderr, code } = await runLoginChild(`
    import { handleLogin } from ${moduleUrl("oauth", "login-cli.ts")};
    ${antigravityFailureSetup}
    await handleLogin("google-antigravity", { ask: async () => "", openUrl: async () => ({ status: "started" }) });
  `);
  expect(code).toBe(1);
  expect(stderr).toContain("Antigravity login could not discover a Cloud Code Assist project");
  expect(stderr).toContain('"stage":"loadCodeAssist","status":200,"root":"object","outcome":"no-project"');
  expect(stderr).toContain('"stage":"onboardUser","status":200,"root":"object","outcome":"done-with-error"');
  expect(stderr).not.toContain(marker);
  expect(stdout).not.toContain("Logged in");
});

test("Antigravity discovery diagnostics survive background login settlement and status", async () => {
  const { stdout, stderr, code } = await runLoginChild(`
    import { startLoginFlow, waitForLoginSettled, getLoginStatus } from ${moduleUrl("oauth", "index.ts")};
    import { getDefaultConfig } from ${moduleUrl("config.ts")};
    import { handleManagementAPI } from ${moduleUrl("server", "management-api.ts")};
    import { ManagementRequest } from ${JSON.stringify(pathToFileURL(repoPath("tests", "helpers", "management-auth.ts")).href)};
    ${antigravityFailureSetup}
    await startLoginFlow("google-antigravity", { forceLogin: true });
    if (!await waitForLoginSettled("google-antigravity", 5000)) throw new Error("login did not settle");
    const req = new ManagementRequest("http://localhost/api/oauth/status?provider=google-antigravity");
    const response = await handleManagementAPI(req, new URL(req.url), getDefaultConfig(), {}, "gui-session");
    console.log(JSON.stringify({ status: getLoginStatus("google-antigravity"), httpStatus: response.status, management: await response.json() }));
  `);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const { status, httpStatus, management } = JSON.parse(stdout.trim());
  expect(httpStatus).toBe(200);
  expect(management).toMatchObject({ error: status.error, loggedIn: false, done: true, status: "error" });
  expect(status).toMatchObject({ loggedIn: false, done: true, status: "error" });
  expect(status.error).toContain("Antigravity login could not discover a Cloud Code Assist project");
  expect(status.error).toContain('"stage":"loadCodeAssist","status":200,"root":"object","outcome":"no-project"');
  expect(status.error).toContain('"stage":"onboardUser","status":200,"root":"object","outcome":"done-with-error"');
  expect(stdout).not.toContain(marker);
});

test("a plain Error cannot impersonate Antigravity diagnostics in CLI or settled status", async () => {
  const { stdout, stderr, code } = await runLoginChild(`
    import { handleLogin } from ${moduleUrl("oauth", "login-cli.ts")};
    import { OAUTH_PROVIDERS, startLoginFlow, waitForLoginSettled, getLoginStatus } from ${moduleUrl("oauth", "index.ts")};
    const error = new Error(${JSON.stringify(marker)});
    error.name = "AntigravityProjectDiscoveryError";
    OAUTH_PROVIDERS["google-antigravity"].login = async ctrl => {
      ctrl.onAuth?.({ url: "https://example.invalid/authorize" });
      throw error;
    };
    await startLoginFlow("google-antigravity", { forceLogin: true });
    if (!await waitForLoginSettled("google-antigravity", 5000)) throw new Error("login did not settle");
    console.log(JSON.stringify(getLoginStatus("google-antigravity")));
    await handleLogin("google-antigravity", { ask: async () => "", runLogin: async () => { throw error; } });
  `);
  expect(code).toBe(1);
  expect(JSON.parse(stdout.trim())).toMatchObject({ error: publicMessage, loggedIn: false, done: true, status: "error" });
  expect(stderr.trim()).toBe(`❌ OAuth login failed (oauth_authentication_failed): ${publicMessage}`);
  expect(stdout + stderr).not.toContain(marker);
});

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
