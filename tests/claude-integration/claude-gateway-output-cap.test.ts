import { afterEach, beforeEach, expect, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let previousDesktopConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-endpoint-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-endpoint-"));
  process.env.OPENCODEX_HOME = testDir;
  previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
  globalThis.fetch = originalFetch;
});

afterEach(async () => {
  if (testDir) await flushConfigDirHardeningAndReaps(testDir);
  if (isolatedCodexHome) await flushConfigDirHardeningAndReaps(isolatedCodexHome.path);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  globalThis.fetch = originalFetch;
  if (testDir) removeTreeWithRetry(testDir);
});

test("non-canonical openai-responses Claude route keeps the caller's max_tokens cap", async () => {
  let body: Record<string, unknown> | undefined;
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      body = await req.json() as Record<string, unknown>;
      return new Response([
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "Hello" })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2 } } })}\n\n`,
      ].join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  saveConfig({
    port: 0,
    defaultProvider: "gateway",
    providers: {
      gateway: { adapter: "openai-responses", baseUrl: `${upstream.url.toString().replace(/\/$/, "")}/v1`, apiKey: "k", allowPrivateNetwork: true },
    },
  } as OcxConfig);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gateway/gpt-test", max_tokens: 128, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(body?.max_output_tokens).toBe(128);
  } finally {
    await server.stop(true);
    upstream.stop(true);
  }
});

