import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { buildMuseCaptureCatalog, museClientToolInstructions } from "../../src/adapters/muse-msp/catalog";
import { createMuseCaptureServer } from "../../src/adapters/muse-msp/capture-server";
import { buildWebSearchTool } from "../../src/web-search/synthetic-tool";
import { museToolCallEvents } from "../../src/adapters/muse-msp/events";
import { museContinuation, museHistoryDigest } from "../../src/adapters/muse-msp/history";
import { buildResponseJSON } from "../../src/bridge/response-json";

describe("Muse compatibility with Codex tools", () => {
  test("maps wait, user input and namespaced MCP tools back to their original client names", () => {
    const parsed=parseRequest({model:"test",input:[{role:"user",content:"hello"}]});
    parsed.context.tools=[
      {name:"wait",description:"Wait for a running operation",parameters:{type:"object",properties:{cell_id:{type:"string"}}}},
      {name:"request_user_input",description:"Ask for input",parameters:{type:"object",properties:{questions:{type:"array"}}}},
      {name:"read_fixture",namespace:"mcp__isolated_probe",description:"Read a fixture",parameters:{type:"object",properties:{}}},
    ];
    const catalog=buildMuseCaptureCatalog(parsed);
    expect(catalog.tools).toHaveLength(3);
    for (let i=0;i<3;i++) {
      const original=parsed.context.tools[i]!;
      const capture=`mcp__opencodex__${catalog.tools[i]!.name}`;
      expect(catalog.approvalTools.get(capture)).toMatchObject({name:original.name,...(original.namespace ? {namespace:original.namespace} : {})});
    }
  });
  test("preserves long tool descriptions and admits synthetic hosted search", async () => {
    const parsed=parseRequest({model:"test",input:[{role:"user",content:"hello"}]});
    const description="x".repeat(30*1024);
    parsed.context.tools=[{name:"exec",description,parameters:{type:"object",properties:{input:{type:"string"}},required:["input"]},freeform:true},buildWebSearchTool()];
    const catalog=buildMuseCaptureCatalog(parsed);
    expect(catalog.tools).toHaveLength(2);
    expect(catalog.tools[0]!.name).toBe("exec");
    expect(catalog.approvalTools.get("mcp__opencodex__exec")).toMatchObject({name:"exec",freeform:true});
    expect(museClientToolInstructions(catalog.approvalTools)).toContain("mcp__opencodex__exec");
    expect(catalog.tools[0]!.description.endsWith(description)).toBe(true);
    expect(catalog.approvalTools.get(`mcp__opencodex__${catalog.tools[1]!.name}`)).toEqual({name:"web_search"});
    const server=createMuseCaptureServer(catalog.tools,async()=>"unused");await server.close();
    expect(museToolCallEvents({clientCallId:`msp_${"a".repeat(48)}`,name:"web_search",arguments:'{"query":"test"}'})[0]).toMatchObject({type:"tool_call_start",name:"web_search"});
  });
  test("retains bounded catalog and unsupported tool contracts", () => {
    const parsed=parseRequest({model:"test",input:[{role:"user",content:"hello"}]});
    parsed.context.tools=[{name:"exec",description:"x".repeat(256*1024+1),parameters:{type:"object"}}];
    expect(()=>buildMuseCaptureCatalog(parsed)).toThrow("invalid_capture_catalog");
    parsed.context.tools=[{name:"image",description:"",parameters:{type:"object"},imageGeneration:true}];
    expect(()=>buildMuseCaptureCatalog(parsed)).toThrow("unsupported_capture_tool");
  });
  test("accepts sidecar replay that omits commentary phase without weakening content checks", () => {
    const make=(phase?:"commentary"|"final_answer")=>({messages:[{role:"assistant" as const,
      content:[{type:"text" as const,text:"searching"}],timestamp:0,...(phase?{phase}: {})}]});
    const digest=(phase?:"commentary"|"final_answer")=>museHistoryDigest(make(phase),"web_search",{query:"example"});
    expect(digest("commentary")).toBe(digest());
    expect(digest("final_answer")).not.toBe(digest());
    expect(museHistoryDigest(make(),"web_search",{query:"different"})).not.toBe(digest());
  });
  test("returns failed sidecar searches to Muse while rejecting other error results", () => {
    const context = (name: string) => ({ messages: [
      { role: "assistant" as const, content: [{ type: "toolCall" as const, id: "call", name, arguments: { query: "fixture" } }], timestamp: 0 },
      { role: "toolResult" as const, toolCallId: "call", toolName: name, content: "Search failed: fixture", isError: true, timestamp: 0 },
    ] });
    expect(museContinuation(context("web_search"))).toMatchObject({ clientCallId: "call", output: "Search failed: fixture" });
    expect(() => museContinuation(context("other"))).toThrow("invalid_continuation");
  });
  test("keeps Codex tool discovery as a tool_search_call", () => {
    const parsed=parseRequest({model:"test",input:[{role:"user",content:"hello"}],tools:[{type:"tool_search",execution:"client",description:"find tools",parameters:{type:"object",properties:{query:{type:"string"}}}}]});
    const catalog=buildMuseCaptureCatalog(parsed);
    expect(catalog.tools).toHaveLength(1);
    const events=museToolCallEvents({clientCallId:`msp_${"b".repeat(48)}`,name:"tool_search",arguments:'{"query":"fixture"}'});
    const response=buildResponseJSON([...events,{type:"done"}],"test",{toolSearchToolNames:new Set(["tool_search"])});
    expect(response.output).toContainEqual(expect.objectContaining({type:"tool_search_call"}));
    const call=(response.output as Array<Record<string,unknown>>).find(item=>item.type==="tool_search_call")!;
    const continued=parseRequest({model:"test",input:[{role:"user",content:"hello"},call,{type:"tool_search_output",call_id:call.call_id,execution:"client",status:"completed",tools:[]}],tools:[{type:"tool_search",execution:"client",description:"find tools",parameters:{type:"object",properties:{query:{type:"string"}}}}]});
    expect(museContinuation(continued.context)).toMatchObject({clientCallId:call.call_id});
  });
});
