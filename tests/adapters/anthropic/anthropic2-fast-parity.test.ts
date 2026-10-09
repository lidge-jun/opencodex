/** Anthropic fast opt-in and downgrade use the same bridge for both OAuth instances. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, instanceFixtureUuid, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";
import type { AnthropicInstanceId } from "../../../src/providers/anthropic-instance-id";
import type { RequestLogContext } from "../../../src/server/request-log";

let f: AnthropicInstanceFixture;
let releaseSpend: (() => void) | undefined;
let handleResponses: typeof import("../../../src/server/responses").handleResponses;
let bodies: Record<string, unknown>[];
let headers: Headers[];
let declineFirst: boolean;
beforeEach(async () => {
  f = await createAnthropicInstanceFixture({ anthropic: { enabled: false }, anthropic2: { enabled: false } });
  await f.seed();
  ({ handleResponses } = await import("../../../src/server/responses"));
  const { acquireOwnedSpendHome } = await import("../../helpers/owned-spend-home");
  releaseSpend = acquireOwnedSpendHome();
  bodies = []; headers = []; declineFirst = false;
  f.config.fastMode = true;
  for (const instance of ["anthropic", "anthropic2"] as const) {
    Object.assign(f.config.providers[instance]!, { baseUrl: "https://fast-bridge.example.test", models: ["claude-opus-5-5", "claude-sonnet-5"],
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const sentHeaders = new Headers(init?.headers);
        const token = sentHeaders.get("authorization")!.replace(/^Bearer /, "");
        const row = f.store.getAccountSet(instance)!.accounts.find(account => account.credential.access === token)!;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // This checks stored identity, not wire UUID ownership: translated sends carry only the bearer.
        expect(row.credential.anthropicIdentity?.accountUuid).toBe(instanceFixtureUuid(instance, f.ids.indexOf(row.id as typeof f.ids[number]) + 1));
        f.ledger.record({ instance, accountId: row.id, token, model: String(body.model) });
        bodies.push(body); headers.push(sentHeaders);
        if (declineFirst && bodies.length === 1) return Response.json({ type: "error", error: {
          type: "rate_limit_error", message: "Usage credits are required for fast mode.",
        } }, { status: 429 });
        return Response.json({ id: "msg_fast", type: "message", role: "assistant", model: body.model,
          content: [{ type: "text", text: "The answer is complete." }], stop_reason: "end_turn", usage: { input_tokens: 4, output_tokens: 5 } });
      }) as typeof fetch,
    });
  }
  f.publishConfig();
});
afterEach(async () => {
  try {
    f.ledger.assertNoCrossSend(); releaseSpend?.(); releaseSpend = undefined;
    (await import("../../../src/responses/state")).clearResponseStateForTests();
  } finally { f.dispose(); }
});
function post(instance: AnthropicInstanceId, model: string, log: RequestLogContext = { model: "", provider: "" }) {
  return handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "session-id": f.sessionKey },
    body: JSON.stringify({ model: `${instance}/${model}`, stream: false, input: "Answer briefly", service_tier: "priority" }),
  }), f.config, log);
}
for (const instance of ["anthropic", "anthropic2"] as const) {
  for (const scenario of ["off", "on", "unsupported"] as const) {
    test(`${instance}: fast ${scenario} retains the instance and canonical wire`, async () => {
      if (scenario !== "off") f.config.providers[instance]!.fastEnabled = true;
      f.publishConfig();
      const model = scenario === "unsupported" ? "claude-sonnet-5" : "claude-opus-5-5";
      const response = await post(instance, model); await response.text();
      expect(response.status).toBe(200); expect(bodies).toHaveLength(1);
      expect(bodies[0]!.model).toBe(model);
      expect(bodies[0]!.speed).toBe(scenario === "on" ? "fast" : undefined);
      expect(headers[0]!.get("anthropic-beta")?.includes("fast-mode-2026-02-01") ?? false).toBe(scenario === "on");
      expect(f.ledger.sends[0]!.instance).toBe(instance);
    });
  }
  test(`${instance}: one fast-credit downgrade uses the same credential and leaves sibling health intact`, async () => {
    f.config.providers[instance]!.fastEnabled = true; f.publishConfig(); declineFirst = true;
    const log: RequestLogContext = { model: "", provider: "" };
    const response = await post(instance, "claude-opus-5-5", log); await response.text();
    expect(response.status).toBe(200); expect(bodies.map(body => body.speed)).toEqual(["fast", undefined]);
    expect(f.ledger.sends.map(send => send.instance)).toEqual([instance, instance]);
    expect(f.ledger.sends[0]!.token).toBe(f.ledger.sends[1]!.token);
    expect(log.activeAttempt?.recoveryKinds).toEqual(["anthropic-fast-downgrade"]);
    for (const sibling of ["anthropic", "anthropic2"] as const) {
      expect(f.routing.anthropicRoutingFor(sibling).getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
    }
  });
}
