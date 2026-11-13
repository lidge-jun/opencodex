import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAdvisorRuntimePlan, type AdvisorRuntimeDeps } from "../../src/advisor/runtime";
import { createAdvisorTaskBudget } from "../../src/advisor/budget";
import { createAdvisorActivityStore } from "../../src/advisor/activity";
import { createAdvisorPreflightLedger } from "../../src/advisor/state";
import { parseRequest } from "../../src/responses/parser";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleAdvisorRoutes } from "../../src/server/management/advisor-routes";
import type { ManagementContext } from "../../src/server/management/context";
import {
  createRegisteredAdvisorPlan, linkAdvisorPlanConfig, setAdvisorPlanFactory, type AdvisorPlanInput,
} from "../../src/server/responses/advisor-plan-slot";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";

// The Advisor factory is registered on the live config object, but /v1/messages hands the
// Responses pipeline a request-scoped replay view (`buildClaudeReplayConfig` plus cacheRetention).
// Looking the factory up by that view alone found nothing, so Claude Code never saw the advisor
// tool and preflight never ran while /v1/chat/completions on the same config worked.

const workerStream = 'data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":null}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

/** Distinctive advice so the dispatched worker body proves what the preflight pass delivered. */
const ADVICE = "advise from the translated messages fixture";
const TASK = "synthetic-private-task-marker";
const ERROR_BODY = "synthetic-private-error-body-marker";
const CREDENTIAL = "synthetic-private-credential-marker";

/** Distinctive advice so the worker body proves it carried the preflight payload. */
const STUB_ADVICE = '{"advisor_result":{"status":"advice","advice":"stub-advice-marker"}}';

const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const plan = (seen: AdvisorPlanInput[], preflights: OcxParsedRequest[] = []) => async (input: AdvisorPlanInput) => {
  seen.push(input);
  return {
    tool: { name: "advisor", description: "fixture", parameters: { type: "object", properties: {} }, advisor: true },
    preflightInject: async (parsed: OcxParsedRequest) => {
      preflights.push(parsed);
      parsed.context.messages = [
        ...parsed.context.messages,
        { role: "user", content: STUB_ADVICE, timestamp: Date.now() },
      ];
      return true;
    },
    attachGuard: () => {},
  };
};

test("a linked request view resolves the live factory at lookup time", async () => {
  const live = { port: 10100, providers: {} } as OcxConfig;
  const view = linkAdvisorPlanConfig(live, { ...live, cacheRetention: "short" as const });
  const nested = linkAdvisorPlanConfig(view, { ...view });
  const seen: AdvisorPlanInput[] = [];
  expect(createRegisteredAdvisorPlan({ config: view, workerIdentity: "w", workerModelId: "w" })).toBeNull();
  setAdvisorPlanFactory(live, plan(seen));
  try {
    expect((await createRegisteredAdvisorPlan({ config: view, workerIdentity: "w", workerModelId: "w" }))?.tool.name).toBe("advisor");
    expect((await createRegisteredAdvisorPlan({ config: nested, workerIdentity: "w", workerModelId: "w" }))?.tool.name).toBe("advisor");
    // The plan still receives the view it was asked for, not the live object.
    expect(seen.map(input => input.config)).toEqual([view, nested]);
    expect(seen[0]!.config).toBe(view);
    // The read-through accessor keeps the view cloneable (#7974).
    expect(structuredClone(view).cacheRetention).toBe("short");
    // An unrelated copy never inherits a factory it was not linked to.
    expect(createRegisteredAdvisorPlan({ config: { ...live }, workerIdentity: "w", workerModelId: "w" })).toBeNull();
  } finally { setAdvisorPlanFactory(live, null); }
  // Disabling the live config detaches every view linked to it.
  expect(createRegisteredAdvisorPlan({ config: view, workerIdentity: "w", workerModelId: "w" })).toBeNull();
});

