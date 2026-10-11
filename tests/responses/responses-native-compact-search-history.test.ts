import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponsesCompact } from "../../src/server/responses";
import { clearCompactHandoffRoutesForTests } from "../../src/server/responses/compact";
import { getDefaultConfig } from "../../src/config";
import { bridgeSearchReplayScope, clearBridgeSearchReplayCacheForTests, rememberBridgeSearchReplay } from "../../src/responses/bridge-search-replay-cache";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { removeTreeWithRetry } from "../helpers/remove-tree";
const fetchBefore = globalThis.fetch; const homeBefore = process.env.OPENCODEX_HOME;
let home: string; let release: (() => void) | undefined;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-native-compact-history-")); process.env.OPENCODEX_HOME = home; release = acquireOwnedSpendHome(); clearCompactHandoffRoutesForTests(); clearBridgeSearchReplayCacheForTests(); });
afterEach(() => { globalThis.fetch = fetchBefore; release?.(); clearCompactHandoffRoutesForTests(); clearBridgeSearchReplayCacheForTests(); if (homeBefore === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = homeBefore; removeTreeWithRetry(home); });
const source = { type: "url", url: "https://example.test/top-level", title: "Top-level reference", page_body: "must not become page text" };
const input = () => [
 { type: "message", role: "user", content: [{ type: "input_text", text: "retain ordinary history" }] },
 { type: "reasoning", content: null, summary: [{ type: "summary_text", text: "native summary" }], encrypted_content: "fresh-native-opaque" },
 { type: "web_search_call", id: "ws_native_or_bridge_unknown", status: "completed", action: { type: "search", query: "reference query" }, sources: [source] },
 { type: "function_call", call_id: "paired-call", name: "read_file", arguments: "{}" },
 { type: "function_call_output", call_id: "paired-call", output: "recorded result" },
];
async function compact(model: string, api = false) {
 const settings = getDefaultConfig(); delete settings.compactionRouting; settings.defaultProvider = "openai"; settings.providers = {
  openai: { adapter: "openai-responses", authMode: "forward", codexAccountMode: "direct", baseUrl: "https://chatgpt.com/backend-api/codex" },
  "openai-apikey": { adapter: "openai-responses", authMode: "key", apiKey: "fixture-key", baseUrl: "https://api.openai.com/v1" },
 };
 const raw = { model: api ? `openai-apikey/${model}` : model, input: input(), tools: [{ type: "web_search" }], tool_choice: "auto" }; const snapshot = JSON.stringify(raw);
 const calls: {url:string;body:Record<string,any>}[] = [];
 globalThis.fetch = (async (url, init) => { calls.push({url:String(url),body:JSON.parse(String(init?.body))}); return Response.json({output:[{type:"compaction",encrypted_content:"official-compact-opaque"}]}); }) as typeof fetch;
 const req = new Request("http://localhost/v1/responses/compact", {method:"POST",headers:{"content-type":"application/json","thread-id":"fixture-new-fork",authorization:`Bearer ${fakeChatGptJwt({chatgpt_account_id:"fixture-account"})}`},body:JSON.stringify(raw)});
 const response = await handleResponsesCompact(req, settings, {model:"",provider:""}); expect(response.status).toBe(200);
 const result=await response.json() as any; expect(result).toMatchObject({output:[{type:"compaction",encrypted_content:"official-compact-opaque"}]}); expect(result.output).toHaveLength(1); expect(JSON.stringify(raw)).toBe(snapshot); expect(calls).toHaveLength(1);
 return {raw,...calls[0]!};
}
test.each(["gpt-6.1-sol","gpt-6-luna","gpt-6-astra"])("Codex native compact %s retains structural hosted history, native ciphertext and official compact output",async model=>{
 const {raw,url,body}=await compact(model);expect(url).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
 expect(body.input.filter((x:any)=>x.type==="web_search_call")).toHaveLength(1);expect(body.input).toEqual(raw.input);
 expect(body.tools).toEqual(raw.tools);expect(body.tool_choice).toBe("auto");
});
test("public API native compact retains structural hosted calls",async()=>{
 const {raw,url,body}=await compact("gpt-6-luna",true);expect(url).toBe("https://api.openai.com/v1/responses/compact");expect(body.input.filter((x:any)=>x.type==="web_search_call")).toEqual(raw.input.filter(x=>x.type==="web_search_call"));
});
test("compact does not invent a replay scope or reuse another principal/model's bridged result",async()=>{
 const scope={clientPrincipalId:"other-principal",clientThreadId:"other-thread",current:{providerName:"openai",adapterName:"openai-responses",modelId:"gpt-6.1-sol",providerDestinationIdentity:"other-destination",credentialIdentity:"other-credential"}};
 rememberBridgeSearchReplay(bridgeSearchReplayScope(scope),"ws_native_or_bridge_unknown",{callId:"other-call",name:"read_file",argumentsText:"{}",output:"other-principal-private-result"});
 const {body}=await compact("gpt-6-astra");expect(JSON.stringify(body)).not.toContain("other-principal-private-result");expect(body.input.filter((x:any)=>x.type==="web_search_call")).toHaveLength(1);expect(body.input.filter((x:any)=>x.type==="function_call")).toHaveLength(1);
});
