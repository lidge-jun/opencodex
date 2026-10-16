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
for (const instance of instances) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  for (const canRetry of [true, false]) {
    test(instance + ": mark and clear all affinity with retry allowance " + canRetry, async () => {
      const { response } = await bound(instance);
      await f.admit(instance, "session-two");
      await f.admit(other, "other-session");
      const otherAffinity = f.routing.anthropicRoutingFor(other).anthropicSessionAffinitySizeForTests();
      expect(f.routing.anthropicRoutingFor(instance).anthropicSessionAffinitySizeForTests()).toBe(2);
      expect(await rotate(instance, response, canRetry)).toBe(canRetry ? f.ids[1] : null);
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
      expect(f.routing.anthropicRoutingFor(instance).anthropicSessionAffinitySizeForTests()).toBe(0);
      expect(f.routing.anthropicRoutingFor(instance).getEligibleAnthropicAccounts()).toEqual([f.ids[1]]);
      expect(f.store.getAccountCredentialWithStatus(other, f.ids[0])?.needsReauth).toBe(false);
      expect(f.routing.anthropicRoutingFor(other).anthropicSessionAffinitySizeForTests()).toBe(otherAffinity);
      expect(f.routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
      expect(await response.json()).toEqual(payload);
    });
  }
  test(instance + ": no eligible sibling still marks reauthentication", async () => {
    await f.store.setAccountPaused(instance, f.ids[1], true);
    const { response } = await bound(instance);
    expect(await rotate(instance, response)).toBeNull();
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(payload);
  });
  test(instance + ": output commitment disables account-refusal recovery", async () => {
    const { response } = await bound(instance);
    expect(await rotate(instance, response, true, false)).toBeNull();
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
    expect(await response.json()).toEqual(payload);
  });
  for (const sameBytes of [false, true]) {
    test(instance + ": relogin before late refusal is preserved " + sameBytes, async () => {
      const { response } = await bound(instance);
      const credential = f.store.getAccountCredential(instance, f.ids[0])!;
      await f.store.saveAccountCredential(instance, f.ids[0], sameBytes ? credential
        : { ...credential, access: "synthetic-" + instance + "-replacement-access" }, { rotateLoginId: true });
      expect(await rotate(instance, response)).toBeNull();
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
    });
  }
  const negatives = [
    { ...payload, error: { type: "authentication_error", message: "OAuth access token has expired." } },
    { ...payload, error: { type: "permission_error", message } },
    { ...payload, error: { type: "authentication_error", message: "Quoted: " + message } },
    { ...payload, error: { type: "authentication_error", message: message.toLowerCase() } },
    { ...payload, error: { type: "authentication_error", message: " " + message + " " } },
    { ...payload, error: { type: "authentication_error", message, code: "invalid_api_key" } },
    { error: payload.error }, [],
  ];
  for (const [index, body] of negatives.entries()) {
    test(instance + ": unmatched 401 body " + index + " has no account effect", async () => {
      const { response } = await bound(instance, Response.json(body, { status: 401 }));
      expect(await rotate(instance, response)).toBeNull();
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
      expect(f.routing.anthropicRoutingFor(instance).anthropicSessionAffinitySizeForTests()).toBe(1);
      expect(await response.json()).toEqual(body);
    });
  }
  for (const body of ["{", JSON.stringify({ ...payload, padding: "x".repeat(65_536) })]) {
    test(instance + ": malformed or oversized refusal is not authority " + body.length, async () => {
      const { response } = await bound(instance, new Response(body, { status: 401 }));
      expect(await rotate(instance, response)).toBeNull();
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
      expect(await response.text()).toBe(body);
    });
  }
  for (const status of [400, 403, 429]) {
    test(instance + ": exact sentence on other status is not revocation " + status, async () => {
      const { response } = await bound(instance, Response.json(payload, { status }));
      expect(await rotate(instance, response, false)).toBeNull();
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
    });
  }
  test(instance + ": unbound matching response is ignored", async () => {
    expect(await rotate(instance, Response.json(payload, { status: 401 }))).toBeNull();
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
  });
  test(instance + ": cancellation preserves the account", async () => {
    const { response } = await bound(instance);
    const abort = new AbortController(); abort.abort();
    expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, response, {
      config: f.config, accountId: f.ids[0], model: f.model, signal: abort.signal, canRetry: true,
    })).toBeNull();
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
  });
  test(instance + ": explicit relogin clears terminal state", async () => {
    const { response } = await bound(instance);
    await rotate(instance, response, false);
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
    const credential = f.store.getAccountCredential(instance, f.ids[0])!;
    await f.store.saveAccountCredential(instance, f.ids[0], { ...credential,
      access: "synthetic-" + instance + "-new-login-access" }, { rotateLoginId: true });
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
    expect(f.routing.anthropicRoutingFor(instance).getEligibleAnthropicAccounts()).toContain(f.ids[0]);
  });
}