test("/v1/messages reaches the factory registered on the live config and sends the advisor tool", async () => {
  const release = acquireOwnedSpendHome();
  const workerBodies: Record<string, unknown>[] = [];
  const seen: AdvisorPlanInput[] = [];
  const preflights: OcxParsedRequest[] = [];
  const config: OcxConfig = {
    defaultProvider: "worker",
    providers: { worker: { adapter: "openai-chat", apiKey: "fixture", models: ["m"], liveModels: false,
      baseUrl: "https://worker.test/v1",
      fetch: (async (_url, init) => {
        workerBodies.push(JSON.parse(String(init?.body)));
        return new Response(workerStream, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch } },
  };
  setAdvisorPlanFactory(config, plan(seen, preflights));
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "worker/m", max_tokens: 100, stream: false, messages: [{ role: "user", content: "fixture" }] }),
    }), config, { model: "", provider: "" }, { requestId: "advisor-messages", start: Date.now() });
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.config).not.toBe(config);
    // The Messages turn runs the automatic preflight pass, not only the tool declaration.
    expect(preflights).toHaveLength(1);
    expect(JSON.stringify(preflights[0]!.context.messages)).toContain("fixture");
    expect(workerBodies).toHaveLength(1);
    const tools = (workerBodies[0]!.tools ?? []) as { function?: { name?: string } }[];
    expect(tools.map(tool => tool.function?.name)).toContain("advisor");
    // The advice the preflight pass injected reached the dispatch, not just the tool declaration.
    expect(JSON.stringify(workerBodies[0])).toContain("stub-advice-marker");
  } finally { setAdvisorPlanFactory(config, null); release(); }
});

test("consent revoked on the live config after the view was copied blocks the consultation", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisor-messages-consent-")); roots.push(root);
  const calls: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.body);
    return Response.json({ choices: [{ message: { content: "advice" } }] });
  }) as typeof fetch;
  const live = { port: 10100, providers: {}, advisor: {
    enabled: true, model: "expert", policy: "manual", effort: "high", contextSharingConsent: "v1",
  } } as OcxConfig;
  const view = linkAdvisorPlanConfig(live, { ...live, cacheRetention: "short" as const });
  setAdvisorPlanFactory(live, async input => createAdvisorRuntimePlan({
    ...input, baseUrlOverride: "http://expert.test", ledger: createAdvisorPreflightLedger(),
    budget: createAdvisorTaskBudget(join(root, "budget.sqlite")), activities: createAdvisorActivityStore(),
  }));
  try {
    const registered = await createRegisteredAdvisorPlan({ config: view, workerIdentity: "w", workerModelId: "w" });
    expect(registered?.consult).toBeDefined();
    // Management writes replace the live object (`config.advisor = ...`) rather than mutating it.
    const { contextSharingConsent: _revoked, ...rest } = live.advisor!;
    live.advisor = rest;
    const parsed = parseRequest({ model: "w", stream: false, input: [{ role: "user", content: "private-task-text" }] });
    const result = await registered!.consult!(parsed, "manual", "question");
    expect(result.blocked).toBe("consent");
    expect(calls).toHaveLength(0);
    // Request-scoped overrides on the view are untouched.
    expect(view.cacheRetention).toBe("short");
  } finally { setAdvisorPlanFactory(live, null); }
});

