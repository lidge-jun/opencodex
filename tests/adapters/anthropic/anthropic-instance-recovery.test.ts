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

  test(`${instance}: exhausted recovery budget retains the original account refusal without another physical send`, async () => {
    const { createRequestExecutionBudget } = await import("../../../src/lib/request-execution-budget");
    // The existing reset-only initial leg is not charged to this shared ledger. This fixture
    // therefore grants zero RECOVERY sends, as the fast-downgrade refusal fixture does.
    const sendBudget = createRequestExecutionBudget({ maxTotalModelSends: 0, baseSendAllowance: 0, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0 }, "instance-refusal-no-recovery-send");
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

  for (const kind of ["search", "image"] as const) {
    test(`${instance}: ${kind} sidecar recovers the same account refusal before output`, async () => {
      if (kind === "search") config.webSearchSidecar = { backend: "anthropic", enabled: true };
      else {
        config.images = { bridgeEnabled: true };
        config.providers.xai = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "test-image-key" };
      }
      fixture.publishConfig();
      reply = (_instance, index, body) => index === 1 ? refusal(403) : body.stream === true ? streamedAnswer("The answer is complete.") : answer();
      const response = await post(instance, {}, { stream: true, tools: [{ type: kind === "search" ? "web_search" : "image_generation" }] });
      expect(response.status).toBe(200); expect(await response.text()).toContain("The answer is complete.");
      expect(sends.map(send => send.token)).toEqual([`Bearer synthetic-${instance}-1-access`, `Bearer synthetic-${instance}-2-access`]);
    });
  }
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
  expect(sends.map(send => send.token)).toEqual((["anthropic2", "anthropic"] as const).map(instance => `Bearer ${instanceFixtureCredential(instance, 1).access}`));
});

for (const surface of ["responses", "chat"] as const) {
  for (const unavailable of ["absent-row", "unmarked-alias", "disabled-alias"] as const) {
    test(`${surface}: ${unavailable} B selector refuses before any OAuth resolver or default-A send`, async () => {
      let selector = `anthropic2/${fixture.model}`;
      if (unavailable === "absent-row") delete config.providers.anthropic2;
      else {
        config.providers.anthropic2!.alias = "pool-b";
        selector = `pool-b/${fixture.model}`;
        if (unavailable === "unmarked-alias") {
          delete config.providers.anthropic2!.anthropicOAuthInstance;
          delete config.providers.anthropic2!.anthropicAccountPool;
        } else config.providers.anthropic2!.disabled = true;
      }
      fixture.publishConfig();
      expect(config.defaultProvider).toBe("anthropic");
      expect(store.getAccountSet("anthropic")!.accounts).toHaveLength(2);
      expect(store.getAccountSet("anthropic2")!.accounts).toHaveLength(2);
      const oauth = await import("../../../src/oauth");
      const activeResolver = spyOn(oauth, "getValidAccessTokenSnapshot");
      const accountResolver = spyOn(oauth, "getValidAccessSnapshotForAccount");
      try {
        const response = surface === "responses" ? await post("anthropic2", {}, { model: selector })
          : await (await import("../../../src/server/chat-completions")).handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: selector, messages: [{ role: "user", content: "Answer briefly" }], stream: false }),
          }), config, { model: "", provider: "" });
        await response.text();
        expect(response.status).toBe(401); expect(sends).toHaveLength(0);
        expect(fixture.ledger.sends).toHaveLength(0);
        expect(activeResolver).not.toHaveBeenCalled(); expect(accountResolver).not.toHaveBeenCalled();
      } finally { activeResolver.mockRestore(); accountResolver.mockRestore(); }
    });
  }
}

for (const selector of ["claude-sonnet-4-6", "vendor/model-with-slash"] as const) {
  test(`B selector guard preserves default A for ${selector}`, async () => {
    const response = await post("anthropic", {}, { model: selector }); await response.text();
    expect(response.status).toBe(200); expect(sends).toHaveLength(1);
    expect(sends[0]!.instance).toBe("anthropic"); expect(sends[0]!.body.model).toBe(selector);
  });
}

