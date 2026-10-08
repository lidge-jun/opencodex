// The Claude usage preflight runs before a claude-cli turn is dispatched. When the request also holds
// the web-search sidecar's cooldown-recovery probe lease, every exit of that preflight must hand the
// lease back: the outer cleanup does not own it, so a leaked lease blocks that account's probe.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { setClaudeUsagePreflightForTests } from "../../src/adapters/claude-cli/usage-admission";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let turns = 0;
function claudeFixture(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "claude-cli",
    buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
    async *parseStream() { yield { type: "done" } as AdapterEvent; },
    async runTurn(_parsed, _incoming, emit) {
      turns++;
      emit({ type: "text_delta", text: "ok" } as AdapterEvent);
      emit({ type: "done" } as AdapterEvent);
    },
  };
}
const resolver = await import("../../src/server/adapter-resolve");
const resolveAdapter = resolver.resolveAdapter;
mock.module("../../src/server/adapter-resolve", () => ({ ...resolver,
  resolveAdapter: (provider: OcxProviderConfig, cache?: "none" | "short" | "long") =>
    provider.adapter === "claude-cli" ? claudeFixture(provider) : resolveAdapter(provider, cache),
}));
let released = 0;
const sidecarAuth = await import("../../src/server/responses/request-sidecar-auth");
mock.module("../../src/server/responses/request-sidecar-auth", () => ({ ...sidecarAuth,
  prepareResponsesSidecarAuth: async () => ({
    routedCompaction: false,
    openAiSidecar: { releaseProbeLease: () => { released++; } },
  }) as Awaited<ReturnType<typeof sidecarAuth.prepareResponsesSidecarAuth>>,
}));
const { handleResponses } = await import("../../src/server/responses");

const originalHome = process.env.OPENCODEX_HOME;
let home = "";
let release: (() => void) | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-claude-preflight-lease-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  turns = 0;
  released = 0;
});
afterEach(() => {
  setClaudeUsagePreflightForTests();
  release?.();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

async function send(): Promise<Response> {
  const config = { port: 0, defaultProvider: "claude-cli", providers: {
    "claude-cli": { adapter: "claude-cli", baseUrl: "https://api.anthropic.com", authMode: "key", selectedModels: ["claude-sonnet-5-5"] },
  } } as OcxConfig;
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-cli/claude-sonnet-5-5", input: "hello", stream: false }),
  }), config, { model: "", provider: "" });
}

test("a preflight that throws hands the probe lease back and starts no turn", async () => {
  setClaudeUsagePreflightForTests(async () => { throw new Error("quota cache unreadable"); });
  // The error itself keeps its existing path (it is rethrown); only the lease is settled first.
  await expect(send()).rejects.toThrow("quota cache unreadable");
  expect(released).toBeGreaterThanOrEqual(1);
  expect(turns).toBe(0);
});

test("an exhausted preflight hands the probe lease back and refuses with 429", async () => {
  setClaudeUsagePreflightForTests(async () => ({ state: "exhausted", checkedAt: Date.now(), resetAt: Date.now() + 60_000, message: "exhausted" }));
  const res = await send();
  expect(res.status).toBe(429);
  expect(released).toBeGreaterThanOrEqual(1);
  expect(turns).toBe(0);
});

test("an available preflight dispatches the turn", async () => {
  setClaudeUsagePreflightForTests(async () => ({ state: "available", checkedAt: Date.now() }));
  const res = await send();
  await res.text();
  expect(res.status).toBe(200);
  expect(turns).toBe(1);
});
