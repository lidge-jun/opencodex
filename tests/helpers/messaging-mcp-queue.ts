import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTestTempOwner } from "../../scripts/test-temp";
import { removeTreeWithRetry } from "./remove-tree";

export const QUEUE_MCP_TARGET = "00000000-0000-4000-8000-000000000002";
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
