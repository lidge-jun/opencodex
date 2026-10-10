import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { saveCredential, getAccountSet, setActiveAccount } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { rememberResponseState, clearResponseStateForTests } from "../../src/responses/state";
import { admitWorkflowTurn, workflowBudgetSnapshot, resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { beginRequestAttempt, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import { handleResponses } from "../../src/server/responses";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { isNonReplayableResponse, isReplayRefusalResponse, markResponseNonReplayable, replayRefusalResponse, retainReplayRefusal } from "../../src/lib/upstream-retry";
import { requestLogDto } from "../../src/server/management/shared";
import { responseWithDeferredRequestLog } from "../../src/server/relay";
import { sanitizeNonReplayableUpstreamError } from "../../src/server/responses/non-replayable-error";

async function probe(options: {
  provider?: Partial<OcxProviderConfig>;
  providerName?: string;
  body?: Record<string, unknown>;
  resets?: number;
  exhausted?: boolean;
  abort?: boolean;
  spentGrant?: boolean;
  downgrade?: boolean;
  used?: number;
  spendOnDowngrade?: boolean;
  previous?: boolean;
  prepaid?: boolean;
  config?: Partial<OcxConfig>;
  answer?: (ordinal: number, authorization: string | null) => Response;
  executor?: typeof fetch;
  oauth?: boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), "ocx-translated-reset-"));
  const oldHome = process.env.OPENCODEX_HOME;
  const oldFetch = globalThis.fetch;
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  try {
    const budget = createRequestExecutionBudget();
    budget.used = options.used ?? (options.exhausted ? 3 : 0);
    const usedBefore = budget.used;
    if (options.spentGrant) budget.claimAmbiguousResend(1);
    const abort = new AbortController();
    resetWorkflowBudgetsForTest();
    const root = "translated-reset-fixture";
    const admission = admitWorkflowTurn(root, "interactive");
    expect(admission?.admitted).toBe(true);
    if (admission?.admitted) admission.lease.release();
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const extraOptions: Partial<HandleResponsesOptions> = {};
    if (options.prepaid) {
      const reserved = budget.reserveDispatch({ sendClass: "repair", targetKey: "mock|test", countedExternally: true });
      expect(reserved.allowed).toBe(true);
      if (reserved.allowed) {
        extraOptions.compactionRecoveryAttempted = true;
        extraOptions.compactionRecoveryPermit = reserved.permit;
      }
    }
    if (options.previous) rememberResponseState(
      { model: "mock/test", input: "earlier", store: true },
      { id: "resp_translated_prior", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "prior answer" }] }], status: "completed" },
      undefined, { clientThreadId: root },
    );
    if (options.oauth) {
      clearGenericFailoverHealth();
      for (const id of ["first", "second"]) await saveCredential("xai", {
        access: `synthetic-${id}`, refresh: `synthetic-refresh-${id}`,
        expires: Date.now() + 3_600_000, accountId: id,
      }, { addAccount: true });
      await setActiveAccount("xai", getAccountSet("xai")!.accounts[0]!.id);
    }
    const authorizations: Array<string | null> = [];
    const bodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      bodies.push(String(init?.body));
      authorizations.push(new Headers(init?.headers).get("authorization"));
      if (options.executor) return options.executor(_input, init);
      if (options.abort) abort.abort();
      if (options.answer) return options.answer(bodies.length, authorizations.at(-1) ?? null);
      if (options.downgrade && bodies.length === 1) {
        if (options.spendOnDowngrade) budget.claimAmbiguousResend(1);
        return Response.json({ error: { type: "invalid_request_error", param: "reasoning_effort",
          message: "reasoning_effort max is not supported for this model" } }, { status: 400 });
      }
      if (bodies.length <= (options.resets ?? 1) + (options.downgrade ? 1 : 0)) {
        throw Object.assign(new Error("synthetic pre-header reset"), { code: "ECONNRESET" });
      }
      return Response.json({ id: "chat-test", choices: [{ index: 0,
        message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }) as typeof fetch;
    const providerName = options.providerName ?? "mock";
    const config = { port: 0, defaultProvider: providerName, providers: {
      [providerName]: { adapter: "openai-chat", baseUrl: "https://synthetic.invalid/v1", apiKey: "synthetic",
        models: ["test"], retryOnReset: {}, ...options.provider },
    }, ...options.config } as OcxConfig;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "x-codex-parent-thread-id": root },
      body: JSON.stringify({ ...(options.previous ? { previous_response_id: "resp_translated_prior" } : {}), model: "mock/test", input: "hello", store: false, stream: false, ...options.body }),
    }), config, logCtx, { sendBudget: budget, abortSignal: abort.signal, ...extraOptions });
    const text = await response.text();
    const attemptSends = (logCtx.attempts ?? []).reduce((sum, attempt) => sum + attempt.sendCount, 0);
    const workflowSends = workflowBudgetSnapshot(root)?.sends ?? 0;
    if (!Object.hasOwn(options.provider ?? {}, "retryOnReset") || (options.provider?.retryOnReset !== undefined && options.provider.retryOnReset.enabled !== false)) {
      expect(budget.used - usedBefore).toBe(bodies.length);
      expect(workflowSends).toBe(bodies.length);
    }
    expect(attemptSends).toBe(bodies.length);
    return { status: response.status, text, headers: response.headers,
      bodies, used: budget.used, workflowSends, attemptSends,
      grantSpent: budget.ambiguousResendSpent, reserveSpent: budget.reserveSpent, authorizations };

  } finally {
    globalThis.fetch = oldFetch;
    try {
      release();
    } finally {
      clearResponseStateForTests();
      resetWorkflowBudgetsForTest();
      clearGenericFailoverHealth();
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  }
}

