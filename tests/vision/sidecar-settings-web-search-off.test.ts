/**
 * The web-search sidecar's master switch, which the Dashboard renders as the picker's Off row.
 *
 * Two properties matter beyond "the value is stored": Off has to reach Codex's own
 * `web_search` mode through the injection (a stored-but-unwritten switch would leave the client
 * advertising the native tool the operator just turned off), and a save that does not MOVE the
 * switch must not rewrite `config.toml`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

async function putSidecarSettings(config: OcxConfig, webSearch: Record<string, unknown>): Promise<Response> {
  const url = new URL("http://localhost/api/sidecar-settings");
  const response = await handleManagementAPI(
    new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ webSearch }),
    }),
    url,
    config,
  );
  if (!response) throw new Error("sidecar settings route did not handle PUT");
  return response;
}

function emptyConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "dummy",
    providers: { dummy: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
    ...overrides,
  } as OcxConfig;
}

describe("web-search sidecar master switch", () => {
  let previousHome: string | undefined;
  let isolatedHome: string | undefined;

  function persistedWebSearch(): Record<string, unknown> | undefined {
    const raw = JSON.parse(readFileSync(join(isolatedHome!, "config.json"), "utf8")) as {
      webSearchSidecar?: Record<string, unknown>;
    };
    return raw.webSearchSidecar;
  }

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedHome = mkdtempSync(join(tmpdir(), "ocx-sidecar-web-off-"));
    process.env.OPENCODEX_HOME = isolatedHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (isolatedHome) removeTreeWithRetry(isolatedHome);
    isolatedHome = undefined;
  });

  test("PUT stores the switch and drops the key again on re-enable", async () => {
    const config = emptyConfig({ webSearchSidecar: { model: "gpt-5.6-luna" } });

    const off = await putSidecarSettings(config, { enabled: false });
    expect(off.status).toBe(200);
    expect((await off.json() as { webSearch: { enabled: boolean } }).webSearch.enabled).toBe(false);
    expect(config.webSearchSidecar).toMatchObject({ enabled: false, model: "gpt-5.6-luna" });
    expect(persistedWebSearch()).toMatchObject({ enabled: false, model: "gpt-5.6-luna" });

    const on = await putSidecarSettings(config, { enabled: true });
    expect(on.status).toBe(200);
    expect((await on.json() as { webSearch: { enabled: boolean } }).webSearch.enabled).toBe(true);
    // true is the default — drop the key so a disable/re-enable cycle does not rewrite the file.
    expect("enabled" in (config.webSearchSidecar ?? {})).toBe(false);
    expect(config.webSearchSidecar?.model).toBe("gpt-5.6-luna");
    expect(persistedWebSearch()).toMatchObject({ model: "gpt-5.6-luna" });
    expect("enabled" in (persistedWebSearch() ?? {})).toBe(false);
  });

  test("invalid enabled values are refused without mutation", async () => {
    const config = emptyConfig({ webSearchSidecar: { enabled: false, model: "gpt-5.6-luna" } });
    const snapshot = { ...config.webSearchSidecar };

    for (const enabled of ["false", "true", 0, 1, null, {}]) {
      const response = await putSidecarSettings(config, { enabled });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
      expect(config.webSearchSidecar).toEqual(snapshot);
    }
  });

  test("the Codex config write is attempted only when the switch moves", async () => {
    const { writeRuntimePort } = await import("../../src/config/process-state");
    writeRuntimePort({ pid: process.pid, port: 10100 });
    const codexInject = await import("../../src/codex/inject");
    const injectionSpy = spyOn(codexInject, "injectCodexConfig").mockResolvedValue({
      success: false,
      retryable: true,
      message: "another Codex config writer owns the lock",
    });

    try {
      const config = emptyConfig({ webSearchSidecar: { model: "gpt-5.6-luna" } });

      const moved = await putSidecarSettings(config, { enabled: false });
      expect(moved.status).toBe(200);
      expect(await moved.json()).toMatchObject({
        webSearch: { enabled: false },
        codexWebSearch: {
          applied: false,
          reason: "write_lock_busy",
          retryable: true,
          detail: "another Codex config writer owns the lock",
        },
      });
      expect(injectionSpy).toHaveBeenCalledTimes(1);

      // Re-sending the value that is already stored is not a change: no second write, and the
      // report says so rather than claiming an apply that never ran.
      const unchanged = await putSidecarSettings(config, { enabled: false });
      expect(unchanged.status).toBe(200);
      expect(await unchanged.json()).toMatchObject({ codexWebSearch: { applied: false, reason: "not_requested" } });
      expect(injectionSpy).toHaveBeenCalledTimes(1);

      const unrelated = await putSidecarSettings(config, { streamRoutedModelOutput: true });
      expect(unrelated.status).toBe(200);
      expect(await unrelated.json()).toMatchObject({ codexWebSearch: { reason: "not_requested" } });
      expect(injectionSpy).toHaveBeenCalledTimes(1);
    } finally {
      injectionSpy.mockRestore();
    }
  });
});