/** The management activity route as the dashboard and CLI reach it: it reads its own config object. */
async function managementActivity(config: OcxConfig) {
  const ctx: ManagementContext = {
    req: new Request("http://localhost/api/advisor/activity"),
    url: new URL("http://localhost/api/advisor/activity"),
    config,
    deps: {},
    version: "test",
    trustedLoopbackIngress: false,
    guiSessionIssuance: null,
    convergeCodexCatalog: async () => ({ status: "skipped", reason: "not-requested", retryable: false }),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
  const response = await handleAdvisorRoutes(ctx);
  return (await response!.json()) as { entries: { trigger: string; status: string; advisorModel: string; requestedEffort: string }[] };
}

/** A real translated /v1/messages turn: worker provider "worker", Advisor routed to "expert". */
function translatedAdvisorFixture(options: { revokeOnDispatch?: boolean; failExpert?: boolean; throwTransport?: boolean; advice?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "advisor-messages-fixture-")); roots.push(root);
  const workerBodies: Record<string, unknown>[] = [];
  const expertBodies: { url: string; body: Record<string, unknown> }[] = [];
  let revoked = false;
  const config: OcxConfig = {
    defaultProvider: "worker",
    advisor: { enabled: true, model: "expert/worker", policy: "preflight", effort: "high", contextSharingConsent: "v1" },
    providers: {
      worker: { adapter: "openai-chat", apiKey: "fixture", models: ["m"], liveModels: false,
        baseUrl: "https://worker.test/v1",
        fetch: (async (_url, init) => {
          workerBodies.push(JSON.parse(String(init?.body)));
          return new Response(workerStream, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch },
      expert: { adapter: "openai-chat", apiKey: CREDENTIAL, models: ["worker"], liveModels: false,
        baseUrl: "https://expert.test/v1",
        fetch: (async (url, init) => {
          // Provider-facing model id is the target model ("worker"); the destination proves the route.
          expertBodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
          // A revocation that lands only after the outbound hop has begun.
          if (options.revokeOnDispatch) revoke();
          if (options.failExpert) return new Response(ERROR_BODY, { status: 400 });
          return Response.json({ choices: [{ message: { content: options.advice ?? ADVICE } }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
        }) as typeof fetch },
    },
  } as OcxConfig;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    // Management writes replace the object; nothing mutates the copied reference in place.
    const { contextSharingConsent: _revokedConsent, ...rest } = config.advisor!;
    config.advisor = rest;
  };
  const register = (extra: Partial<AdvisorRuntimeDeps> = {}) => setAdvisorPlanFactory(config, async input => createAdvisorRuntimePlan({
    ...input,
    ledger: createAdvisorPreflightLedger(),
    budget: createAdvisorTaskBudget(join(root, "budget.sqlite")),
    ...extra,
  }));
  // The Advisor self-fetches over loopback; re-enter the real data plane so the expert provider runs.
  const activate = () => { globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/chat/completions")) {
      if (options.throwTransport) throw new Error("exception-task-marker exception-advice-marker exception-credential-marker");
      const response = await handleChatCompletions(new Request(url, init), config, { model: "", provider: "" });
      // Exercise a loopback error that echoes private content even if the provider adapter
      // itself sanitized its error. The actual expert dispatch still ran above.
      if (options.failExpert && !response.ok) return new Response(ERROR_BODY, { status: response.status });
      return response;
    }
    throw new Error("unexpected external fetch: " + url);
  }) as typeof fetch;
  };
  activate();
  return { config, workerBodies, expertBodies, revoke, register, activate, revoked: () => revoked };
}

/** The real Messages request, with orientation evidence after the latest user turn. */
function messagesRequest(task = TASK): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "worker/m", max_tokens: 100, stream: false, messages: [
      { role: "user", content: [{ type: "text", text: `repair the token store ${task}` },
        { type: "tool_result", tool_use_id: "call_1", content: "3 tests failed" }] },
    ] }),
    signal: AbortSignal.timeout(10_000),
  });
}

// Regression: the plan used to take its activity store from the replay view. Stores are keyed by
// config identity, and the management route reads the live config's store, so a consultation made
// through /v1/messages was invisible in the dashboard and the CLI activity feed.
test("/v1/messages records its consultation in the management-visible activity feed", async () => {
  const release = acquireOwnedSpendHome();
  const fixture = translatedAdvisorFixture();
  fixture.register();
  try {
    const response = await handleClaudeMessages(messagesRequest(),
      fixture.config, { model: "", provider: "" }, { requestId: "advisor-messages-activity", start: Date.now() });
    await response.text();
    expect(response.status).toBe(200);
    expect(fixture.expertBodies).toHaveLength(1);
    expect(fixture.expertBodies[0]!.url).toBe("https://expert.test/v1/chat/completions");

    const feed = await managementActivity(fixture.config);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]).toMatchObject({ trigger: "preflight", status: "ok", advisorModel: "expert/worker" });
    // The feed's record is the consultation whose advice reached the worker.
    expect(JSON.stringify(fixture.workerBodies[0])).toContain(ADVICE);
  } finally { setAdvisorPlanFactory(fixture.config, null); release(); }
});

