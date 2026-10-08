/** Real Responses recovery with colliding account IDs and an instance-owned send ledger. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import type { AnthropicInstanceId } from "../../../src/providers/anthropic-instance-id";
import type { HandleResponsesOptions } from "../../../src/server/responses/core-options";
import { createAnthropicInstanceFixture, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";

const instances = ["anthropic", "anthropic2"] as const;
let store: typeof import("../../../src/oauth/store");
let routing: typeof import("../../../src/oauth/anthropic-routing");
let resolver: typeof import("../../../src/server/adapter-resolve");
let handleResponses: typeof import("../../../src/server/responses").handleResponses;
let fixture: AnthropicInstanceFixture;
let releaseSpend: (() => void) | undefined;
let ids: Record<AnthropicInstanceId, string[]>;
let config: OcxConfig;
let sends: Array<{ instance: AnthropicInstanceId; token: string | null; uuid: string | undefined; body: Record<string, unknown> }>;
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
    headers: { "content-type": "application/json", "session-id": "equal-session", authorization: "Bearer synthetic-caller-must-not-send" },
    body: JSON.stringify({ model: `${instance}/claude-sonnet-4-6`, input: "Answer briefly", stream: false, ...body }),
  }), config, { model: "", provider: "" }, options);
}

beforeEach(async () => {
  fixture = await createAnthropicInstanceFixture({ anthropic: { enabled: false }, anthropic2: { enabled: false } });
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
        fixture.ledger.record({ instance, accountId: row!.id, token: token!.replace(/^Bearer /, ""),
          uuid: row!.credential.anthropicIdentity?.accountUuid, model: String(body.model) });
        sends.push({ instance, token, uuid: row?.credential.anthropicIdentity?.accountUuid, body });
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
  } finally { fixture.dispose(); }
});

for (const instance of instances) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  for (const status of [403, 429] as const) {
    test(`${instance}: pool-off ${status} recovers only inside the selected instance`, async () => {
      reply = (_instance, index) => index === 1 ? refusal(status) : answer();
      const response = await post(instance);
      await response.text();
      expect(response.status).toBe(200);
      expect(sends.map(send => send.token)).toEqual([`Bearer synthetic-${instance}-1-access`, `Bearer synthetic-${instance}-2-access`]);
      expect(sends.every(send => send.instance === instance)).toBe(true);
      expect(routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(ids[instance][0]!)).not.toBeNull();
      expect(routing.anthropicRoutingFor(other).getAnthropicAccountHealthSnapshot(ids[other][0]!)).toBeNull();
      expect(store.getAccountSet(other)!.activeAccountId).toBe(ids[other][0]);
    });
  }

  test(`${instance}: paused replacement remains excluded during refusal recovery`, async () => {
    await store.setAccountPaused(instance, ids[instance][1]!, true);
    reply = () => refusal(403);
    const response = await post(instance);
    await response.text();
    expect(response.status).toBe(403);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.token).toBe(`Bearer synthetic-${instance}-1-access`);
  });

  for (const mutation of ["pause", "manual"] as const) {
    test(`${instance}: ${mutation} during request build invalidates the old send binding`, async () => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const original = resolver.resolveAdapter;
      let held = false;
      const buildSpy = spyOn(resolver, "resolveAdapter").mockImplementation((...args) => {
        const adapter = original(...args);
        const build = adapter.buildRequest.bind(adapter);
        adapter.buildRequest = async (...buildArgs) => {
          const result = await build(...buildArgs);
          if (!held) { held = true; entered.resolve(); await release.promise; }
          return result;
        };
        return adapter;
      });
      try {
        const pending = post(instance);
        await entered.promise;
        if (mutation === "pause") await store.setAccountPaused(instance, ids[instance][0]!, true);
        else await store.setActiveAccount(instance, ids[instance][1]!);
        release.resolve();
        const response = await pending;
        await response.text();
        expect(response.status).toBe(200);
        expect(sends.map(send => send.token)).toEqual([`Bearer synthetic-${instance}-2-access`]);
      } finally { release.resolve(); buildSpy.mockRestore(); }
    });
  }

  test(`${instance}: strict model route cannot recover outside its allowlist`, async () => {
    const pool = { enabled: true, routes: [{ name: "strict", match: "claude-sonnet-4-6", accounts: [ids[instance][0]!] }] };
    if (instance === "anthropic") config.anthropicAccountPool = pool;
    else config.providers.anthropic2!.anthropicAccountPool = pool;
    fixture.publishConfig();
    reply = () => refusal(429);
    const response = await post(instance);
    await response.text();
    expect(response.status).toBe(429);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.token).toBe(`Bearer synthetic-${instance}-1-access`);
  });

  test(`${instance}: cancellation during refusal read never sends a replacement`, async () => {
    const abort = new AbortController();
    reply = () => { abort.abort(); return refusal(403); };
    const response = await post(instance, { abortSignal: abort.signal });
    await response.text();
    expect(sends).toHaveLength(1);
  });
}

for (const mutation of ["marker", "disable", "target"] as const) {
  test(`B ${mutation} removal while building refuses before the physical send`, async () => {
    const entered = deferred<void>(); const release = deferred<void>();
    const original = resolver.resolveAdapter;
    let held = false;
    const buildSpy = spyOn(resolver, "resolveAdapter").mockImplementation((...args) => {
      const adapter = original(...args); const build = adapter.buildRequest.bind(adapter);
      adapter.buildRequest = async (...buildArgs) => {
        const result = await build(...buildArgs);
        if (!held) { held = true; entered.resolve(); await release.promise; }
        return result;
      };
      return adapter;
    });
    try {
      const pending = post("anthropic2"); await entered.promise;
      if (mutation === "marker") delete config.providers.anthropic2!.anthropicOAuthInstance;
      else if (mutation === "disable") config.providers.anthropic2!.disabled = true;
      else config.providers.anthropic2!.baseUrl = "https://replacement.example.test";
      release.resolve(); const response = await pending; await response.text();
      expect(response.status).toBe(401);
      expect(sends).toHaveLength(0);
    } finally { release.resolve(); buildSpy.mockRestore(); }
  });
}

test("unmarked canonical B OAuth fails closed even with orphan B credentials and pool off", async () => {
  config.providers.anthropic2!.baseUrl = "https://api.anthropic.com";
  delete config.providers.anthropic2!.anthropicOAuthInstance;
  delete config.providers.anthropic2!.anthropicAccountPool;
  fixture.publishConfig();
  const oauth = await import("../../../src/oauth");
  const generic = spyOn(oauth, "getValidAccessTokenSnapshot");
  try {
    const response = await post("anthropic2"); await response.text();
    expect(response.status).toBe(401); expect(sends).toHaveLength(0);
    expect(generic).not.toHaveBeenCalled();
  } finally { generic.mockRestore(); }
});

test("custom key B remains key-auth with both OAuth pools populated", async () => {
  const provider = config.providers.anthropic2!;
  delete provider.anthropicOAuthInstance;
  delete provider.anthropicAccountPool;
  provider.authMode = "key"; provider.apiKey = "synthetic-custom-key";
  const keySends: Headers[] = [];
  (provider as OcxProviderConfig & { fetch: typeof fetch }).fetch = (async (_input, init) => {
    keySends.push(new Headers(init?.headers)); return answer();
  }) as typeof fetch;
  fixture.publishConfig();
  const response = await post("anthropic2"); await response.text();
  expect(response.status).toBe(200); expect(keySends).toHaveLength(1);
  expect(keySends[0]!.get("x-api-key")).toBe("synthetic-custom-key");
  expect(keySends[0]!.get("authorization")).toBeNull();
  expect(sends).toHaveLength(0);
});

function streamedAnswer(text: string): Response {
  const usage = { input_tokens: 8, output_tokens: 6 };
  const frames = [
    { type: "message_start", message: { id: "msg_stream", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }, { type: "message_stop" },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
for (const instance of instances) {
  test(`${instance}: post-output terminal continuation does not replay on account 403`, async () => {
    reply = (_instance, index) => index === 1 ? streamedAnswer("I will modify the file now.") : refusal(403);
    const response = await post(instance, {}, { stream: true, input: "Please modify the file now",
      tools: [{ type: "function", name: "read_file", description: "read a file", parameters: { type: "object" } }],
    });
    expect(await response.text()).toContain("I will modify the file now.");
    expect(sends.map(send => send.token)).toEqual([`Bearer synthetic-${instance}-1-access`, `Bearer synthetic-${instance}-1-access`]);
    expect(routing.anthropicRoutingFor(instance).getEligibleAnthropicAccounts()).toEqual(ids[instance]);
  });

  test(`${instance}: empty pre-output continuation uses scoped recovery and the shared request bound`, async () => {
    config.emptyCompletionRetry = true; fixture.publishConfig();
    reply = (_instance, index) => index === 1 ? streamedAnswer("") : index === 2 ? refusal(403) : streamedAnswer("The answer is complete.");
    const response = await post(instance, {}, { stream: true });
    expect(await response.text()).toContain("The answer is complete.");
    expect(sends.map(send => send.token)).toEqual([`Bearer synthetic-${instance}-1-access`, `Bearer synthetic-${instance}-1-access`, `Bearer synthetic-${instance}-2-access`]);
  });

  test(`${instance}: physical send budget refuses recovery while retaining the original account refusal`, async () => {
    const { createRequestExecutionBudget } = await import("../../../src/lib/request-execution-budget");
    const sendBudget = createRequestExecutionBudget({ maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, "instance-refusal-one-send");
    reply = () => refusal(403);
    const response = await post(instance, { sendBudget }); await response.text();
    expect(response.status).toBe(403); expect(sends).toHaveLength(1);
    expect(routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(ids[instance][0]!)).not.toBeNull();
  });

  test(`${instance}: late refusal cannot cool a replaced credential generation`, async () => {
    const entered = deferred<void>(); const returned = deferred<Response>();
    reply = () => { entered.resolve(); return returned.promise; };
    const pending = post(instance); await entered.promise;
    const row = store.getAccountSet(instance)!.accounts[0]!;
    await store.saveAccountCredential(instance, row.id, { ...row.credential, access: `synthetic-${instance}-renewed-access`, refresh: `synthetic-${instance}-renewed-refresh` });
    returned.resolve(refusal(403));
    const response = await pending; await response.text();
    expect(response.status).toBe(403); expect(sends).toHaveLength(1);
    expect(routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(ids[instance][0]!)).toBeNull();
  });

  test(`${instance}: explicit fallback widens only to its own surviving account`, async () => {
    const pool = { enabled: true, routes: [{ name: "fallback", match: fixture.model, accounts: [ids[instance][0]!], fallback: true }] };
    if (instance === "anthropic") config.anthropicAccountPool = pool;
    else config.providers.anthropic2!.anthropicAccountPool = pool;
    fixture.publishConfig();
    reply = (_instance, index) => index === 1 ? refusal(429) : answer();
    const response = await post(instance); await response.text();
    expect(response.status).toBe(200);
    expect(sends.map(send => send.token)).toEqual([`Bearer synthetic-${instance}-1-access`, `Bearer synthetic-${instance}-2-access`]);
  });

  test(`${instance}: search sidecar recovers the same account refusal before output`, async () => {
    config.webSearchSidecar = { backend: "anthropic", enabled: true }; fixture.publishConfig();
    reply = (_instance, index, body) => index === 1 ? refusal(403) : body.stream === true ? streamedAnswer("The answer is complete.") : answer();
    const response = await post(instance, {}, { stream: true, tools: [{ type: "web_search" }] });
    expect(response.status).toBe(200); expect(await response.text()).toContain("The answer is complete.");
    expect(sends.map(send => send.token)).toEqual([`Bearer synthetic-${instance}-1-access`, `Bearer synthetic-${instance}-2-access`]);
  });
}

test("direct B with an empty B namespace never borrows a populated A namespace", async () => {
  await store.mutateStore(auth => { delete auth.anthropic2; });
  const response = await post("anthropic2"); await response.text();
  expect(response.status).toBe(401); expect(sends).toHaveLength(0);
  expect(store.getAccountSet("anthropic")!.accounts).toHaveLength(2);
});

test("an explicit B then A combo retains its declared cross-instance transition", async () => {
  // Pause B's second account so the first target has no implicit recovery candidate.
  await store.setAccountPaused("anthropic2", ids.anthropic2[1]!, true);
  config.combos = { explicit: { strategy: "failover", targets: [
    { provider: "anthropic2", model: fixture.model }, { provider: "anthropic", model: fixture.model },
  ] } };
  fixture.publishConfig();
  reply = instance => instance === "anthropic2" ? refusal(429) : answer();
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/explicit", input: "Answer briefly", stream: false }),
  }), config, { model: "", provider: "" });
  await response.text(); expect(response.status).toBe(200);
  expect(sends.map(send => send.instance)).toEqual(["anthropic2", "anthropic"]);
  expect(sends.map(send => send.token)).toEqual(["Bearer synthetic-anthropic2-1-access", "Bearer synthetic-anthropic-1-access"]);
});
