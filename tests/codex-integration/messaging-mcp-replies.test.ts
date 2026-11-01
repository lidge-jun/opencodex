import { describe, expect, spyOn, test } from "bun:test";
import { queueMcpRpc } from "../../src/messaging/mcp-queue-rpc";
import { queueMcpReadReply } from "../../src/messaging/mcp-reply-tools";
import { QUEUE_MCP_TARGET, REPLY_MCP_CLIENT, REPLY_MCP_TURN, queueMcpFixture } from "../helpers/messaging-mcp-queue";

const input = { threadId: QUEUE_MCP_TARGET, clientMessageId: REPLY_MCP_CLIENT };
const payload = (r: unknown) => r as Record<string, any>;

describe.skipIf(process.platform === "win32")("opt-in MCP stored turn replies", () => {
  test("disabled, malformed and cross-scope cursors allocate no helper", async () => {
    const f = queueMcpFixture("reply-success");
    try {
      expect((await queueMcpReadReply(f.options, input)).available).toBe(false);
      const options = { ...f.options, allowReplyRead: true };
      for (const raw of [{ ...input, threadId: "name" }, { ...input, clientMessageId: "bad" }, { ...input, cursor: "%%%" },
        { ...input, cursor: Buffer.from(JSON.stringify({v:1,stage:"search",...input,threadId:REPLY_MCP_TURN,nativeCursor:"next"})).toString("base64url") }]) {
        expect((await queueMcpReadReply(options, raw)).available).toBe(false);
      }
      expect((await queueMcpRpc(f.options,"thread/items/list",{})).status).toBe("not_sent");
      expect((await queueMcpRpc(options,"thread/resume" as never,{})).status).toBe("not_sent");
      expect(f.calls()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test("receipt match returns only bounded final text with non-exclusive turn association", async () => {
    const f = queueMcpFixture("reply-success");
    try {
      const r = payload(await queueMcpReadReply({ ...f.options, allowReplyRead: true }, input));
      expect(r).toMatchObject({ available:true,status:"observed",association:"same_turn_not_exclusive",turnId:REPLY_MCP_TURN,turnStatus:"completed",
        replies:[{itemId:"answer-1",text:"fixture answer",phase:"final_answer",truncated:false}],nextCursor:null });
      expect(JSON.stringify(r)).not.toContain("PRIVATE_");
      expect(f.calls().filter(c=>c.frame.method !== "initialize" && c.frame.method !== "initialized").map(c=>c.frame.method))
        .toEqual(["thread/items/list","thread/items/list","thread/turns/list"]);
      for (const c of f.calls()) expect(JSON.stringify(c.argv)).not.toContain(REPLY_MCP_CLIENT);
    } finally { await f.close(); }
  });

  test("caller-owned search cursor continues across helper processes", async () => {
    const f = queueMcpFixture("reply-search-pages");
    try {
      const options = { ...f.options, allowReplyRead: true };
      const first = payload(await queueMcpReadReply(options,input));
      expect(first).toMatchObject({available:true,status:"not_observed",reachedHistoryEnd:false,replies:[]});
      expect(first.nextCursor).toBeString();
      const next = payload(await queueMcpReadReply(options,{...input,cursor:first.nextCursor}));
      expect(next.status).toBe("observed"); expect(next.replies[0].text).toBe("fixture answer");
      expect(new Set(f.calls().map(c=>c.pid)).size).toBe(4);
    } finally { await f.close(); }
  });

  test("reply continuation revalidates the user item before returning the next page", async () => {
    const f = queueMcpFixture("reply-paged");
    try {
      const options = { ...f.options, allowReplyRead: true };
      const first = payload(await queueMcpReadReply(options,input));
      expect(first.replies).toEqual([]); expect(first.nextCursor).toBeString();
      const next = payload(await queueMcpReadReply(options,{...input,cursor:first.nextCursor}));
      expect(next.replies[0].itemId).toBe("answer-1"); expect(next.nextCursor).toBeNull();
      expect(f.calls().filter(c=>c.frame.method === "thread/items/read")).toHaveLength(1);
    } finally { await f.close(); }
  });

  test("refresh revisits a partially written item instead of dropping its later final text", async () => {
    const f = queueMcpFixture("reply-refresh");
    try {
      const options = { ...f.options, allowReplyRead: true };
      const first = payload(await queueMcpReadReply(options,input));
      expect(first.replies).toEqual([]);
      const refreshed = payload(await queueMcpReadReply(options,{...input,cursor:first.refreshCursor}));
      expect(refreshed.replies).toMatchObject([{itemId:"answer-1",text:"fixture answer"}]);
    } finally { await f.close(); }
  });

  test("stale or forged position data must revalidate its input before projecting text", async () => {
    const f = queueMcpFixture("reply-stale");
    try {
      const options = { ...f.options, allowReplyRead: true };
      const first = payload(await queueMcpReadReply(options,input));
      const r = payload(await queueMcpReadReply(options,{...input,cursor:first.nextCursor}));
      expect(r).toEqual({available:false,error:{code:"reply_stale_match"}});
      const cursor = Buffer.from(JSON.stringify({v:1,stage:"replies",...input,turnId:REPLY_MCP_TURN,userItemId:"forged",nativeCursor:null})).toString("base64url");
      expect((await queueMcpReadReply(options,{...input,cursor})).available).toBe(false);
      expect(f.calls().filter(c=>c.frame.method === "thread/items/list" && c.frame.params?.turnId)).toHaveLength(1);
    } finally { await f.close(); }
  });

  for (const mode of ["reply-none","reply-null","reply-missing-client"]) test(`${mode}: absence within history is not non-delivery`,async()=>{
    const f=queueMcpFixture(mode);
    try { expect(await queueMcpReadReply({...f.options,allowReplyRead:true},input)).toMatchObject({available:true,status:"not_observed",reachedHistoryEnd:true,replies:[]}); }
    finally {await f.close();}
  });

  test("unrelated messages without clientId do not hide a matching receipt or its final text",async()=>{
    const f=queueMcpFixture("reply-unrelated-missing-client");
    try {expect(await queueMcpReadReply({...f.options,allowReplyRead:true},input)).toMatchObject({available:true,status:"observed",replies:[{itemId:"answer-1",text:"fixture answer"}]});}
    finally {await f.close();}
  });

  for (const mode of ["reply-reject","reply-wrong-turn","reply-invalid-client","reply-too-many","reply-bad-turns"]) test(`${mode}: unavailable without private diagnostics`,async()=>{
    const f=queueMcpFixture(mode);
    try { const r=await queueMcpReadReply({...f.options,allowReplyRead:true},input);expect(r.available).toBe(false);expect(JSON.stringify(r)).not.toContain("PRIVATE_"); }
    finally {await f.close();}
  });

  test("duplicate correlation is ambiguous rather than a guessed reply",async()=>{
    const f=queueMcpFixture("reply-ambiguous");
    try {expect(await queueMcpReadReply({...f.options,allowReplyRead:true},input)).toEqual({available:true,status:"ambiguous",replies:[]});}
    finally {await f.close();}
  });

  test("a repeated native cursor cannot create a history paging loop",async()=>{
    const f=queueMcpFixture("reply-cycle");
    try {const opts={...f.options,allowReplyRead:true};const first=payload(await queueMcpReadReply(opts,input));expect((await queueMcpReadReply(opts,{...input,cursor:first.nextCursor})).available).toBe(false);}
    finally {await f.close();}
  });

  test("running turn without final text is an observed input, not completed work",async()=>{
    const f=queueMcpFixture("reply-running");
    try {expect(await queueMcpReadReply({...f.options,allowReplyRead:true},input)).toMatchObject({status:"observed",turnStatus:"inProgress",replies:[]});}
    finally {await f.close();}
  });

  test("long UTF-8 replies have explicit truncation without broken codepoints",async()=>{
    const f=queueMcpFixture("reply-long");
    try {const r=payload(await queueMcpReadReply({...f.options,allowReplyRead:true},input));expect(r.replies[0].truncated).toBe(true);expect(Buffer.byteLength(r.replies[0].text)).toBeLessThanOrEqual(16384);expect(r.replies[0].text).not.toContain("\ufffd");expect(r.replies.reduce((n:number,x:{text:string})=>n+Buffer.byteLength(x.text),0)).toBeLessThanOrEqual(16384);expect(r.replies[1].truncated).toBe(true);}
    finally {await f.close();}
  });

  for (const [mode,status] of [["reply-failed","failed"],["reply-interrupted","interrupted"],["reply-old-turn","unverified"]]) test(`${mode}: status observation never certifies completed work`,async()=>{
    const f=queueMcpFixture(mode);
    try {expect(await queueMcpReadReply({...f.options,allowReplyRead:true},input)).toMatchObject({status:"observed",turnStatus:status,association:"same_turn_not_exclusive"});}
    finally {await f.close();}
  });

  test("unknown phase is not silently promoted to a final answer",async()=>{
    const f=queueMcpFixture("reply-unknown-phase");
    try {expect(await queueMcpReadReply({...f.options,allowReplyRead:true},input)).toMatchObject({status:"observed",replies:[]});}
    finally {await f.close();}
  });

  test("shared-turn final text can precede a later input and is not certified as its exclusive reply",async()=>{
    const f=queueMcpFixture("reply-earlier-final");
    try {const r=payload(await queueMcpReadReply({...f.options,allowReplyRead:true},input));expect(r.association).toBe("same_turn_not_exclusive");expect(r.replies.map((x:{text:string})=>x.text)).toEqual(["earlier fixture answer","fixture answer"]);}
    finally {await f.close();}
  });

  test("one outer deadline cancels sequential helpers instead of granting each a new full budget",async()=>{
    const f=queueMcpFixture("reply-delay");const native=setTimeout;let shortened=false;
    const timer=spyOn(globalThis,"setTimeout").mockImplementation(((fn,ms,...args)=>{
      if(ms===20000&&!shortened){shortened=true;return native(fn,650,...args);}return native(fn,ms,...args);
    }) as typeof setTimeout);
    try {expect((await queueMcpReadReply({...f.options,allowReplyRead:true},input)).available).toBe(false);expect(f.calls().filter(c=>c.frame.method === "thread/turns/list")).toHaveLength(0);}
    finally {timer.mockRestore();await f.close();}
  });

  test("cancelled reads reap their helper and do not retry or mutate the queue",async()=>{
    const f=queueMcpFixture("hang");const abort=new AbortController();
    try {
      const pending=queueMcpReadReply({...f.options,allowReplyRead:true},input,abort.signal);
      const until=performance.now()+3000;while(!f.calls().some(c=>c.frame.method === "thread/items/list")&&performance.now()<until)await Bun.sleep(10);
      expect(f.calls().at(-1)?.frame.method).toBe("thread/items/list");const pid=f.calls().at(-1)!.pid;abort.abort();
      expect((await pending).available).toBe(false);expect(()=>process.kill(pid,0)).toThrow();
      expect(f.calls().filter(c=>c.frame.method === "thread/items/list")).toHaveLength(1);
    }finally{abort.abort();await f.close();}
  });
});
