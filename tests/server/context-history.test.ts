// mock.module replacements require file isolation (bun test --isolate).
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";

type Selection = { headers: Headers; mode: string; options: { modelId: string } };
let selection: Selection | undefined;
const config: OcxConfig = { port: 0, defaultProvider: "openai", providers: {} };
const logContext = (): RequestLogContext => ({ model: "context_history", provider: "" });
let materialized: { config: OcxConfig; modelId: string } | undefined;
let materializationError: Error | undefined;
let validated=0;
let probe=false;let released=0;let directError=false;
const errors = {
  CodexAccountCooldownError: class extends Error {},
  CodexDirectAuthenticationError: class extends Error {},
  CodexAuthContextError: class extends Error {},
  CodexMainProfileDrainingError: class extends Error {},
  CodexPoolAuthenticationError: class extends Error {},
  CodexThreadAffinityExpiredError: class extends Error {},
};
mock.module("../../src/codex/auth-context",()=>({
  ...errors,
  resolveCodexAuthContext:async(headers: Headers, _config: OcxConfig, mode: string, options: Selection["options"])=>{selection={headers,mode,options};if(directError)throw new errors.CodexDirectAuthenticationError();return {kind:"pool",accountId:"test-account",...(probe?{probeLeaseId:"test-probe"}:{})};},
  isCodexAuthContextUsable:()=>true,
  releaseCodexAuthContextProbeLease:()=>{released++;},
  headersForCodexAuthContext:(_headers: Headers, _auth: unknown, selectedConfig: OcxConfig, modelId: string) => {
    materialized = { config: selectedConfig, modelId };
    if (materializationError) throw materializationError;
    return new Headers({ authorization: "Bearer test-only", "chatgpt-account-id": "test-only" });
  },
  cooldownErrorResponse:()=>new Response("cooldown",{status:429}),
  codexMainProfileDrainingResponse:()=>new Response("draining",{status:503}),
}));
const realRouting = await import("../../src/codex/routing");
mock.module("../../src/codex/routing",()=>({...realRouting, formatCodexProviderForLog:()=>"openai-test"}));
mock.module("../../src/providers/openai-sidecar",()=>({listOpenAiForwardSidecarCandidates:()=>[{providerName:"openai",provider:{baseUrl:"https://chatgpt.com/backend-api/codex"},accountMode:"pool"}]}));
class ForwardAdmissionCredentialError extends Error {}
mock.module("../../src/server/auth-cors",()=>({ForwardAdmissionCredentialError,validateForwardAdmissionCredential:(h:Headers)=>{validated++;if(!h.has("authorization"))throw new ForwardAdmissionCredentialError("test credential missing");}}));
mock.module("../../src/server/responses",()=>({codexLogAccountId:()=>"test",decodeRequestErrorResponse:()=>new Response("invalid json",{status:400})}));
mock.module("../../src/server/lifecycle",()=>({codexAccountSelectionForTurn:()=>()=>undefined}));
const { handleContextHistory, contextSelectionHeaders } = await import("../../src/server/context-history");
const originalFetch=globalThis.fetch;
function setFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}
afterAll(()=>{globalThis.fetch=originalFetch;mock.restore();});
beforeEach(()=>{globalThis.fetch=originalFetch;materialized=undefined;materializationError=undefined;selection=undefined;validated=0;probe=false;released=0;directError=false;});

describe("context relay contract",()=>{
  test("selects root shared lane but sends original body and protocol headers",async()=>{
    const body={context:{session_id:"root-test",current_agent_name:"/root"},encrypted_arguments:"opaque+==",unknown:{future:true}};
    let sent: RequestInit & { url: string } = { url: "" };
    setFetch(async(url: string | URL | Request, opts?: RequestInit)=>{sent={url:String(url),...opts};return new Response('{"ok":true}',{headers:{"content-type":"application/json","x-request-id":"req-test"}});});
    const req=new Request("http://127.0.0.1/backend-api/codex/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer incoming","content-type":"application/json","x-openai-encrypted-tool-arguments":"true","x-openai-tool-output-truncation-policy":"{\"mode\":\"tokens\"}"},body:JSON.stringify(body)});
    const r=await handleContextHistory(req,config,logContext(),"alpha/notes/v2/write_file");
    expect(r.status).toBe(200);expect(r.headers.get("x-request-id")).toBe("req-test");
    expect(materialized).toEqual({ config, modelId: "context_history" });
    expect(validated).toBe(1);expect(selection?.mode).toBe("pool");expect(selection?.options.modelId).toBe("context_history");
    expect(selection?.headers.get("session-id")).toBe("root-test");expect(selection?.headers.get("thread-id")).toBe("root-test");expect(selection?.headers.get("x-codex-parent-thread-id")).toBeNull();
    expect(JSON.parse(String(sent.body))).toEqual(body);expect(new Headers(sent.headers).has("session-id")).toBe(false);
    expect(new Headers(sent.headers).get("x-openai-encrypted-tool-arguments")).toBe("true");expect(sent.redirect).toBe("manual");
  });
  test("propagates errors without retrying or hiding a write failure",async()=>{
    let calls=0;
    setFetch(async()=>{calls++;return new Response('{"error":"feature denied"}',{status:403,headers:{"retry-after":"7"}});});
    const req=new Request("http://localhost/v1/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"s"}})});
    const r=await handleContextHistory(req,config,logContext(),"alpha/notes/v2/write_file");
    expect(r.status).toBe(403);expect(await r.text()).toBe('{"error":"feature denied"}');expect(r.headers.get("retry-after")).toBe("7");expect(calls).toBe(1);
  });
  test("rejects malformed context before any account selection",async()=>{
    const req=new Request("http://localhost/v1/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:"{}"});
    expect((await handleContextHistory(req,config,logContext(),"alpha/notes/v2/write_file")).status).toBe(400);expect(selection).toBeUndefined();
    expect(contextSelectionHeaders(new Headers({"x-codex-parent-thread-id":"parent"}),"s").get("session-id")).toBeNull();
  });
});

