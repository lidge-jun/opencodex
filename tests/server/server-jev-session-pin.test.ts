/**
 * #7525: an opt-in JEV session pin keeps one client session on the target JEV chose for it, so the
 * provider prompt cache stays warm, while default-off Combos keep deciding on every request.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns, coolComboTarget } from "../../src/combos";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { resolveProviderApiKey } from "../../src/providers/api-key-resolve";
import { publishDecisionKeyQuota } from "../../src/providers/quota-decision-snapshot";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { RequestLogContext } from "../../src/server/request-log";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import type { ResponsesDispatchers } from "../../src/server/responses/core-options";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearJevSessionPinsForTests, JEV_SESSION_PIN_ROUTE_REASON } from "../../src/server/responses/jev-session-pin";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { activateJevQuotaEvidence, deactivateJevQuotaEvidence } from "../helpers/jev-quota-activation";
import { createTempHome } from "../helpers/temp-home";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const SOL = { provider: "sol", model: "gpt-5.6-sol" } as const;
const LUNA = { provider: "luna", model: "gpt-5.6-luna" } as const;

function resetState(): void {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearComboRecallForTests();
  clearJevSessionPinsForTests();
}
beforeEach(resetState);
afterEach(resetState);

function modelProvider(model: string): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: `https://${model}.example.test/v1`,
    authMode: "key",
    apiKey: `key-${model}`,
    liveModels: false,
    models: [model],
    modelReasoningEfforts: { [model]: ["low", "medium", "high"] },
  };
}

/** A JEV Combo whose decision service records every call and always answers `choice`. */
function makeConfig(choice: string, decisions: string[], sessionPin: boolean): OcxConfig {
  const jevFetch = (async () => {
    decisions.push(choice);
    return Response.json({ answers: { route: { choice, confidence: 0.8 } } });
  }) as typeof fetch;
  return {
    port: 0,
    defaultProvider: "sol",
    providers: {
      jev: { adapter: "jev-decision", baseUrl: JEV_URL, authMode: "key", liveModels: false, apiKey: "typesafe-test-key", fetch: jevFetch },
      sol: modelProvider(SOL.model),
      luna: modelProvider(LUNA.model),
    },
    combos: {
      auto: {
        alias: "jev-auto",
        strategy: "jev",
        targets: [{ ...LUNA }, { ...SOL }],
        ...(sessionPin ? { sessionPin: { ttlMs: 20 * 60_000 } } : {}),
      },
    },
  };
}

type ChildOptions = Parameters<ResponsesDispatchers["handleResponses"]>[3];
type Child = (body: Record<string, unknown>, complete: () => void, options: ChildOptions) => Response | Promise<Response>;

/** Children complete like a real stream: the completion callback runs before the response returns. */
function dispatchers(child: Child): ResponsesDispatchers {
  return {
    async handleResponses(request, _config, _logCtx, options) {
      const body = await request.json() as Record<string, unknown>;
      return child(body, () => options?.onResponseComplete?.(String(body.model)), options);
    },
    async handleComboResponses() {
      throw new Error("nested combo dispatch is not expected");
    },
  };
}

const served: Child = (body, complete) => {
  complete();
  return Response.json({ id: `resp-${String(body.model)}`, object: "response", status: "completed", model: body.model, output: [] });
};

async function turn(config: OcxConfig, options: {
  session?: string | null;
  admission?: DataPlaneAdmission;
  child?: Child;
  signal?: AbortSignal;
  log?: RequestLogContext;
  models?: string[];
} = {}): Promise<Response> {
  const body = { model: "jev-auto", input: "Implement the next step.", stream: false };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.session !== null) headers.session_id = options.session ?? "session-a";
  const request = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers, body: JSON.stringify(body) });
  const budget = createTranslatorBudget();
  const child = options.child ?? served;
  try {
    return await executeComboResponses(request, body, "auto", config, options.log ?? { model: "", provider: "" }, {
      translatorBudget: budget,
      ...(options.admission ? { admission: options.admission } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    }, dispatchers((childBody, complete, childOptions) => {
      options.models?.push(String(childBody.model));
      return child(childBody, complete, childOptions);
    }));
  } finally {
    budget.dispose();
  }
}

