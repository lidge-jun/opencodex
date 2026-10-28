import { afterAll, afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown } from "../../src/combos";
import { comboTargetCooldownExpiry, comboTargetCooldownRevision } from "../../src/combos/failover";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import type { ProviderAdapter } from "../../src/adapters/base";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";

// `mock.module` outlives this file: Bun keeps the override below for every file that runs after
// this one in the same process. This is a spread snapshot of the real module, taken before it.
const actualResolver = { ...(await import("../../src/server/adapter-resolve")) };
const actualResolveAdapter = actualResolver.resolveAdapter;
let customRunTurn: NonNullable<ProviderAdapter["runTurn"]> | undefined;

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long") {
    if (provider.adapter !== "test-run-turn") {
      return actualResolveAdapter(provider, cacheRetention);
    }
    return {
      name: "test-run-turn",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "error", message: "test runTurn adapter does not use parseStream" };
      },
      async runTurn(parsed, incoming, emit) {
        if (!customRunTurn) throw new Error("custom runTurn not installed");
        await customRunTurn(parsed, incoming, emit);
      },
    } satisfies ProviderAdapter;
  },
}));

afterAll(() => {  // Put the real module back for every later file in the same process.
  mock.module("../../src/server/adapter-resolve", () => actualResolver);
});

const { handleResponses } = await import("../../src/server/responses");

/**
 * Cooldown-readiness combo failover: a first target that reports ready and then fails
 * must still hand off to the next combo target.
 *
 * This case was written in `server-combo-failover-e2e.test.ts` and moved here. That
 * file carries a file-size-ratchet cap that the new test pushed past its ceiling, so
 * the case lives in this sibling file instead of raising the cap.
 *
 * The harness below is the subset of that file's fixture these cases actually use: real
 * loopback upstreams, an isolated home, and the combo/request-log state that leaks
 * between tests. The loopback cases drive real adapters; the runTurn case uses the same
 * narrow resolver seam as the parent file to emit deterministic adapter events.
 */

// The parent file raises this for the same reason: a real loopback server plus combo
// failover exceeds the 5s default under full-suite load on Windows.
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const provider = comboProviderFactory(() => undefined);
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-zero-output-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-zero-output-"));
  process.env.OPENCODEX_HOME = testDir;
  // Direct handler dispatches need the writer lease that startServer normally holds.
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  clearRequestLogsForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  customRunTurn = undefined;
  // Release before home teardown to prevent Windows removal failures and a live unlinked database.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let responseStatePending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearCodexUpstreamHealth();
    clearRequestLogsForTests();
  }
  expect(responseStatePending).toBe(false);
});

/** Loopback upstream whose lifetime the afterEach owns. */
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

