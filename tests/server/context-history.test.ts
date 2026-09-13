// mock.module replacements require file isolation (bun test --isolate).
import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetContextRelayActivationForTests } from "../../src/codex/context-compat";
import type { CodexAuthContext } from "../../src/codex/auth-context";
import { recordContextSessionOwner, clearContextSessionOwnersForTests } from "../../src/codex/context-owner";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";
import type { RequestLogContext } from "../../src/server/request-log";

type Selection = { headers: Headers; mode: string; options: { modelId: string; admission?: DataPlaneAdmission; substituteMainCredentialForDirect?: boolean; accountId?: string; requestScopedMainCredential?: boolean } };
let selection: Selection | undefined;
const config: OcxConfig = { port: 0, defaultProvider: "openai", providers: {} };
const logContext = (): RequestLogContext => ({ model: "context_history", provider: "" });

// The relay only exists while Codex own config opts in, so these cases need a home that does.
const codexHome = mkdtempSync(join(tmpdir(), "ocx-context-flag-"));
const codexConfigPath = join(codexHome, "config.toml");
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = codexHome;
function setContextFeature(enabled: boolean): void {
  writeFileSync(codexConfigPath, enabled ? "[features]\ncontext_management.experimental_mode = true\n" : "model = \"gpt-5.5\"\n");
  resetContextRelayActivationForTests();
}
setContextFeature(true);
let materialized: { config: OcxConfig; modelId: string } | undefined;
let materializationError: Error | undefined;
let materializationOptions: { admission?: DataPlaneAdmission; substituteMainCredential?: boolean } | undefined;
let outgoingBearer = "test-only";
let outgoingAccount = "test-only";
let accountMode = "pool";
let validated=0;
let probe=false;let released=0;let directError=false;let duringSelection:(()=>void)|undefined;
const errors = {
  CodexAccountCooldownError: class extends Error {},
  CodexMainSubstitutionUnavailableError: class extends Error {},
  CodexDirectAuthenticationError: class extends Error {},
  CodexAuthContextError: class extends Error {},
  CodexMainProfileDrainingError: class extends Error {},
  CodexPoolAuthenticationError: class extends Error {},
  CodexThreadAffinityExpiredError: class extends Error {},
};
mock.module("../../src/codex/auth-context",()=>({
  ...errors,
  resolveCodexAuthContext:async(headers: Headers, _config: OcxConfig, mode: string, options: Selection["options"])=>{selection={headers,mode,options};duringSelection?.();if(directError)throw new errors.CodexDirectAuthenticationError();return {kind:"pool",accountId:"test-account",...(probe?{probeLeaseId:"test-probe"}:{})};},
  isCodexAuthContextUsable:()=>true,
  releaseCodexAuthContextProbeLease:()=>{released++;},
  materializeCodexUpstreamAuth: (_headers: Headers, _auth: unknown, options: { config: OcxConfig; modelId: string; admission?: DataPlaneAdmission; substituteMainCredential?: boolean }) => {
    materializationOptions = options;
    materialized = { config: options.config, modelId: options.modelId };
    if (materializationError) throw materializationError;
    return new Headers({ authorization: `Bearer ${outgoingBearer}`, "chatgpt-account-id": outgoingAccount });
  },
  headersForCodexAuthContext:(_headers: Headers, _auth: unknown, selectedConfig: OcxConfig, modelId: string) => {
    materialized = { config: selectedConfig, modelId };
    if (materializationError) throw materializationError;
    return new Headers({ authorization: "Bearer test-only", "chatgpt-account-id": outgoingAccount });
  },
  cooldownErrorResponse:()=>new Response("cooldown",{status:429}),
  codexMainProfileDrainingResponse:()=>new Response("draining",{status:503}),
}));
const realRouting = await import("../../src/codex/routing");
mock.module("../../src/codex/routing",()=>({...realRouting, formatCodexProviderForLog:()=>"openai-test"}));
mock.module("../../src/providers/openai-sidecar",()=>({listOpenAiForwardSidecarCandidates:()=>[{providerName:"openai",provider:{baseUrl:"https://chatgpt.com/backend-api/codex"},accountMode}]}));
class ForwardAdmissionCredentialError extends Error {}
mock.module("../../src/server/auth-cors",()=>({ForwardAdmissionCredentialError,resolveContextPrincipal:(_r:Request,_c:OcxConfig,a?:{contextPrincipalId?:string})=>a?.contextPrincipalId,validateForwardAdmissionCredential:(h:Headers)=>{validated++;if(!h.has("authorization") || h.get("authorization") === "Bearer ocx_data_test_admission")throw new ForwardAdmissionCredentialError("test credential missing");}}));
mock.module("../../src/server/responses",()=>({codexLogAccountId:()=>"test",decodeRequestErrorResponse:()=>new Response("invalid json",{status:400})}));
mock.module("../../src/server/lifecycle",()=>({codexAccountSelectionForTurn:()=>()=>undefined}));
const { handleContextHistory, contextSelectionHeaders } = await import("../../src/server/context-history");
const destination = "https://chatgpt.com/backend-api/codex";
let issuedTokens = 0;
// A real ChatGPT credential carries a stable user claim; ownership continuity across a refresh
// depends on it, so a test that models a refresh has to issue distinct tokens for one user.
function userToken(user: string): string {
  const payload = Buffer.from(JSON.stringify({
    iat: ++issuedTokens, "https://api.openai.com/auth": { chatgpt_user_id: user },
  }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}
function seedOwner(sessionId: string, kind: "stored" | "caller" = "stored", account = "test-only",
  now?: number, token = "test-only") {
  const auth = kind === "caller" ? { kind: "main", accountId: null } : {
    kind: "pool", accountId: "test-account", chatgptAccountId: account,
    accessToken: "test-only", generation: 1, writerGeneration: 0,
  };
  recordContextSessionOwner("principal-a", new Headers({ "session-id": sessionId }), destination,
    auth as CodexAuthContext, new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": account }), false, now);
}
const originalFetch=globalThis.fetch;
function setFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: originalFetch.preconnect });
}
afterAll(()=>{if(previousCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousCodexHome;resetContextRelayActivationForTests();clearContextSessionOwnersForTests();globalThis.fetch=originalFetch;mock.restore();});
beforeEach(()=>{clearContextSessionOwnersForTests();for (const id of ["root", "root-test", "s"]) seedOwner(id);outgoingAccount="test-only";globalThis.fetch=originalFetch;materialized=undefined;materializationError=undefined;selection=undefined;validated=0;materializationOptions=undefined;outgoingBearer="test-only";accountMode="pool";probe=false;released=0;directError=false;duringSelection=undefined;setContextFeature(true);});

describe("context relay contract",()=>{
  test("selects root shared lane but sends original body and protocol headers",async()=>{
    const body={context:{session_id:"root-test",current_agent_name:"/root"},encrypted_arguments:"opaque+==",unknown:{future:true}};
    let sent: RequestInit & { url: string } = { url: "" };
    setFetch(async(url: string | URL | Request, opts?: RequestInit)=>{sent={url:String(url),...opts};return new Response('{"ok":true}',{headers:{"content-type":"application/json","x-request-id":"req-test"}});});
    const req=new Request("http://127.0.0.1/backend-api/codex/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer incoming","content-type":"application/json","x-openai-encrypted-tool-arguments":"true","x-openai-tool-output-truncation-policy":"{\"mode\":\"tokens\"}"},body:JSON.stringify(body)});
    const r=await handleContextHistory(req, config, logContext(), "alpha/notes/v2/write_file", undefined, keyAdmission);
    expect(r.status).toBe(200);expect(r.headers.get("x-request-id")).toBe("req-test");
    expect(materialized).toEqual({ config, modelId: "context_history" });
    expect(validated).toBeGreaterThanOrEqual(1);expect(selection?.mode).toBe("pool");expect(selection?.options.modelId).toBe("context_history");
    expect(selection?.headers.get("session-id")).toBe("root-test");expect(selection?.headers.get("thread-id")).toBe("root-test");expect(selection?.headers.get("x-codex-parent-thread-id")).toBeNull();
    expect(JSON.parse(String(sent.body))).toEqual(body);expect(new Headers(sent.headers).has("session-id")).toBe(false);
    expect(new Headers(sent.headers).get("x-openai-encrypted-tool-arguments")).toBe("true");expect(sent.redirect).toBe("manual");
  });
  test("propagates errors without retrying or hiding a write failure",async()=>{
    let calls=0;
    setFetch(async()=>{calls++;return new Response('{"error":"feature denied"}',{status:403,headers:{"retry-after":"7"}});});
    const req=new Request("http://localhost/v1/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"s"}})});
    const r=await handleContextHistory(req, config, logContext(), "alpha/notes/v2/write_file", undefined, keyAdmission);
    expect(r.status).toBe(403);expect(await r.text()).toBe('{"error":"feature denied"}');expect(r.headers.get("retry-after")).toBe("7");expect(calls).toBe(1);
  });
  test("rejects malformed context before any account selection",async()=>{
    const req=new Request("http://localhost/v1/alpha/notes/v2/write_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:"{}"});
    expect((await handleContextHistory(req, config, logContext(), "alpha/notes/v2/write_file", undefined, keyAdmission)).status).toBe(400);expect(selection).toBeUndefined();
    expect(contextSelectionHeaders(new Headers({"x-codex-parent-thread-id":"parent"}),"s").get("session-id")).toBeNull();
  });
});

test("context traffic releases quota probe and maps missing direct auth",async()=>{
 const request=()=>new Request("http://localhost/v1/alpha/notes/v2/read_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"root-test"}})});
 probe=true;
 expect((await handleContextHistory(request(), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(503);
 expect(released).toBe(1);
 probe=false;directError=true;
 expect((await handleContextHistory(request(), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(401);
});
test("invalid header characters are rejected before selection",async()=>{
 const req=new Request("http://localhost/v1/alpha/notes/v2/read_file",{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json"},body:JSON.stringify({context:{session_id:"bad\nvalue"}})});
 expect((await handleContextHistory(req, config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(400);
 expect(selection).toBeUndefined();
});

function contextRequest(body: string, headers: HeadersInit = { authorization: "Bearer test" }, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/alpha/notes/v2/read_file", { method: "POST", headers, body, signal });
}

test("missing admission credential fails before parsing or selecting an account", async () => {
  const response = await handleContextHistory(contextRequest("not json", {}), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission);
  expect(response.status).toBe(401);
  expect(selection).toBeUndefined();
});

test("malformed JSON and non-string or oversized session IDs fail before selection", async () => {
  for (const body of ["not json", "null", JSON.stringify({ context: { session_id: 42 } }), JSON.stringify({ context: { session_id: "a".repeat(513) } })]) {
    expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(400);
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
  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/write_file", undefined, keyAdmission)).status).toBe(502);
  const controller = new AbortController();
  setFetch(async () => { calls++; controller.abort(); throw new Error("test canceled"); });
  expect((await handleContextHistory(contextRequest(body, { authorization: "Bearer test" }, controller.signal), config, logContext(), "alpha/notes/v2/write_file", undefined, keyAdmission)).status).toBe(499);
  expect(calls).toBe(2);
});

test("a client that gives up before dispatch releases without reaching upstream", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return Response.json({}); });
  const controller = new AbortController();
  controller.abort();
  const response = await handleContextHistory(
    contextRequest(JSON.stringify({ context: { session_id: "root" } }), { authorization: "Bearer test" }, controller.signal),
    config, logContext(), "alpha/notes/v2/write_file", undefined, keyAdmission);
  // The deadline starts before the body is read, so cancellation there is reported as the client
  // hanging up rather than as a parse failure, and nothing is written upstream.
  expect(response.status).toBe(499);
  expect(calls).toBe(0);
});

test("cancelling during credential selection dispatches nothing", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return Response.json({ value: "ok" }); });
  const controller = new AbortController();
  duringSelection = () => controller.abort();
  const response = await handleContextHistory(
    contextRequest(JSON.stringify({ context: { session_id: "root" } }), { authorization: "Bearer test" }, controller.signal),
    config, logContext(), "alpha/notes/v2/write_file", undefined, keyAdmission);
  // Selection is inside the deadline, so a client that leaves during it is reported as a hangup
  // and nothing reaches upstream. Listener-owned lease release is covered separately.
  expect(response.status).toBe(499);
  expect(selection).toBeDefined();
  expect(calls).toBe(0);
});

test.each(["body", "selection"])("disabling the feature during %s prevents dispatch", async stage => {
  let calls = 0;
  setFetch(async () => { calls++; return Response.json({}); });
  const body = JSON.stringify({ context: { session_id: "root" } });
  if (stage === "selection") duringSelection = () => setContextFeature(false);
  const req = stage === "body"
    ? new Request("http://localhost/v1/alpha/notes/v2/write_file", {
        method: "POST", headers: { authorization: "Bearer test" },
        body: new ReadableStream({ pull(controller) {
          setContextFeature(false);
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        } }, { highWaterMark: 0 }),
      })
    : contextRequest(body);
  const response = await handleContextHistory(req, config, logContext(),
    "alpha/notes/v2/write_file", undefined, keyAdmission);
  expect(response.status).toBe(404);
  expect(calls).toBe(0);
});

test("a key withdrawn during the request cannot dispatch on its earlier admission", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return Response.json({ value: "ok" }); });
  seedOwner("root-revalidate");
  const body = JSON.stringify({ context: { session_id: "root-revalidate" } });
  const response = await handleContextHistory(contextRequest(body), config, logContext(),
    "alpha/notes/v2/read_file", undefined, keyAdmission, () => null);
  expect(response.status).toBe(401);
  expect(calls).toBe(0);

  const rotated = { kind: "configured", keyId: "synthetic-key", source: "dedicated", contextPrincipalId: "principal-b" } as const;
  expect((await handleContextHistory(contextRequest(body), config, logContext(),
    "alpha/notes/v2/read_file", undefined, keyAdmission, () => rotated)).status).toBe(401);
  expect(calls).toBe(0);
});

test("with the experimental feature off the endpoints do not exist", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return Response.json({ value: "ok" }); });
  setContextFeature(false);
  const body = JSON.stringify({ context: { session_id: "root" } });
  // Rewriting the injected base URL is what makes the feature reachable, but a caller that can
  // already reach the data plane can POST these paths directly, so the opt-in has to hold here.
  for (const endpoint of ["alpha/history/v2/list_items", "alpha/notes/v2/write_file"]) {
    const response = await handleContextHistory(contextRequest(body), config, logContext(), endpoint, undefined, keyAdmission);
    expect(response.status).toBe(404);
  }
  expect(selection).toBeUndefined();
  expect(calls).toBe(0);
});

test("an admission without a caller principal cannot reach context history", async () => {
  const before = selection;
  // Loopback admission authenticates the socket, not a person. Without a minted principal there
  // is no owner to compare against, so the relay refuses instead of serving whoever asked.
  for (const admission of [undefined, { kind: "loopback", source: "loopback" } as const]) {
    const response = await handleContextHistory(
      contextRequest(JSON.stringify({ context: { session_id: "root" } })),
      config, logContext(), "alpha/notes/v2/read_file", undefined, admission);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: {
      type: "permission_error", code: "permission_denied",
      message: "Context history requires an opencodex API key on the request; admission alone carries no caller identity",
    } });
  }
  expect(selection).toBe(before);
});

