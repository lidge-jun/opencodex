import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kiroAdapter from "../../src/adapters/kiro";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { oauthAccountLogLabel } from "../../src/codex/account-label";
import { getDefaultConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { credentialGeneration, getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import * as kiroCatalog from "../../src/providers/kiro-model-catalog";
import { clearAccountQuotaCache } from "../../src/providers/quota";
import { clearReasoningReplayCacheForTests, reasoningReplayOAuthCredentialIdentity } from "../../src/responses/reasoning-replay-cache";
import { clearResponseStateForTests, clearResponseStateMemoryForTests, flushResponseState, previousResponseProviderState } from "../../src/responses/state";
import { flushThoughtSignatureReplayForTests, resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;
let releaseSpend: (() => void) | undefined;
let restores: Array<() => void>;
let networkCalls: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-refusal-composition-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  restores = [];
  networkCalls = 0;
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  clearResponseStateForTests();
  kiroCatalog.clearKiroAccountModels();
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error("Refusal composition fixture must never use the network");
  }) as typeof fetch;
});

afterEach(async () => {
  // Settle writers while their home is still owned, then cancel the quota debounce.
  await flushResponseState();
  await flushThoughtSignatureReplayForTests();
  releaseSpend?.();
  releaseSpend = undefined;
  clearResponseStateForTests();
  clearAccountQuotaCache();
  clearGenericFailoverHealth();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  kiroCatalog.clearKiroAccountModels();
  for (const restore of restores.reverse()) restore();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
  expect(networkCalls).toBe(0);
});

function request(previousId?: string, stream = false): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", session_id: "kiro-refusal-composition" },
    body: JSON.stringify({
      model: "kiro/claude-sonnet-4.5", input: previousId ? "Continue the fixture." : "Seed the fixture.",
      stream, store: false, ...(previousId ? { previous_response_id: previousId } : {}),
    }),
  });
}

async function completedId(response: Response, stream: boolean): Promise<string> {
  expect(response.status).toBe(200);
  const text = await response.text();
  const completed = stream
    ? text.split(/\r?\n/).filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)))
      .find(event => event.type === "response.completed")?.response
    : JSON.parse(text);
  expect(completed?.status).toBe("completed");
  expect(typeof completed?.id).toBe("string");
  return completed.id;
}

type BuildObservation = Pick<OcxParsedRequest,
  "_kiroAuthContext" | "_providerContinuation" | "_providerContinuationOwner"
  | "_reasoningReplayScope" | "_stripReasoningEncryptedContent" | "_dropForeignReasoningItemIds"> & {
    access: string | undefined;
  };