test("translated consultations stay in their live config feed and omit private content from metadata and logs", async () => {
  const release = acquireOwnedSpendHome();
  // Construct B first: the loopback fetch installed by A then routes A's actual consultation.
  const b = translatedAdvisorFixture();
  const a = translatedAdvisorFixture();
  b.config.advisor = { ...b.config.advisor!, effort: "low" };
  b.register();
  a.register();
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const response = await handleClaudeMessages(messagesRequest(), a.config,
      { model: "", provider: "" }, { requestId: "advisor-isolation-success", start: Date.now() });
    await response.text();
    expect(response.status).toBe(200);
    expect(a.expertBodies).toHaveLength(1);
    expect(JSON.stringify(a.expertBodies[0]!.body)).toContain(TASK);
    expect(JSON.stringify(a.workerBodies[0])).toContain(ADVICE);
    const feedA = await managementActivity(a.config);
    const feedB = await managementActivity(b.config);
    expect(feedA.entries).toHaveLength(1);
    expect(feedA.entries[0]).toMatchObject({ trigger: "preflight", status: "ok" });
    expect(feedB.entries).toHaveLength(0);
    expect(b.expertBodies).toHaveLength(0);
    expect(logs.some(line => line.includes("[advisor]"))).toBe(true);
    for (const marker of [TASK, ADVICE, ERROR_BODY, CREDENTIAL]) {
      expect(JSON.stringify([feedA, feedB, logs.filter(line => line.includes("[advisor]"))])).not.toContain(marker);
    }
  } finally {
    console.warn = originalWarn;
    setAdvisorPlanFactory(a.config, null);
    setAdvisorPlanFactory(b.config, null);
    release();
  }
});

test("translated expert HTTP errors do not expose their body in activity or advisor logs", async () => {
  const release = acquireOwnedSpendHome();
  const fixture = translatedAdvisorFixture({ failExpert: true });
  fixture.register();
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const response = await handleClaudeMessages(messagesRequest(), fixture.config,
      { model: "", provider: "" }, { requestId: "advisor-isolation-error", start: Date.now() });
    await response.text();
    expect(response.status).toBe(200);
    expect(fixture.expertBodies).toHaveLength(1);
    const feed = await managementActivity(fixture.config);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.status).toBe("failed");
    expect(logs.some(line => line.includes("[advisor]"))).toBe(true);
    for (const marker of [TASK, ADVICE, ERROR_BODY, CREDENTIAL]) {
      expect(JSON.stringify([feed, logs.filter(line => line.includes("[advisor]"))])).not.toContain(marker);
    }
  } finally {
    console.warn = originalWarn;
    setAdvisorPlanFactory(fixture.config, null);
    release();
  }
});

// Consent is rechecked before the outbound hop. A revocation in the claim-to-dispatch window
// blocks the transfer; the worker still runs without advisory context.
test("revocation after the view was copied but before dispatch blocks the /v1/messages consultation", async () => {
  const release = acquireOwnedSpendHome();
  const fixture = translatedAdvisorFixture();
  fixture.register({ afterPreflightClaim: fixture.revoke });
  try {
    const response = await handleClaudeMessages(messagesRequest(),
      fixture.config, { model: "", provider: "" }, { requestId: "advisor-messages-revoke-before", start: Date.now() });
    await response.text();
    expect(fixture.revoked()).toBe(true);
    expect(response.status).toBe(200);
    expect(fixture.expertBodies).toHaveLength(0);
    expect(fixture.workerBodies).toHaveLength(1);
    expect(JSON.stringify(fixture.workerBodies[0])).not.toContain(ADVICE);
  } finally { setAdvisorPlanFactory(fixture.config, null); release(); }
});

// The documented boundary: once dispatched, a revocation neither cancels the consultation nor
// retracts context already sent. This is what the docs now say, instead of promising a retraction.
test("revocation after dispatch does not cancel the /v1/messages consultation", async () => {
  const release = acquireOwnedSpendHome();
  const fixture = translatedAdvisorFixture({ revokeOnDispatch: true });
  fixture.register();
  try {
    const response = await handleClaudeMessages(messagesRequest(),
      fixture.config, { model: "", provider: "" }, { requestId: "advisor-messages-revoke-after", start: Date.now() });
    await response.text();
    expect(fixture.revoked()).toBe(true);
    expect(response.status).toBe(200);
    // Dispatched: the context left the proxy, and the consultation completed.
    expect(fixture.expertBodies).toHaveLength(1);
    expect(JSON.stringify(fixture.expertBodies[0]!.body)).toContain(TASK);
    expect(JSON.stringify(fixture.workerBodies[0])).toContain(ADVICE);
  } finally { setAdvisorPlanFactory(fixture.config, null); release(); }
});


