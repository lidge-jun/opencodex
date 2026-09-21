import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";

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

  const script = `
    const { handleManagementAPI } = await import("./src/server/management-api");
    const { startupHealthFixture } = await import("./tests/helpers/startup-health");
    const config = JSON.parse(process.env.OCX_TEST_ROUTE_CONFIG);
    const request = new Request("http://127.0.0.1:10100/api/settings", {
      // Same requirement as the in-process cases: managementRequestOrigin derives the
      // allowed origin from the Host header, and a constructed Request carries none.
      headers: { host: "127.0.0.1:10100" },
    });
    const response = await handleManagementAPI(request, new URL(request.url), config, {
      getCachedStartupHealth: async () => startupHealthFixture(),
    });
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: join(root, "opencodex"),
      OCX_TEST_ROUTE_CONFIG: JSON.stringify({
        port: 10100,
        defaultProvider: "openai",
        codexDesktopAuthless: true,
        codexClientCompaction: true,
        providers: {
          openai: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            apiKey: "sk-secret-value",
            defaultModel: "gpt-test",
          },
        },
      }),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  try {
    if (child.status !== 0) {
      throw new Error(`isolated settings GET failed: ${child.stderr || child.stdout}`);
    }
    const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
    expect(line).toBeDefined();
    const response = JSON.parse(line!) as { status: number; body: Record<string, unknown> };
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
