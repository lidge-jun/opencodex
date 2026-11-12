import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseQueueMcpArgs } from "../../src/cli/message-mcp-command";
import { LOCAL_TARGET, localFixtureThread, localMessagingFixture, NO_REPLY } from "../helpers/messaging-local";
import { queueMcpFixture } from "../helpers/messaging-mcp-queue";
import { repoPath } from "../helpers/repo-root";

const base=["--codex","/fixture/codex","--codex-home","/fixture/home"];
test("resume grant and absolute socket must be supplied together exactly once",()=>{
  expect(parseQueueMcpArgs([...base,"--allow-resume","--resume-socket","/fixture/server.sock","--resume-permissions",":read-only"]))
    .toEqual({codex:"/fixture/codex",codexHome:"/fixture/home",allowResume:true,resumeSocket:"/fixture/server.sock",resumePermissions:":read-only"});
  for(const extra of [["--allow-resume"],["--resume-socket","/fixture/sock"],["--allow-resume","--resume-socket","relative"],
    ["--allow-resume","--allow-resume","--resume-socket","/a"],["--allow-resume","--resume-socket","/a","--resume-socket","/b"], ["--allow-resume","--resume-socket","/a"],
    ["--allow-resume","--resume-socket","/a","--resume-permissions",""],["--allow-resume","--resume-socket","/a","--resume-permissions","bad name"],
    ["--allow-resume","--resume-socket","/a","--resume-permissions", "x".repeat(129)]]) expect(parseQueueMcpArgs([...base,...extra])).toBeNull();
});

test("option values cannot grant resume access or conceal stray tokens",()=>{
  for(const grant of ["--allow-resume","--allow-reply-read"]){
    expect(parseQueueMcpArgs([...base,"--resume-socket","/fixture/sock","--resume-permissions",grant,":read-only"])).toBeNull();
    expect(parseQueueMcpArgs([...base,"--allow-resume","--resume-socket","/fixture/sock","--resume-permissions",grant,":read-only"])).toBeNull();
  }
});

test("standalone grants can follow values without reinterpreting literal profile IDs",()=>{
  for(const profile of ["--allow-resume","--allow-reply-read"]){
    expect(parseQueueMcpArgs(["--resume-permissions",profile,...base,"--resume-socket","/fixture/sock","--allow-resume"]))
      .toEqual({codex:"/fixture/codex",codexHome:"/fixture/home",allowResume:true,resumeSocket:"/fixture/sock",resumePermissions:profile});
  }
});

const result=(r:any)=>JSON.parse(r.content[0].text);
describe.skipIf(process.platform === "win32")("resume MCP CLI",()=>{
  test("explicit grant is inert on initialization, registers a separate tool and refuses unsafe resume on the selected server",async()=>{
    const q=queueMcpFixture();const f=localMessagingFixture(c=>c.method === "thread/read" ? {thread:{...localFixtureThread(),status:{type:"notLoaded"}}} : undefined,{allowResume:true});
    const client=new Client({name:"fixture",version:"1"});
    const transport=new StdioClientTransport({command:process.execPath,args:[repoPath("src/cli/index.ts"),"message","mcp","--codex",q.options.codex,"--codex-home",f.codexHome,"--allow-resume","--resume-socket",join(f.codexHome,"app-server-control/app-server-control.sock"),"--resume-permissions",":read-only"],stderr:"pipe"});
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(["codex_queue_message","codex_resume_thread","codex_threads"]);
      expect(f.calls).toEqual([]);expect(q.calls()).toEqual([]);
      expect(result(await client.callTool({name:"codex_resume_thread",arguments:{threadId:LOCAL_TARGET}}))).toMatchObject({status:"not_resumed",executionVerified:false,error:{code:"resume_atomicity_unsupported"}});
      expect(q.calls()).toEqual([]);expect(f.calls.filter(c=>c.method === "thread/resume")).toHaveLength(0);
      await client.callTool({name:"codex_resume_thread",arguments:{threadId:LOCAL_TARGET,permissions:":danger-full-access"}});
      expect(f.calls.some(c=>c.method === "thread/resume")).toBe(false);
    }finally{await client.close();await f.close();await q.close();}
  },15_000);

  test("same-thread overlap is refused; four distinct calls share admission and disconnect cleanup",async()=>{
    const q=queueMcpFixture();const f=localMessagingFixture(c=>c.method === "thread/read" ? {thread:{...localFixtureThread(String(c.params.threadId)),status:{type:"notLoaded"}}} : c.method === "configRequirements/read" ? NO_REPLY : undefined,{allowResume:true});
    const client=new Client({name:"fixture",version:"1"});
    const transport=new StdioClientTransport({command:process.execPath,args:[repoPath("src/cli/index.ts"),"message","mcp","--codex",q.options.codex,"--codex-home",f.codexHome,"--allow-reply-read","--allow-resume","--resume-socket",join(f.codexHome,"app-server-control/app-server-control.sock"),"--resume-permissions",":read-only"],stderr:"pipe"});
    const pending:Promise<unknown>[]=[];
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(expect.arrayContaining(["codex_queue_message","codex_read_reply","codex_resume_thread","codex_threads"]));
      pending.push(client.callTool({name:"codex_resume_thread",arguments:{threadId:LOCAL_TARGET}}).catch(e=>e));
      const until=performance.now()+5000;while(!f.calls.some(c=>c.method === "configRequirements/read")&&performance.now()<until)await Bun.sleep(10);
      expect(result(await client.callTool({name:"codex_resume_thread",arguments:{threadId:LOCAL_TARGET}}))).toMatchObject({status:"not_resumed",error:{code:"resume_busy"}});
      for(let i=3;i<=5;i++) pending.push(client.callTool({name:"codex_resume_thread",arguments:{threadId:`00000000-0000-4000-8000-00000000000${i}`}}).catch(e=>e));
      const end=performance.now()+5000;while(f.calls.filter(c=>c.method === "configRequirements/read").length<4&&performance.now()<end)await Bun.sleep(10);
      expect(f.calls.filter(c=>c.method === "configRequirements/read")).toHaveLength(4);
      const overlaps=await Promise.all(Array.from({length:8},()=>client.callTool({name:"codex_resume_thread",arguments:{threadId:LOCAL_TARGET}})));
      for(const overlap of overlaps){
        expect(overlap.isError).not.toBe(true);
        expect(result(overlap)).toMatchObject({status:"not_resumed",error:{code:"resume_busy"}});
      }
      expect(f.calls.filter(c=>c.method === "configRequirements/read")).toHaveLength(4);
      expect((await client.callTool({name:"codex_threads",arguments:{}})).isError).toBe(true);
      await client.close();await Promise.allSettled(pending);await Bun.sleep(50);
      expect(f.activeConnections).toBe(0);expect(q.calls()).toEqual([]);
    }finally{await client.close();await Promise.allSettled(pending);await f.close();await q.close();}
  },15_000);
});