describe("combo cooldown-ready fallback", () => {
  test.each([false, true])("JEV carries an all-cooled reservation through decision and fallback (failed choice=%s)", async failedChoice => {
    const hits: string[] = [];
    const first = serve(() => {
      hits.push("a");
      return Response.json(responsesSuccess("reserved first target"));
    });
    const selected = serve(() => {
      hits.push("b");
      return failedChoice
        ? Response.json({ error: { message: "fixture limit", type: "rate_limit_error" } },
          { status: 429, headers: { "retry-after": "600" } })
        : Response.json(responsesSuccess("reserved JEV choice"));
    });
    const decisions: Array<{ questions: { route: { criteria: Record<string, unknown> } } }> = [];
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(first), "key-a", {
        liveModels: false, models: ["m1"], modelReasoningEfforts: { m1: [] },
      }),
      b: provider("openai-responses", baseUrl(selected), "key-b", {
        liveModels: false, models: ["m2"], modelReasoningEfforts: { m2: [] },
      }),
    }, undefined, { strategy: "jev", cooldownReprobe: { enabled: true } });
    config.providers.jev = provider("jev-decision", "https://api.typesafe.ai/v1/systemone", "jev-fixture-key", {
      liveModels: false,
      fetch: (async (_input, init) => {
        decisions.push(JSON.parse(String(init?.body)));
        return Response.json({ answers: { route: { choice: "b/m2:none", confidence: 0.8 } } });
      }) as typeof fetch,
    });
    for (const target of config.combos!.free!.targets) coolComboTarget("free", target, { retryAfter: "600", status: 429 });
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, logCtx);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(failedChoice ? "reserved first target" : "reserved JEV choice");
    expect(decisions).toHaveLength(1);
    expect(Object.keys(decisions[0]!.questions.route.criteria)).toEqual(["a/m1:none", "b/m2:none"]);
    expect(logCtx.jevDecision?.gate).toBe("apply");
    expect(logCtx.jevDecision?.selected).toMatchObject({ provider: "b", model: "m2" });
    expect(hits).toEqual(failedChoice ? ["b", "a"] : ["b"]);
    expect(isComboTargetInCooldown("free", config.combos!.free!.targets[0]!)).toBe(!failedChoice);
    expect(isComboTargetInCooldown("free", config.combos!.free!.targets[1]!)).toBe(failedChoice);
  });

  test.each([false, true])("JEV rejects a reservation replaced while its decision is pending (all replaced=%s)", async replaceAll => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const hits: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const first = serve(async request => {
      hits.push("a");
      bodies.push(await request.json() as Record<string, unknown>);
      return Response.json(responsesSuccess("current reserved fallback"));
    });
    const selected = serve(() => {
      hits.push("b");
      return Response.json(responsesSuccess("stale reserved choice"));
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(first), "key-a", {
        liveModels: false, models: ["m1"], modelReasoningEfforts: { m1: ["low"] },
      }),
      b: provider("openai-responses", baseUrl(selected), "key-b", {
        liveModels: false, models: ["m2"], modelReasoningEfforts: { m2: ["high"] },
      }),
    }, undefined, { strategy: "jev", reasoningEffortMode: "adaptive", cooldownReprobe: { enabled: true } });
    const decisions: Array<{ questions: { route: { criteria: Record<string, unknown> } } }> = [];
    config.providers.jev = provider("jev-decision", "https://api.typesafe.ai/v1/systemone", "jev-fixture-key", {
      liveModels: false,
      fetch: (async (_input, init) => {
        decisions.push(JSON.parse(String(init?.body)));
        entered.resolve();
        await finish.promise;
        return Response.json({
          answers: { route: { choice: "b/m2:high", confidence: 0.8 } },
          usage: { input_tokens: 3, output_tokens: 1 },
        });
      }) as typeof fetch,
    });
    const targets = config.combos!.free!.targets;
    const retryAfter = new Date(Date.now() + 60_000).toUTCString();
    for (const target of targets) coolComboTarget("free", target, { retryAfter, status: 429 });
    const originalRevision = comboTargetCooldownRevision("free", targets[1]!);
    const originalExpiry = comboTargetCooldownExpiry("free", targets[1]!);
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, logCtx);
    let barrierValidated = false;
    try {
      await Promise.race([entered.promise, pending.then(() => {
        throw new Error("request completed before the JEV decision barrier");
      })]);
      // A concurrent failure writes new evidence while JEV is deciding. Matching expiry
      // must not make this request's older reservation own the replacement cooldown.
      for (const target of replaceAll ? targets : [targets[1]!]) {
        coolComboTarget("free", target, { retryAfter, status: 429 });
      }
      expect(comboTargetCooldownRevision("free", targets[1]!)).not.toBe(originalRevision);
      expect(comboTargetCooldownExpiry("free", targets[1]!)).toBe(originalExpiry);
      barrierValidated = true;
    } finally {
      finish.resolve();
      if (!barrierValidated) {
        // Join the request before fixture teardown without replacing the original assertion.
        try { await (await pending).body?.cancel(); } catch { /* Preserve the barrier failure. */ }
      }
    }
    const response = await pending;
    const text = await response.text();
    expect(hits).toEqual(replaceAll ? [] : ["a"]);
    expect(response.status).toBe(replaceAll ? 503 : 200);
    expect(text).toContain(replaceAll ? "combo_unavailable" : "current reserved fallback");
    expect(decisions).toHaveLength(1);
    expect(Object.keys(decisions[0]!.questions.route.criteria)).toEqual(["a/m1:low", "b/m2:high"]);
    expect(isComboTargetInCooldown("free", targets[1]!)).toBe(true);
    expect(isComboTargetInCooldown("free", targets[0]!)).toBe(replaceAll);
    expect(logCtx.jevDecision).toMatchObject({
      selected: replaceAll ? { provider: "b", model: "m2", effort: "high" }
        : { provider: "a", model: "m1", effort: "low" },
      gate: "invalid", backend: "typesafe", latencyMs: expect.any(Number),
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    });
    expect(logCtx.jevDecision?.confidence).toBeUndefined();
    expect(logCtx.jevDecision?.chosenProbability).toBeUndefined();
    if (replaceAll) expect((logCtx.attempts ?? []).reduce((total, attempt) => total + attempt.sendCount, 0)).toBe(0);
    else expect(bodies[0]!.reasoning).toMatchObject({ effort: "low" });
  });

  test("successful reprobe stays exclusive until dispatch succeeds, then releases its target", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let hits = 0;
    const upstream = serve(async () => {
      hits++;
      started.resolve();
      await finish.promise;
      return Response.json(responsesSuccess("reprobe recovered"));
    });
    const target = { provider: "a", model: "m1" };
    const config = comboConfig({ a: provider("openai-responses", baseUrl(upstream), "key-a") }, [target],
      { cooldownReprobe: { enabled: true } });
    coolComboTarget("free", target, { retryAfter: "600", status: 429 });
    const post = () => handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, { model: "", provider: "" });
    const pending = post();
    try {
      await started.promise;
      const concurrent = await post();
      expect(concurrent.status).toBe(503);
      await concurrent.text();
      expect(hits).toBe(1);
      expect(isComboTargetInCooldown("free", target)).toBe(true);
    } finally { finish.resolve(); }
    const recovered = await pending;
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain("reprobe recovered");
    expect(isComboTargetInCooldown("free", target)).toBe(false);
    const later = await post();
    expect(later.status).toBe(200);
    await later.text();
    expect(hits).toBe(2);
  });

  test("failed single-target reprobe cannot send twice through an identical Retry-After date", async () => {
    const retryAfter = new Date(Date.now() + 60_000).toUTCString();
    let hits = 0;
    const upstream = serve(() => {
      hits++;
      return Response.json({ error: { message: "fixture limit", type: "rate_limit_error" } },
        { status: 429, headers: { "retry-after": retryAfter } });
    });
    const target = { provider: "a", model: "m1" };
    const config = comboConfig({ a: provider("openai-chat", baseUrl(upstream), "key-a") }, [target],
      { cooldownReprobe: { enabled: true }, waitForCooldownMs: 1 });
    coolComboTarget("free", target, { retryAfter, status: 429 });
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(429);
    await response.text();
    expect(hits).toBe(1);
    expect(isComboTargetInCooldown("free", target)).toBe(true);
  });

  test("a reserved last-resort target survives the server's wait-policy fallback", async () => {
    let firstHits = 0;
    let backupHits = 0;
    customRunTurn = async (_parsed, _incoming, emit) => {
      firstHits++;
      emit({ type: "error", status: 429, errorType: "rate_limit_error", message: "fixture limit" });
    };
    const backup = serve(() => {
      backupHits++;
      return Response.json(responsesSuccess("reserved backup recovered"));
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-responses", baseUrl(backup), "key-b"),
    }, undefined, { cooldownReprobe: { enabled: true }, cooldownWaitPolicy: "before-last-resort", waitForCooldownMs: 0 });
    config.combos!.free!.targets[1]!.lastResort = true;
    for (const target of config.combos!.free!.targets) coolComboTarget("free", target, { retryAfter: "600", status: 429 });
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
    }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("reserved backup recovered");
    expect([firstHits, backupHits]).toEqual([1, 1]);
    expect(isComboTargetInCooldown("free", config.combos!.free!.targets[0]!)).toBe(true);
    expect(isComboTargetInCooldown("free", config.combos!.free!.targets[1]!)).toBe(false);
  });

  test("runTurn cooldown-ready heartbeat preserves combo fallback on a final 429", async () => {
    let firstHits = 0;
    let backupHits = 0;
    customRunTurn = async (_parsed, _incoming, emit) => {
      firstHits += 1;
      emit({ type: "heartbeat", preflightReady: true });
      emit({ type: "error", status: 429, errorType: "rate_limit_error", message: "stated reset still active" });
    };
    const backup = serve(() => {
      backupHits += 1;
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "backup after cooldown" } }] })}`,
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    });

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, { model: "", provider: "" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(firstHits).toBe(1);
    expect(backupHits).toBe(1);
    expect(body).toContain("backup after cooldown");
    expect(body).not.toContain("stated reset still active");
  });

  test("a delayed stated reset does not hold a combo child before fallback", async () => {
    const delayedReset = Promise.withResolvers<void>();
    const firstStarted = Promise.withResolvers<void>();
    let firstHits = 0;
    let backupHits = 0;
    customRunTurn = async (_parsed, incoming, emit) => {
      firstHits += 1;
      if (!incoming.comboAttempt) {
        emit({ type: "heartbeat", preflightReady: true });
        firstStarted.resolve();
        await delayedReset.promise;
      } else {
        firstStarted.resolve();
      }
      emit({ type: "error", status: 429, errorType: "rate_limit_error", message: "stated reset still active" });
    };
    const backup = serve(() => {
      backupHits += 1;
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "backup after delayed reset" } }] })}`,
        "data: [DONE]",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-chat", baseUrl(backup), "key-b"),
    });
    const pending = handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, { model: "", provider: "" });
    await firstStarted.promise;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let response: Response | null;
    try {
      response = await Promise.race([
        pending,
        new Promise<null>(resolve => { guard = setTimeout(() => resolve(null), 2_500); }),
      ]);
    } finally {
      if (guard !== undefined) clearTimeout(guard);
      delayedReset.resolve();
    }
    if (response === null) {
      await (await pending).body?.cancel();
      throw new Error("combo held its response until the delayed reset arrived");
    }
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(firstHits).toBe(1);
    expect(backupHits).toBe(1);
    expect(body).toContain("backup after delayed reset");
    expect(body).not.toContain("stated reset still active");
  });
});
/** Provider base URL for a fixture server, without the trailing slash. */
function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

/** Minimal completed Responses payload the backup target answers with. */
function responsesSuccess(text: string, model = "responses-model"): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

/** Failover combo over the supplied providers, one target per provider in order. */
function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
  extra: Partial<NonNullable<OcxConfig["combos"]>[string]> = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { free: { strategy: "failover", targets, ...extra } },
  };
}
