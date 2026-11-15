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
      defaultProvider: "primary", multiAgentMode: "v2-plaintext",
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

// The merge of dev's Remote Link observation with this PR's replay owner key left one ordering
// guarantee unproven: a continuation refused for ownership must never reach the link observer, so a
// foreign caller cannot even leave a capture for the returned turn. Both halves are asserted, so the
// refusal test cannot pass by observing nothing at all.
test("a refused replay owner never reaches the link observer, while the owner does", async () => {
  const config: OcxConfig = {
    defaultProvider: "primary", multiAgentMode: "v2-plaintext",
    providers: { primary: { adapter: "openai-chat", authMode: "key", apiKey: "synthetic-provider",
      baseUrl: "https://fixture.invalid/v1", models: ["model"] } },
    apiKeys: [{ id: "a", key: "synthetic-a" }, { id: "b", key: "synthetic-b" }],
    combos: { fan: { strategy: "failover", targets: [{ provider: "primary", model: "model" }] } },
  };
  rememberResponseState({ input: "stored-input" }, { id: "resp_owned", output: [], status: "completed" },
    undefined, { clientThreadId: "own-b", replayOwnerKey: responseReplayOwnerKey(
      contextPrincipalIdOf(resolveDataPlaneAdmissionSecret("synthetic-b", config)!), "own-b") });
  const run = async (apiKey: string, thread: string) => {
    const observed: unknown[] = [];
    let failed = 0;
    const body = { model: "combo/fan", input: "continue", stream: false, previous_response_id: "resp_owned" };
    const req = new Request("http://localhost/v1/responses", { method: "POST", headers: {
      "content-type": "application/json", "thread-id": thread, "x-opencodex-api-key": apiKey,
    }, body: JSON.stringify(body) });
    const translatorBudget = createTranslatorBudget();
    try {
      const response = await executeComboResponses(req, body, "fan", config, { model: "", provider: "" },
        { admission: resolveDataPlaneAdmissionSecret(apiKey, config)!, translatorBudget, linkTurn: {
          expanded() { observed.push("expanded"); },
          expansionFailed() { failed += 1; },
          terminal() {},
          logFields() { return { transport: "link", first: false } as never; },
        } }, {
          async handleResponses() { return Response.json({ id: "resp-next", object: "response", status: "completed", output: [] }); },
          async handleComboResponses() { throw new Error("Unexpected nested combo"); },
        });
      return { status: response.status, observed, failed };
    } finally {
      translatorBudget.dispose();
    }
  };
  // A different caller on the same thread is refused before any observation or upstream dispatch.
  const foreign = await run("synthetic-a", "own-b");
  expect(foreign.status).toBe(400);
  expect(foreign.observed).toEqual([]);
  expect(foreign.failed).toBe(1);
  // The owner advances, so the assertions above describe a real refusal rather than a dead fixture.
  const owner = await run("synthetic-b", "own-b");
  expect(owner.status).toBe(200);
  expect(owner.observed).toEqual(["expanded"]);
  expect(owner.failed).toBe(0);
});
