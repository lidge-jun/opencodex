// The CLI first-party picker advertises Desktop 3P registry aliases; a CLI-classified request using one
// stays the Code surface, while a Desktop entrypoint keeps the Desktop attribution.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { buildDesktop3pRegistry } from "../../src/claude/desktop-3p";
import { startServer } from "../../src/server";
import { clearRequestLogsForTests, getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { managementFetch as fetch } from "../helpers/management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let previousDesktopConfigDir: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-cli-picker-surface-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-cli-picker-surface-"));
  process.env.OPENCODEX_HOME = testDir;
  previousDesktopConfigDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(testDir, "claude-desktop");
});

afterEach(() => {
  buildDesktop3pRegistry([], []);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDesktopConfigDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDesktopConfigDir;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function chatUpstream() {
  return Bun.serve({
    port: 0,
    fetch() {
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
}

test("a registry alias from a CLI User-Agent is the Code surface; a Desktop entrypoint stays Desktop", async () => {
  const upstream = chatUpstream();
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: new URL("/v1", upstream.url).href, apiKey: "k", allowPrivateNetwork: true } },
  } as OcxConfig);
  const server = startServer(0);
  try {
    buildDesktop3pRegistry([], [{ provider: "mock", id: "test-model" }], {
      version: 1, assignments: { "mock/test-model": { family: "opus", alias: "claude-opus-4-8-20260201" } },
      defaults: { opus: "mock/test-model", fable: null, sonnet: null, haiku: null },
    });
    const surfaces: Array<string | undefined> = [];
    for (const userAgent of ["claude-cli/2.1.287 (external, cli)", "claude-cli/2.1.287 (external, claude-desktop)"]) {
      clearRequestLogsForTests();
      const response = await fetch(new URL("/v1/messages", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "placeholder", "anthropic-version": "2023-06-01", "user-agent": userAgent },
        body: JSON.stringify({ model: "claude-opus-4-8-20260201", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      surfaces.push(getRequestLogEntries().at(-1)?.surface);
    }
    expect(surfaces).toEqual(["claude", "claude-desktop"]);
  } finally {
    await server.stop(true);
    await upstream.stop(true);
  }
});