for (const instance of instances) {
  test(`${instance}: search loop does not offer account-403 recovery after routed output`, async () => {
    const { runWithWebSearch } = await import("../../../src/web-search/loop");
    const { parseRequest } = await import("../../../src/responses/parser");
    const { createTranslatorBudget } = await import("../../../src/lib/translator-budget");
    const translatorBudget = createTranslatorBudget();
    globalThis.fetch = (async () => Response.json({ results: [{ title: "Fixture", url: "https://example.test/result", content: "Synthetic result" }] })) as typeof fetch;
    let routedSends = 0; let rotations = 0;
    const adapter: import("../../../src/adapters/base").ProviderAdapter = {
      name: "mock-anthropic-output",
      buildRequest: () => ({ url: "https://routed.example.test/messages", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => ++routedSends === 1 ? new Response("ok") : refusal(403),
      async *parseStream() {
        yield { type: "text_delta", text: "I will check. " };
        yield { type: "tool_call_start", id: "search-1", name: "web_search" };
        yield { type: "tool_call_delta", arguments: '{"query":"fixture query"}' };
        yield { type: "tool_call_end" }; yield { type: "done" };
      },
    };
    try {
      const response = await runWithWebSearch({
        parsed: parseRequest({ model: `${instance}/${fixture.model}`, input: "Answer briefly", stream: true, tools: [{ type: "web_search" }] }),
        adapter, incomingMeta: { headers: new Headers(), providerName: instance, translatorBudget },
        backend: "exa", exaApiKey: "test-exa-key", hostedTool: { type: "web_search" }, selectedForwardHeaders: new Headers(),
        settings: { model: "exa-fixture-model", reasoning: "low", timeoutMs: 30_000 }, maxSearches: 1, streamRoutedModelOutput: true,
        on429: () => { rotations++; return null; },
      });
      expect(await response.text()).toContain("I will check.");
      expect(routedSends).toBe(2); expect(rotations).toBe(0);
    } finally { translatorBudget.dispose(); }
  });
}

/** The management removal boundary reconciles every account-qualified bucket before re-add. */
let syntheticReconcileGeneration = 0;
async function reconcileLiveAccounts(): Promise<import("../../../src/lib/state-store-sweeper").GenerationContext> {
  const cache = await import("../../../src/providers/quota/account-cache");
  const recovery = await import("../../../src/providers/quota/anthropic-cooldown-recovery");
  const sweeper = await import("../../../src/lib/state-store-sweeper");
  // Direct hook calls do not publish a lifecycle generation. Advance this fixture's own
  // epoch on EVERY reconciliation, including re-add, instead of presenting the same epoch twice.
  syntheticReconcileGeneration = Math.max(syntheticReconcileGeneration, sweeper.captureConfigGeneration()) + 1;
  const context: import("../../../src/lib/state-store-sweeper").GenerationContext = {
    generation: syntheticReconcileGeneration, providerNames: new Set(instances),
    oauthAccountKeys: new Set(instances.flatMap(instance => store.getAccountSet(instance)!.accounts.map(row => cache.accountCacheKey(instance, row.id)))),
    comboIds: new Set(), comboTargets: new Set(), codexAccountIds: new Set(), configRoots: new Set(),
  };
  fixture.modelQuota.reconcileAllAnthropicFamilyQuota(context);
  fixture.ratePolicy.reconcileAllAnthropicRatePauses(context);
  recovery.reconcileAllAnthropicCooldownGenerations(context);
  cache.reconcileProviderAccountQuotaRows(context);
  routing.reconcileAnthropicRoutingState(context, config);
  return context;
}

async function expectLiveQuotaWriterAdmission(instance: AnthropicInstanceId, id: string): Promise<void> {
  const cache = await import("../../../src/providers/quota/account-cache");
  const sweeper = await import("../../../src/lib/state-store-sweeper");
  // Real sends still capture the lifecycle's numeric writer generation. A restored live key
  // admits that writer through the production live-key exception, even below the fixture epoch.
  expect(cache.mayCommitAccountQuotaKey(cache.accountCacheKey(instance, id), sweeper.captureConfigGeneration())).toBe(true);
}
for (const instance of instances) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  for (const previouslyReserved of [false, true]) {
    for (const status of [200, 403, 429] as const) {
      test(`${instance}: ${status} from identical credential ABA is retired (prior reservation=${previouslyReserved})`, async () => {
        const recovery = await import("../../../src/providers/quota/anthropic-cooldown-recovery");
        const ownRecovery = recovery.anthropicCooldownRecoveryFor(instance);
        const otherRecovery = recovery.anthropicCooldownRecoveryFor(other);
        const model = "claude-fable-5";
        config.providers[instance]!.models!.push(model); fixture.publishConfig();
        const original = structuredClone(store.getAccountSet(instance)!.accounts[0]!);
        const id = original.id;
        if (previouslyReserved) ownRecovery.reserveAnthropicAccountIncarnation(id);
        const siblingGeneration = otherRecovery.anthropicCooldownGeneration(id);
        const siblingActive = store.getAccountSet(other)!.activeAccountId;
        const entered = deferred<void>(); const returned = deferred<Response>();
        reply = () => { entered.resolve(); return returned.promise; };
        const pending = post(instance, {}, { model: `${instance}/${model}` });
        await entered.promise;
        expect(await store.removeAccount(instance, id)).toBe(true);
        const removedContext = await reconcileLiveAccounts();
        // Restore every credential byte, UUID and login ID. The reconciled send incarnation
        // must still reject the retired response; a hash/UUID comparison alone cannot do so.
        await store.mutateStore(auth => { auth[instance]!.accounts.unshift(original); });
        await store.setActiveAccount(instance, id);
        const restoredContext = await reconcileLiveAccounts();
        expect(store.credentialGeneration(store.getAccountCredential(instance, id)!)).toBe(store.credentialGeneration(original.credential));
        const family = fixture.modelQuota.anthropicModelQuotaFor(instance);
        if (status === 200) family.observeAnthropicFamilyQuota(id, [
          { label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: Date.now() + 60_000 },
        ], Date.now());
        const familyGeneration = family.anthropicFamilyQuotaGeneration(id);
        const responseHeaders = {
          "anthropic-ratelimit-unified-5h-utilization": "0.95",
          "anthropic-ratelimit-unified-7d_oi-utilization": "1",
          "anthropic-ratelimit-unified-7d_oi-status": "rejected",
          ...(status === 429 ? { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": "30" } : {}),
        };
        const late = status === 200 ? answer() : refusal(status);
        for (const [name, value] of Object.entries(responseHeaders)) late.headers.set(name, value);
        returned.resolve(late);
        const response = await pending; await response.text();
        expect(response.status).toBe(status); expect(sends).toHaveLength(1);
        expect(fixture.quota.getCachedProviderAccountQuota(instance, id)).toBeNull();
        expect(family.anthropicFamilyQuotaGeneration(id)).toBe(familyGeneration);
        expect(family.anthropicFamilyRejected(id, model)).toBe(status === 200);
        expect(routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(id)).toBeNull();
        expect(fixture.ratePolicy.anthropicRatePolicyFor(instance).anthropicRatePauseUntil(id)).toBeUndefined();
        expect(otherRecovery.anthropicCooldownGeneration(id)).toBe(siblingGeneration);
        expect(store.getAccountSet(other)!.activeAccountId).toBe(siblingActive);
        expect(fixture.quota.getCachedProviderAccountQuota(other, id)).toBeNull();
        expect(routing.anthropicRoutingFor(other).getAnthropicAccountHealthSnapshot(id)).toBeNull();
        expect(fixture.modelQuota.anthropicModelQuotaFor(other).anthropicFamilyRejected(id, model)).toBe(false);
        expect(restoredContext.generation).toBeGreaterThan(removedContext.generation);
        await expectLiveQuotaWriterAdmission(instance, id);
        reply = () => { const fresh = answer(); fresh.headers.set("anthropic-ratelimit-unified-5h-utilization", "0.23"); return fresh; };
        const fresh = await post(instance); await fresh.text();
        expect(fresh.status).toBe(200); expect(sends).toHaveLength(2);
        expect(fixture.ledger.sends[1]!.accountId).toBe(id);
        expect(sends[1]!.token).toBe(`Bearer ${original.credential.access}`);
        expect(fixture.quota.getCachedProviderAccountQuota(instance, id)?.fiveHourPercent).toBe(23);
        expect(fixture.ledger.sends.every(send => send.instance === instance)).toBe(true);
        expect(fixture.quota.getCachedProviderAccountQuota(other, id)).toBeNull();
      });
    }
  }
}

for (const instance of instances) {
  test(`${instance}: relogin with identical credential bytes retires the pending physical response`, async () => {
    const original = structuredClone(store.getAccountSet(instance)!.accounts[0]!);
    const entered = deferred<void>(); const returned = deferred<Response>();
    reply = () => { entered.resolve(); return returned.promise; };
    const pending = post(instance); await entered.promise;
    await store.saveAccountCredential(instance, original.id, original.credential, { rotateLoginId: true });
    expect(store.getAccountSet(instance)!.accounts[0]!.loginId).not.toBe(original.loginId);
    expect(store.credentialGeneration(store.getAccountCredential(instance, original.id)!)).toBe(store.credentialGeneration(original.credential));
    const late = refusal(403); late.headers.set("anthropic-ratelimit-unified-5h-utilization", "0.95"); returned.resolve(late);
    const response = await pending; await response.text();
    expect(response.status).toBe(403); expect(sends).toHaveLength(1);
    expect(fixture.quota.getCachedProviderAccountQuota(instance, original.id)).toBeNull();
    expect(routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(original.id)).toBeNull();
    await expectLiveQuotaWriterAdmission(instance, original.id);
    reply = () => { const fresh = answer(); fresh.headers.set("anthropic-ratelimit-unified-5h-utilization", "0.23"); return fresh; };
    const fresh = await post(instance); await fresh.text();
    expect(fresh.status).toBe(200); expect(sends).toHaveLength(2);
    expect(fixture.ledger.sends[1]!.accountId).toBe(original.id);
    expect(sends[1]!.token).toBe(`Bearer ${original.credential.access}`);
    expect(fixture.quota.getCachedProviderAccountQuota(instance, original.id)?.fiveHourPercent).toBe(23);
  });
}

for (const surface of ["responses", "chat"] as const) {
  for (const lowerRow of ["absent", "disabled-alias"] as const) {
    test(`${surface}: exact uppercase custom provider wins while literal lower B remains unavailable (${lowerRow})`, async () => {
      if (lowerRow === "absent") delete config.providers.anthropic2;
      else {
        config.providers.anthropic2!.alias = "ANTHROPIC2";
        config.providers.anthropic2!.disabled = true;
      }
      const customSends: Array<{ headers: Headers; model: unknown }> = [];
      config.providers.ANTHROPIC2 = {
        adapter: "anthropic", baseUrl: "https://uppercase-key.example.test", authMode: "key", apiKey: "test-uppercase-key", models: [fixture.model],
        fetch: (async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          customSends.push({ headers: new Headers(init?.headers), model: body.model });
          return body.stream === true ? streamedAnswer("The answer is complete.") : answer();
        }) as typeof fetch,
      } as OcxProviderConfig & { fetch: typeof fetch };
      fixture.publishConfig();
      expect(store.getAccountSet("anthropic")!.accounts).toHaveLength(2);
      expect(store.getAccountSet("anthropic2")!.accounts).toHaveLength(2);
      const oauth = await import("../../../src/oauth");
      const activeResolver = spyOn(oauth, "getValidAccessTokenSnapshot");
      const accountResolver = spyOn(oauth, "getValidAccessSnapshotForAccount");
      const sendSelector = async (selector: string) => surface === "responses"
        ? post("anthropic2", {}, { model: selector })
        : (await import("../../../src/server/chat-completions")).handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: selector, messages: [{ role: "user", content: "Answer briefly" }], stream: false }),
        }), config, { model: "", provider: "" });
      try {
        const unavailable = await sendSelector(`anthropic2/${fixture.model}`); await unavailable.text();
        expect(unavailable.status).toBe(401); expect(customSends).toHaveLength(0); expect(sends).toHaveLength(0);
        const custom = await sendSelector(`ANTHROPIC2/${fixture.model}`);
        expect(custom.status).toBe(200); expect(await custom.text()).toContain("The answer is complete.");
        expect(customSends).toHaveLength(1); expect(customSends[0]!.model).toBe(fixture.model);
        expect(customSends[0]!.headers.get("x-api-key")).toBe("test-uppercase-key");
        expect(customSends[0]!.headers.get("authorization")).toBeNull();
        expect(sends).toHaveLength(0); expect(fixture.ledger.sends).toHaveLength(0);
        expect(activeResolver).not.toHaveBeenCalled(); expect(accountResolver).not.toHaveBeenCalled();
      } finally { activeResolver.mockRestore(); accountResolver.mockRestore(); }
    });
  }
}

