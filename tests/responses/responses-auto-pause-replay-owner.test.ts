import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { credentialGeneration, getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { handleResponses } from "../../src/server/responses/core";
import * as transport from "../../src/server/responses/request-transport";
import { createResponsesEffects } from "../../src/server/responses/response-effects";
import { commitReasoningReplayServingIdentity, reasoningReplayKeyCredentialIdentity, reasoningReplayOAuthCredentialIdentity } from "../../src/responses/reasoning-replay-cache";
import { flushResponseState, clearResponseStateForTests } from "../../src/responses/state";
import type { OcxParsedRequest, OcxProviderContinuationOwner } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let releaseSpend: () => void;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-auto-pause-replay-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  clearGenericFailoverHealth();
});
afterEach(async () => {
  await flushResponseState(); clearResponseStateForTests();
  releaseSpend(); clearGenericFailoverHealth();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

for (const oauth of [false, true]) for (const native of [false, true]) {
  test(`${oauth ? "OAuth" : "key"} auto-pause rebinds ${native ? "native Responses" : "translated Chat"} retry and persistence owners`, async () => {
    const name = oauth ? "command-code" : "fixture";
    if (oauth) {
      for (const id of ["A", "B"]) await saveCredential(name, {
        access: `synthetic-${id}`, refresh: `synthetic-refresh-${id}`,
        expires: Date.now() + 3_600_000, accountId: `synthetic-${id}`, source: "oauth",
      });
      await setActiveAccount(name, getAccountSet(name)!.accounts[0]!.id);
    }
    const config = getDefaultConfig();
    config.defaultProvider = name; config.defaultModel = "fixture";
    config.providers = { [name]: {
      baseUrl: "https://example.test/v1", adapter: native ? "openai-responses" : "openai-chat",
      authMode: oauth ? "oauth" : "key", models: ["fixture"],
      accountAutoPause: { enabled: true, consecutiveFailures: 1 },
      ...(!oauth ? { apiKey: "synthetic-A", apiKeyPool: [{ id: "A", key: "synthetic-A" }, { id: "B", key: "synthetic-B" }] } : {}),
    } };
    saveConfig(config);
    // Derive the opaque expected digest from fixture B, independently of recovery's selection.
    const secondAccount = oauth ? getAccountSet(name)!.accounts[1]! : undefined;
    const expectedCredentialIdentity = secondAccount
      ? reasoningReplayOAuthCredentialIdentity({ accountId: secondAccount.id, generation: credentialGeneration(secondAccount.credential) })
      : reasoningReplayKeyCredentialIdentity({ apiKey: "synthetic-B" });
    expect(expectedCredentialIdentity).toBeDefined();
    const sends: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const auth = new Headers(init?.headers).get("authorization")!;
      sends.push(auth);
      if (auth === "Bearer synthetic-A") return Response.json({ error: {
        type: "permission_error", message: "OAuth authentication is currently not allowed for this organization",
      } }, { status: 403 });
      return native
        ? Response.json({ id: "synthetic-response", object: "response", model: "fixture", status: "completed", output: [{ id: "synthetic-message", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } })
        : Response.json({ id: "synthetic-completion", object: "chat.completion", model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }) as typeof fetch;
    let outer: OcxParsedRequest | undefined;
    let retry: OcxParsedRequest | undefined;
    let oldOwner: OcxProviderContinuationOwner | undefined;
    let oldReplayCredential: string | undefined;
    let persisted: ReturnType<Exclude<ReturnType<typeof createResponsesEffects>, Response>["continuationStateForResponse"]>;
    const prepare = transport.prepareResponsesTransport;
    const prepared = spyOn(transport, "prepareResponsesTransport").mockImplementation(async (...args) => {
      const state = await prepare(...args);
      if (state instanceof Response) return state;
      outer = args[2].parsed;
      oldOwner = outer._providerContinuationOwner;
      oldReplayCredential = outer._reasoningReplayScope?.current?.credentialIdentity;
      // Seed previously accepted A state; transport and account selection remain real.
      commitReasoningReplayServingIdentity(outer._reasoningReplayScope);
      outer._providerContinuationCandidate = { __ocxOwner: oldOwner!, cursor: { conversationId: "synthetic-A-conversation" } };
      outer._providerContinuation = { cursor: { conversationId: "synthetic-A-conversation" } };
      outer._cursorConversationId = "synthetic-A-conversation";
      const recover = state.recoverAutoPausedSelection;
      state.recoverAutoPausedSelection = async requestParsed => {
        // Terminal recovery may pass a shallow clone; its owner fields are independent
        // even though the replay scope holder is shared with the persistence request.
        retry = { ...requestParsed };
        const recovered = await recover(retry);
        const effects = createResponsesEffects(args[0], args[1], {
          parsed: outer!, route: args[2].route, poolAffinityKey: null, substituteMainCredential: false,
        }, { routedCompaction: false });
        if (!(effects instanceof Response)) persisted = effects.continuationStateForResponse({ cursor: { conversationId: "synthetic-B-conversation" } });
        return recovered;
      };
      return state;
    });
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", "thread-id": `synthetic-${oauth}-${native}` },
        body: JSON.stringify({ model: `${name}/fixture`, input: "synthetic", stream: false, store: false }),
      }), config, { model: "fixture", provider: name });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(sends).toEqual(["Bearer synthetic-A", "Bearer synthetic-B"]);
      expect(oldOwner).toBeDefined();
      expect(oldReplayCredential).toBeDefined();
      expect(oldOwner!.credentialIdentity).not.toBe(expectedCredentialIdentity);
      expect(oldReplayCredential).not.toBe(expectedCredentialIdentity);
      expect(retry).toBeDefined();
      for (const parsed of [outer!, retry!]) {
        expect(parsed._providerContinuationOwner?.credentialIdentity).toBe(expectedCredentialIdentity);
        expect(parsed._reasoningReplayScope?.current?.credentialIdentity).toBe(expectedCredentialIdentity);
        expect(parsed._providerContinuation).toBeUndefined();
        expect(parsed._cursorConversationId).toBeUndefined();
        expect(parsed._stripReasoningEncryptedContent).toBe(true);
        expect(parsed._dropForeignReasoningItemIds).toBe(true);
      }
      expect(retry!._providerContinuationOwner).toEqual(outer!._providerContinuationOwner);
      expect(persisted?.__ocxOwner).toEqual(retry!._providerContinuationOwner);
      expect(persisted?.__ocxOwner?.credentialIdentity).toBe(expectedCredentialIdentity);
      expect(persisted?.cursor?.conversationId).toBe("synthetic-B-conversation");
    } finally { prepared.mockRestore(); }
  });
}
