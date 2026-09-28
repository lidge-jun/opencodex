import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedCodexConfig } from "../../src/codex/inject/bounded-config-reader";
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

/**
 * Same isolation boundary as the settings cases, for the restore path: CODEX_HOME must
 * be fixed before the module graph binds CODEX_CONFIG_PATH. The child's last stdout line
 * is the JSON result; earlier lines may be the restore machinery's own logs.
 */
function runIsolatedCodexScript(options: {
  root: string;
  codexHome: string;
  script: string;
}): Record<string, unknown> {
  const child = spawnSync(process.execPath, ["--eval", options.script], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      CODEX_HOME: options.codexHome,
      OPENCODEX_HOME: join(options.root, "opencodex"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (child.status !== 0) {
    const cause = child.error ? ` (${child.error.name}: ${child.error.message})` : "";
    throw new Error(`isolated codex script failed (status=${child.status} signal=${child.signal})${cause}: ${child.stderr || child.stdout}`);
  }
  const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
  expect(line).toBeDefined();
  return JSON.parse(line!) as Record<string, unknown>;
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

test.skipIf(process.platform === "win32")(
  "GET /api/settings refuses a config.toml FIFO without blocking",
  () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-settings-fifo-cfg-"));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    const fifo = spawnSync("mkfifo", [join(codexHome, "config.toml")], { encoding: "utf8" });
    expect(fifo.status).toBe(0);

    try {
      const response = runIsolatedSettingsRequest({
        root,
        codexHome,
        routeConfig: ISOLATED_PROVIDER_CONFIG,
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
          apply: { applied: false, reason: "ownership_undetermined", retryable: true },
        },
      });
    } finally {
      removeTreeWithRetry(root);
    }
  },
  15_000,
);

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

test("readBoundedCodexConfig returns null only for a config absent at lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-bounded-reader-"));
  try {
    expect(readBoundedCodexConfig(join(root, "config.toml"))).toBeNull();
    writeFileSync(join(root, "config.toml"), 'model_provider = "custom"\n');
    expect(readBoundedCodexConfig(join(root, "config.toml"))).toContain('"custom"');
    // Present but unreadable-as-a-bounded-regular-file is a throw, not a null.
    mkdirSync(join(root, "as-dir.toml"));
    expect(() => readBoundedCodexConfig(join(root, "as-dir.toml"))).toThrow();
    writeFileSync(join(root, "big.toml"), `# ${"x".repeat(1024 * 1024)}\nmodel = "gpt-5.5"\n`);
    expect(() => readBoundedCodexConfig(join(root, "big.toml"))).toThrow();
  } finally {
    removeTreeWithRetry(root);
  }
});

test.skipIf(process.platform === "win32")(
  "readBoundedCodexConfig resolves a symlinked config to a bounded regular target",
  () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-bounded-link-"));
    try {
      writeFileSync(join(root, "dotfiles-codex.toml"), 'model_provider = "custom"\n');
      symlinkSync(join(root, "dotfiles-codex.toml"), join(root, "config.toml"));
      expect(readBoundedCodexConfig(join(root, "config.toml"))).toContain('"custom"');
      // A link does not launder an unsafe target: the descriptor check still refuses it.
      symlinkSync("/dev/null", join(root, "null.toml"));
      expect(() => readBoundedCodexConfig(join(root, "null.toml"))).toThrow();
      symlinkSync(join(root, "missing.toml"), join(root, "dangling.toml"));
      expect(readBoundedCodexConfig(join(root, "dangling.toml"))).toBeNull();
    } finally {
      removeTreeWithRetry(root);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "GET /api/settings reads ownership through a symlinked config.toml",
  () => {
    // Codex and the injector read the link's target, so the bounded observation must
    // too — otherwise settings reports undetermined for a config that plainly selects
    // an external provider.
    const root = mkdtempSync(join(tmpdir(), "ocx-settings-link-cfg-"));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(root, "dotfiles-codex.toml"), 'model_provider = "custom"\n');
    symlinkSync(join(root, "dotfiles-codex.toml"), join(codexHome, "config.toml"));

    try {
      const response = runIsolatedSettingsRequest({
        root,
        codexHome,
        routeConfig: ISOLATED_PROVIDER_CONFIG,
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
          apply: { applied: false, reason: "external_provider", retryable: false },
        },
      });
    } finally {
      removeTreeWithRetry(root);
    }
  },
  15_000,
);

test.skipIf(process.platform === "win32")(
  "native restore still classifies a symlinked config.toml's target",
  () => {
    // Regression for the shared ownership probe: a link to a small regular config must
    // produce the external-provider result, not an early exit that leaves injected
    // routing pointed at a stopped proxy.
    const root = mkdtempSync(join(tmpdir(), "ocx-restore-link-cfg-"));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(root, "dotfiles-codex.toml"), 'model_provider = "custom"\n');
    symlinkSync(join(root, "dotfiles-codex.toml"), join(codexHome, "config.toml"));

    try {
      const result = runIsolatedCodexScript({
        root,
        codexHome,
        script: `
          const { restoreNativeCodex } = await import("./src/codex/inject");
          const result = restoreNativeCodex();
          console.log(JSON.stringify({ success: result.success, externalProvider: result.externalProvider ?? null }));
        `,
      });
      expect(result).toMatchObject({ success: true, externalProvider: "custom" });
    } finally {
      removeTreeWithRetry(root);
    }
  },
  15_000,
);

test("native restore tolerates a config.toml over the observation bound", () => {
  // A valid config larger than the 1 MiB observation bound must still classify as
  // external — the read/write ownership probe is not the bounded settings reader.
  const root = mkdtempSync(join(tmpdir(), "ocx-restore-big-cfg-"));
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), `# ${"x".repeat(1024 * 1024)}\nmodel_provider = "custom"\n`);

  try {
    const result = runIsolatedCodexScript({
      root,
      codexHome,
      script: `
        const { restoreNativeCodex } = await import("./src/codex/inject");
        const result = restoreNativeCodex();
        console.log(JSON.stringify({ success: result.success, externalProvider: result.externalProvider ?? null }));
      `,
    });
    expect(result).toMatchObject({ success: true, externalProvider: "custom" });
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
