import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { clearResponseStateForTests, rememberResponseState } from "../../src/responses/state";
import { responseReplayOwnerKey } from "../../src/responses/state/replay-owner";
import { contextPrincipalIdOf, resolveDataPlaneAdmissionSecret } from "../../src/server/auth-cors";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import { bindProviderContinuationForRoute } from "../../src/server/responses/core-replay";
import type { OcxConfig, OcxParsedRequest, OcxProviderContinuationOwner } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
let home: string;
let previousHome: string | undefined;
let release: () => void;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-combo-replay-id-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearResponseStateForTests();
  globalThis.fetch = (async () => { throw new Error("The replay fixture must not use the network"); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearResponseStateForTests();
  release();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

for (const padded of [true, false]) {
  test(`combo retains the authorized ${padded ? "padded" : "un-padded"} response ID for provider state`, async () => {
    const config: OcxConfig = {
      defaultProvider: "primary",
      providers: { primary: { adapter: "openai-chat", authMode: "key", apiKey: "synthetic-provider",
        baseUrl: "https://fixture.invalid/v1", models: ["model"] } },
      apiKeys: [{ id: "a", key: "synthetic-a" }, { id: "b", key: "synthetic-b" }],
      combos: { fan: { strategy: "failover", targets: [{ provider: "primary", model: "model" }] } },
    };
    const foreignId = padded ? "resp-exact" : " resp-exact ";
    const ownedId = padded ? " resp-exact " : "resp-exact";
    // Both callers use the same provider account: the route fence cannot replace caller ownership.
    const providerOwner: OcxProviderContinuationOwner = { version: 1, providerName: "primary",
      providerDestinationIdentity: `destination:${"a".repeat(64)}`, adapterName: "openai-chat",
      modelId: "model", credentialIdentity: `key:${"b".repeat(64)}` };
    for (const [id, key, thread, text] of [
      [foreignId, "synthetic-a", "own-a", "foreign-state"],
      [ownedId, "synthetic-b", "own-b", "owned-state"],
    ]) {
      const admission = resolveDataPlaneAdmissionSecret(key!, config)!;
      rememberResponseState({ input: `${text}-input` }, { id, output: [], status: "completed" },
        { __ocxOwner: providerOwner, kiro: { conversationId: `${text}-continuation` } },
        { clientThreadId: thread, replayOwnerKey: responseReplayOwnerKey(contextPrincipalIdOf(admission), thread) });
    }
    const body = { model: "combo/fan", input: "continue", stream: false, previous_response_id: ownedId };
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: {
      "content-type": "application/json", "thread-id": "own-b", "x-opencodex-api-key": "synthetic-b",
    }, body: JSON.stringify(body) });
    const translatorBudget = createTranslatorBudget();
    let childCalls = 0;
    try {
      const response = await executeComboResponses(req, body, "fan", config, { model: "", provider: "" },
        { admission: resolveDataPlaneAdmissionSecret("synthetic-b", config)!, translatorBudget }, {
          async handleResponses(_req, _config, _log, options) {
            childCalls++;
            const snapshot = options?.comboReplaySnapshot;
            expect(JSON.stringify(snapshot?.sourceBody)).toContain("owned-state-input");
            expect(JSON.stringify(snapshot?.sourceBody)).not.toContain("foreign-state-input");
            const parsed = { _providerContinuationCandidate: snapshot?.providerContinuation } as OcxParsedRequest;
            bindProviderContinuationForRoute(parsed, providerOwner);
            expect(parsed._providerContinuation?.kiro?.conversationId).toBe("owned-state-continuation");
            return Response.json({ id: "resp-next", object: "response", status: "completed", output: [] });
          },
          async handleComboResponses() { throw new Error("Unexpected nested combo"); },
        });
      expect(response.status).toBe(200);
      expect(childCalls).toBe(1);
    } finally {
      translatorBudget.dispose();
    }
  });
}
