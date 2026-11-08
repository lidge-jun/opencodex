import { describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MessageBudget } from "../../src/messaging/budget";
import { LocalMessageRpc } from "../../src/messaging/rpc";
import { queueMcpResume } from "../../src/messaging/mcp-resume-tools";
import { LOCAL_TARGET, LOCAL_OTHER, localFixtureThread, localMessagingFixture, LocalFixtureRpcError, NO_REPLY } from "../helpers/messaging-local";

const input = { threadId: LOCAL_TARGET };
const options = (f: ReturnType<typeof localMessagingFixture>) => ({ codex:"/unused",codexHome:f.codexHome,allowResume:true,resumePermissions:":read-only",resumeSocket:join(f.codexHome,"app-server-control/app-server-control.sock") });
const unloaded = () => ({thread:{...localFixtureThread(),status:{type:"notLoaded"}}});

describe.skipIf(process.platform === "win32")("explicit existing-server MCP resume",()=>{
  test("disabled and invalid requests connect to nothing",async()=>{
    const f=localMessagingFixture();
    try {
      expect(await queueMcpResume({...options(f),allowResume:false},input)).toMatchObject({status:"not_resumed",error:{code:"resume_disabled"}});
      for(const raw of [{threadId:"name"},{...input,permission:"bypass"}]) expect(await queueMcpResume(options(f),raw)).toMatchObject({status:"not_resumed",error:{code:"resume_invalid_input"}});
      expect((await queueMcpResume({...options(f),codexHome:"relative"},input)).status).toBe("not_resumed");
      expect((await queueMcpResume({...options(f),resumePermissions:undefined},input)).status).toBe("not_resumed");
      expect(f.calls).toEqual([]);
    }finally{await f.close();}
  });

  test("same-home notLoaded target is resumed once with pinned permissions and no messages or private output",async()=>{
    const f=localMessagingFixture(c=> c.method === "thread/read" ? unloaded() : c.method === "thread/resume" ? {thread:localFixtureThread(),activePermissionProfile:{id:":read-only"}} : undefined,{allowResume:true});
    try {
      const r=await queueMcpResume(options(f),input);
      expect(r).toEqual({status:"resumed",threadId:LOCAL_TARGET,observedStatus:"idle",permissionProfileId:":read-only",executionVerified:false});
      expect(f.calls.map(c=>c.method)).toEqual(["initialize","initialized","thread/read","configRequirements/read","permissionProfile/list","thread/resume"]);
      expect(f.calls.at(-2)!.params).toEqual({cwd:localFixtureThread().cwd,limit:50,cursor:null});
      expect(f.calls.at(-1)!.params).toEqual({threadId:LOCAL_TARGET,excludeTurns:true,permissions:":read-only"});
      expect(JSON.stringify(r)).not.toContain("must not be exposed");expect(f.failures).toEqual([]);
    }finally{await f.close();}
  });

  test("uppercase UUIDs use canonical lowercase lookup and resume",async()=>{
    const id="abcdefab-cdef-4abc-8def-abcdefabcdef";
    const f=localMessagingFixture(c=>c.method === "thread/read" ? {thread:{...localFixtureThread(id),status:{type:"notLoaded"}}} : c.method === "thread/resume" ? {thread:localFixtureThread(id),activePermissionProfile:{id:":read-only"}} : undefined,{allowResume:true});
    try {
      expect(await queueMcpResume(options(f),{threadId:id.toUpperCase()})).toMatchObject({status:"resumed",threadId:id});
      expect(f.calls.filter(c=>c.method === "thread/read"||c.method === "thread/resume").map(c=>c.params.threadId)).toEqual([id,id]);
    }finally{await f.close();}
  });

  for(const state of ["idle","active","systemError"]) test(`${state} does not trigger a resume`,async()=>{
    const f=localMessagingFixture(c=> c.method === "thread/read" ? {thread:{...localFixtureThread(),status:{type:state}}} : undefined);
    try {const r=await queueMcpResume(options(f),input);expect(r.status).toBe(state === "systemError" ? "not_resumed" : "already_loaded");expect(f.calls.some(c=>c.method === "thread/resume")).toBe(false);}
    finally{await f.close();}
  });

  test("default local/remote RPC connections cannot resume",async()=>{
    const f=localMessagingFixture();const budget=new MessageBudget();const rpc=await LocalMessageRpc.connect(f.url,budget);
    try {expect(await rpc.resumeThread(LOCAL_TARGET,":read-only")).toMatchObject({status:"not_resumed",error:{code:"resume_disabled"}});expect(f.calls.some(c=>c.method === "thread/resume")).toBe(false);}
    finally{rpc.close();budget.dispose();await f.close();}
  });

  test("a different or unreported server home refuses before thread lookup",async()=>{
    const f=localMessagingFixture();
    try {expect(await queueMcpResume({...options(f),codexHome:f.root},input)).toMatchObject({status:"not_resumed",error:{code:"resume_home_mismatch"}});expect(f.calls.some(c=>c.method.startsWith("thread/"))).toBe(false);}
    finally{await f.close();}
    const missing=localMessagingFixture(c=>c.method === "initialize" ? {userAgent:"older"} : undefined);
    try {expect((await queueMcpResume(options(missing),input)).status).toBe("not_resumed");expect(missing.calls.some(c=>c.method.startsWith("thread/"))).toBe(false);}
    finally{await missing.close();}
    const rel=localMessagingFixture(c=>c.method === "initialize" ? {userAgent:"malformed",codexHome:relative(process.cwd(),rel.codexHome)} : undefined);
    try {expect((await queueMcpResume(options(rel),input)).status).toBe("not_resumed");expect(rel.calls.some(c=>c.method.startsWith("thread/"))).toBe(false);}
    finally{await rel.close();}
  });

  test("canonical home aliases work, while a reported file is not a home",async()=>{
    const f=localMessagingFixture();const alias=join(f.root,"alias");symlinkSync(f.codexHome,alias);
    try {expect((await queueMcpResume({...options(f),codexHome:alias},input)).status).toBe("already_loaded");}
    finally{await f.close();}
    const bad=localMessagingFixture(c=>c.method === "initialize" ? {userAgent:"fixture",codexHome:join(bad.root,"file")} : undefined);
    writeFileSync(join(bad.root,"file"),"");
    try {expect((await queueMcpResume({...options(bad),codexHome:join(bad.root,"file")},input)).status).toBe("not_resumed");expect(bad.calls.some(c=>c.method.startsWith("thread/"))).toBe(false);}
    finally{await bad.close();}
  });

  for(const [label,reply] of [
    ["missing",{data:[],nextCursor:null}],
    ["disallowed",{data:[{id:":read-only",allowed:false}],nextCursor:null}],
    ["malformed",{data:[{id:":read-only",allowed:"yes"}],nextCursor:null}],
    ["duplicate",{data:[{id:":read-only",allowed:true},{id:":read-only",allowed:true}],nextCursor:null}],
    ["outside page",{data:[],nextCursor:"next"}],
  ] as const) test(`${label} permission profile refuses before resume`,async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "permissionProfile/list" ? reply : undefined,{allowResume:true});
    try {expect((await queueMcpResume(options(f),input)).status).toBe("not_resumed");expect(f.calls.some(c=>c.method === "thread/resume")).toBe(false);}
    finally{await f.close();}
  });

  for(const requirements of [undefined,{}, {requirements:{allowedPermissionProfiles:{":read-only":true}}}]) test(`unverifiable or managed policy refuses without native resume`,async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "configRequirements/read" ? (requirements ?? new LocalFixtureRpcError(-32601,"PRIVATE")) : undefined,{allowResume:true});
    try {expect((await queueMcpResume(options(f),input)).status).toBe("not_resumed");expect(f.calls.some(c=>c.method === "permissionProfile/list"||c.method === "thread/resume")).toBe(false);}
    finally{await f.close();}
  });

  test("unsupported catalog API refuses before resume",async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "permissionProfile/list" ? new LocalFixtureRpcError(-32601,"PRIVATE") : undefined,{allowResume:true});
    try {const r=await queueMcpResume(options(f),input);expect(r.status).toBe("not_resumed");expect(JSON.stringify(r)).not.toContain("PRIVATE");expect(f.calls.some(c=>c.method === "thread/resume")).toBe(false);}
    finally{await f.close();}
  });

  test("missing or relative target cwd refuses before permission reads",async()=>{
    for(const cwd of [undefined,"relative"]){
      const f=localMessagingFixture(c=>c.method === "thread/read" ? {thread:{...unloaded().thread,cwd}} : undefined,{allowResume:true});
      try {expect((await queueMcpResume(options(f),input)).status).toBe("not_resumed");expect(f.calls.some(c=>c.method === "configRequirements/read"||c.method === "thread/resume")).toBe(false);}
      finally{await f.close();}
    }
  });

  test("a profile removed after its catalog check cannot be retried as an inherited default",async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "thread/resume" ? new LocalFixtureRpcError(-32602,"removed profile") : undefined,{allowResume:true});
    try {expect((await queueMcpResume(options(f),input)).status).toBe("unknown");expect(f.calls.filter(c=>c.method === "thread/resume").map(c=>c.params)).toEqual([{threadId:LOCAL_TARGET,excludeTurns:true,permissions:":read-only"}]);}
    finally{await f.close();}
  });

  test("a different acknowledged profile is unknown, never resumed",async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "thread/resume" ? {thread:localFixtureThread(),activePermissionProfile:{id:":danger-full-access"}} : undefined,{allowResume:true});
    try {expect(await queueMcpResume(options(f),input)).toMatchObject({status:"unknown",error:{code:"resume_profile_mismatch"}});}
    finally{await f.close();}
  });

  test("server rejection after a resume write remains unknown, not replayed or disclosed",async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "thread/resume" ? new LocalFixtureRpcError(-32601,"PRIVATE_ERROR") : undefined,{allowResume:true});
    try {const r=await queueMcpResume(options(f),input);expect(r).toMatchObject({status:"unknown",error:{code:"resume_rejected"}});expect(JSON.stringify(r)).not.toContain("PRIVATE");expect(f.calls.filter(c=>c.method === "thread/resume")).toHaveLength(1);}
    finally{await f.close();}
  });

  test("wrong-thread acknowledgement is unknown without retry",async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "thread/resume" ? {thread:localFixtureThread(LOCAL_OTHER)} : undefined,{allowResume:true});
    try {expect((await queueMcpResume(options(f),input)).status).toBe("unknown");expect(f.calls.filter(c=>c.method === "thread/resume")).toHaveLength(1);}
    finally{await f.close();}
  });

  test("cancellation after writing resume is unknown and closes the connection",async()=>{
    const f=localMessagingFixture(c=>c.method === "thread/read" ? unloaded() : c.method === "thread/resume" ? NO_REPLY : undefined,{allowResume:true});const abort=new AbortController();
    try {
      const pending=queueMcpResume(options(f),input,abort.signal);
      const until=performance.now()+3000;while(!f.calls.some(c=>c.method === "thread/resume")&&performance.now()<until)await Bun.sleep(10);
      expect(f.calls.filter(c=>c.method === "thread/resume")).toHaveLength(1);abort.abort();
      expect((await pending).status).toBe("unknown");await Bun.sleep(20);expect(f.activeConnections).toBe(0);
    }finally{abort.abort();await f.close();}
  });

  test("approval requests are never answered or interpreted as execution permission",async()=>{
    const f=localMessagingFixture(c=>{
      if(c.method === "thread/read") return unloaded();
      if(c.method === "thread/resume") {f.broadcast(JSON.stringify({id:999,method:"item/commandExecution/requestApproval",params:{}}));return NO_REPLY;}
    },{allowResume:true});
    try {expect((await queueMcpResume(options(f),input)).status).toBe("unknown");expect(f.calls.map(c=>c.method)).toEqual(["initialize","initialized","thread/read","configRequirements/read","permissionProfile/list","thread/resume"]);}
    finally{await f.close();}
  });

  test("pre-cancellation and missing/socket-network paths start no server",async()=>{
    const f=localMessagingFixture();const abort=new AbortController();abort.abort();
    try {
      expect((await queueMcpResume(options(f),input,abort.signal)).status).toBe("not_resumed");
      for(const socket of [join(f.root,"absent.sock"),"wss://example.invalid/","/tmp/no:socket"]) expect((await queueMcpResume({...options(f),resumeSocket:socket},input)).status).toBe("not_resumed");
      expect(f.calls).toEqual([]);
    }finally{await f.close();}
  });
});
