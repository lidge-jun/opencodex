import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { managementFetch as fetch } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("provider management validates verbosity records without replacing valid config", async () => {
  const testDir = mkdtempSync(join(tmpdir(), "ocx-provider-verbosity-"));
  const previousHome = process.env.OPENCODEX_HOME;
  const previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  const isolatedCodexHome = installIsolatedCodexHome("ocx-provider-verbosity-codex-");
  process.env.OPENCODEX_HOME = testDir;
  let server: ReturnType<typeof startServer> | undefined;
  try {
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    server = startServer(0);
    const acceptedVerbosityCapability = await fetch(new URL("/api/providers", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "custom-verbosity-capability",
        provider: {
          adapter: "openai-responses",
          baseUrl: "https://api.example.test/v1",
          modelSupportsVerbosity: { terse: false },
        },
      }),
    });
    expect(acceptedVerbosityCapability.status).toBe(200);
    for (const invalid of [[], { terse: "false" }, { "": false }]) {
      const rejected = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-verbosity-capability",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://api.example.test/v1",
            modelSupportsVerbosity: invalid,
          },
        }),
      });
      expect(rejected.status).toBe(400);
    }
    expect(loadConfig().providers["custom-verbosity-capability"].modelSupportsVerbosity).toEqual({ terse: false });
  } finally {
    await server?.stop(true);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
    else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
    isolatedCodexHome.restore();
    removeTreeWithRetry(testDir);
  }
}, 60_000);