for (const unavailable of ["absent-row", "unmarked-oauth", "unmarked-chat-oauth"] as const) {
  test(`native Chat key default cannot replace explicit unavailable B (${unavailable})`, async () => {
    if (unavailable === "absent-row") delete config.providers.anthropic2;
    else {
      delete config.providers.anthropic2!.anthropicOAuthInstance;
      delete config.providers.anthropic2!.anthropicAccountPool;
      if (unavailable === "unmarked-chat-oauth") config.providers.anthropic2!.adapter = "openai-chat";
    }
    const defaultKey = "access-token-value-test-native-gateway";
    const defaultSends: Array<{ model: unknown; stream: unknown; headers: Headers }> = [];
    config.defaultProvider = "gateway";
    config.providers.gateway = {
      adapter: "openai-chat", authMode: "key", apiKey: defaultKey, baseUrl: "https://native-gateway.example.test/v1",
      fetch: (async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        defaultSends.push({ model: body.model, stream: body.stream, headers: new Headers(init?.headers) });
        return Response.json({ id: "chatcmpl_gateway", object: "chat.completion", model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: "The answer is complete." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
        });
      }) as typeof fetch,
    } as OcxProviderConfig & { fetch: typeof fetch };
    fixture.publishConfig();
    expect(store.getAccountSet("anthropic")!.accounts).toHaveLength(2);
    expect(store.getAccountSet("anthropic2")!.accounts).toHaveLength(2);
    const { handleChatCompletions } = await import("../../../src/server/chat-completions");
    const { routeModel, routeConcreteModel } = await import("../../../src/router");
    const oauth = await import("../../../src/oauth");
    const activeResolver = spyOn(oauth, "getValidAccessTokenSnapshot");
    const accountResolver = spyOn(oauth, "getValidAccessSnapshotForAccount");
    const send = (model: string) => handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Answer briefly" }], stream: false }),
    }), config, { model: "", provider: "" });
    try {
      const selector = `anthropic2/${fixture.model}`;
      expect(() => routeModel(config, selector)).toThrow("Anthropic Pool 2");
      expect(() => routeConcreteModel(config, selector)).toThrow("Anthropic Pool 2");
      if (unavailable !== "absent-row") {
        // Invalid B OAuth also refuses when selected as a default, without a qualifier.
        expect(() => routeModel({ ...config, defaultProvider: "anthropic2" }, "unknown-bare-model")).toThrow("Anthropic Pool 2");
      }
      const refusal = await send(selector);
      expect(refusal.status).toBe(401);
      expect(await refusal.json()).toMatchObject({ error: { type: "authentication_error" } });
      expect(defaultSends).toHaveLength(0); expect(sends).toHaveLength(0); expect(fixture.ledger.sends).toHaveLength(0);
      expect(activeResolver).not.toHaveBeenCalled(); expect(accountResolver).not.toHaveBeenCalled();
      // The same gateway and request shape must actually enter native Chat for an unrelated
      // slash-containing model. This prevents a bridge-only fixture from hiding the bypass.
      const { nativeChatDeclineReason } = await import("../../../src/server/chat-native-eligibility");
      const controlModel = "vendor/ordinary-slash-model";
      const controlBody = { model: controlModel, messages: [{ role: "user", content: "Answer briefly" }], stream: false };
      expect(nativeChatDeclineReason(routeModel(config, controlModel), controlBody, config)).toBeUndefined();
      const control = await send(controlModel);
      expect(control.status).toBe(200); expect(await control.text()).toContain("The answer is complete.");
      expect(defaultSends).toHaveLength(1); expect(defaultSends[0]!.model).toBe(controlModel);
      expect(defaultSends[0]!.stream).toBe(false);
      expect(defaultSends[0]!.headers.get("authorization")).toBe(`Bearer ${defaultKey}`);
      expect(activeResolver).not.toHaveBeenCalled(); expect(accountResolver).not.toHaveBeenCalled();
    } finally { activeResolver.mockRestore(); accountResolver.mockRestore(); }
  });
}