test("context traffic releases quota probe and maps missing direct auth",async()=>{
 const request=()=>new Request("http://localhost/v1/alpha/notes/v2/read_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"root-test"}})});
 probe=true;
 expect((await handleContextHistory(request(),config,logContext(),"alpha/notes/v2/read_file")).status).toBe(503);
 expect(released).toBe(1);
 probe=false;directError=true;
 expect((await handleContextHistory(request(),config,logContext(),"alpha/notes/v2/read_file")).status).toBe(401);
});
test("invalid header characters are rejected before selection",async()=>{
 const req=new Request("http://localhost/v1/alpha/notes/v2/read_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"bad\nvalue"}})});
 expect((await handleContextHistory(req,config,logContext(),"alpha/notes/v2/read_file")).status).toBe(400);
 expect(selection).toBeUndefined();
});

function contextRequest(body: string, headers: HeadersInit = { authorization: "Bearer test" }, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/alpha/notes/v2/read_file", { method: "POST", headers, body, signal });
}

test("missing admission credential fails before parsing or selecting an account", async () => {
  const response = await handleContextHistory(contextRequest("not json", {}), config, logContext(), "alpha/notes/v2/read_file");
  expect(response.status).toBe(401);
  expect(selection).toBeUndefined();
});

test("malformed JSON and non-string or oversized session IDs fail before selection", async () => {
  for (const body of ["not json", "null", JSON.stringify({ context: { session_id: 42 } }), JSON.stringify({ context: { session_id: "a".repeat(513) } })]) {
    expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(400);
    expect(selection).toBeUndefined();
  }
});

test("existing session and child affinity headers are not overwritten", () => {
  for (const entry of [{ "session-id": "existing" }, { "thread-id": "child" }, { "x-codex-parent-thread-id": "parent" }] as Record<string, string>[]) {
    const headers = new Headers(entry);
    const result = contextSelectionHeaders(headers, "root");
    expect([...result]).toEqual([...headers]);
    expect([...headers]).toEqual([...new Headers(entry)]);
  }
});

test("network failures and client cancellation do not retry writes", async () => {
  let calls = 0;
  setFetch(async () => { calls++; throw new Error("test transport failure"); });
  const body = JSON.stringify({ context: { session_id: "root" } });
  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/write_file")).status).toBe(502);
  const controller = new AbortController();
  setFetch(async () => { calls++; controller.abort(); throw new Error("test canceled"); });
  expect((await handleContextHistory(contextRequest(body, { authorization: "Bearer test" }, controller.signal), config, logContext(), "alpha/notes/v2/write_file")).status).toBe(499);
  expect(calls).toBe(2);
});

test("unknown endpoints and methods are rejected before admission", async () => {
  expect((await handleContextHistory(contextRequest("{}"), config, logContext(), "alpha/notes/v2/delete_file")).status).toBe(404);
  expect((await handleContextHistory(new Request("http://localhost/v1/alpha/notes/v2/read_file"), config, logContext(), "alpha/notes/v2/read_file")).status).toBe(404);
  expect(validated).toBe(0);
  expect(selection).toBeUndefined();
});

test("credential materialization rechecks hardlocks and maps auth errors", async () => {
  const body = JSON.stringify({ context: { session_id: "root" } });
  let calls = 0;
  setFetch(async () => { calls++; return new Response("unexpected"); });
  for (const [error, status] of [[new errors.CodexAccountCooldownError(), 429], [new errors.CodexAuthContextError(), 401]] as const) {
    materializationError = error;
    const response = await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file");
    expect(response.status).toBe(status);
    expect(materialized).toEqual({ config, modelId: "context_history" });
  }
  expect(calls).toBe(0);
});
