import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleResponses } from "../../src/server/responses";
import { clearKeyCooldowns, getKeyCooldownUntil } from "../../src/providers/key-failover";
import { createRequestExecutionBudget, CODEX_TEXT_GUARDED_BUDGET_POLICY } from "../../src/lib/request-execution-budget";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const creditMessage = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const refusal = (status = 400, message = creditMessage, type = "invalid_request_error") => Response.json({ type: "error", error: { type, message } }, { status });
const sse = (events: Record<string, unknown>[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const output = [
  { type: "message_start", message: { id: "msg_billing_fixture", type: "message", role: "assistant", model: "claude-x", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "billing recovered" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];
const success = (stream = false) => stream
  ? new Response(sse(output), { headers: { "content-type": "text/event-stream" } })
  : Response.json({ id: "msg_billing_fixture", type: "message", role: "assistant", model: "claude-x",
    content: [{ type: "text", text: "billing recovered" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 2 } });
type Lane = "native" | "translated";
let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let seen: { key: string | null; body: unknown }[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-billing-fixture-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  seen = [];
  clearKeyCooldowns();
});
afterEach(async () => {
  await upstream?.stop(true);
  upstream = undefined;
  releaseSpend?.();
  releaseSpend = undefined;
  clearKeyCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(reply: (index: number, stream: boolean) => Response, keys = 2): OcxConfig {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean };
    seen.push({ key: request.headers.get("x-api-key"), body });
    return reply(seen.length - 1, body.stream === true);
  } });
  const config = { port: 0, defaultProvider: "anth", protocols: { rollout: { managedMessagesNative: true } }, providers: { anth: {
    adapter: "anthropic", authMode: "key", baseUrl: `http://127.0.0.1:${upstream.port}`, allowPrivateNetwork: true,
    apiKey: "fixture-key-0", models: ["claude-x"],
    apiKeyPool: Array.from({ length: keys }, (_, id) => ({ id: `k${id}`, key: `fixture-key-${id}`, addedAt: id + 1 })),
  } } } as OcxConfig;
  saveConfig(config);
  return config;
}

async function send(lane: Lane, config: OcxConfig, signal?: AbortSignal, budget?: ReturnType<typeof createRequestExecutionBudget>, stream = false) {
  const request = new Request(`http://localhost/v1/${lane === "native" ? "messages" : "responses"}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify(lane === "native"
      ? { model: "anth/claude-x", messages: [{ role: "user", content: "hello" }], max_tokens: 16, stream }
      : { model: "anth/claude-x", input: "hello", stream }),
  });
  return lane === "native"
    ? handleClaudeMessages(request, config, { model: "", provider: "" })
    : handleResponses(request, config, { model: "", provider: "" }, { abortSignal: signal, sendBudget: budget });
}

for (const lane of ["native", "translated"] as const) describe(`${lane} Anthropic billing sends`, () => {
  for (const status of [400, 402]) test(`rotates a proven ${status} billing refusal once with identical request content`, async () => {
    const config = fixture((index, stream) => index === 0 ? refusal(status) : success(stream));
    const response = await send(lane, config);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("billing recovered");
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-1");
    const remaining = getKeyCooldownUntil("anth", "k0")! - Date.now();
    expect(remaining).toBeGreaterThan(590_000);
    expect(remaining).toBeLessThanOrEqual(600_000);
  });

  test("configured headers overriding A with C do not cool A or commit B", async () => {
    const config = fixture(() => refusal());
    // A runtime override exercises the send fence; persisted config rejects auth headers.
    config.providers.anth!.headers = { "x-api-key": "fixture-key-C" };
    const response = await send(lane, config);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-C"]);
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
  });

  test("billing ownership survives a leased concurrency response-body wrapper", async () => {
    const config = fixture((index, stream) => index === 0 ? refusal() : success(stream));
    config.providers.anth!.requestPacing = { enabled: true, maxConcurrentRequests: 1 };
    saveConfig(config);
    const response = await send(lane, config);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("billing recovered");
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(getKeyCooldownUntil("anth", "k0")).not.toBeNull();
  });

  for (const kind of ["ordinary", "truncated", "code", "message", "envelope"] as const) test(`${kind} 400 stays terminal`, async () => {
    const config = fixture(() => kind === "ordinary" ? refusal(400, "Invalid request")
      : kind === "truncated" ? new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: creditMessage } }).slice(0, -1), { status: 400, headers: { "content-type": "application/json" } })
      : kind === "code" ? Response.json({ type: "error", error: { type: "invalid_request_error", code: "context_length_exceeded", message: creditMessage } }, { status: 400 })
      : kind === "message" ? refusal(400, `Diagnostic: ${creditMessage}`)
      : Response.json({ response: { type: "error", error: { type: "invalid_request_error", message: creditMessage } } }, { status: 400 }));
    const response = await send(lane, config);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
  });

  test("exhaustion preserves the last upstream billing body", async () => {
    const config = fixture(() => refusal());
    const response = await send(lane, config);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(getKeyCooldownUntil("anth", "k0")).not.toBeNull();
    expect(getKeyCooldownUntil("anth", "k1")).not.toBeNull();
  });

  test("a single key does not rotate or cool on billing", async () => {
    const config = fixture(() => refusal(), 1);
    const response = await send(lane, config);
    expect(response.status).toBe(400);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
  });

  test("the shared send ceiling retains the actual terminal refusal", async () => {
    const config = fixture(() => refusal(), 8);
    const budget = lane === "translated" ? createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0 }) : undefined;
    const response = await send(lane, config, undefined, budget);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(creditMessage);
    expect(seen).toHaveLength(lane === "native" ? 4 : 2);
  });

  for (const kind of ["text", "tool"] as const) test(`billing error after emitted ${kind} is never replayed`, async () => {
    const emitted = kind === "text" ? output.slice(0, 3) : [output[0]!,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_billing_fixture", name: "billing_tool", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 0 }];
    const config = fixture(() => new Response(sse([...emitted, { type: "error", error: { type: "billing_error", message: creditMessage } }]), {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await send(lane, config, undefined, undefined, true);
    expect(await response.text()).toContain(kind === "text" ? "billing recovered" : "billing_tool");
    expect(seen).toHaveLength(1);
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
  });

  for (const statuses of [[400, 401], [400, 429], [400, 429, 400], [429, 400], [429, 402]]) test(`mixed ${statuses.join("→")} refusals share billing recovery`, async () => {
    const config = fixture((index, stream) => index < statuses.length
      ? refusal(statuses[index]!, [400, 402].includes(statuses[index]!) ? creditMessage : "fixture credential/rate refusal",
        statuses[index] === 401 ? "authentication_error" : statuses[index] === 429 ? "rate_limit_error" : "invalid_request_error")
      : success(stream), statuses.length + 1);
    const response = await send(lane, config);
    expect(seen.map(entry => entry.key)).toEqual(Array.from({ length: statuses.length + 1 }, (_, index) => `fixture-key-${index}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("billing recovered");
    expect(seen).toHaveLength(statuses.length + 1);
  });

  if (lane === "translated") for (const status of [401, 429]) test(`mixed billing→${status} keeps B's terminal body at an exact two-send budget`, async () => {
    const terminalMessage = `fixture terminal ${status} from B`;
    const config = fixture((index, stream) => index === 0 ? refusal()
      : index === 1 ? refusal(status, terminalMessage, status === 401 ? "authentication_error" : "rate_limit_error")
      : success(stream), 3);
    const budget = createRequestExecutionBudget({ ...CODEX_TEXT_GUARDED_BUDGET_POLICY,
      maxTotalModelSends: 2, baseSendAllowance: 2, finalRecoveryAllowance: 0 });
    const response = await send(lane, config, undefined, budget);
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(body).toContain(terminalMessage);
    expect(body).not.toContain("send_budget_exhausted");
    expect(seen.map(entry => entry.key)).toEqual(["fixture-key-0", "fixture-key-1"]);
    expect(seen[1]!.body).toEqual(seen[0]!.body);
    expect(budget.used).toBe(2);
  });

  test("client cancellation during the refusal peek never sends B", async () => {
    const opened = Promise.withResolvers<void>();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const config = fixture(() => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      body = controller;
      controller.enqueue(new TextEncoder().encode('{"type":"error","error":'));
      opened.resolve();
    } }), { status: 400, headers: { "content-type": "application/json" } }));
    const abort = new AbortController();
    const pending = send(lane, config, abort.signal);
    await opened.promise;
    await Bun.sleep(30);
    abort.abort();
    body.close();
    const response = await pending;
    expect(response.status).toBe(499);
    await response.text();
    expect(seen).toHaveLength(1);
    expect(getKeyCooldownUntil("anth", "k0")).toBeNull();
    expect(loadConfig().providers.anth!.apiKey).toBe("fixture-key-0");
  });
});
