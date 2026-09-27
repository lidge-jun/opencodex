import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";

// Shared fixture for the isolated-subprocess settings tests: the ownership predicate
// binds CODEX_CONFIG_PATH to CODEX_HOME at module load, so each case runs in a child
// whose env is fixed before the module graph loads. The child timeout stays below
// the test timeout so a wedged child fails as a timeout, not a hanging test.
const ISOLATED_PROVIDER_CONFIG = {
  port: 10100,
  defaultProvider: "openai",
  providers: {
    openai: {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-secret-value",
      defaultModel: "gpt-test",
    },
  },
};

function runIsolatedSettingsRequest(options: {
  root: string;
  codexHome: string;
  routeConfig: Record<string, unknown>;
  // The request-specific tail: must produce `response` before the shared print.
  scriptBody: string;
}): { status: number; body: Record<string, unknown> } {
  const script = `
    const { handleManagementAPI } = await import("./src/server/management-api");
    const { startupHealthFixture } = await import("./tests/helpers/startup-health");
    const { catalogConvergenceFactory } = await import("./tests/helpers/catalog-convergence");
    const config = JSON.parse(process.env.OCX_TEST_ROUTE_CONFIG);
    ${options.scriptBody}
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      CODEX_HOME: options.codexHome,
      OPENCODEX_HOME: join(options.root, "opencodex"),
      OCX_TEST_ROUTE_CONFIG: JSON.stringify(options.routeConfig),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (child.status !== 0) {
    // A timeout or spawn failure leaves no output; surface status/signal/error
    // so the diagnostic still names the cause instead of a bare colon.
    const cause = child.error ? ` (${child.error.name}: ${child.error.message})` : "";
    throw new Error(`isolated settings request failed (status=${child.status} signal=${child.signal})${cause}: ${child.stderr || child.stdout}`);
  }
  const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
  expect(line).toBeDefined();
  return JSON.parse(line!) as { status: number; body: Record<string, unknown> };
}
test("PUT /api/settings reports Codex write-lock contention as retryable", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-settings-desktop-switch-"));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  const previousOcxHome = process.env.OPENCODEX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = join(root, "opencodex");
  process.env.CODEX_HOME = codexHome;

  const codexInject = await import("../../src/codex/inject");
  const injectionSpy = spyOn(codexInject, "injectCodexConfig").mockResolvedValue({
    success: false,
    retryable: true,
    message: "another Codex config writer owns the lock",
  });

  try {
    const [{ writeRuntimePort }, { handleManagementAPI }, { catalogConvergenceFactory }, { startupHealthFixture }] = await Promise.all([
      import("../../src/config/process-state"),
      import("../../src/server/management-api"),
      import("../helpers/catalog-convergence"),
      import("../helpers/startup-health"),
    ]);
    const config = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-chat" as const,
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-secret-value",
          defaultModel: "gpt-test",
        },
      },
    };
    writeRuntimePort({ pid: process.pid, port: config.port });
    const request = new Request("http://127.0.0.1:10100/api/settings", {
      method: "PUT",
      // `host` is not optional here. `managementRequestOrigin` derives the allowed origin
      // from the Host header, and an in-process `new Request` carries none, so the settings
      // handler is never reached and the response is a 403 cross-origin rejection.
      headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
      body: JSON.stringify({ codexDesktopAuthless: true }),
    });
    const response = await handleManagementAPI(request, new URL(request.url), config, {
      saveConfigPreservingClaudeCode: () => {},
      getCachedStartupHealth: async () => startupHealthFixture(),
      createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
    });

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      codexDesktopAuthless: true,
      codexDesktopSwitches: {
        apply: {
          applied: false,
          reason: "write_lock_busy",
          retryable: true,
          detail: "another Codex config writer owns the lock",
        },
      },
    });
    expect(injectionSpy).toHaveBeenCalledTimes(1);
  } finally {
    injectionSpy.mockRestore();
    if (previousOcxHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOcxHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    removeTreeWithRetry(root);
  }
});

test("GET /api/settings reports external Codex ownership without an apply attempt", () => {
  // The ownership predicate reads CODEX_CONFIG_PATH, which is bound to CODEX_HOME at module
  // load, so an externally owned config.toml must live in a home fixed before the child
  // process starts — mutating process.env here would not move the already-bound path.
  const root = mkdtempSync(join(tmpdir(), "ocx-settings-external-get-"));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model_provider = "custom"\n', "utf8");

  try {
    const response = runIsolatedSettingsRequest({
      root,
      codexHome,
      routeConfig: {
        ...ISOLATED_PROVIDER_CONFIG,
        codexDesktopAuthless: true,
        codexClientCompaction: true,
      },
      scriptBody: `
        const request = new Request("http://127.0.0.1:10100/api/settings", {
          // Same requirement as the in-process cases: managementRequestOrigin derives the
          // allowed origin from the Host header, and a constructed Request carries none.
          headers: { host: "127.0.0.1:10100" },
        });
        const response = await handleManagementAPI(request, new URL(request.url), config, {
          getCachedStartupHealth: async () => startupHealthFixture(),
        });
      `,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      codexDesktopSwitches: {
        codexDesktopAuthless: { stored: true, effective: null },
        codexClientCompaction: { stored: true, effective: null },
        apply: { applied: false, reason: "external_provider", retryable: false },
        authSource: { presentsCodexAccount: null },
      },
    });
  } finally {
    removeTreeWithRetry(root);
  }
}, 15_000);

test("GET /api/settings survives an unreadable config.toml during ownership detection", () => {
  // existsSync passes but readFileSync throws: config.toml as a directory is a
  // deterministic stand-in for a permission error or a delete racing the read.
  const root = mkdtempSync(join(tmpdir(), "ocx-settings-unreadable-cfg-"));
  const codexHome = join(root, "codex");
  mkdirSync(join(codexHome, "config.toml"), { recursive: true });

  try {
    const response = runIsolatedSettingsRequest({
      root,
      codexHome,
      routeConfig: {
        ...ISOLATED_PROVIDER_CONFIG,
        codexDesktopAuthless: true,
        codexClientCompaction: true,
      },
      scriptBody: `
        const request = new Request("http://127.0.0.1:10100/api/settings", {
          headers: { host: "127.0.0.1:10100" },
        });
        const response = await handleManagementAPI(request, new URL(request.url), config, {
          getCachedStartupHealth: async () => startupHealthFixture(),
        });
      `,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      codexDesktopSwitches: {
        codexDesktopAuthless: { stored: true, effective: null },
        codexClientCompaction: { stored: true, effective: null },
        apply: { applied: false, reason: "ownership_undetermined", retryable: true },
        authSource: { presentsCodexAccount: null },
      },
    });
  } finally {
    removeTreeWithRetry(root);
  }
}, 15_000);

test("PUT /api/settings keeps the undetermined-ownership explanation on a locked save", () => {
  // clientIntegrations.codex = false trips the apply gate before the injector runs, and an
  // unreadable config.toml leaves ownership undetermined. The locked save must still report
  // that explanation instead of collapsing to integration_disabled — the GET path and the
  // switch PUT then agree on what could not be read.
  const root = mkdtempSync(join(tmpdir(), "ocx-settings-undetermined-put-"));
  const codexHome = join(root, "codex");
  mkdirSync(join(codexHome, "config.toml"), { recursive: true });

  try {
    const response = runIsolatedSettingsRequest({
      root,
      codexHome,
      routeConfig: {
        ...ISOLATED_PROVIDER_CONFIG,
        clientIntegrations: { codex: false },
      },
      scriptBody: `
        const request = new Request("http://127.0.0.1:10100/api/settings", {
          method: "PUT",
          headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
          body: JSON.stringify({ codexDesktopAuthless: true }),
        });
        const response = await handleManagementAPI(request, new URL(request.url), config, {
          saveConfigPreservingClaudeCode: () => {},
          getCachedStartupHealth: async () => startupHealthFixture(),
          createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
        });
      `,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      codexDesktopSwitches: {
        codexDesktopAuthless: { stored: true, effective: null },
        apply: {
          applied: false,
          reason: "ownership_undetermined",
          retryable: true,
          detail: expect.stringContaining("ownership could not be determined"),
        },
        authSource: { presentsCodexAccount: null },
      },
    });
  } finally {
    removeTreeWithRetry(root);
  }
}, 15_000);

test("PUT /api/settings reports external Codex ownership when the integration is disabled", () => {
  // clientIntegrations.codex = false trips the apply gate before the injector runs, so
  // the ownership classification has to happen inside applyCodexConfigInjection itself.
  // Same subprocess boundary as the GET cases: the ownership predicate binds CODEX_HOME
  // at module load.
  const root = mkdtempSync(join(tmpdir(), "ocx-settings-external-put-"));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model_provider = "custom"\n', "utf8");

  try {
    const response = runIsolatedSettingsRequest({
      root,
      codexHome,
      routeConfig: {
        ...ISOLATED_PROVIDER_CONFIG,
        clientIntegrations: { codex: false },
      },
      scriptBody: `
        const request = new Request("http://127.0.0.1:10100/api/settings", {
          method: "PUT",
          headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
          body: JSON.stringify({ codexDesktopAuthless: true }),
        });
        const response = await handleManagementAPI(request, new URL(request.url), config, {
          saveConfigPreservingClaudeCode: () => {},
          getCachedStartupHealth: async () => startupHealthFixture(),
          createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
        });
      `,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      codexDesktopSwitches: {
        codexDesktopAuthless: { stored: true, effective: null },
        apply: { applied: false, reason: "external_provider", retryable: false },
        authSource: { presentsCodexAccount: null },
      },
    });
  } finally {
    removeTreeWithRetry(root);
  }
}, 15_000);

test("post-gate injector read failure retains undetermined ownership and null effective state", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-settings-post-gate-"));
  const codexHome = join(root, "codex");
  mkdirSync(join(codexHome, "config.toml"), { recursive: true });
  try {
    const result = runIsolatedSettingsRequest({ root, codexHome,
      routeConfig: { ...ISOLATED_PROVIDER_CONFIG, clientIntegrations: { codex: true } },
      scriptBody: `
        const { writeRuntimePort } = await import("./src/config/process-state");
        writeRuntimePort({ pid: process.pid, port: config.port });
        const request = new Request("http://127.0.0.1:10100/api/settings", {
          method: "PUT", headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
          body: JSON.stringify({ codexDesktopAuthless: true, codexClientCompaction: true }),
        });
        const response = await handleManagementAPI(request, new URL(request.url), config, {
          saveConfigPreservingClaudeCode: () => {},
          getCachedStartupHealth: async () => startupHealthFixture(),
          createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
        });
      `,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ codexDesktopSwitches: {
      codexDesktopAuthless: { stored: true, effective: null },
      codexClientCompaction: { stored: true, effective: null },
      apply: { applied: false, reason: "ownership_undetermined", retryable: true },
      authSource: { presentsCodexAccount: null },
    } });
  } finally { removeTreeWithRetry(root); }
}, 15000);