test("unknown endpoints and methods are rejected before admission", async () => {
  expect((await handleContextHistory(contextRequest("{}"), config, logContext(), "alpha/notes/v2/delete_file", undefined, keyAdmission)).status).toBe(404);
  expect((await handleContextHistory(new Request("http://localhost/v1/alpha/notes/v2/read_file"), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(404);
  expect(validated).toBe(0);
  expect(selection).toBeUndefined();
});

test("credential materialization rechecks hardlocks and maps auth errors", async () => {
  const body = JSON.stringify({ context: { session_id: "root" } });
  let calls = 0;
  setFetch(async () => { calls++; return new Response("unexpected"); });
  for (const [error, status] of [[new errors.CodexAccountCooldownError(), 429], [new errors.CodexAuthContextError(), 401]] as const) {
    materializationError = error;
    const response = await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission);
    expect(response.status).toBe(status);
    expect(materialized).toEqual({ config, modelId: "context_history" });
  }
  expect(calls).toBe(0);
});


const keyAdmission: DataPlaneAdmission = { kind: "configured", keyId: "synthetic-key", source: "dedicated", contextPrincipalId: "principal-a" };
const bearerAdmission: DataPlaneAdmission = { kind: "configured", keyId: "synthetic-key", source: "bearer", contextPrincipalId: "principal-a" };
const admissionHeaders = { authorization: "Bearer ocx_data_test_admission" };

test("bearer-admitted context validates the body before selecting credentials", async () => {
  const response = await handleContextHistory(contextRequest("{}", admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("context.session_id");
  expect(selection).toBeUndefined();
});

test("stored ownership remains fixed across current Direct and Pool settings", async () => {
  let calls = 0;
  setFetch(async (_url, init) => {
    calls++;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only");
    return new Response("{}");
  });
  for (const mode of ["direct", "pool"]) {
    accountMode = mode;
    const response = await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}', admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
    expect(response.status).toBe(200);
    expect(selection?.mode).toBe("pool");
    expect(selection?.options.accountId).toBe("test-account");
    expect(selection?.options.admission).toEqual(bearerAdmission);
    expect(selection?.options.substituteMainCredentialForDirect).toBe(true);
    expect(materializationOptions?.admission).toEqual(bearerAdmission);
    expect(materializationOptions?.substituteMainCredential).toBe(true);
  }
  expect(calls).toBe(2);
});

test("proxy credentials cannot escape materialization or bypass non-bearer rejection", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return new Response("unexpected"); });
  outgoingBearer = "ocx_data_test_admission";
  const body = '{"context":{"session_id":"root"}}';
  const response = await handleContextHistory(contextRequest(body, admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
  expect(response.status).toBe(401);
  expect(materialized).toBeDefined();
  for (const admission of [undefined, { kind: "environment", source: "dedicated" } as const, { kind: "loopback", source: "loopback" } as const]) {
    selection = undefined;
    expect((await handleContextHistory(contextRequest(body, admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, admission)).status).toBe(401);
    expect(selection).toBeUndefined();
  }
  expect(calls).toBe(0);
});


test("missing usable stored credentials fail before upstream I/O in bearer mode", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return new Response("unexpected"); });
  for (const mode of ["direct", "pool"]) {
    accountMode = mode;
    materializationError = mode === "direct"
      ? new errors.CodexMainSubstitutionUnavailableError()
      : new errors.CodexPoolAuthenticationError();
    const response = await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}', admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission);
    expect(response.status).toBe(401);
    expect(materializationOptions?.substituteMainCredential).toBe(true);
  }
  expect(calls).toBe(0);
});