for (const instance of instances) {
 test(instance + ": audit malformed UTF-8 is not terminal authority", async () => {
   const prefix=new TextEncoder().encode(JSON.stringify({...payload,padding:"X"}));
   const index=prefix.indexOf(88,prefix.length-6); expect(index).toBeGreaterThan(0); prefix[index]=255;
   const {response}=await bound(instance,new Response(prefix,{status:401}));
   expect(await rotate(instance,response)).toBeNull();
   expect(f.store.getAccountCredentialWithStatus(instance,f.ids[0])?.needsReauth).toBe(false);
 });
 test(instance + ": audit delayed body relogin preserves same-byte replacement", async () => {
   let release!:()=>void; const ready=new Promise<void>(r=>release=r);
   let entered!:()=>void; const begin=new Promise<void>(r=>entered=r);
   const response=new Response(new ReadableStream({ async pull(controller) { entered(); await ready; controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); } }),{status:401});
   await bound(instance,response);
   const pending=rotate(instance,response); await begin;
   await f.store.saveAccountCredential(instance,f.ids[0],f.store.getAccountCredential(instance,f.ids[0])!,{rotateLoginId:true});
   release(); expect(await pending).toBeNull();
   expect(f.store.getAccountCredentialWithStatus(instance,f.ids[0])?.needsReauth).toBe(false);
 });
}

for (const instance of instances) for (const replacement of ["same-login", "pause"]) {
 test(instance + ": audit locked snapshot fences queued " + replacement, async () => {
   const {response}=await bound(instance);
   let release!:()=>void; const hold=new Promise<void>(r=>release=r);
   let entered!:()=>void; const ready=new Promise<void>(r=>entered=r);
   const blocker=f.store.mutateStore(async()=>{entered();await hold;}); await ready;
   const newer=replacement === "pause" ? f.store.setAccountPaused(instance,f.ids[0],true)
      : f.store.saveAccountCredential(instance,f.ids[0],f.store.getAccountCredential(instance,f.ids[0])!,{rotateLoginId:true});
   const pending=rotate(instance,response);
   try {
     for (let i=0;i<100 && f.store.oauthMutationTailSnapshot().active<3;i++) await new Promise<void>(r=>setImmediate(r));
     expect(f.store.oauthMutationTailSnapshot().active).toBe(3);
   } finally {release();}
   await blocker; await newer; expect(await pending).toBeNull();
   expect(f.store.getAccountCredentialWithStatus(instance,f.ids[0])?.needsReauth).toBe(false);
 });
}


for (const instance of instances) {
  test(instance + ": exact null-code evidence is accepted", async () => {
    const { response } = await bound(instance, Response.json({ ...payload, error: { ...payload.error, code: null } }, { status: 401 }));
    expect(await rotate(instance, response)).toBe(f.ids[1]);
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
  });
  test(instance + ": singleton is marked without a replay proposal", async () => {
    await f.store.removeAccount(instance, f.ids[1]);
    const { response } = await bound(instance);
    expect(await rotate(instance, response)).toBeNull();
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
    expect(await response.json()).toEqual(payload);
  });
  test(instance + ": rejected persistence offers no alternate and keeps the response", async () => {
    const { response } = await bound(instance);
    const failure = spyOn(f.store, "markAccountNeedsReauthIfGeneration").mockRejectedValue(new Error("synthetic write failure"));
    try {
      expect(await rotate(instance, response)).toBeNull();
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
      expect(await response.json()).toEqual(payload);
    } finally { failure.mockRestore(); }
  });
  for (const fallback of [false, true]) {
    test(instance + ": revoked recovery retains model route fallback " + fallback, async () => {
      const pool = { enabled: true, routes: [{ name: "strict", match: f.model, accounts: [f.ids[0]], fallback }] };
      if (instance === "anthropic") f.config.anthropicAccountPool = pool;
      else f.config.providers.anthropic2!.anthropicAccountPool = pool;
      const { response } = await bound(instance);
      const decision = (await import("../../../src/oauth/anthropic-model-routes")).resolveAnthropicModelRouteForInstance(instance, f.config, f.model).decision;
      expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, response, {
        config: f.config, accountId: f.ids[0], model: f.model, decision, canRetry: true,
      })).toBe(fallback ? f.ids[1] : null);
      expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(true);
    });
  }
  test(instance + ": response from the other instance is never authority", async () => {
    const other = instance === "anthropic" ? "anthropic2" : "anthropic";
    const { response } = await bound(other);
    expect(await rotate(instance, response)).toBeNull();
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
    expect(f.store.getAccountCredentialWithStatus(other, f.ids[0])?.needsReauth).toBe(false);
  });
  test(instance + ": cancellation during body classification makes no durable change", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const response = new Response(new ReadableStream({
      async pull(controller) { entered(); await hold; controller.enqueue(new TextEncoder().encode(JSON.stringify(payload))); controller.close(); },
    }), { status: 401 });
    await bound(instance, response);
    const abort = new AbortController();
    const pending = refusal.rotateAnthropicAccountOnResponseForInstance(instance, response, {
      config: f.config, accountId: f.ids[0], model: f.model, canRetry: true, signal: abort.signal,
    });
    await ready;
    abort.abort();
    release();
    expect(await pending).toBeNull();
    expect(f.store.getAccountCredentialWithStatus(instance, f.ids[0])?.needsReauth).toBe(false);
  });
}