describe("JEV session pin (#7525)", () => {
  test("default off: every turn of one session asks JEV again and records no pin", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, false);
    const log: RequestLogContext = { model: "", provider: "" };
    expect((await turn(config)).status).toBe(200);
    expect((await turn(config, { log })).status).toBe(200);
    expect(decisions).toHaveLength(2);
    expect(log.jevDecision).not.toHaveProperty("pinned");
    expect(log.jevDecision).not.toHaveProperty("pinReason");
  });

  test("a pinned session reuses JEV's target and effort without another decision call", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    const bodies: Record<string, unknown>[] = [];
    const child: Child = (body, complete) => { bodies.push(body); return served(body, complete); };
    expect((await turn(config, { child })).status).toBe(200);
    const log: RequestLogContext = { model: "", provider: "" };
    expect((await turn(config, { child, log })).status).toBe(200);
    expect(decisions).toHaveLength(1);
    expect(bodies.map(body => [body.model, (body.reasoning as { effort?: string } | undefined)?.effort]))
      .toEqual([["sol/gpt-5.6-sol", "high"], ["sol/gpt-5.6-sol", "high"]]);
    expect(log.jevDecision).toEqual({
      version: 1,
      comboId: "auto",
      backend: "typesafe",
      selected: { provider: "sol", model: SOL.model, effort: "high" },
      gate: "apply",
      latencyMs: 0,
      pinned: true,
      pinReason: "session",
    });
    expect(log.routeDecision?.selected.reason).toBe(JEV_SESSION_PIN_ROUTE_REASON);
  });

  test("requests without an explicit session, other sessions and other callers are decided afresh", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    const alice: DataPlaneAdmission = { kind: "configured", keyId: "alice", source: "bearer", contextPrincipalId: "p-alice" };
    const bob: DataPlaneAdmission = { kind: "configured", keyId: "bob", source: "bearer", contextPrincipalId: "p-bob" };
    await turn(config, { session: null });
    await turn(config, { session: null });
    expect(decisions).toHaveLength(2);
    await turn(config, { admission: alice });
    await turn(config, { admission: bob });
    await turn(config, { admission: alice, session: "session-b" });
    expect(decisions).toHaveLength(5);
    await turn(config, { admission: alice });
    expect(decisions).toHaveLength(5);
  });

  test("a failed pinned send hops over and the next turn is decided afresh", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    await turn(config);
    const models: string[] = [];
    const failing: Child = (body, complete) => body.model === "sol/gpt-5.6-sol"
      ? Response.json({ error: { type: "server_error", message: "busy" } }, { status: 500 })
      : served(body, complete);
    expect((await turn(config, { child: failing, models })).status).toBe(200);
    expect(models).toEqual(["sol/gpt-5.6-sol", "luna/gpt-5.6-luna"]);
    expect(decisions).toHaveLength(1);
    const log: RequestLogContext = { model: "", provider: "" };
    await turn(config, { log });
    expect(decisions).toHaveLength(2);
    expect(log.jevDecision).not.toHaveProperty("pinned");
  });

  test("a pinned stream that ends failed, or a dispatch that throws, also ends the pin", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    await turn(config);
    const failedStream: Child = (body, _complete, options) => {
      options?.onNativePassthroughTerminal?.("failed");
      return Response.json({ id: "resp-failed", object: "response", status: "completed", model: body.model, output: [] });
    };
    await turn(config, { child: failedStream });
    expect(decisions).toHaveLength(1);
    await turn(config);
    expect(decisions).toHaveLength(2);
    const thrown: Child = () => { throw new Error("transport exploded"); };
    await expect(turn(config, { child: thrown })).rejects.toThrow("transport exploded");
    expect(decisions).toHaveLength(2);
    await turn(config);
    expect(decisions).toHaveLength(3);
  });

  test("a stream that reports failed after the Combo committed it ends the pin", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    await turn(config);
    let committedOptions: ChildOptions;
    const lateFailure: Child = (body, _complete, options) => {
      committedOptions = options;
      return Response.json({ id: "resp-late", object: "response", status: "completed", model: body.model, output: [] });
    };
    expect((await turn(config, { child: lateFailure })).status).toBe(200);
    expect(decisions).toHaveLength(1);
    // The callback gate is committed once the Combo returned the response; the stream fails later.
    committedOptions?.onNativePassthroughTerminal?.("failed");
    await turn(config);
    expect(decisions).toHaveLength(2);
  });

  test("a cancelled send neither writes nor drops the pin", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    const cancelled = () => {
      const controller = new AbortController();
      const child: Child = () => {
        controller.abort(new Error("client went away"));
        return Response.json({ error: { message: "aborted" } }, { status: 499 });
      };
      return { child, signal: controller.signal };
    };
    expect((await turn(config, cancelled())).status).toBe(499);
    await turn(config);
    expect(decisions).toHaveLength(2);
    expect((await turn(config, cancelled())).status).toBe(499);
    const log: RequestLogContext = { model: "", provider: "" };
    await turn(config, { log });
    expect(decisions).toHaveLength(2);
    expect(log.jevDecision).toMatchObject({ pinned: true });
  });

  test("a fail-open decision never pins the session", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    config.providers.jev!.fetch = (async () => {
      decisions.push("http");
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    await turn(config);
    await turn(config);
    expect(decisions).toEqual(["http", "http"]);
  });

  test("a cooling pinned target releases the pin and records why", async () => {
    const decisions: string[] = [];
    const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
    await turn(config);
    coolComboTarget("auto", SOL, { cooldownMs: 60_000 });
    const log: RequestLogContext = { model: "", provider: "" };
    await turn(config, { log });
    expect(decisions).toHaveLength(2);
    expect(log.jevDecision).toMatchObject({ pinReason: "target_unavailable" });
    expect(log.jevDecision).not.toHaveProperty("pinned");
  });

  test("opted-in quota evidence reading nearly exhausted releases the pin", async () => {
    const home = createTempHome("ocx-jev-session-pin-quota-");
    try {
      activateJevQuotaEvidence();
      const decisions: string[] = [];
      const config = makeConfig("sol/gpt-5.6-sol:high", decisions, true);
      config.combos!.auto!.decisionQuotaSignals = true;
      await turn(config);
      const provider = config.providers.sol!;
      resolveProviderApiKey(provider.apiKey);
      publishDecisionKeyQuota("sol", provider, [{ window: "weekly", percent: 95, observedAt: Date.now() }]);
      const log: RequestLogContext = { model: "", provider: "" };
      await turn(config, { log });
      expect(decisions).toHaveLength(2);
      expect(log.jevDecision).toMatchObject({ pinReason: "quota_nearly_exhausted" });
    } finally {
      deactivateJevQuotaEvidence();
      home.remove();
    }
  });
});
