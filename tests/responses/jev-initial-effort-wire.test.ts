import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleResponses } from "../../src/server/responses/core";
import { getActiveTurnCount } from "../../src/server/lifecycle";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import { clearComboSelectionState, clearComboTargetCooldowns, concreteComboRequestBody } from "../../src/combos";
import { getRequestLogEntries, type RequestLogContext } from "../../src/server/request-log";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { chatStream, chatSuccess } from "../helpers/combo-failover-upstream";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Rec = Record<string, unknown>;
type Lane = "native" | "responses";
type Backend = "typesafe" | "systemone" | "model";
let home: string;
let prior: string | undefined;
let codex: IsolatedCodexHome;
let release: () => void;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
beforeEach(() => {
  prior = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "jev-effort-wire-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("jev-effort-codex-");
  release = acquireOwnedSpendHome();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns();
});
afterEach(async () => {
  release();
  for (const server of servers.splice(0)) await server.stop(true);
  closeRequestHistoryIndex();
  await flushResponseState(); clearResponseStateForTests();
  clearComboSelectionState(); clearComboTargetCooldowns(); clearKeyCooldowns();
  resetProviderRequestPacingForTest();
  if (prior === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prior;
  codex.restore(); removeTreeWithRetry(home);
});

/** Start a teardown-owned loopback upstream that records bodies and headers before replying. */
function upstream(reply: (body: Rec) => Response | Promise<Response> = body => body.stream === true ? chatStream("fixture answer") : chatSuccess("fixture answer")) {
  const bodies: Rec[] = [];
  const headers: Headers[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as Rec;
    bodies.push(body); headers.push(req.headers);
    return reply(body);
  } });
  servers.push(server);
  return { bodies, headers, baseUrl: new URL("/v1", server.url).href };
}
/** Build a synthetic Chat provider with an overridable effort ladder and loopback transport. */
function provider(baseUrl: string, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl, allowPrivateNetwork: true, apiKey: "fixture-inference-key",
    authMode: "key", liveModels: false, models: ["m"], reasoningEfforts: ["low", "medium", "high"], ...extra };
}
/** Configure one JEV backend and ingress lane with captured inference and decision requests. */
function fixture(lane: Lane, backend: Backend, effort: "low" | "high" | null, failure = false) {
  const inference = upstream();
  const choice = `a/m:${effort ?? "none"}`;
  const judge = upstream(body => failure
    ? Response.json({ error: { message: "fixture judge unavailable" } }, { status: 500 })
    : backend === "model" ? chatStream(JSON.stringify({ choice }))
    : Response.json({ answers: { route: { choice } } }));
  const decisionBodies: Rec[] = [];
  const config: OcxConfig = {
    port: 0, defaultProvider: "a",
    providers: { a: provider(inference.baseUrl, effort === null ? { reasoningEfforts: [] } : {}) },
    combos: { auto: { strategy: "jev", targets: [{ provider: "a", model: "m" }] } },
    ...(lane === "native" ? { protocols: { rollout: { nativeChatCombos: true } } } : {}),
  };
  if (backend === "model") {
    config.providers.judge = provider(judge.baseUrl, { apiKey: "fixture-judge-key", reasoningEfforts: ["low"] });
    config.combos!.auto!.decisionModel = "judge/m";
  } else {
    const id = backend === "typesafe" ? "jev" : "decider";
    config.providers[id] = { adapter: "jev-decision", liveModels: false, apiKey: "fixture-service-key",
      baseUrl: backend === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : new URL("systemone", judge.baseUrl + "/").href,
      ...(backend === "systemone" ? { defaultModel: "fixture-judge", allowPrivateNetwork: true } : {}),
      ...(backend === "typesafe" ? { fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        decisionBodies.push(JSON.parse(String(init?.body)) as Rec);
        return failure ? Response.json({ error: {} }, { status: 500 }) : Response.json({ answers: { route: { choice } } });
      }) as unknown as typeof fetch } : {}),
    };
    if (backend === "systemone") {
      config.combos!.auto!.decisionProvider = id;
      // System One requires two expanded options; a second no-effort target is still eligible.
      config.providers.b = provider(inference.baseUrl, effort === null ? { reasoningEfforts: [] } : {});
      config.combos!.auto!.targets.push({ provider: "b", model: "m" });
    }
  }
  return { config, inference, judge, decisionBodies };
}
/** Dispatch and drain a fixture request, returning its response and lane-owned log metadata. */
async function send(lane: Lane, config: OcxConfig, extra: Rec = {}, signal?: AbortSignal, headers: Rec = {}, admission?: DataPlaneAdmission) {
  const body = lane === "native"
    ? { model: "combo/auto", messages: [{ role: "user", content: "Solve the fixture task." }], reasoning_effort: "high", stream: false, ...extra }
    : { model: "combo/auto", input: "Solve the fixture task.", reasoning: { effort: "high", summary: "auto" }, stream: false, ...extra };
  const request = new Request(`http://localhost/v1/${lane === "native" ? "chat/completions" : "responses"}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-caller-key",
      "x-codex-parent-thread-id": "fixture-parent-thread", ...headers } as HeadersInit,
    body: JSON.stringify(body), ...(signal ? { signal } : {}),
  });
  const log: RequestLogContext = { model: "", provider: "" };
  const requestId = crypto.randomUUID();
  const response = lane === "native"
    ? await handleChatCompletions(request, config, log, { requestId, start: Date.now(), admission })
    : await handleResponses(request, config, log, { admission, abortSignal: request.signal });
  await response.text();
  const row = lane === "native" ? getRequestLogEntries().find(row => row.requestId === requestId)! : log;
  return { response, row };
}

for (const lane of ["native", "responses"] as const) {
  for (const backend of ["typesafe", "systemone", "model"] as const) {
    for (const effort of ["low", "high", null] as const) {
      test(`${lane}/${backend}: actual initial wire effort ${effort}`, async () => {
        const f = fixture(lane, backend, effort);
        const { response, row } = await send(lane, f.config, { service_tier: "priority", thinking: { type: "enabled" }, thinking_budget: 999,
          ...(lane === "native" ? { reasoning: { effort: "medium", summary: "auto" }, reasoning_effort: "none" } : { reasoning_effort: "none" }) });
        expect(response.status).toBe(200);
        expect(f.inference.bodies).toHaveLength(1);
        const wire = f.inference.bodies[0]!;
        expect(wire.reasoning_effort).toBe(effort ?? undefined);
        expect(wire.service_tier).toBeUndefined();
        expect(wire.thinking).toBeUndefined(); expect(wire.thinking_budget).toBeUndefined();
        expect((wire.reasoning as Rec | undefined)?.effort).toBeUndefined();
        expect(row.jevDecision).toMatchObject({ backend, gate: "apply", selected: { provider: "a", model: "m", effort } });
        expect(row.attempts).toHaveLength(1); expect(row.attempts![0]!.sendCount).toBe(1);
        // row is RequestLogEntry | RequestLogContext; only the persisted entry carries protocolTrace.
        if (lane === "native") expect("protocolTrace" in row ? row.protocolTrace?.attempts?.[0]?.mode : undefined).toBe("native");
        if (backend === "model") {
          expect(f.judge.bodies).toHaveLength(1);
          expect(f.judge.headers[0]!.get("authorization")).toBe("Bearer fixture-judge-key");
          expect(f.judge.headers[0]!.get("x-codex-parent-thread-id")).toBeNull();
          expect(f.judge.bodies[0]!.tools).toBeUndefined();
          expect(f.judge.bodies[0]!.max_tokens ?? f.judge.bodies[0]!.max_completion_tokens).toBe(1024);
        } else expect(backend === "typesafe" ? f.decisionBodies : f.judge.bodies).toHaveLength(1);
      }, 30_000);
    }
  }
  test(`${lane}: unknown effort ladder supports global fail-open null without force defaults`, async () => {
    const f = fixture(lane, "model", null, true);
    delete f.config.providers.a!.reasoningEfforts;
    Object.assign(f.config.combos!.auto!, { defaultEffort: "high", defaultEffortMode: "force" });
    const { response, row } = await send(lane, f.config);
    expect(response.status).toBe(200); expect(f.inference.bodies).toHaveLength(1);
    expect(f.inference.bodies[0]!.reasoning_effort).toBeUndefined();
    expect(row.jevDecision).toMatchObject({ gate: "http", selected: { effort: null } });
  });
  for (const failure of [false, true]) {
    test(`${lane}: force-default plus ${failure ? "failed judge global" : "selected"} null dispatches`, async () => {
      const f = fixture(lane, "model", null, failure);
      Object.assign(f.config.combos!.auto!, { defaultEffort: "high", defaultEffortMode: "force" });
      const { response, row } = await send(lane, f.config);
      expect(response.status).toBe(200);
      expect(f.inference.bodies).toHaveLength(1);
      expect(f.inference.bodies[0]!.reasoning_effort).toBeUndefined();
      expect(row.jevDecision).toMatchObject({ gate: failure ? "http" : "apply", selected: { effort: null } });
    }, 30_000);
  }
}

test.each(["none", "minimal"])("native caller sentinel %s cannot override the initial decision", async caller => {
  const f = fixture("native", "typesafe", "high");
  const { response, row } = await send("native", f.config, { reasoning_effort: caller });
  expect(response.status).toBe(200); expect(f.inference.bodies[0]!.reasoning_effort).toBe("high");
  expect(row.requestedEffort).toBe(`${caller}->high`);
});

test.each(["effortCap", "subagentEffortCap"] as const)("native JEV effort retains provider pin, %s and honest applied transitions", async cap => {
  const f = fixture("native", "model", "low");
  f.config.providers.a!.pinnedReasoningEffort = "high";
  f.config[cap] = "medium";
  const { row } = await send("native", f.config, {}, undefined, { "x-openai-subagent": "collab_spawn" });
  expect(f.inference.bodies[0]!.reasoning_effort).toBe("medium");
  expect(row.jevDecision?.selected.effort).toBe("low");
  expect(row.requestedEffort).toBe("high->low->high->medium");
  expect(row.attempts![0]!.requestedEffort).toBe(row.requestedEffort);
});

test("native initial null still permits a downstream provider pin on an unknown ladder", async () => {
  const f = fixture("native", "model", null);
  delete f.config.providers.a!.reasoningEfforts;
  f.config.providers.a!.pinnedReasoningEffort = "high";
  const { response, row } = await send("native", f.config);
  expect(response.status).toBe(200); expect(f.inference.bodies[0]!.reasoning_effort).toBe("high");
  expect(row.jevDecision?.selected.effort).toBeNull(); expect(row.requestedEffort).toBe("high");
});

test("native provider gateway effort normalization still runs after the JEV choice", async () => {
  const f = fixture("native", "typesafe", "low");
  f.config.providers.a!.reasoningWireFormat = "gateway-object";
  await send("native", f.config);
  expect(f.inference.bodies[0]!.reasoning_effort).toBeUndefined();
  expect(f.inference.bodies[0]!.reasoning).toEqual({ enabled: true, effort: "low" });
});

for (const lane of ["native", "responses"] as const) {
  test(`${lane}: retry targets use original effort and only one classification`, async () => {
    const f = fixture(lane, "model", "low");
    const first = upstream(() => Response.json({ error: { message: "fixture unavailable" } }, { status: 503 }));
    f.config.providers.a!.baseUrl = first.baseUrl;
    f.config.providers.a!.transientRetryOn5xx = { attempts: 1 };
    f.config.providers.b = provider(f.inference.baseUrl);
    f.config.combos!.auto!.targets.push({ provider: "b", model: "m" });
    const { response, row } = await send(lane, f.config);
    expect(response.status).toBe(200); expect(f.judge.bodies).toHaveLength(1);
    expect(first.bodies.length).toBeGreaterThan(0);
    for (const body of first.bodies) expect(body.reasoning_effort).toBe("low");
    expect(f.inference.bodies).toHaveLength(1); expect(f.inference.bodies[0]!.reasoning_effort).toBe("high");
    // Direct Responses ingress has no outer final-log owner to finish the accepted attempt.
    expect(row.attempts!.map(attempt => attempt.status)).toEqual([503, lane === "native" ? 200 : 0]);
    expect(row.attempts![0]!.sendCount).toBe(first.bodies.length);
    expect(row.attempts![1]!.sendCount).toBe(1);
  }, 30_000);
}

test("ordinary force invariant is not relaxed", () => {
  expect(() => concreteComboRequestBody({}, { provider: "a", model: "m" }, null, [], "strict", "force"))
    .toThrow("force combo default effort requires a valid defaultEffort");
});

for (const lane of ["native", "responses"] as const) {
  test(`${lane}: unallowlisted service effort fails open without applying the rejected effort`, async () => {
    const f = fixture(lane, "typesafe", "high");
    f.config.combos!.auto!.targets[0]!.reasoningEfforts = ["low"];
    const { row } = await send(lane, f.config);
    expect(row.jevDecision).toMatchObject({ gate: "invalid", selected: { effort: "low" } });
    expect(f.inference.bodies[0]!.reasoning_effort).toBe("low");
  });
  test(`${lane}: restrictive empty intersection never receives a decision effort`, async () => {
    const f = fixture(lane, "model", "high");
    f.config.providers.a!.reasoningEfforts = [];
    f.config.combos!.auto!.targets[0]!.reasoningEfforts = ["high"];
    f.config.providers.b = provider(f.inference.baseUrl, { reasoningEfforts: ["low"] });
    f.config.combos!.auto!.targets.push({ provider: "b", model: "m" });
    const { row } = await send(lane, f.config);
    expect(row.jevDecision).toMatchObject({ gate: "invalid", selected: { provider: "b", effort: "low" } });
    expect(f.inference.bodies).toHaveLength(1);
    expect(f.inference.bodies[0]!.reasoning_effort).toBe("low");
  });
  test(`${lane}: actual detached model admission denial sends no judge bytes`, async () => {
    const f = fixture(lane, "model", "high");
    f.config.apiKeys = [{ id: "fixture-scope", key: "fixture-scoped-key", name: "fixture", createdAt: "2026-01-01T00:00:00Z", allowedProviders: ["a"] }];
    const { response, row } = await send(lane, f.config, {}, undefined, {}, { kind: "configured", keyId: "fixture-scope", source: "bearer" });
    expect(response.status).toBe(200); expect(f.judge.bodies).toHaveLength(0);
    expect(f.inference.bodies).toHaveLength(1); expect(f.inference.bodies[0]!.reasoning_effort).toBe("medium");
    expect(row.jevDecision).toMatchObject({ backend: "model", gate: "http", selected: { effort: "medium" } });
    expect(getActiveTurnCount()).toBe(0);
  });
  test(`${lane}: cancellation during detached judge prevents inference and releases its turn`, async () => {
    const f = fixture(lane, "model", "low");
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const hold = new Promise<void>(resolve => { finish = resolve; });
    const judge = upstream(async () => { entered(); await hold; return chatStream('{"choice":"a/m:low"}'); });
    f.config.providers.judge!.baseUrl = judge.baseUrl;
    const controller = new AbortController();
    const pending = send(lane, f.config, {}, controller.signal);
    await started;
    const reason = new Error("fixture caller cancellation");
    controller.abort(reason); finish();
    const { response } = await pending;
    expect(controller.signal.reason).toBe(reason); expect(response.status).toBe(499);
    expect(f.inference.bodies).toHaveLength(0); expect(judge.bodies).toHaveLength(1);
    expect(getActiveTurnCount()).toBe(0);
  }, 30_000);
}

test("native model judge with explicit send policy and inference each settle one distinct physical spend", async () => {
  const f = fixture("native", "model", "low");
  // Generic Chat adapters report physical sends through the explicit transient policy path.
  // Unconfigured generic-adapter spend reporting is outside this initial-effort repair.
  f.config.providers.judge!.transientRetryOn5xx = { attempts: 1 };
  const { row } = await send("native", f.config);
  const records = readFileSync(join(home, "spend-ledger.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Rec);
  // One-send turns keep their newest booking open until terminal settlement; a separate
  // dispatch record is only required once a later send confirms an older reservation.
  const reserved = records.filter(record => record.kind === "reserve");
  const settled = records.filter(record => record.kind === "settle");
  expect(f.judge.bodies).toHaveLength(1); expect(f.inference.bodies).toHaveLength(1);
  expect(reserved).toHaveLength(2); expect(settled).toHaveLength(2);
  expect(new Set(settled.map(record => record.send)).size).toBe(2);
  expect(settled.map(record => record.send)).toEqual(reserved.map(record => record.send));
  expect(settled.map(record => record.tokens)).toEqual([3, 3]);
  expect(row.attempts).toHaveLength(1); expect(row.attempts![0]!.sendCount).toBe(1);
  expect(getActiveTurnCount()).toBe(0);
});