describe("translated Responses pre-header reset replay (#6510)", () => {
  test("a bare opt-in replays identical chat bytes once and charges both sends", async () => {
    const result = await probe({});
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(2);
    expect(result.bodies[0]).toBe(result.bodies[1]);
    expect(result.used).toBe(2);
  });

  test.each([
    ["absent opt-in", { provider: { retryOnReset: undefined } }],
    ["disabled opt-in", { provider: { retryOnReset: { enabled: false } } }],
    ["stored turn", { body: { store: true } }],
    ["spent request-wide replacement", { spentGrant: true }],
    ["exact one-send policy", { provider: { transientRetryOn5xx: { attempts: 1 } } }],
  ] as const)("%s does not fund a duplicate turn", async (_name, options) => {
    const result = await probe(options);
    expect(result.status).toBe(429);
    expect(result.text).toContain("upstream_reset_replay_refused");
    expect(result.bodies).toHaveLength(1);
  });

  test("a reset during a rebuilt effort-downgrade send uses the same grant", async () => {
    const result = await probe({ downgrade: true, provider: { reasoningEfforts: ["high", "max"] },
      body: { reasoning: { effort: "max" } } });
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(3);
    expect(result.bodies[1]).toBe(result.bodies[2]);
    expect(result.used).toBe(3);
  });

  test("repeated resets exhaust the grant after two sends", async () => {
    const result = await probe({ resets: 10 });
    expect(result.status).toBe(429);
    expect(result.bodies).toHaveLength(2);
    expect(result.used).toBe(2);
  });

  test("exhausted send budget blocks dispatch", async () => {
    const result = await probe({ exhausted: true });
    expect(result.status).toBe(429);
    expect(result.bodies).toHaveLength(0);
  });

  test("cancellation never spends the replacement", async () => {
    const result = await probe({ abort: true });
    expect(result.status).toBe(499);
    expect(result.bodies).toHaveLength(1);
  });
});

const reset = (): never => { throw Object.assign(new Error("synthetic reset"), { code: "ECONNRESET" }); };
const effortRefusal = (): Response => Response.json({ error: { type: "invalid_request_error",
  param: "reasoning_effort", message: "reasoning_effort max is not supported for this model" } }, { status: 400 });
