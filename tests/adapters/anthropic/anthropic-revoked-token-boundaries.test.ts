import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AnthropicInstanceId } from "../../../src/providers/anthropic-instance-id";
import { createAnthropicInstanceFixture, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";

let f: AnthropicInstanceFixture;
let refusal: typeof import("../../../src/oauth/anthropic-account-refusal");
let ownership: typeof import("../../../src/oauth/anthropic-send-ownership");
const instances = ["anthropic", "anthropic2"] as const;
const message = "OAuth access token has been revoked.";
const payload = { type: "error", error: { type: "authentication_error", message } };

beforeEach(async () => {
  f = await createAnthropicInstanceFixture();
  await f.seed();
  refusal = await import("../../../src/oauth/anthropic-account-refusal");
  ownership = await import("../../../src/oauth/anthropic-send-ownership");
});
afterEach(async () => { await f?.dispose(); });

async function bound(instance: AnthropicInstanceId, response = Response.json(payload, { status: 401 })) {
  const { snapshot } = await f.admit(instance, "session-one");
  expect(snapshot).not.toBeNull();
  const owner = ownership.captureAnthropicPhysicalSendOwnership(snapshot!);
  expect(owner).not.toBeNull();
  refusal.bindAnthropicRefusalCredentialForSend(response, owner!);
  return { response, snapshot: snapshot!, owner: owner! };
}
function rotate(instance: AnthropicInstanceId, response: Response, canRetry = true, allowAccountRefusal = true) {
  return refusal.rotateAnthropicAccountOnResponseForInstance(instance, response, {
    config: f.config, accountId: f.ids[0], model: f.model, sessionKey: "session-one",
    requestKey: {}, canRetry, allowAccountRefusal,
  });
}
for (const instance of instances) for (const mutation of ["uuid", "cancel", "epoch", "remove-readd"] as const) {
 test(instance + ": independent queued " + mutation + " cannot acquire terminal authority", async () => {
  const { response, snapshot } = await bound(instance);
  refusal.bindAnthropicRefusalCredentialForSend(response, ownership.captureAnthropicPhysicalSendOwnership(snapshot)!,
    f.store.getAccountCredential(instance, f.ids[0])!.accountId);
  const abort = new AbortController();
  if (mutation === "epoch") f.quota.clearAccountQuotaCache();
  if (mutation === "remove-readd") {
    const original = structuredClone(f.store.getAccountSet(instance)!.accounts[0]!);
    await f.store.removeAccount(instance,f.ids[0]);
    const cache=await import("../../../src/providers/quota/account-cache");
    const recovery=await import("../../../src/providers/quota/anthropic-cooldown-recovery");
    const sweeper=await import("../../../src/lib/state-store-sweeper");
    const context={generation:sweeper.captureConfigGeneration()+1,providerNames:new Set(instances),
      oauthAccountKeys:new Set(instances.flatMap(i=>f.store.getAccountSet(i)!.accounts.map(a=>cache.accountCacheKey(i,a.id)))),
      comboIds:new Set<string>(),comboTargets:new Set<string>(),codexAccountIds:new Set<string>(),configRoots:new Set<string>()};
    recovery.reconcileAllAnthropicCooldownGenerations(context);
    await f.store.mutateStore(s=>{s[instance]!.accounts.unshift(original);});
  }
  let release!:()=>void,entered!:()=>void;
  const hold=new Promise<void>(r=>release=r), ready=new Promise<void>(r=>entered=r);
  const blocker=f.store.mutateStore(async()=>{entered();await hold;}); await ready;
  const newer=mutation === "uuid" ? f.store.mutateStore(s=>{s[instance]!.accounts[0]!.credential.accountId="55555555-5555-4555-8555-555555555555";}) : Promise.resolve();
  const pending=refusal.rotateAnthropicAccountOnResponseForInstance(instance,response,{
    config:f.config,accountId:f.ids[0],model:f.model,canRetry:true,signal:abort.signal});
  try {for(let i=0;i<100;i++) await new Promise<void>(r=>setImmediate(r)); if(mutation==="cancel")abort.abort();}
  finally {release();}
  await blocker;await newer;
  expect(await pending).toBeNull();
  expect(f.store.getAccountCredentialWithStatus(instance,f.ids[0])?.needsReauth).toBe(false);
 });
}
test("independent Pool 2 disable while terminal writer is queued",async()=>{
 const {response}=await bound("anthropic2");
 let release!:()=>void,entered!:()=>void;
 const hold=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const blocker=f.store.mutateStore(async()=>{entered();await hold;});await ready;
 const pending=rotate("anthropic2",response);
 try {for(let i=0;i<100 && f.store.oauthMutationTailSnapshot().active<2;i++)await new Promise<void>(r=>setImmediate(r));
   expect(f.store.oauthMutationTailSnapshot().active).toBe(2); f.config.providers.anthropic2!.disabled=true;}
 finally {release();}
 await blocker;expect(await pending).toBeNull();
 expect(f.store.getAccountCredentialWithStatus("anthropic2",f.ids[0])?.needsReauth).toBe(false);
});

for (const instance of instances) {
  test(`${instance}: independent search loop does not offer revoked-401 recovery after routed output`, async () => {
    const { runWithWebSearch } = await import("../../../src/web-search/loop");
    const { parseRequest } = await import("../../../src/responses/parser");
    const { createTranslatorBudget } = await import("../../../src/lib/translator-budget");
    const translatorBudget = createTranslatorBudget();
    globalThis.fetch = (async () => Response.json({ results: [{ title: "Fixture", url: "https://example.test/result", content: "Synthetic result" }] })) as typeof fetch;
    let routedSends = 0; let rotations = 0;
    const adapter: import("../../../src/adapters/base").ProviderAdapter = {
      name: "mock-anthropic-output",
      buildRequest: () => ({ url: "https://routed.example.test/messages", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => ++routedSends === 1 ? new Response("ok") : Response.json(payload,{status:401}),
      async *parseStream() {
        yield { type: "text_delta", text: "I will check. " };
        yield { type: "tool_call_start", id: "search-1", name: "web_search" };
        yield { type: "tool_call_delta", arguments: '{"query":"fixture query"}' };
        yield { type: "tool_call_end" }; yield { type: "done" };
      },
    };
    try {
      const response = await runWithWebSearch({
        parsed: parseRequest({ model: `${instance}/${f.model}`, input: "Answer briefly", stream: true, tools: [{ type: "web_search" }] }),
        adapter, incomingMeta: { headers: new Headers(), providerName: instance, translatorBudget },
        backend: "exa", exaApiKey: "test-exa-key", hostedTool: { type: "web_search" }, selectedForwardHeaders: new Headers(),
        settings: { model: "exa-fixture-model", reasoning: "low", timeoutMs: 30_000 }, maxSearches: 1, streamRoutedModelOutput: true,
        on429: () => { rotations++; return null; },
      });
      expect(await response.text()).toContain("I will check.");
      expect(routedSends).toBe(2); expect(rotations).toBe(0);
    } finally { translatorBudget.dispose(); }
  });
}
