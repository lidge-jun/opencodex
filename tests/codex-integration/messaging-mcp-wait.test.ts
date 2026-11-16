import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueMcpWaitReply } from "../../src/messaging/mcp-reply-wait";
import { QUEUE_MCP_TARGET, REPLY_MCP_CLIENT, queueMcpFixture } from "../helpers/messaging-mcp-queue";

const input = { threadId: QUEUE_MCP_TARGET, clientMessageId: REPLY_MCP_CLIENT };
const payload = (value: unknown) => value as Record<string, any>;
const methods = (f: ReturnType<typeof queueMcpFixture>) => f.calls().filter(c => !["initialize", "initialized"].includes(c.frame.method));

describe.skipIf(process.platform === "win32")("bounded stored reply waiting", () => {
  test("disabled, invalid budgets and invalid cursors start no helper", async () => {
    const f = queueMcpFixture("reply-success");
    try {
      expect((await queueMcpWaitReply(f.options,input)).available).toBe(false);
      for (const waitMs of [0,-1,20_001,1.5,NaN]) expect((await queueMcpWaitReply({...f.options,allowReplyRead:true},{...input,waitMs})).available).toBe(false);
      expect((await queueMcpWaitReply({...f.options,allowReplyRead:true},{...input,cursor:"%%%"})).available).toBe(false);
      expect(f.calls()).toHaveLength(0);
    } finally { await f.close(); }
  });

  test("existing final text returns immediately without requiring a new reply", async () => {
    const f = queueMcpFixture("reply-success");
    try {
      const r=payload(await queueMcpWaitReply({...f.options,allowReplyRead:true},input));
      expect(r).toMatchObject({available:true,waitOutcome:"reply_observed",attempts:1,association:"same_turn_not_exclusive",replies:[{text:"fixture answer"}]});
      expect(r.lastObservationAgeMs).toBeGreaterThanOrEqual(0);
      expect(methods(f)).toHaveLength(3); expect(JSON.stringify(r)).not.toContain("PRIVATE_");
    } finally { await f.close(); }
  });

  test("observation age includes time spent reading later metadata", async () => {
    const f = queueMcpFixture("reply-slow-metadata");
    try {
      const result = payload(await queueMcpWaitReply({ ...f.options, allowReplyRead: true }, input));
      expect(result).toMatchObject({ available: true, waitOutcome: "reply_observed" });
      expect(result.lastObservationAgeMs).toBeGreaterThanOrEqual(1_200);
    } finally { await f.close(); }
  }, 10_000);

  for (const mode of ["reply-refresh","reply-wait-terminal"]) test(`${mode}: stored terminal status does not hide a late final item`,async()=>{
    const f=queueMcpFixture(mode);
    try {
      const r=payload(await queueMcpWaitReply({...f.options,allowReplyRead:true},input));
      expect(r).toMatchObject({available:true,waitOutcome:"reply_observed",attempts:2,replies:[{itemId:"answer-1",text:"fixture answer"}]});
      expect(f.calls().filter(c=>c.frame.method === "thread/items/read")).toHaveLength(1);
      const reads=f.calls().filter(c=>c.frame.method === "thread/items/list"&&c.frame.params?.turnId);
      expect(reads).toHaveLength(2);expect(reads[1]!.frame.params?.cursor).toBeNull();
      expect(methods(f).every(c=>["thread/items/list","thread/items/read","thread/turns/list"].includes(c.frame.method))).toBe(true);
    } finally {await f.close();}
  },15_000);

  test("a not-yet-stored input is searched again within the bounded wait",async()=>{
    const f=queueMcpFixture("reply-wait-late-input");
    try {expect(await queueMcpWaitReply({...f.options,allowReplyRead:true},input)).toMatchObject({available:true,waitOutcome:"reply_observed",attempts:2});}
    finally {await f.close();}
  },15_000);

  for(const mode of ["reply-search-pages","reply-paged"]) test(`${mode}: returns the next page instead of silently scanning or waiting`,async()=>{
    const f=queueMcpFixture(mode);
    try {
      const r=payload(await queueMcpWaitReply({...f.options,allowReplyRead:true},input));
      expect(r).toMatchObject({available:true,waitOutcome:"needs_pagination",attempts:1,replies:[]});expect(r.nextCursor).toBeString();
    } finally {await f.close();}
  });

  test("three snapshots exhaust the attempt limit even when the time budget remains",async()=>{
    const f=queueMcpFixture("reply-wait-empty");
    try {
      const r=payload(await queueMcpWaitReply({...f.options,allowReplyRead:true},input));
      expect(r).toMatchObject({available:true,waitOutcome:"wait_exhausted",attempts:3,replies:[]});
      expect(methods(f)).toHaveLength(9);expect(r.refreshCursor).toBeString();
    } finally {await f.close();}
  },15_000);

  test("deadline during the pause returns the aged last observation without another helper",async()=>{
    const f=queueMcpFixture("reply-wait-empty");
    try {
      const r=payload(await queueMcpWaitReply({...f.options,allowReplyRead:true},{...input,waitMs:1_500}));
      expect(r).toMatchObject({available:true,waitOutcome:"wait_exhausted",attempts:1});
      expect(r.lastObservationAgeMs).toBeGreaterThan(0);expect(methods(f)).toHaveLength(3);
      await Bun.sleep(30);expect(methods(f)).toHaveLength(3);
    } finally {await f.close();}
  });

  test("timeout before any snapshot is unavailable and reaps its helper",async()=>{
    const f=queueMcpFixture("hang");
    try {
      expect(await queueMcpWaitReply({...f.options,allowReplyRead:true},{...input,waitMs:700})).toEqual({available:false,error:{code:"reply_wait_timeout"}});
      for(const pid of new Set(f.calls().map(c=>c.pid))) expect(()=>process.kill(pid,0)).toThrow();
    } finally {await f.close();}
  });

  test("a read rejection after a successful snapshot remains unavailable",async()=>{
    const f=queueMcpFixture("reply-wait-failure");
    try {
      const r=await queueMcpWaitReply({...f.options,allowReplyRead:true},input);
      expect(r).toMatchObject({available:false,error:{code:"reply_read_unavailable"}});expect(JSON.stringify(r)).not.toContain("PRIVATE_");
    } finally {await f.close();}
  },15_000);

  test("a read rejection observed before the deadline survives delayed helper shutdown", async () => {
    const f = queueMcpFixture("reply-reject-delayed-close");
    try {
      const waitMs = 6_000;
      writeFileSync(join(f.root, "deadline"), String(Date.now() + waitMs));
      const result = await queueMcpWaitReply({ ...f.options, allowReplyRead: true }, { ...input, waitMs });
      expect(methods(f)).toHaveLength(1);
      expect(result).toEqual({ available: false, error: { code: "reply_read_unavailable" } });
    } finally { await f.close(); }
  }, 15_000);

  for (const mode of ["reply-wait-timely-close", "reply-wait-timely-close-later"]) test(`${mode}: a timely complete snapshot survives cleanup after the deadline`, async () => {
    const f = queueMcpFixture(mode);
    try {
      const waitMs = 6_000;
      writeFileSync(join(f.root, "deadline"), String(Date.now() + waitMs));
      const result = payload(await queueMcpWaitReply({ ...f.options, allowReplyRead: true }, { ...input, waitMs }));
      expect(result).toMatchObject({ available: true, waitOutcome: "reply_observed",
        attempts: mode === "reply-wait-timely-close" ? 1 : 2, replies: [{ itemId: "answer-1", text: "fixture answer" }] });
      expect(result.lastObservationAgeMs).toBeGreaterThanOrEqual(0);
    } finally { await f.close(); }
  }, 20_000);

  test("a first snapshot completed after the deadline never authorizes success", async () => {
    const f = queueMcpFixture("reply-wait-late-frame");
    try {
      const waitMs = 4_000;
      writeFileSync(join(f.root, "deadline"), String(Date.now() + waitMs));
      expect(await queueMcpWaitReply({ ...f.options, allowReplyRead: true }, { ...input, waitMs }))
        .toEqual({ available: false, error: { code: "reply_wait_timeout" } });
    } finally { await f.close(); }
  }, 20_000);

  test("a stale timely snapshot does not authorize a later snapshot completed after the deadline", async () => {
    const f = queueMcpFixture("reply-wait-late-frame-later");
    try {
      const waitMs = 6_000;
      writeFileSync(join(f.root, "deadline"), String(Date.now() + waitMs));
      const result = payload(await queueMcpWaitReply({ ...f.options, allowReplyRead: true }, { ...input, waitMs }));
      expect(result).toMatchObject({ available: true, waitOutcome: "wait_exhausted", attempts: 2, status: "observed", replies: [] });
      expect(JSON.stringify(result)).not.toContain("fixture answer");
      expect(f.calls().filter(c => c.frame.method === "thread/turns/list")).toHaveLength(2);
    } finally { await f.close(); }
  }, 20_000);

  test("a malformed later snapshot stays unavailable when helper shutdown crosses the deadline", async () => {
    const f = queueMcpFixture("reply-wait-malformed-delayed");
    try {
      const waitMs = 8_000;
      writeFileSync(join(f.root, "deadline"), String(Date.now() + waitMs));
      const result = await queueMcpWaitReply({ ...f.options, allowReplyRead: true }, { ...input, waitMs });
      expect(f.calls().some(call => call.frame.method === "thread/items/read")).toBe(true);
      expect(result).toEqual({ available: false, error: { code: "reply_read_unavailable" } });
    } finally { await f.close(); }
  }, 15_000);

  test("parent cancellation wins after a read rejection during helper shutdown", async () => {
    const f = queueMcpFixture("reply-reject-delayed-close"), abort = new AbortController();
    try {
      const waitMs = 6_000, marker = join(f.root, "outcome-sent");
      writeFileSync(join(f.root, "deadline"), String(Date.now() + waitMs));
      const pending = queueMcpWaitReply({ ...f.options, allowReplyRead: true }, { ...input, waitMs }, abort.signal);
      const until = performance.now() + waitMs;
      while (!existsSync(marker) && performance.now() < until) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      abort.abort();
      expect(await pending).toEqual({ available: false, error: { code: "reply_wait_cancelled" } });
    } finally { abort.abort(); await f.close(); }
  }, 15_000);

  test("a later hanging snapshot inherits the original deadline and preserves the aged observation",async()=>{
    const f=queueMcpFixture("reply-wait-hang-second");
    try {
      const started=performance.now();
      const r=payload(await queueMcpWaitReply({...f.options,allowReplyRead:true},{...input,waitMs:4_000}));
      expect(r).toMatchObject({available:true,waitOutcome:"wait_exhausted",attempts:2,replies:[]});
      expect(performance.now()-started).toBeLessThan(6_000);expect(r.lastObservationAgeMs).toBeGreaterThan(2_000);
      for(const pid of new Set(f.calls().map(c=>c.pid))) expect(()=>process.kill(pid,0)).toThrow();
    } finally {await f.close();}
  },10_000);

  test("ambiguous matches return immediately with no final text",async()=>{
    const f=queueMcpFixture("reply-ambiguous");
    try {expect(await queueMcpWaitReply({...f.options,allowReplyRead:true},input)).toMatchObject({available:true,waitOutcome:"ambiguous",attempts:1,replies:[]});expect(methods(f)).toHaveLength(1);}
    finally {await f.close();}
  });

  test("parent cancellation during the pause prevents later helpers",async()=>{
    const f=queueMcpFixture("reply-wait-empty"), abort=new AbortController();
    try {
      const result=queueMcpWaitReply({...f.options,allowReplyRead:true},input,abort.signal);
      const until=performance.now()+4_000;
      while(!f.calls().some(c=>c.frame.method === "thread/turns/list") && performance.now()<until) await Bun.sleep(10);
      expect(f.calls().some(c=>c.frame.method === "thread/turns/list")).toBe(true);
      await Bun.sleep(100);abort.abort();
      expect(await result).toEqual({available:false,error:{code:"reply_wait_cancelled"}});
      expect(methods(f)).toHaveLength(3);
    } finally {abort.abort();await f.close();}
  });
});
