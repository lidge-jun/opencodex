import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestTempOwner } from "../../scripts/test-temp";
import { removeTreeWithRetry } from "./remove-tree";

export const QUEUE_MCP_TARGET = "00000000-0000-4000-8000-000000000002";
export const REPLY_MCP_CLIENT = "00000000-0000-4000-8000-000000000003";
export const REPLY_MCP_TURN = "00000000-0000-4000-8000-000000000004";
export interface QueueMcpCall { frame: { method: string; params?: Record<string, unknown> }; argv: string[]; sender?: string; home: string; pid: number }

/** Offline native CLI with one fixed failure mode, private capture and no user credentials. */
export function queueMcpFixture(mode = "success") {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-queue-mcp-"));
  writeTestTempOwner(root);
  const home = join(root, "home"), capture = join(root, "capture.jsonl"), codex = join(root, "codex");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(capture, "", { mode: 0o600 });
  writeFileSync(codex, `#!${process.execPath}
const fs = require("node:fs");
const rl = require("node:readline").createInterface({input:process.stdin});
const mode = ${JSON.stringify(mode)};
const emit = value => process.stdout.write(JSON.stringify(value)+"\\n");
const emitAtDeadlineOffsetAndDelayClose = (value, offsetMs) => {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
  const deadline = Number(fs.readFileSync(${JSON.stringify(join(root, "deadline"))}, "utf8"));
  setTimeout(() => {
    emit(value);
    fs.writeFileSync(${JSON.stringify(join(root, "outcome-sent"))}, "sent");
  }, Math.max(0, deadline - Date.now() + offsetMs));
};
const emitBeforeDeadlineAndDelayClose = value => emitAtDeadlineOffsetAndDelayClose(value, -450);
rl.on("line", line => {
  const f = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({frame:f,argv:process.argv.slice(2),sender:process.env.CODEX_THREAD_ID,home:process.env.CODEX_HOME,pid:process.pid})+"\\n");
  if(f.method === "initialize") return emit(mode === "init-reject" ? {id:1,error:{code:-32600,message:"PRIVATE_NATIVE_ERROR"}} : {id:1,result:{userAgent:"fixture"}});
  if(f.id !== 2) return;
  if(mode === "hang") return;
  if(mode === "disconnect") return process.exit(0);
  if(mode === "oversize") return process.stdout.write("x".repeat(1048577));
  if(mode === "bad-json") return process.stdout.write("bad\\n");
  if(mode === "bad-utf8") return process.stdout.write(Buffer.from([255,10]));
  if(mode === "bad-error") return emit({id:2,error:{message:"PRIVATE_NATIVE_ERROR"}});
  if(mode === "missing-error-message") return emit({id:2,error:{code:-32602}});
  if(mode === "mixed-error-result") return emit({id:2,error:{code:-32602,message:"private"},result:{}});
  if(mode === "reject") return emit({id:2,error:{code:-32602,message:"PRIVATE_NATIVE_ERROR"}});
  if(mode === "reply-reject-delayed-close") {
    return emitBeforeDeadlineAndDelayClose({id:2,error:{code:-32601,message:"PRIVATE_READ_FAILURE"}});
  }
  if(mode.startsWith("reply-") && ["thread/items/list","thread/items/read","thread/turns/list"].includes(f.method)) {
    const turnId = ${JSON.stringify(REPLY_MCP_TURN)};
    const user = {turnId,item:{type:"userMessage",id:"user-1",clientId:${JSON.stringify(REPLY_MCP_CLIENT)},content:[{type:"text",text:"PRIVATE_USER"}]}};
    const final = {turnId,item:{type:"agentMessage",id:"answer-1",phase:"final_answer",text:mode === "reply-long" ? "가".repeat(6000) : "fixture answer",memoryCitation:"PRIVATE_CITATION"}};
    const later = {turnId,item:{type:"userMessage",id:"other-user",clientId:null,content:[{type:"text",text:"PRIVATE_OTHER_USER"}]}};
    const commentary = {turnId,item:{type:"agentMessage",id:"commentary",phase:"commentary",text:"PRIVATE_COMMENTARY"}};
    const tool = {turnId,item:{type:"commandExecution",id:"tool-1",aggregatedOutput:"PRIVATE_TOOL"}};
    if(f.method === "thread/items/read") {
      if(mode === "reply-wait-malformed-delayed") return emitBeforeDeadlineAndDelayClose({id:2,result:{data:[null]}});
      if(mode === "reply-stale") user.item.clientId="another-client";
      return emit({id:2,result:{data:[user]}});
    }
    if(f.method === "thread/turns/list") {
      const turnsCalls = fs.readFileSync(${JSON.stringify(capture)},"utf8").trim().split("\\n").map(x=>JSON.parse(x)).filter(x=>x.frame.method === "thread/turns/list").length;
      const response = {id:2,result:{data:mode === "reply-old-turn" ? [] : [{id:turnId,status:mode === "reply-bad-turns" ? "done" : mode === "reply-running" ? "inProgress" : mode === "reply-failed" ? "failed" : ["reply-interrupted","reply-wait-terminal"].includes(mode) ? "interrupted" : "completed",items:[]}],nextCursor:null}};
      if(mode === "reply-wait-timely-close") return emitBeforeDeadlineAndDelayClose(response);
      if(mode === "reply-wait-timely-close-later" && turnsCalls >= 2) return emitBeforeDeadlineAndDelayClose(response);
      if(mode === "reply-wait-late-frame") return emitAtDeadlineOffsetAndDelayClose(response, 150);
      if(mode === "reply-wait-late-frame-later" && turnsCalls >= 2) return emitAtDeadlineOffsetAndDelayClose(response, 150);
      if(mode === "reply-slow-metadata") return setTimeout(() => emit(response), 1200);
      return emit(response);
    }
    if(mode === "reply-reject") return emit({id:2,error:{code:-32601,message:"PRIVATE_SERVER"}});
    const searching = !f.params.turnId;
    let data = searching ? [final,user] : [user,commentary,tool,later,final], nextCursor=null;
    if(searching && mode === "reply-none") data=[];
    if(searching && mode === "reply-null") user.item.clientId=null;
    if(searching && mode === "reply-missing-client") delete user.item.clientId;
    if(mode === "reply-unrelated-missing-client") {delete later.item.clientId;if(searching) data.unshift(later);}
    if(mode === "reply-invalid-client") {later.item.clientId=42;if(searching) data.unshift(later);}
    if(searching && mode === "reply-ambiguous") data=[user,{...user,item:{...user.item,id:"user-2"}}];
    if(searching && mode === "reply-search-pages" && !f.params.cursor) {data=[later];nextCursor="search-next";}
    if(searching && mode === "reply-cycle") {data=[];nextCursor="cycle";}
    if(searching && mode === "reply-too-many") data=Array.from({length:51},(_,i)=>({...user,item:{...user.item,id:"user-"+i}}));
    if(!searching && mode === "reply-wrong-turn") final.turnId="00000000-0000-4000-8000-000000000099";
    if(!searching && mode === "reply-paged" && !f.params.cursor) {data=[user,tool];nextCursor="reply-next";}
    if(!searching && mode === "reply-paged" && f.params.cursor) data=[final];
    if(!searching && mode === "reply-stale") {data=[user];nextCursor="reply-next";}
    if(!searching && mode === "reply-running") data=[user,commentary];
    if(!searching && mode === "reply-unknown-phase") final.item.phase=null;
    if(mode === "reply-missing-phase") delete final.item.phase;
    if(mode === "reply-unrelated-missing-phase") {delete commentary.item.phase;if(searching) data.unshift(commentary);}
    if(mode === "reply-invalid-phase") final.item.phase="unsupported";
    if(mode === "reply-invalid-text") final.item.text=42;
    if(!searching && mode === "reply-long") data.push({...final,item:{...final.item,id:"answer-2",text:"second"}});
    if(!searching && mode === "reply-earlier-final") data.unshift({...final,item:{...final.item,id:"earlier-answer",text:"earlier fixture answer"}});
    if(!searching && mode === "reply-refresh") {
      if(f.params.cursor != null) return emit({id:2,result:{data:[],nextCursor:null}});
      const calls=fs.readFileSync(${JSON.stringify(capture)},"utf8").trim().split("\\n").map(x=>JSON.parse(x));
      const reads=calls.filter(x=>x.frame.method === "thread/items/list" && x.frame.params.turnId).length;
      if(reads<2) {final.item.phase="partial_answer";final.item.text="PRIVATE_PARTIAL";}
    }
    if(mode.startsWith("reply-wait-")) {
      const calls=fs.readFileSync(${JSON.stringify(capture)},"utf8").trim().split("\\n").map(x=>JSON.parse(x));
      const reads=calls.filter(x=>x.frame.method === "thread/items/list" && x.frame.params.turnId).length;
      if(!searching && mode === "reply-wait-timely-close-later" && reads<2) {final.item.phase="partial_answer";final.item.text="PRIVATE_PARTIAL";}
      if(searching && mode === "reply-wait-late-input" && calls.filter(x=>x.frame.method === "thread/items/list").length===1) data=[];
      const earlyComplete = ["reply-wait-late-input","reply-wait-timely-close","reply-wait-late-frame"].includes(mode);
      if(!searching && (mode === "reply-wait-empty" || (!earlyComplete && reads<2))) data=[user,commentary];
      if(!searching && mode === "reply-wait-failure" && reads>=2) return emit({id:2,error:{code:-32601,message:"PRIVATE_READ_FAILURE"}});
      if(!searching && mode === "reply-wait-hang-second" && reads>=2) return;
    }
    if(!searching && mode === "reply-deadline-barrier") return;
    return emit({id:2,result:{data,nextCursor}});
  }
  if(f.method === "thread/list") {
    const result = {data:[{id:${JSON.stringify(QUEUE_MCP_TARGET)},name:"fixture",preview:"PRIVATE_PREVIEW",cwd:"PRIVATE_CWD",turns:["PRIVATE_TURN"]}],nextCursor:"next-page"};
    if(mode === "bad-list") result.data[0].id="not-a-uuid";
    if(mode === "bad-cursor") result.nextCursor="x".repeat(8193);
    return emit({id:2,result});
  }
  if(f.method !== "thread/queue/add") return emit({id:2,error:{code:-32601,message:"unexpected lifecycle RPC"}});
  emit({id:mode === "wrong-id" ? 99 : 2,result:{queuedSubmission:{id:"fixture-submission",clientUserMessageId:mode === "wrong-correlation" ? "wrong" : f.params.clientUserMessageId,input:mode === "missing-receipt-input" ? undefined : f.params.input}}});
});
`, { mode: 0o700 });
  chmodSync(codex, 0o700);
  return { root, options: { codex, codexHome: home }, calls: (): QueueMcpCall[] => readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    close: () => removeTreeWithRetry(root) };
}
