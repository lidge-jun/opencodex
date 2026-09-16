import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import {
  RESPONSES_CORE_MODULES,
  readResponsesCoreModule,
} from "../helpers/responses-core-source";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { createAdapterContinuations } from "../../src/server/responses/adapter-continuation";
import type { AdapterFetchContext, AdapterRequest } from "../../src/adapters/base";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { TransientSendBudget } from "../../src/lib/upstream-retry";

// Existing, separately owned siblings at the extraction boundary. A new owner
// cannot silently disappear from source-oracle coverage by being absent from the inventory.
const EXISTING_BOUNDARIES = new Set([
  "account-change-state.ts", "agent-task-recovery.ts", "codex-auth-error.ts",
  "codex-ws-metadata.ts", "codex-ws-wire.ts", "collaboration.ts",
  "combo-session-recall.ts", "combo-stream-preflight.ts", "context-overflow.ts",
  "empty-completion-guard.ts", "encrypted-payload.ts", "fetch-helpers.ts",
  "input-admission.ts", "outbound-body-guard.ts", "passthrough-error.ts",
  "responses-field-backfill.ts", "terminal-guard.ts", "upstream-error.ts", "ws-upstream.ts",
]);

function siblingImports(source: string): string[] {
  return Array.from(source.matchAll(/\bfrom\s+["']\.\/([^"']+)["']/g), match =>
    match[1]!.endsWith(".ts") ? match[1]! : `${match[1]}.ts`);
}

function ownerGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = ["core.ts"];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (graph.has(name) || EXISTING_BOUNDARIES.has(name)) continue;
    const source = readFileSync(repoPath("src", "server", "responses", name), "utf8");
    const children = siblingImports(source).filter(child => !EXISTING_BOUNDARIES.has(child));
    graph.set(name, children);
    pending.push(...children);
  }
  return graph;
}