test("translated transport exceptions preserve safe failure without leaking exception contents", async () => {
  const release = acquireOwnedSpendHome();
  const fixture = translatedAdvisorFixture({ throwTransport: true });
  fixture.register();
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const response = await handleClaudeMessages(messagesRequest(), fixture.config,
      { model: "", provider: "" }, { requestId: "advisor-transport-error", start: Date.now() });
    const body = await response.text();
    expect(response.status).toBe(200);
    const feed = await managementActivity(fixture.config);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]!.status).toBe("failed");
    expect(logs.some(line => line.includes("advisor connect_error"))).toBe(true);
    expect(JSON.stringify(fixture.workerBodies)).toContain("advisor connect_error");
    for (const marker of ["exception-task-marker", "exception-advice-marker", "exception-credential-marker"]) {
      expect(JSON.stringify([feed, logs, fixture.workerBodies, body])).not.toContain(marker);
    }
  } finally {
    console.warn = originalWarn;
    setAdvisorPlanFactory(fixture.config, null);
    release();
  }
});

test("two live translated configurations isolate activity and consent", async () => {
  const release = acquireOwnedSpendHome();
  const a = translatedAdvisorFixture({ advice: "advice-for-config-a" });
  const b = translatedAdvisorFixture({ advice: "advice-for-config-b" });
  b.config.advisor = { ...b.config.advisor!, effort: "low" };
  a.register(); b.register();
  const run = async (fixture: typeof a, task: string) => {
    fixture.activate();
    const response = await handleClaudeMessages(messagesRequest(task), fixture.config,
      { model: "", provider: "" }, { requestId: task, start: Date.now() });
    await response.text();
    expect(response.status).toBe(200);
  };
  try {
    await run(a, "task-for-config-a");
    await run(b, "task-for-config-b");
    expect(a.expertBodies).toHaveLength(1);
    expect(b.expertBodies).toHaveLength(1);
    expect(JSON.stringify(a.expertBodies)).toContain("task-for-config-a");
    expect(JSON.stringify(b.expertBodies)).toContain("task-for-config-b");
    expect(JSON.stringify(a.workerBodies)).toContain("advice-for-config-a");
    expect(JSON.stringify(b.workerBodies)).toContain("advice-for-config-b");
    expect(JSON.stringify([a.expertBodies, a.workerBodies])).not.toContain("config-b");
    expect(JSON.stringify([b.expertBodies, b.workerBodies])).not.toContain("config-a");
    const feedA = await managementActivity(a.config);
    const feedB = await managementActivity(b.config);
    expect(feedA.entries).toHaveLength(1);
    expect(feedB.entries).toHaveLength(1);
    expect(feedA.entries[0]!.requestedEffort).toBe("high");
    expect(feedB.entries[0]!.requestedEffort).toBe("low");
    for (const marker of ["task-for-config-a", "task-for-config-b", "advice-for-config-a", "advice-for-config-b", CREDENTIAL]) {
      expect(JSON.stringify([feedA, feedB])).not.toContain(marker);
    }
    a.revoke();
    await run(a, "after-revoke-a");
    await run(b, "after-revoke-b");
    expect(a.expertBodies).toHaveLength(1);
    expect(b.expertBodies).toHaveLength(2);
    expect((await managementActivity(a.config)).entries).toHaveLength(1);
    expect((await managementActivity(b.config)).entries).toHaveLength(2);
    b.revoke();
    await run(b, "after-revoke-b-again");
    expect(b.expertBodies).toHaveLength(2);
  } finally {
    setAdvisorPlanFactory(a.config, null); setAdvisorPlanFactory(b.config, null); release();
  }
});