test("unknown, expired and conflicting owners fail before selecting or sending", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return new Response("unexpected"); });
  for (const state of ["unknown", "expired", "conflicting"]) {
    clearContextSessionOwnersForTests();
    if (state === "expired") seedOwner("root", "stored", "test-only", Date.now() - 25 * 60 * 60_000);
    if (state === "conflicting") { seedOwner("root"); seedOwner("root", "stored", "other-account"); }
    expect((await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}'), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(409);
    expect(selection).toBeUndefined();
  }
  expect(calls).toBe(0);
});

test("stored token refresh is accepted but physical account replacement is refused", async () => {
  let calls = 0;
  setFetch(async () => { calls++; return new Response("{}"); });
  // Same person, new token: that is what a refresh looks like, and it stays the same owner.
  clearContextSessionOwnersForTests();
  seedOwner("root", "stored", "test-only", undefined, userToken("user-a"));
  outgoingBearer = userToken("user-a");
  const body = '{"context":{"session_id":"root"}}';
  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(200);
  outgoingAccount = "replacement-account";
  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(409);
  expect(calls).toBe(1);
});

test("caller owner uses Direct request credentials and cannot authorize proxy-bearer substitution", async () => {
  clearContextSessionOwnersForTests(); seedOwner("root", "caller");
  let calls = 0;
  setFetch(async () => { calls++; return new Response("{}"); });
  const body = '{"context":{"session_id":"root"}}';
  expect((await handleContextHistory(contextRequest(body), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission)).status).toBe(200);
  expect(selection?.mode).toBe("direct");
  expect(selection?.options.requestScopedMainCredential).toBe(true);
  expect(selection?.options.accountId).toBeUndefined();
  expect(materializationOptions?.substituteMainCredential).toBe(false);
  selection = undefined;
  expect((await handleContextHistory(contextRequest(body, admissionHeaders), config, logContext(), "alpha/notes/v2/read_file", undefined, bearerAdmission)).status).toBe(409);
  expect(selection).toBeUndefined(); expect(calls).toBe(1);
});

test("a context root conflicting with protocol headers is rejected without selection", async () => {
  const response = await handleContextHistory(contextRequest('{"context":{"session_id":"root"}}', {
    authorization: "Bearer test", "session-id": "another-root",
  }), config, logContext(), "alpha/notes/v2/read_file", undefined, keyAdmission);
  expect(response.status).toBe(409); expect(selection).toBeUndefined();
});