describe("Responses core module boundaries", () => {
  test("every extracted owner is covered and remains below 2000 physical lines", () => {
    const graph = ownerGraph();
    expect([...graph.keys()].sort()).toEqual([...RESPONSES_CORE_MODULES].sort());
    for (const name of RESPONSES_CORE_MODULES) {
      const text = readResponsesCoreModule(name);
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      expect({ name, belowLimit: lines < 2000 }).toEqual({ name, belowLimit: true });
    }
  });

  test("owner dependencies are acyclic, including type-only state contracts", () => {
    const graph = ownerGraph();
    const complete = new Set<string>();
    const active = new Set<string>();
    const visit = (name: string): void => {
      expect({ name, cycle: active.has(name) }).toEqual({ name, cycle: false });
      if (complete.has(name)) return;
      active.add(name);
      for (const child of graph.get(name) ?? []) visit(child);
      active.delete(name);
      complete.add(name);
    };
    visit("core.ts");
  });

  test("recursive combo dispatch enters the public ingress without a reverse core import", () => {
    const combo = readResponsesCoreModule("core-combo.ts");
    const prepare = readResponsesCoreModule("request-prepare.ts");
    expect(combo).toContain("requestDispatchers.handleResponses(");
    expect(prepare).toContain("requestDispatchers.handleComboResponses(");
    for (const name of RESPONSES_CORE_MODULES) {
      if (name !== "core.ts") expect(siblingImports(readResponsesCoreModule(name))).not.toContain("core.ts");
    }
    expect(readResponsesCoreModule("core.ts"))
      .toContain("const requestDispatchers: ResponsesDispatchers = { handleResponses, handleComboResponses };");
  });

  test("lease transfer retains both finally owners until response construction settles", () => {
    const ingress = readResponsesCoreModule("core.ts");
    const native = readResponsesCoreModule("passthrough-execution.ts");
    expect(ingress).toContain("return await executePassthroughResponse(");
    expect(native).toContain("return await deliverPassthroughResponse(");
    expect(native.indexOf("admissionState.pendingHostAdmissionLease = null;"))
      .toBeLessThan(native.indexOf("await preparePassthroughExchange("));
    expect(native).toMatch(/finally\s*\{\s*if \(nativeHostState\.lease\)\s*\{\s*releaseUpstreamHostAdmission\(nativeHostState\.lease\);\s*releaseCodexAuthContextProbeLease\(admissionState\.authCtx\);/);
    expect(ingress).toMatch(/finally\s*\{\s*if \(admissionState\.pendingHostAdmissionLease\)/);
  });

  test("local admission decisions cannot shadow the outer lease owner", () => {
    const prepare = readResponsesCoreModule("request-prepare.ts");
    expect(prepare).toContain("const admission = acquireUpstreamHostAdmission(");
    expect(prepare).toContain("admissionState.pendingHostAdmissionLease = admission.lease;");
    expect(prepare).not.toContain("admission.pendingHostAdmissionLease = admission.lease;");
  });

  test("live adapter, alias and continuation counters are not copied into snapshots", () => {
    const transport = readResponsesCoreModule("request-transport.ts");
    const effects = readResponsesCoreModule("response-effects.ts");
    const exchange = readResponsesCoreModule("adapter-dispatch.ts");
    const continuation = readResponsesCoreModule("adapter-continuation.ts");
    for (const name of ["activeAdapter", "runTurnAdapter", "sameTargetRequest", "transportToken", "genericFailovers"]) {
      expect(transport).toContain(`get ${name}()`);
      expect(transport).toContain(`set ${name}(value:`);
    }
    expect(effects).toContain("set responseCompletionCancelled(value:");
    expect(exchange).toContain("set rateLimitRetries(value:");
    expect(continuation).toContain("adapterExchange.rateLimitRetries");
    expect(continuation).toContain("transportState.activeAdapter");
  });
});

function budgetOwner(sendBudget: TransientSendBudget) {
  const translatorBudget = createTranslatorBudget();
  const result = createResponsesSendBudget({
    req: new Request("http://localhost/v1/responses"),
    logCtx: { model: "test", provider: "test" },
    options: { translatorBudget, sendBudget },
  }, { route: { providerName: "test", modelId: "test", provider: {
    adapter: "openai-chat", authMode: "key", baseUrl: "https://budget-fixture.invalid/v1",
  } } } as Parameters<typeof createResponsesSendBudget>[1]);
  if (result instanceof Response) {
    translatorBudget.dispose();
    throw new Error("Unexpected workflow refusal without a workflow root");
  }
  return { owner: result, dispose: () => translatorBudget.dispose() };
}

describe("Responses request-owned send budget after extraction", () => {
  test("a prepaid retry-helper continuation retains the remaining base retry after a reset", async () => {
    const holder = createRequestExecutionBudget();
    holder.used = 1;
    const { owner, dispose } = budgetOwner(holder);
    const hop = owner.reserveCredentialHop("auth-recovery", "fixture", true);
    expect(hop.allowed).toBe(true);
    owner.pendingHopPermit = hop.permit;
    const translatorBudget = createTranslatorBudget();
    const parsed = { modelId: "fixture", stream: false };
    let sends = 0;
    const adapter = {
      name: "openai-chat",
      async buildRequest() { return { url: "https://fixture.invalid/", method: "POST", headers: {}, body: "{}" }; },
      async parseResponse() { return []; },
    };
    type Args = Parameters<typeof createAdapterContinuations>;
    const continuation = createAdapterContinuations(
      { options: {}, config: {}, logCtx: { model: "fixture", provider: "fixture" } } as Args[0],
      { route: { providerName: "fixture", modelId: "fixture", provider: {
        adapter: "openai-chat", baseUrl: "https://fixture.invalid/",
      } }, parsed, translatorBudget } as Args[1],
      { activeAdapter: adapter, oauthDispatch: () => async () => {
        sends += 1;
        if (sends === 1) throw Object.assign(new Error("fixture ECONNRESET"), { code: "ECONNRESET" });
        return new Response("{}");
      } } as unknown as Args[2],
      { routedCompaction: false }, owner,
      { upstream: new AbortController(), connectMs: 100, rateLimitPolicy: null, rateLimitRetries: 0,
        stallTimeoutMs: 100, keyPool429RetryAllowed: () => false },
    );
    try {
      const events = [];
      for await (const event of continuation.fetchTerminalGuardContinuation(parsed as Args[1]["parsed"], "oauth-account-429")) events.push(event);
      expect(sends).toBe(2);
      expect(holder.used).toBe(3);
      expect(holder.reserveSpent).toBe(false);
      expect(owner.pendingHopPermit).toBeUndefined();
      expect(events).toEqual([]);
      hop.permit?.release();
      expect(holder.used).toBe(3);
    } finally { translatorBudget.dispose(); dispose(); }
  });

  for (const [adapterOwned, prepaid] of [[true, false], [true, true], [false, true]]) {
    test.each(["build", "pacing", "adapter", "sent"] as const)(`continuation refunds only unused permits (adapterOwned=${adapterOwned}, prepaid=${prepaid}, %s)`, async failure => {
      const holder = createRequestExecutionBudget();
      holder.used = 3;
      const { owner, dispose } = budgetOwner(holder);
      if (prepaid) {
        const hop = owner.reserveCredentialHop("auth-recovery", "fixture", adapterOwned);
        expect(hop.allowed).toBe(true);
        owner.pendingHopPermit = hop.permit;
      }
      const translatorBudget = createTranslatorBudget();
      const upstream = new AbortController();
      if (failure === "pacing") upstream.abort();
      let sends = 0;
      const parsed = { modelId: "fixture", stream: false };
      const adapter = {
        name: adapterOwned ? "kiro" : "google", fetchResponseUsesSendBudget: adapterOwned,
        async buildRequest() {
          if (failure === "build") throw new Error("fixture build failure");
          return { url: "https://fixture.invalid/", method: "POST", headers: {}, body: "{}" };
        },
        async fetchResponse(request: AdapterRequest, ctx: AdapterFetchContext) {
          if (failure === "adapter") throw new Error("fixture before physical send");
          if (adapterOwned) {
            const send = ctx.sendBudget!.reserveDispatch({ sendClass: "transient", targetKey: request.url });
            expect(send.allowed).toBe(true);
            if (!send.allowed) throw new Error("Expected funded physical send");
            expect(send.permit.use()).toBe(true);
          } else {
            await ctx.executor!(request.url, { method: request.method, body: request.body });
          }
          sends += 1;
          return new Response("{}");
        },
        async parseResponse() { return []; },
      };
      type Args = Parameters<typeof createAdapterContinuations>;
      const continuation = createAdapterContinuations(
        { options: {}, config: {}, logCtx: { model: "fixture", provider: "fixture" } } as Args[0],
        { route: { providerName: "fixture", modelId: "fixture", provider: {
          adapter: "kiro", baseUrl: "https://fixture.invalid/",
          requestPacing: { enabled: true, minIntervalMs: failure === "pacing" ? 1 : 0 },
        } }, parsed, translatorBudget } as Args[1],
        { activeAdapter: adapter, oauthDispatch: () => async () => new Response("{}") } as unknown as Args[2],
        { routedCompaction: false }, owner,
        { upstream, connectMs: 100, rateLimitPolicy: null, rateLimitRetries: 0, stallTimeoutMs: 100,
          keyPool429RetryAllowed: () => false },
      );
      try {
        const events = [];
        for await (const event of continuation.fetchTerminalGuardContinuation(parsed as Args[1]["parsed"], "empty-completion")) events.push(event);
        expect(sends).toBe(failure === "sent" ? 1 : 0);
        expect(holder.used).toBe(failure === "sent" ? 4 : 3);
        expect(holder.reserveSpent).toBe(failure === "sent");
        expect(owner.pendingHopPermit).toBeUndefined();
        expect(events.some(event => event.type === "error")).toBe(failure !== "sent");
      } finally { translatorBudget.dispose(); dispose(); }
    });
  }

  test("legacy holders retain identity and an exhausted remainder stays zero", () => {
    const holder = { used: 2 };
    const { owner, dispose } = budgetOwner(holder);
    try {
      expect(owner.remainingTransientSendBudget(3)).toBe(1);
      owner.noteTransientSends(1);
      expect(holder.used).toBe(3);
      expect(owner.remainingTransientSendBudget(3)).toBe(0);
      expect(owner.adapterSendBudget).toBeUndefined();
    } finally { dispose(); }
  });

  test("two call frames inheriting one holder consume the same allowance", () => {
    const holder = createRequestExecutionBudget();
    const a = budgetOwner(holder);
    const b = budgetOwner(holder);
    try {
      expect(a.owner.adapterSendBudget).toBe(holder);
      expect(b.owner.adapterSendBudget).toBe(holder);
      a.owner.noteTransientSends(1);
      b.owner.noteTransientSends(1);
      expect(holder.used).toBe(2);
      expect(a.owner.remainingTransientSendBudget(3)).toBe(1);
      expect(b.owner.remainingTransientSendBudget(3)).toBe(1);
    } finally { a.dispose(); b.dispose(); }
  });

  test("a transferred recovery permit is the exact closure-owned single-use permit", () => {
    const holder = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(holder);
    try {
      owner.noteTransientSends(3);
      const hop = owner.reserveCredentialHop("auth-recovery", "test|model", true);
      expect(hop.allowed).toBe(true);
      if (!hop.permit) throw new Error("Expected a recovery permit");
      owner.pendingHopPermit = hop.permit;
      const allowance = owner.recoverySendAllowance(3, "auth-recovery", "test|model");
      expect(allowance.attempts).toBe(1);
      expect(allowance.permit).toBe(hop.permit);
      expect(owner.pendingHopPermit).toBeUndefined();
      expect(hop.permit.use()).toBe(true);
      expect(hop.permit.use()).toBe(false);
      owner.noteTransientSends(1);
      expect(holder.used).toBe(4);
      expect(owner.remainingTransientSendBudget(3)).toBe(0);
    } finally { dispose(); }
  });
});