const chatSuccess = (): Response => Response.json({ id: "chat-test", choices: [{ index: 0,
  message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });

describe("reset replacement error confidentiality", () => {
  const credential = "fixture-active-credential-v1";
  const genericBody = { error: { type: "upstream_error",
    message: "Provider error 400: upstream diagnostic withheld for a non-replayable failure",
  } };
  const diagnostics = [
    ...([
      ["nested JSON escape", credential, "invalid request: \\u0066ixture-active-credential-v1; path C:\\safe\\u1234.txt"],
      ["percent escape", credential, "invalid request: %66ixture-active-credential-v1"],
      ["nested percent escape", credential, "invalid request: %2566ixture-active-credential-v1"],
      ["numeric reference", credential, "invalid request: &#102;ixture-active-credential-v1"],
      ["named reference", "fixture+credential-v1", "invalid request: fixture&plus;credential-v1"],
      ["percent-encoded named reference", "fixture+credential-v1", "invalid request: fixture%26plus%3Bcredential-v1"],
      ["multi-code-point named reference", "fj-credential-v1", "bad key &fjlig;-credential-v1"],
      ["UTF-8 percent sequence", "éabcdeé-active-v1", "invalid request: %C3%A9%61%62%63%64%65%C3%A9-active-v1"],
      ["fullwidth percent", credential, "invalid request: ％66ixture-active-credential-v1"],
      ["uppercase Greek lookalike", "fixture-Active-credential-v1", "invalid request: fixture-\u0391ctive-credential-v1"],
      ["ligature lookalike", credential, "invalid request: \uFB01xture-active-credential-v1"],
      ["fullwidth lookalike", credential, "invalid request: ｆｉｘｔｕｒｅ-active-credential-v1"],
      ["zero-width split", credential, "invalid request: fixture-active-\u200Bcredential-v1"],
      ["nested JSON short escape", "fixture/credential-v1", "invalid request: fixture\\/credential-v1"],
      ["uppercase hex numeric reference", credential, "invalid request: &#X66;ixture-active-credential-v1"],
      ["numeric reference without semicolon", credential, "invalid request: &#102ixture-active-credential-v1"],
      ["legacy named reference without semicolon", "fixture&credential-v1", "invalid request: fixture&ampcredential-v1"],
      ["legacy reference before equals", "fixture&credential", "invalid request: fixture&ampcredential="],
      ["legacy reference before long run", "fixture&" + "a".repeat(40), "invalid request: fixture&amp" + "a".repeat(40)],
      ["over-nested percent encoding", credential, "invalid request: %2525252566ixture-active-credential-v1"],
      ["HTML split", credential, "invalid request: fixture-active-<b>credential-v1</b>"],
      ["query without reference start", credential, "see https://x.test/a?b=1 for details"],
      ["query with reference start", credential, "see https://x.test/a?b=1&c=2"],
      ["redaction marker overlap", "REDACTED", "api_key=REDACTED"],
    ] as const).map(([name, apiKey, message]) => ({ name, apiKey,
      text: JSON.stringify({ error: { message } }), contentType: "application/json", type: "upstream_error" })),
    ...([
      ["plain echo", credential, `invalid request: ${credential}`, "text/plain"],
      ["JSON unicode escape", credential, JSON.stringify({ error: { message: credential } }).replaceAll("f", "\\u0066"), "application/json"],
      ["JSON short escape", "fixture/credential-v1", '{"error":{"message":"fixture\\/credential-v1"}}', "application/json"],
      ["numeric credential normalized to exponent", "1000000000000000000000", '{"error":{"code":1e21}}', "application/json"],
      ["numeric scalar credential", "867530912345", '{"error":{"message":"invalid request","code":867530912345,"count":17,"flag":false}}', "application/json"],
      ["boolean scalar credential", "true", '{"error":{"message":"x","code":true}}', "application/json"],
      ["null scalar credential", "null", '{"error":{"message":"x","code":null}}', "application/json"],
      ["credential as JSON key", credential, JSON.stringify({ error: { [credential]: 1 } }), "application/json"],
      ["non-ASCII JSON key", "fixture-Active", JSON.stringify({ error: { message: "x", ["fixture-\u0391ctive"]: 1 } }), "application/json"],
      ["array body", credential, JSON.stringify([credential, { message: `invalid request: ${credential}` }, 17]), "application/json"],
      ["non-2xx SSE body", credential, `event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"invalid request: ${credential}"}}}\n\n`, "text/event-stream"],
      ["malformed JSON", credential, `{"error":{"message":"invalid request: ${credential}"`, "application/json"],
      ["over-nested JSON", credential, '{"detail":'.repeat(65) + JSON.stringify(credential) + "}".repeat(65), "application/json"],
      ["escaped credential in every JSON field", credential, JSON.stringify({ error: { message: credential, type: credential, code: credential },
        [credential]: credential }).replaceAll(credential, credential.replaceAll("f", "\\u0066")), "application/json"],
    ] as const).map(([name, apiKey, text, contentType]) => ({ name, apiKey, text, contentType, type: "upstream_error" })),
    { name: "allowlisted type with hostile message", apiKey: credential,
      text: JSON.stringify({ error: { type: "invalid_request_error", message: credential } }),
      contentType: "application/json", type: "invalid_request_error" },
  ];
  test.each((["openai-chat", "openai-responses"] as const).flatMap(adapter =>
    diagnostics.map(diagnostic => [adapter, diagnostic.name, diagnostic] as const),
  ))("%s withholds upstream diagnostics (%s)", async (adapter, _name, diagnostic) => {
    const result = await probe({ provider: { adapter, apiKey: diagnostic.apiKey }, answer: ordinal => ordinal === 1
      ? reset() : new Response(diagnostic.text, { status: 400, headers: { "content-type": diagnostic.contentType } }) });
    expect(result.authorizations).toEqual([`Bearer ${diagnostic.apiKey}`, `Bearer ${diagnostic.apiKey}`]);
    expect(result.status).toBe(400);
    expect(result.bodies).toHaveLength(2);
    expect(result.used).toBe(2);
    expect(result.grantSpent).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ error: { type: diagnostic.type, message: genericBody.error.message } });
    expect(result.text).not.toContain(diagnostic.apiKey);
  });

  for (const adapter of ["openai-chat", "openai-responses"] as const) {
    test(`${adapter} preserves an allowlisted upstream error type`, async () => {
      const result = await probe({ provider: { adapter, apiKey: credential }, answer: ordinal => ordinal === 1
        ? reset() : Response.json({ error: { type: "invalid_request_error", message: credential } }, { status: 400 }) });
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(2);
      expect(result.used).toBe(2);
      expect(result.grantSpent).toBe(true);
      expect(JSON.parse(result.text)).toEqual({ error: { type: "invalid_request_error", message: genericBody.error.message } });
      expect(result.text).not.toContain(credential);
    });

    test(`${adapter} preserves an allowlisted upstream error code without its diagnostic`, async () => {
      const result = await probe({ provider: { adapter, apiKey: credential }, answer: ordinal => ordinal === 1
        ? reset() : Response.json({ error: { type: "invalid_request_error", code: "context_length_exceeded", message: credential } }, { status: 400 }) });
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(2);
      expect(result.used).toBe(2);
      expect(result.grantSpent).toBe(true);
      expect(JSON.parse(result.text)).toEqual({ error: { type: "invalid_request_error",
        code: "context_length_exceeded", message: genericBody.error.message } });
      expect(result.text).not.toContain(credential);
    });

    test.each(["unrecognized_error_code", credential])(`${adapter} drops an unapproved upstream error code (%s)`, async code => {
      const result = await probe({ provider: { adapter, apiKey: credential }, answer: ordinal => ordinal === 1
        ? reset() : Response.json({ error: { type: "invalid_request_error", code, message: credential } }, { status: 400 }) });
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(2);
      expect(result.used).toBe(2);
      expect(result.grantSpent).toBe(true);
      expect(JSON.parse(result.text)).toEqual({ error: { type: "invalid_request_error", message: genericBody.error.message } });
      expect(result.text).not.toContain(code);
      expect(result.text).not.toContain(credential);
    });

    test(`${adapter} rejects a credential-valued upstream error type`, async () => {
      const result = await probe({ provider: { adapter, apiKey: credential }, answer: ordinal => ordinal === 1
        ? reset() : Response.json({ error: { type: credential } }, { status: 400 }) });
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(2);
      expect(result.used).toBe(2);
      expect(result.grantSpent).toBe(true);
      expect(JSON.parse(result.text)).toEqual(genericBody);
      expect(result.text).not.toContain(credential);
    });

    test(`${adapter} drops upstream diagnostic headers and preserves retry refusal`, async () => {
      const result = await probe({ provider: { adapter, apiKey: credential }, answer: ordinal => ordinal === 1
        ? reset() : Response.json({ error: { message: `invalid request: ${credential}` } }, { status: 400, headers: {
          "x-debug-token": credential, "x-upstream-debug": credential, "set-cookie": `diagnostic=${credential}`,
          "retry-after": "0", "x-should-retry": "false",
        } }) });
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(2);
      expect(result.used).toBe(2);
      expect(result.grantSpent).toBe(true);
      expect(JSON.parse(result.text)).toEqual(genericBody);
      expect(result.text).not.toContain(credential);
      expect([...result.headers.entries()]).toEqual([["content-type", "application/json"], ["x-should-retry", "false"]]);
      expect(result.headers.get("x-debug-token")).toBeNull();
      expect(result.headers.get("x-upstream-debug")).toBeNull();
      expect(result.headers.get("set-cookie")).toBeNull();
      expect(result.headers.get("retry-after")).toBeNull();
      expect(result.headers.get("x-should-retry")).toBe("false");
    });

    test(`${adapter} withholds diagnostics after header OWS normalization`, async () => {
      const result = await probe({ provider: { adapter, apiKey: `${credential} ` }, answer: (ordinal, authorization) => ordinal === 1
        ? reset() : Response.json({ error: { message: `invalid request: ${authorization!.replace(/^Bearer /, "")}` } }, { status: 400 }) });
      expect(result.authorizations).toEqual([`Bearer ${credential}`, `Bearer ${credential}`]);
      expect(result.status).toBe(400);
      expect(result.bodies).toHaveLength(2);
      expect(JSON.parse(result.text)).toEqual(genericBody);
    });
  }

  test("withholds diagnostics after an OAuth account replacement", async () => {
    const result = await probe({ oauth: true, providerName: "xai", provider: { adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1", authMode: "oauth", models: ["test"] },
      body: { model: "xai/test" }, answer: (ordinal, authorization) => ordinal === 1
        ? Response.json({ error: { message: "quota exhausted" } }, { status: 429 })
        : ordinal === 2 ? reset() : Response.json({ error: { message: `invalid request: ${authorization}` } }, { status: 400 }) });
    expect(result.status).toBe(400);
    expect(result.authorizations[0]).not.toBe(result.authorizations[2]);
    expect(result.text).not.toContain(result.authorizations[2]!.replace(/^Bearer /, ""));
    expect(JSON.parse(result.text)).toEqual(genericBody);
    expect(result.bodies).toHaveLength(3);
  });

  test.each(["openai-chat", "openai-responses"] as const)("%s keeps a replacement terminal through combo consumption", async adapter => {
    const result = await probe({ provider: { adapter, apiKey: credential, models: ["test", "other"] },
      config: { combos: { pair: { strategy: "failover", targets: [
        { provider: "mock", model: "test" }, { provider: "mock", model: "other" },
      ] } } }, body: { model: "combo/pair" }, answer: ordinal => ordinal === 1 ? reset()
        : ordinal === 2 ? Response.json({ error: { code: "context_length_exceeded", message: `context length exceeded: ${credential}` } }, { status: 400 })
          : chatSuccess() });
    expect(result.status).toBe(400);
    expect(result.text).not.toContain(credential);
    // The combo owner reformats the consumed failure; it can only restate the sanitized projection.
    expect(JSON.parse(result.text).error.message).toContain(genericBody.error.message);
    expect(result.text).not.toContain("context length exceeded");
    expect(result.bodies).toHaveLength(2);
  });

  test("the client projection preserves marker provenance before lifetime wrapping", async () => {
    const upstream = Response.json({ error: { message: `invalid request: ${credential}` } }, { status: 400 });
    markResponseNonReplayable(upstream);
    const safe = await sanitizeNonReplayableUpstreamError(upstream, new AbortController().signal);
    expect(safe.status).toBe(400);
    expect(isNonReplayableResponse(safe)).toBe(true);
    expect(isReplayRefusalResponse(safe)).toBe(false);
    expect(await safe.text()).not.toContain(credential);
    const refusal = replayRefusalResponse();
    expect(await sanitizeNonReplayableUpstreamError(refusal, new AbortController().signal)).toBe(refusal);
    expect(isReplayRefusalResponse(refusal)).toBe(true);
    await refusal.text();
  });

  test("an ordinary error keeps its existing delivery owner", async () => {
    const upstream = Response.json({ error: { message: "ordinary error" } }, { status: 400 });
    expect(await sanitizeNonReplayableUpstreamError(upstream, new AbortController().signal)).toBe(upstream);
    await upstream.text();
  });

  test("bodyless terminal responses retain their real status", async () => {
    const upstream = new Response(null, { status: 304, headers: { "x-upstream-debug": credential } });
    markResponseNonReplayable(upstream);
    const safe = await sanitizeNonReplayableUpstreamError(upstream, new AbortController().signal);
    expect(safe.status).toBe(304);
    expect(safe.body).toBeNull();
    expect(safe.headers.get("x-upstream-debug")).toBeNull();
    expect(isNonReplayableResponse(safe)).toBe(true);
  });

  test("oversized or cancelled diagnostics release their reader without leaking a prefix", async () => {
    for (const abortRead of [false, true]) {
      const abort = new AbortController();
      let cancelled = false;
      const upstream = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(credential + (abortRead ? "" : "x".repeat(65_536))));
          if (abortRead) queueMicrotask(() => abort.abort());
        },
        cancel() { cancelled = true; },
      }), { status: 400 });
      markResponseNonReplayable(upstream);
      const safe = await sanitizeNonReplayableUpstreamError(upstream, abort.signal);
      expect(safe.status).toBe(abortRead ? 499 : 400);
      expect(await safe.text()).not.toContain(credential);
      expect(cancelled).toBe(true);
      expect(isNonReplayableResponse(safe)).toBe(true);
    }
  });
});

