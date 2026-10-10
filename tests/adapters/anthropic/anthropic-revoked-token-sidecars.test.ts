/** Real Responses recovery with colliding account IDs and an instance-owned send ledger. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import type { AnthropicInstanceId } from "../../../src/providers/anthropic-instance-id";
import type { HandleResponsesOptions } from "../../../src/server/responses/core-options";
import { createAnthropicInstanceFixture, instanceFixtureCredential, instanceFixtureUuid, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";

const instances = ["anthropic", "anthropic2"] as const;
let store: typeof import("../../../src/oauth/store");
let routing: typeof import("../../../src/oauth/anthropic-routing");
let resolver: typeof import("../../../src/server/adapter-resolve");
let handleResponses: typeof import("../../../src/server/responses").handleResponses;
let fixture: AnthropicInstanceFixture;
let releaseSpend: (() => void) | undefined;
let ids: Record<AnthropicInstanceId, string[]>;
let config: OcxConfig;
let sends: Array<{ instance: AnthropicInstanceId; token: string | null; body: Record<string, unknown> }>;
let reply: (instance: AnthropicInstanceId, index: number, body: Record<string, unknown>) => Response | Promise<Response>;

function answer(): Response {
  return Response.json({ id: "msg_synthetic", type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "The answer is complete." }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 6 } });
}
function refusal(status: 403 | 429): Response {
  return Response.json({ type: "error", error: status === 403
    ? { type: "permission_error", message: "Your account does not have access to Claude Code" }
    : { type: "rate_limit_error", message: "Synthetic shared quota exhausted" } }, {
    status, headers: { "retry-after": "30", ...(status === 429 ? { "anthropic-ratelimit-unified-5h-status": "rejected" } : {}) },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function post(instance: AnthropicInstanceId, options: HandleResponsesOptions = {}, body: Record<string, unknown> = {}) {
  return handleResponses(new Request("http://localhost/v1/responses", { method: "POST",
    headers: { "content-type": "application/json", "session-id": "equal-session", authorization: "Bearer access-token-value-test-caller-excluded" },
    body: JSON.stringify({ model: `${instance}/claude-sonnet-4-6`, input: "Answer briefly", stream: false, ...body }),
  }), config, { model: "", provider: "" }, options);
}

beforeEach(async () => {
  fixture = await createAnthropicInstanceFixture({ anthropic: { enabled: false }, anthropic2: { enabled: false } });
  fixture.quota.resetProviderQuotaReconcileStateForTests();
  await fixture.seed();
  ({ store, routing, config } = fixture);
  resolver = await import("../../../src/server/adapter-resolve");
  ({ handleResponses } = await import("../../../src/server/responses"));
  const { acquireOwnedSpendHome } = await import("../../helpers/owned-spend-home");
  releaseSpend = acquireOwnedSpendHome();
  ids = { anthropic: [...fixture.ids], anthropic2: [...fixture.ids] };
  sends = [];
  reply = () => answer();
  for (const instance of instances) {
    Object.assign(config.providers[instance]!, { baseUrl: "https://instance-bridge.example.test", models: [fixture.model],
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const token = new Headers(init?.headers).get("authorization");
        const row = store.getAccountSet(instance)?.accounts.find(account => `Bearer ${account.credential.access}` === token);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(row).toBeDefined();
        // Source identity is separate evidence; the translated adapter sends no account UUID.
        expect(row!.credential.anthropicIdentity?.accountUuid).toBe(instanceFixtureUuid(instance, fixture.ids.indexOf(row!.id as typeof fixture.ids[number]) + 1));
        fixture.ledger.record({ instance, accountId: row!.id, token: token!.replace(/^Bearer /, ""), model: String(body.model) });
        sends.push({ instance, token, body });
        return reply(instance, sends.length, body);
      }) as typeof fetch,
    });
  }
  fixture.publishConfig();
});
afterEach(async () => {
  try {
    fixture.ledger.assertNoCrossSend();
    releaseSpend?.(); releaseSpend = undefined;
    const { clearResponseStateForTests } = await import("../../../src/responses/state");
    clearResponseStateForTests();
  } finally {
    try { await fixture.dispose(); }
    finally { fixture.quota.resetProviderQuotaReconcileStateForTests(); }
  }
});

function revoked() {
  return Response.json({ type: "error", error: { type: "authentication_error",
    message: "OAuth access token has been revoked." } }, { status: 401 });
}
function answerStream(text = "The answer is complete.") {
  const message = { id: "msg_synthetic", type: "message", role: "assistant", model: fixture.model,
    content: [], stop_reason: null, usage: { input_tokens: 8, output_tokens: 0 } };
  const frames = [
    { type: "message_start", message },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(frame => "event: " + frame.type + "\ndata: " + JSON.stringify(frame) + "\n\n").join(""),
    { headers: { "content-type": "text/event-stream" } });
}

for (const instance of instances) for (const kind of ["search", "image"] as const) {
  test(instance + ": exact revoked 401 reaches real " + kind + " recovery", async () => {
    if (kind === "search") config.webSearchSidecar = { backend: "anthropic", enabled: true };
    else {
      config.images = { bridgeEnabled: true };
      config.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1",
        authMode: "key", apiKey: "synthetic-image-key" };
    }
    reply = (_instance, index) => index === 1 ? revoked() : answerStream();
    const response = await post(instance, {}, { stream: true,
      tools: [{ type: kind === "search" ? "web_search" : "image_generation" }] });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("The answer is complete.");
    expect(sends).toHaveLength(2);
    expect(fixture.ledger.sends.map(send => [send.instance, send.accountId])).toEqual([
      [instance, fixture.ids[0]], [instance, fixture.ids[1]],
    ]);
    expect(store.getAccountCredentialWithStatus(instance, fixture.ids[0])?.needsReauth).toBe(true);
    const other = instance === "anthropic" ? "anthropic2" : "anthropic";
    expect(store.getAccountCredentialWithStatus(other, fixture.ids[0])?.needsReauth).toBe(false);
  });
  test(instance + ": unknown 401 in " + kind + " cannot mark or fail over", async () => {
    if (kind === "search") config.webSearchSidecar = { backend: "anthropic", enabled: true };
    else {
      config.images = { bridgeEnabled: true };
      config.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1",
        authMode: "key", apiKey: "synthetic-image-key" };
    }
    reply = () => Response.json({ type: "error", error: { type: "authentication_error",
      message: "OAuth access token has expired." } }, { status: 401 });
    const response = await post(instance, {}, { stream: true,
      tools: [{ type: kind === "search" ? "web_search" : "image_generation" }] });
    await response.text();
    expect(sends).toHaveLength(1);
    expect(store.getAccountCredentialWithStatus(instance, fixture.ids[0])?.needsReauth).toBe(false);
  });
}
