import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { saveCredential, getAccountSet, setActiveAccount } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { rememberResponseState, clearResponseStateForTests } from "../../src/responses/state";
import { admitWorkflowTurn, workflowBudgetSnapshot, resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import type { RequestLogContext } from "../../src/server/request-log";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import { handleResponses } from "../../src/server/responses";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

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
  answer?: (ordinal: number) => Response;
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
      if (options.answer) return options.answer(bodies.length);
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
    return { status: response.status, text, bodies, used: budget.used, workflowSends, attemptSends,
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
    expect(result.text).toContain(status === 400 ? "reasoning_effort max is not supported" : "upstream_reset_replay_refused");
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