describe("Kiro refusal dispatch preserves the serving account boundary", () => {
  for (const [status, reason] of [[400, "MONTHLY_REQUEST_COUNT"], [403, "TEMPORARILY_SUSPENDED"]] as const) {
    for (const stream of [false, true]) {
      test(`${status} refusal rebinds retry and ${stream ? "streamed" : "buffered"} response state`, async () => {
        // These seams replace only provider I/O. Selection, refusal classification, rotation,
        // dispatch rebinding, response delivery, and continuation persistence remain real.
        const nativeFactory = spyOn(kiroAdapter, "createKiroAdapter").mockImplementation(() => {
          throw new Error("The real Kiro adapter must not be constructed by this fixture");
        });
        const catalog = spyOn(kiroCatalog, "refreshKiroAccountModelsDetached").mockImplementation(() => {});
        restores.push(() => nativeFactory.mockRestore(), () => catalog.mockRestore());
        for (const name of ["a", "b"]) {
          await saveCredential("kiro", {
            access: `synthetic-access-${name}`, refresh: `synthetic-refresh-${name}`,
            expires: Date.now() + 86_400_000, accountId: `fixture-${name}`,
            kiro: { profileArn: `fixture-profile-${name}`, apiRegion: "us-east-1", ssoRegion: "us-east-1" },
          }, { addAccount: true });
        }
        const [first, second] = getAccountSet("kiro")!.accounts;
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        await setActiveAccount("kiro", first!.id);
        const secondIdentity = reasoningReplayOAuthCredentialIdentity({
          accountId: second!.id, generation: credentialGeneration(second!.credential),
        });
        const observations: BuildObservation[] = [];
        const sentAccess: string[] = [];
        const events = (response: Response): AdapterEvent[] => [
          { type: "text_delta", text: "Synthetic completed answer." },
          { type: "done", endTurn: true, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
            providerState: { kiro: { conversationId: response.headers.get("x-fixture-conversation")! } } },
        ];
        const factory = spyOn(ADAPTER_REGISTRY.kiro, "create").mockImplementation(provider => ({
          name: "kiro", reportsPhysicalSends: true,
          buildRequest(parsed) {
            observations.push(structuredClone({
              access: provider.apiKey, _kiroAuthContext: parsed._kiroAuthContext,
              _providerContinuation: parsed._providerContinuation,
              _providerContinuationOwner: parsed._providerContinuationOwner,
              _reasoningReplayScope: parsed._reasoningReplayScope,
              _stripReasoningEncryptedContent: parsed._stripReasoningEncryptedContent,
              _dropForeignReasoningItemIds: parsed._dropForeignReasoningItemIds,
            }));
            return { url: "https://kiro-fixture.invalid/generate", method: "POST",
              headers: { authorization: provider.apiKey! }, body: "{}" };
          },
          async fetchResponse(outbound, context) {
            const send = context?.sendBudget?.reserveDispatch({ sendClass: "initial", targetKey: "synthetic-kiro" });
            if (send && (!send.allowed || !send.permit.use())) throw new Error("Fixture send allowance exhausted");
            context?.onPhysicalSend?.({ ordinal: 1 });
            sentAccess.push(outbound.headers.authorization!);
            if (sentAccess.length === 2) return Response.json({ reason }, { status });
            return new Response("synthetic", { headers: {
              "x-fixture-conversation": sentAccess.length === 1 ? "conversation-a" : "conversation-b",
            } });
          },
          async *parseStream(response) { yield* events(response); },
          async parseResponse(response) { return events(response); },
        }));
        restores.push(() => factory.mockRestore());
        const config = { ...getDefaultConfig(), defaultProvider: "kiro", providers: {
          kiro: { adapter: "kiro", authMode: "oauth", baseUrl: "https://runtime.us-east-1.kiro.dev" },
        } };
        const seedId = await completedId(await handleResponses(request(), config, { model: "", provider: "" }), false);
        const seedState = previousResponseProviderState(seedId);
        expect(seedState?.kiro?.conversationId).toBe("conversation-a");
        expect(seedState?.__ocxOwner).toBeDefined();
        const log: RequestLogContext = { model: "", provider: "" };
        const finalId = await completedId(await handleResponses(request(seedId, stream), config, log), stream);

        expect(sentAccess).toEqual(["synthetic-access-a", "synthetic-access-a", "synthetic-access-b"]);
        expect(observations).toHaveLength(3);
        const refused = observations[1]!;
        const retried = observations[2]!;
        // Positive restoration before refusal prevents a vacuous "state was absent" pass.
        expect(refused._providerContinuation?.kiro?.conversationId).toBe("conversation-a");
        expect(refused._providerContinuationOwner).toEqual(seedState!.__ocxOwner);
        expect(retried._providerContinuation).toBeUndefined();
        expect(retried._kiroAuthContext?.profileArn).toBe("fixture-profile-b");
        expect(retried._reasoningReplayScope?.current?.credentialIdentity).toBe(secondIdentity);
        expect(retried._providerContinuationOwner).not.toEqual(seedState!.__ocxOwner);
        expect(retried._stripReasoningEncryptedContent).toBe(true);
        expect(retried._dropForeignReasoningItemIds).toBe(true);
        await flushResponseState();
        clearResponseStateMemoryForTests();
        const finalState = previousResponseProviderState(finalId);
        expect(finalState?.kiro?.conversationId).toBe("conversation-b");
        expect(finalState?.__ocxOwner).toEqual(retried._providerContinuationOwner);
        expect(log.accountLogLabel).toBe(oauthAccountLogLabel(second!.id, "kiro"));
        expect(log.activeAttempt?.accountLogLabel).toBe(oauthAccountLogLabel(second!.id, "kiro"));
        expect(getAccountSet("kiro")!.activeAccountId).toBe(second!.id);
        expect(catalog).toHaveBeenCalled();
        expect(nativeFactory).not.toHaveBeenCalled();
        expect(networkCalls).toBe(0);
      });
    }
  }
});