describe("translated reset replay boundaries and accounting", () => {
  test("a valid stored predecessor refuses replay even after local expansion", async () => {
    const result = await probe({ previous: true });
    expect(result.status, result.text).toBe(429);
    expect(result.text).toContain("upstream_reset_replay_refused");
    expect(result.bodies).toHaveLength(1);
    expect(result.bodies[0]).toContain("prior answer");
    expect(result.grantSpent).toBe(false);
  });

  test.each([
    ["conversation", { conversation: "conv-fixture" }],
    ["stream id", { stream_id: "stream-fixture" }],
    ["hosted tool", { tools: [{ type: "web_search" }] }],
  ])("%s cannot authorize an ambiguous replacement", async (_label, body) => {
    const result = await probe({ body });
    expect(result.status).toBe(429);
    expect(result.text).toContain("upstream_reset_replay_refused");
    expect(result.bodies).toHaveLength(1);
    expect(result.grantSpent).toBe(false);
  });

  test.each([400, 401, 429, 503])("replacement HTTP %i is terminal before rebuild or target hop", async status => {
    const result = await probe({ provider: { reasoningEfforts: ["high", "max"], retryOn429: { attempts: 2 } },
      body: { reasoning: { effort: "max" } },
      answer: ordinal => ordinal === 1 ? reset() : status === 400 ? effortRefusal()
        : Response.json({ error: { message: "recoverable-looking failure" } }, { status }) });
    expect(result.status, result.text).toBe(status === 400 ? 400 : 429);
    if (status === 400) expect(JSON.parse(result.text)).toEqual({ error: { type: "invalid_request_error",
      message: "Provider error 400: upstream diagnostic withheld for a non-replayable failure",
    } });
    else expect(result.text).toContain("upstream_reset_replay_refused");
    expect(result.bodies).toHaveLength(2);
    expect(result.bodies[0]).toBe(result.bodies[1]);
    expect(result.grantSpent).toBe(true);
  });

  test("a grant spent before rebuild stays spent on the rebuilt reset", async () => {
    const result = await probe({ downgrade: true, spendOnDowngrade: true,
      provider: { reasoningEfforts: ["high", "max"] }, body: { reasoning: { effort: "max" } } });
    expect(result.status).toBe(429);
    expect(result.text).toContain("upstream_reset_replay_refused");
    expect(result.bodies).toHaveLength(2);
    expect(result.bodies[0]).not.toBe(result.bodies[1]);
    expect(result.grantSpent).toBe(true);
  });

  test("two granted replacements are shared within the configured three sends", async () => {
    const result = await probe({ resets: 2, provider: { retryOnReset: { replacements: 2 } } });
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(3);
    expect(new Set(result.bodies).size).toBe(1);
    expect(result.used).toBe(3);
    expect(result.workflowSends).toBe(3);
  });

  test.each([1, 2, 3])("configured total %i remains exact across an effort rebuild", async attempts => {
    const result = await probe({ provider: { reasoningEfforts: ["high", "max"],
      transientRetryOn5xx: { attempts } }, body: { reasoning: { effort: "max" } },
      answer: ordinal => ordinal === 1 ? effortRefusal() : ordinal === 2 ? reset() : chatSuccess() });
    expect(result.bodies).toHaveLength(attempts);
    expect(result.used).toBe(attempts);
    expect(result.reserveSpent).toBe(false);
    expect(result.status).toBe(attempts === 3 ? 200 : 429);
    if (attempts === 2) expect(result.text).toContain("upstream_reset_replay_refused");
  });

  test("a configured total also deducts sends from an earlier request leg", async () => {
    const result = await probe({ used: 1, provider: { transientRetryOn5xx: { attempts: 2 } } });
    expect(result.status).toBe(429);
    expect(result.bodies).toHaveLength(1);
    expect(result.used).toBe(2);
    expect(result.grantSpent).toBe(false);
  });

  test.each([false, true])("a prepaid compaction slot is counted once (exact policy %s)", async exact => {
    const result = await probe({ prepaid: true, resets: 0, used: 2,
      provider: exact ? { transientRetryOn5xx: { attempts: 3 } } : {}, answer: () => chatSuccess() });
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(1);
    expect(result.used).toBe(3);
    expect(result.workflowSends).toBe(1);
  });

  test.each([false, true])("a prepaid repair's last slot survives reset-only accounting (base exhausted %s)", async lastSlot => {
    const fastRefusal = () => Response.json({ type: "error", error: { type: "rate_limit_error",
      message: "Usage credits are required for fast mode." } }, { status: 429 });
    const success = () => Response.json({ id: "msg-ok", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    const result = await probe({ providerName: "anthropic-apikey", used: lastSlot ? 2 : 0, provider: { adapter: "anthropic",
      baseUrl: "https://api.anthropic.com", models: ["claude-opus-5-5"], fastEnabled: true },
      config: { fastMode: true }, body: { model: "anthropic-apikey/claude-opus-5-5" },
      answer: ordinal => ordinal === 1 ? fastRefusal() : success() });
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(2);
    expect(JSON.parse(result.bodies[0]!).speed).toBe("fast");
    expect(JSON.parse(result.bodies[1]!).speed).toBeUndefined();
    expect(result.used).toBe(lastSlot ? 4 : 2);
    expect(result.reserveSpent).toBe(lastSlot);
    expect(result.workflowSends).toBe(2);
  });

  test("a compact-only prepaid slot without retry policies cannot replace a reset", async () => {
    const result = await probe({ prepaid: true, provider: { retryOnReset: undefined } });
    expect(result.status).toBe(429);
    expect(result.text).toContain("upstream_reset_replay_refused");
    expect(result.bodies).toHaveLength(1);
    expect(result.used).toBe(1);
    expect(result.workflowSends).toBe(1);
    expect(result.grantSpent).toBe(false);
  });

  test("direct Google compact-only recovery keeps one send without either policy", async () => {
    const result = await probe({ prepaid: true, provider: { adapter: "google", retryOnReset: undefined },
      answer: () => Response.json({ error: { message: "temporary unavailable" } }, { status: 503 }) });
    expect(result.status).toBe(503);
    expect(result.bodies).toHaveLength(1);
    expect(result.used).toBe(1);
    expect(result.workflowSends).toBe(1);
  });

  test.each([false, true])("a prepaid OAuth hop is charged once even with an inapplicable transient policy (%s)", async exact => {
    const result = await probe({ oauth: true, providerName: "xai", provider: { adapter: "openai-chat",
      baseUrl: "https://api.x.ai/v1", authMode: "oauth", models: ["test"],
      ...(exact ? { transientRetryOn5xx: { attempts: 2 } } : {}) },
      body: { model: "xai/test" }, answer: ordinal => ordinal === 1
        ? Response.json({ error: { message: "quota exhausted" } }, { status: 429 }) : chatSuccess() });
    expect(result.status, result.text).toBe(200);
    expect(result.bodies).toHaveLength(2);
    expect(result.used).toBe(2);
    expect(result.workflowSends).toBe(2);
    expect(result.authorizations[0]).not.toBe(result.authorizations[1]);
    expect(result.reserveSpent).toBe(false);
  });

  test.each([false, true])("translated post-header stream reset never replays (output %s)", async output => {
    const result = await probe({ body: { stream: true }, answer: () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "chat-stream", choices: [
          { index: 0, delta: output ? { role: "assistant", content: "visible" } : { role: "assistant" }, finish_reason: null },
        ] })}\n\n`));
      },
      pull(controller) { controller.error(Object.assign(new Error("post-header reset"), { code: "ECONNRESET" })); },
    }), { headers: { "content-type": "text/event-stream" } }) });
    expect(result.status).toBe(200);
    expect(result.text).toContain("response.failed");
    if (output) expect(result.text).toContain("visible");
    expect(result.bodies).toHaveLength(1);
    expect(result.grantSpent).toBe(false);
  });

  test("a real upstream consumes the complete body then disconnects before headers", async () => {
    const received: string[] = [];
    let signalSecondBody!: () => void;
    const secondBody = new Promise<void>(resolve => { signalSecondBody = resolve; });
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push(Buffer.concat(chunks).toString());
        if (received.length === 1) request.socket.destroy();
        else {
          signalSecondBody();
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "chat-loopback", choices: [{ index: 0,
            message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        }
      });
    });
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no loopback port");
      const result = await probe({ provider: { baseUrl: `http://127.0.0.1:${address.port}/v1`, allowPrivateNetwork: true }, executor: globalThis.fetch });
      expect(result.status, result.text).toBe(200);
      await secondBody;
      expect(received).toHaveLength(2);
      expect(received[0]).toBe(received[1]);
      expect(JSON.parse(received[0]!).messages).toEqual([{ role: "user", content: "hello" }]);
      expect(result.used).toBe(2);
      expect(result.workflowSends).toBe(2);
      expect(result.attemptSends).toBe(2);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});

function tracked(response: Response) {
  const attempt = beginRequestAttempt(1, "fixture-provider", "fixture-model", "openai-responses");
  const logCtx: RequestLogContext = {
    model: "fixture-model", provider: "fixture-provider", activeAttempt: attempt, attempts: [attempt],
  };
  const entries: RequestLogEntry[] = [];
  const result = responseWithDeferredRequestLog(response, "ocx-replay-attribution", Date.now(), logCtx,
    entry => entries.push(entry));
  return { result, entries, logCtx, attempt };
}

function expectAttribution(entry: RequestLogEntry, cause: string, permission: string) {
  expect(entry.failureCause).toBe(cause);
  expect(entry.attempts?.at(-1)?.failureCause).toBe(cause);
  const dto = requestLogDto(entry);
  expect(dto.resendPermission).toBe(permission);
  expect((dto.attempts as Record<string, unknown>[]).at(-1)?.resendPermission).toBe(permission);
}

describe("deferred replay refusal attribution", () => {
  test("synthetic refusal records ambiguous execution without changing the client response", async () => {
    const original = replayRefusalResponse();
    const payload = await original.clone().text();
    const { result, entries, attempt } = tracked(original);
    expect(entries).toHaveLength(0);
    expect(result.status).toBe(429);
    expect([...result.headers]).toEqual([...original.headers]);
    expect(result.headers.get("x-should-retry")).toBe("false");
    expect(result.headers.get("retry-after")).toBeNull();
    expect(isReplayRefusalResponse(result)).toBe(true);
    expect(await result.text()).toBe(payload);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expectAttribution(entry, "transport-ambiguous", "refused-ambiguous");
    expect(entry.status).toBe(429);
    expect(entry.terminalSource).toBe("synthetic");
    expect(entry.errorCode).toBe("upstream_reset_replay_refused");
    expect(attempt.errorCode).toBe("upstream_reset_replay_refused");
  });

  test("marker wins when the refusal message is unfamiliar", async () => {
    const payload = JSON.stringify({ error: { message: "Fixture diagnostic without replay keywords" } });
    const { result, entries } = tracked(retainReplayRefusal(new Response(payload, {
      status: 429, headers: { "content-type": "application/json" },
    })));
    expect(await result.text()).toBe(payload);
    expect(entries).toHaveLength(1);
    expectAttribution(entries[0]!, "transport-ambiguous", "refused-ambiguous");
    expect(entries[0]!.errorCode).toBe("upstream_reset_replay_refused");
    expect(entries[0]!.terminalSource).toBe("synthetic");
  });

  test("a bodyless marked refusal still supplies closed attribution facts", () => {
    const original = retainReplayRefusal(new Response(null, { status: 429 }));
    const { result, entries } = tracked(original);
    expect(result).toBe(original);
    expect(entries).toHaveLength(1);
    expectAttribution(entries[0]!, "transport-ambiguous", "refused-ambiguous");
    expect(entries[0]!.errorCode).toBe("upstream_reset_replay_refused");
    expect(entries[0]!.terminalSource).toBe("synthetic");
  });

  test("an empty marked refusal supplies attribution without JSON diagnostics", async () => {
    const { result, entries } = tracked(retainReplayRefusal(new Response("", {
      status: 429, headers: { "content-type": "application/json" },
    })));
    expect(await result.text()).toBe("");
    expect(entries).toHaveLength(1);
    expectAttribution(entries[0]!, "transport-ambiguous", "refused-ambiguous");
    expect(entries[0]!.errorCode).toBe("upstream_reset_replay_refused");
    expect(entries[0]!.terminalSource).toBe("synthetic");
  });

  test("unmarked upstream refusal wording cannot prove an ambiguous transport failure", async () => {
    const payload = JSON.stringify({ error: {
      code: "upstream_reset_replay_refused",
      message: "The upstream exchange did not complete reliably. The request may already have been processed; automatic replay was stopped.",
    } });
    const { result, entries, logCtx } = tracked(new Response(payload, {
      status: 429, headers: { "content-type": "application/json", "retry-after": "7" },
    }));
    expect(isReplayRefusalResponse(result)).toBe(false);
    expect(result.status).toBe(429);
    expect(result.headers.get("retry-after")).toBe("7");
    expect(await result.text()).toBe(payload);
    expect(entries).toHaveLength(1);
    expect(logCtx.causeHint).toBeUndefined();
    expect(entries[0]!.terminalSource).toBeUndefined();
    expectAttribution(entries[0]!, "rate-limit", "permitted");
  });

  for (const code of ["rate_limit_exceeded", "upstream_reset_replay_refused"]) {
    test(`genuine upstream 429 remains a rate limit even with code ${code}`, async () => {
      const payload = JSON.stringify({ error: { code, message: "Fixture provider throttled" } });
      const original = new Response(payload, {
        status: 429, headers: { "content-type": "application/json", "retry-after": "7" },
      });
      const { result, entries, logCtx } = tracked(original);
      expect(isReplayRefusalResponse(result)).toBe(false);
      expect(result.status).toBe(429);
      expect(result.headers.get("retry-after")).toBe("7");
      expect(await result.text()).toBe(payload);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.errorCode).toBe("rate_limit_exceeded");
      expect(entries[0]!.terminalSource).toBeUndefined();
      expect(logCtx.causeHint).toBeUndefined();
      expectAttribution(entries[0]!, "rate-limit", "permitted");
    });
  }

  test("client cancellation retains precedence over a marked refusal", async () => {
    const { result, entries } = tracked(replayRefusalResponse());
    await result.body!.cancel();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe(499);
    expect(entries[0]!.errorCode).toBe("client_closed_request");
    expectAttribution(entries[0]!, "client-cancelled", "refused-futile");
  });
});
