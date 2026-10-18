import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGrokManagedBlock, injectGrokConfig } from "../../../src/grok/inject";
import { buildOmpClientConfig } from "../../../src/clients/config-export/omp";
import { handleChatCompletions } from "../../../src/server/chat-completions";
import type { RequestLogContext } from "../../../src/server/request-log";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

/**
 * D3 activation evidence: the fence stamps `x-opencodex-grok` on every registered
 * model, and a chat/completions request carrying it lands in the grok usage bucket.
 * Best-effort attribution for the dashboard — never an auth or billing signal.
 */

test("the managed fence stamps the grok attribution header on every model", () => {
  const block = buildGrokManagedBlock(10100, [{ id: "kimi/k3", contextWindow: 262_144 }]);
  expect(block).toContain('extra_headers = { "x-opencodex-grok" = "1" }');
  // The header lives in the shared [model_providers.opencodex] block, inherited by every
  // [model.*] table that references it via model_provider.
  const providerBlock = block.slice(block.indexOf("[model_providers.opencodex]"), block.indexOf("[model."));
  expect(providerBlock).toContain("x-opencodex-grok");
});

test("the fence survives a write and keeps the header line parseable", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-attr-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  try {
    const result = injectGrokConfig(10100, [{ id: "gpt-5.6-sol", contextWindow: 372_000 }], { grokHome });
    expect(result.ok).toBe(true);
    const content = readFileSync(join(grokHome, "config.toml"), "utf8");
    expect(content).toContain('extra_headers = { "x-opencodex-grok" = "1" }');
  } finally {
    removeTreeWithRetry(root);
  }
});

function chatReq(headers: Record<string, string>): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "prov/model", messages: [{ role: "user", content: "hi" }] }),
  });
}

const config = { port: 0, defaultProvider: "mock", providers: {} } as unknown as OcxConfig;

test("a request carrying the header is tagged grok; one without is not", async () => {
  // The handler sets logCtx.surface before any upstream work; a routing failure for the
  // unknown provider still leaves the tag set, so this drives the header path without
  // needing a live provider.
  const tagged: RequestLogContext = { model: "", provider: "" };
  await handleChatCompletions(chatReq({ "x-opencodex-grok": "1" }), config, tagged).catch(() => {});
  expect(tagged.surface).toBe("grok");

  const plain: RequestLogContext = { model: "", provider: "" };
  await handleChatCompletions(chatReq({}), config, plain).catch(() => {});
  expect(plain.surface).toBeUndefined();
});

test("the managed OMP block stamps its own surface marker", () => {
  // The marker is what puts OMP traffic in its own usage bucket instead of the
  // untagged `codex` catch-all. It is non-secret, so the client stays loopbackOnly.
  const block = buildOmpClientConfig({
    baseUrl: "http://127.0.0.1:10100/v1",
    config: { port: 10100, hostname: "127.0.0.1", defaultProvider: "mock", providers: {} } as OcxConfig,
    models: [{ namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5" }],
  }).providers.opencodex!;
  expect(block.headers).toEqual({ "x-opencodex-client": "omp" });
  // Nothing secret rides along: the placeholder stays the only credential-shaped value.
  expect(JSON.stringify(block)).not.toContain("x-opencodex-api-key");
});

test.each(["omp", "hermes"] as const)("a request carrying the %s marker is tagged separately from codex", async surface => {
  const tagged: RequestLogContext = { model: "", provider: "" };
  await handleChatCompletions(chatReq({ "x-opencodex-client": surface }), config, tagged).catch(() => {});
  expect(tagged.surface).toBe(surface);
});

test.each(["cursor", "1", "Hermes", "toString"])("an unknown marker %s does not become a surface", async value => {
  const unknown: RequestLogContext = { model: "", provider: "" };
  await handleChatCompletions(chatReq({ "x-opencodex-client": value }), config, unknown).catch(() => {});
  expect(unknown.surface).toBeUndefined();
});

test.each(["omp", "hermes"])("the Grok marker outranks the %s marker", async surface => {
  const both: RequestLogContext = { model: "", provider: "" };
  await handleChatCompletions(
    chatReq({ "x-opencodex-grok": "1", "x-opencodex-client": surface }), config, both,
  ).catch(() => {});
  expect(both.surface).toBe("grok");
});
