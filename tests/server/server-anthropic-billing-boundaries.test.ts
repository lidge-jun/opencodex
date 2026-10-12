/** #6958 boundaries: Chat Completions entry, cross-request skip, secret hygiene, OAuth separation. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { clearAnthropicAccountPoolState, getAnthropicAccountHealthSnapshot } from "../../src/oauth/anthropic-routing";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearKeyCooldowns, getKeyCooldownUntil } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const creditMessage = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
// Distinctive key material: any fragment of it in a log line or client body is a leak.
const secret = (index: number) => `fixture-billing-secret-${index}-QWxhZGRpbjpvcGVu`;
const refusal = (status = 400) => Response.json({ type: "error", error: { type: "invalid_request_error", message: creditMessage } }, { status });
const sse = (events: Record<string, unknown>[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const streamed = () => new Response(sse([
  { type: "message_start", message: { id: "msg_boundary", type: "message", role: "assistant", model: "claude-x", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "billing recovered" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
]), { headers: { "content-type": "text/event-stream" } });
const success = () => Response.json({ id: "msg_boundary", type: "message", role: "assistant", model: "claude-x",
  content: [{ type: "text", text: "billing recovered" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 2 } });

let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let seen: (string | null)[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-billing-boundary-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  seen = [];
  clearKeyCooldowns();
  clearAnthropicAccountPoolState();
  resetProviderRequestPacingForTest();
});
afterEach(async () => {
  await upstream?.stop(true);
  upstream = undefined;
  releaseSpend?.();
  releaseSpend = undefined;
  clearKeyCooldowns();
  clearAnthropicAccountPoolState();
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

/** Upstream answers by key, so a refused key keeps refusing on every later request. */
function fixture(refusedKeys: Set<string>, keys = 2): OcxConfig {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean };
    const key = request.headers.get("x-api-key");
    seen.push(key);
    if (key !== null && refusedKeys.has(key)) return refusal();
    return body.stream === true ? streamed() : success();
  } });
  const config = { port: 0, defaultProvider: "anth", protocols: { rollout: { managedMessagesNative: true } }, providers: { anth: {
    adapter: "anthropic", authMode: "key", baseUrl: `http://127.0.0.1:${upstream.port}`, allowPrivateNetwork: true,
    apiKey: secret(0), models: ["claude-x"],
    apiKeyPool: Array.from({ length: keys }, (_, id) => ({ id: `k${id}`, key: secret(id), addedAt: id + 1 })),
  } } } as OcxConfig;
  saveConfig(config);
  return config;
}

type Entry = "chat" | "messages" | "responses";
function send(entry: Entry, config: OcxConfig): Promise<Response> {
  const path = entry === "chat" ? "chat/completions" : entry;
  const body = entry === "responses" ? { model: "anth/claude-x", input: "hello", stream: false }
    : { model: "anth/claude-x", messages: [{ role: "user", content: "hello" }], max_tokens: 16, stream: false };
  const request = new Request(`http://localhost/v1/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const logCtx = { model: "", provider: "" };
  return entry === "chat" ? handleChatCompletions(request, config, logCtx)
    : entry === "messages" ? handleClaudeMessages(request, config, logCtx)
      : handleResponses(request, config, logCtx, {});
}

async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map(method => console[method]);
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      lines.push(args.map(arg => typeof arg === "string" ? arg : arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : Bun.inspect(arg)).join(" "));
    };
  }
  try {
    return { result: await run(), lines };
  } finally {
    methods.forEach((method, index) => { console[method] = original[index]!; });
  }
}

test("Chat Completions on an Anthropic key pool recovers a credit-balance refusal on the next key", async () => {
  const config = fixture(new Set([secret(0)]));
  const response = await send("chat", config);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("billing recovered");
  expect(seen).toEqual([secret(0), secret(1)]);
  expect(loadConfig().providers.anth!.apiKey).toBe(secret(1));
  const remaining = getKeyCooldownUntil("anth", "k0")! - Date.now();
  expect(remaining).toBeGreaterThan(3_590_000);
  expect(remaining).toBeLessThanOrEqual(3_600_000);
});

for (const entry of ["messages", "responses", "chat"] as const) {
  test(`${entry}: the next request skips the refused key instead of probing it again`, async () => {
    const config = fixture(new Set([secret(0)]), 3);
    const first = await send(entry, config);
    expect(first.status).toBe(200);
    await first.text();
    const second = await send(entry, loadConfig());
    expect(second.status).toBe(200);
    await second.text();
    // One refused probe in total: the second request starts on the committed sibling.
    expect(seen).toEqual([secret(0), secret(1), secret(1)]);
    expect(getKeyCooldownUntil("anth", "k1")).toBeNull();
  });

  test(`${entry}: rotation and exhaustion never put key material in logs or the client body`, async () => {
    const recovered = await captureConsole(async () => {
      const response = await send(entry, fixture(new Set([secret(0)])));
      return { status: response.status, body: await response.text() };
    });
    await upstream?.stop(true);
    seen = [];
    clearKeyCooldowns();
    const exhausted = await captureConsole(async () => {
      const response = await send(entry, fixture(new Set([secret(0), secret(1)])));
      return { status: response.status, body: await response.text() };
    });
    expect(recovered.result.status).toBe(200);
    expect(exhausted.result.status).toBe(400);
    expect(exhausted.result.body).toContain("credit balance is too low");
    // Non-vacuous: the rotation and exhaustion lines were captured, naming ids and the reason.
    expect(recovered.lines.some(line => line.includes("credit-balance refusal on key k0; rotating to key k1"))).toBe(true);
    expect(exhausted.lines.some(line => line.includes("keys in cooldown after credit-balance refusal"))).toBe(true);
    const observed = [...recovered.lines, ...exhausted.lines, recovered.result.body, exhausted.result.body].join("\n");
    expect(observed).not.toContain("fixture-billing-secret");
    expect(observed).not.toContain("QWxhZGRpbjpvcGVu");
  });
}

test("key-pool billing recovery leaves the Anthropic OAuth account roster untouched", async () => {
  for (const index of [0, 1]) {
    await saveCredential("anthropic", { access: `synthetic-oauth-access-${index}`, refresh: `synthetic-oauth-refresh-${index}`,
      expires: Date.now() + 3_600_000, accountId: `synthetic-oauth-account-${index}` });
  }
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  const config = fixture(new Set([secret(0)]));
  for (const entry of ["messages", "responses"] as const) {
    const response = await send(entry, entry === "messages" ? config : loadConfig());
    expect(response.status).toBe(200);
    await response.text();
  }
  expect(getAccountSet("anthropic")!.activeAccountId).toBe(ids[0]);
  for (const id of ids) expect(getAnthropicAccountHealthSnapshot(id)).toBeNull();
  // Only the key that refused is held; the OAuth roster gained no cooldown or selection change.
  expect(getKeyCooldownUntil("anth", "k0")).not.toBeNull();
  expect(getKeyCooldownUntil("anth", "k1")).toBeNull();
});
