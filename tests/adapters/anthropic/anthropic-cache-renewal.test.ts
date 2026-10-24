import { test, expect } from "bun:test";
import { Clock } from "../../helpers/anthropic-renewal-clock";
import { AnthropicCacheRenewal, cacheUsage, renewalBody, type RenewalWire, type CacheRuntimeState } from "../../../src/anthropic/cache-renewal";
import { applyRuntimePatches, projectCacheRuntime } from "../../../src/codex/cache-runtime-state";

const usage = { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
const naturalBody = JSON.stringify({ model: "claude-opus-5-5", stream: true, max_tokens: 8192,
  cache_control: { type: "ephemeral" }, thinking: { type: "adaptive" }, output_config: { effort: "max" },
  tools: [{ name: "fixture_tool", input_schema: { type: "object" } }],
  system: [{ type: "text", text: "Fixed system." }], messages: [{ role: "user", content: [
    { type: "text", text: "Continue the original task." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "offline-image-exact-bytes" } },
  ] }] });

function fixture() {
  const clock = new Clock();
  const watches = new Map<string, (state: CacheRuntimeState) => void>();
  let disposed = 0;
  const manager = new AnthropicCacheRenewal({ now: () => clock.now, later: clock.later, clear: clock.clear,
    watch: (thread, update) => { watches.set(thread, update); update({ running: true, turn: "turn-a" });
      return () => { disposed++; watches.delete(thread); }; } });
  const sent: any[] = [], results: any[] = [];
  let allowed = true;
  let send: RenewalWire["send"] = async (body, signal, dispatched) => {
    dispatched(); sent.push({ body: JSON.parse(body), at: clock.now, signal });
    return Response.json({ content: [], usage });
  };
  const wire = (identity = "account-a", body = naturalBody): RenewalWire => ({ identity, body, turnId: "request-turn-a", model: "claude-opus-5-5",
    allowed: () => allowed, send: (...args) => send(...args), record: event => results.push(event) });
  return { clock, watches, manager, sent, results, wire, setAllowed: (value: boolean) => { allowed = value; },
    setSend: (value: RenewalWire["send"]) => { send = value; }, disposed: () => disposed };
}

test("仅修改零输出字段，保持完整图片、工具和推理前缀", () => {
  const body = JSON.parse(renewalBody(naturalBody)!);
  expect(body).toEqual({ ...JSON.parse(naturalBody), stream: false, max_tokens: 0 });
});
for (const change of [
  { thinking: { type: "enabled", budget_tokens: 1024 } }, { output_config: { format: { type: "json_schema" } } },
  { tool_choice: { type: "any" } }, { tool_choice: { type: "tool", name: "fixture_tool" } }, { max_tokens: 0 },
  { cache_control: { type: "ephemeral", ttl: "1h" } }, { cache_control: undefined },
]) test(`不兼容请求不通过改写前缀强行续期 ${JSON.stringify(change)}`, () => {
  expect(renewalBody(JSON.stringify({ ...JSON.parse(naturalBody), ...change }))).toBeUndefined();
});

test("无用量、非法用量和零缓存不是命中证据", () => {
  for (const raw of [undefined, {}, { ...usage, cache_read_input_tokens: null }, { ...usage, output_tokens: -1 }]) expect(cacheUsage(raw)).toBeUndefined();
});

test("四分三十秒才续，成功后按发送时间重新计时", async () => {
  const f = fixture(); f.manager.begin("main", f.wire())(usage);
  await f.clock.advance(269999); expect(f.sent).toHaveLength(0);
  await f.clock.advance(270000); expect(f.sent).toHaveLength(1);
  await f.clock.advance(540000); expect(f.sent).toHaveLength(2);
  expect(f.sent.map(x => x.at)).toEqual([270000, 540000]); f.manager.close();
});

test("不兼容的新自然请求停止旧前缀续期", async () => {
  const f = fixture(); f.manager.begin("main", f.wire())(usage);
  f.manager.begin("main", f.wire("account-a", JSON.stringify({ ...JSON.parse(naturalBody), max_tokens: 0 })))(usage);
  await f.clock.advance(900000); expect(f.sent).toHaveLength(0); f.manager.close();
});

test("畸形空内容响应不能延长续期链", async () => {
  const f = fixture(); f.manager.begin("main", f.wire())(usage);
  f.setSend(async (_body, _signal, dispatched) => { dispatched(); return Response.json({ content: "", usage }); });
  await f.clock.advance(900000); expect(f.results).toHaveLength(1); expect(f.results[0].reason).toBe("unconfirmed"); f.manager.close();
});

test("首次写入也能建立缓存时钟", async () => {
  const f = fixture(); f.manager.begin("main", f.wire())({ ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 });
  await f.clock.advance(270000); expect(f.sent).toHaveLength(1); f.manager.close();
});

test("回答未结束也续期，不把确认到达时刻当起点", async () => {
  const f = fixture(); const confirm = f.manager.begin("main", f.wire());
  await f.clock.advance(120000); confirm(usage);
  await f.clock.advance(270000); expect(f.sent).toHaveLength(1); f.manager.close();
});

test("新自然请求尚未确认时仍维护旧前缀，确认后换新计时", async () => {
  const f = fixture(); f.manager.begin("main", f.wire())(usage);
  await f.clock.advance(260000); const confirm = f.manager.begin("main", f.wire());
  await f.clock.advance(270000); expect(f.sent).toHaveLength(1);
  await f.clock.advance(280000); confirm(usage);
  await f.clock.advance(529999); expect(f.sent).toHaveLength(1);
  await f.clock.advance(530000); expect(f.sent).toHaveLength(2); f.manager.close();
});

test("自然请求命中后取消旧计时器", async () => {
  const f = fixture(); f.manager.begin("main", f.wire())(usage);
  await f.clock.advance(200000); f.manager.begin("main", f.wire())(usage);
  await f.clock.advance(270000); expect(f.sent).toHaveLength(0);
  await f.clock.advance(470000); expect(f.sent).toHaveLength(1); f.manager.close();
});

test("超时后才出现的缓存确认不能触发冷写", async () => {
  const f = fixture(); const confirm = f.manager.begin("main", f.wire());
  await f.clock.advance(310000); confirm(usage);
  await f.clock.advance(900000); expect(f.sent).toHaveLength(0); f.manager.close();
});

for (const raw of [{ ...usage, cache_read_input_tokens: 0 }, {}]) test(`自然请求未缓存不启动续期 ${JSON.stringify(raw)}`, async () => {
  const f = fixture(); f.manager.begin("main", f.wire())(raw);
  await f.clock.advance(900000); expect(f.sent).toHaveLength(0); f.manager.close();
});

for (const state of [{ running: false, turn: "turn-a" }, { running: false, turn: null }])
  test(`任务结束、失联或新 turn 不继承旧计时 ${JSON.stringify(state)}`, async () => {
    const f = fixture(); f.manager.begin("main", f.wire())(usage); f.watches.get("main")!(state);
    await f.clock.advance(900000); expect(f.sent).toHaveLength(0); expect(f.disposed()).toBe(1); f.manager.close();
  });

test("真实active不依赖可选前端消息ID，请求新轮次清除旧快照及回调", async () => {
  const f = fixture(); const old = f.manager.begin("main", f.wire());
  f.watches.get("main")!({ running: true, turn: null }); old(usage);
  await f.clock.advance(270000); expect(f.sent).toHaveLength(1);
  const fresh = f.manager.begin("main", { ...f.wire(), turnId: "request-turn-b" });
  old(usage); await f.clock.advance(540000); expect(f.sent).toHaveLength(1);
  fresh(usage); f.manager.close();
  expect(projectCacheRuntime({ threadRuntimeStatus: { type: "active" } }).running).toBe(true);
});

test("自然用量早于首个IPC快照时，确认active后仍从原发送时间计时", async () => {
  const clock = new Clock(); let update!: (state: CacheRuntimeState) => void; let sends = 0;
  const manager = new AnthropicCacheRenewal({ now: () => clock.now, later: clock.later, clear: clock.clear,
    watch: (_thread, emit) => { update = emit; return () => {}; } });
  manager.begin("main", { turnId: "actual-turn", identity: "account", body: naturalBody, model: "claude-opus-5-5",
    allowed: () => true, record: () => {}, send: async (_body, _signal, dispatched) => {
      sends++; dispatched(); return Response.json({ content: [], usage });
    } })(usage);
  await clock.advance(1000); update({ running: true, turn: null });
  await clock.advance(269999); expect(sends).toBe(0);
  await clock.advance(270000); expect(sends).toBe(1); manager.close();
});

test("主与两个子代理按自身 ID 分开续期", async () => {
  const f = fixture(); for (const thread of ["main", "child-a", "child-b"]) f.manager.begin(thread, f.wire())(usage);
  f.watches.get("child-a")!({ running: false, turn: "turn-a" });
  await f.clock.advance(270000); expect(f.sent).toHaveLength(2); f.manager.close();
});

test("旧账号、旧自然请求的迟到确认不覆盖新快照", async () => {
  const f = fixture(); const old = f.manager.begin("main", f.wire());
  await f.clock.advance(100000); f.manager.begin("main", f.wire("account-b"))(usage); old(usage);
  await f.clock.advance(270000); expect(f.sent).toHaveLength(0);
  await f.clock.advance(370000); expect(f.sent).toHaveLength(1); f.manager.close();
});

test("缓存禁用或凭据失效后不再发送", async () => {
  const f = fixture(); f.manager.begin("main", f.wire())(usage); f.setAllowed(false);
  await f.clock.advance(900000); expect(f.sent).toHaveLength(0); f.manager.close();
});

for (const answer of [
  { content: [], usage: { ...usage, cache_creation_input_tokens: 1000 } },
  { content: [], usage: { ...usage, cache_read_input_tokens: 100 } },
  { content: [], usage: { ...usage, output_tokens: 1 } }, { content: [] },
  { content: [{ type: "tool_use", name: "fixture_tool", input: {} }], usage },
]) test(`部分命中、冷写或异常输出暂停收费循环 ${JSON.stringify(answer)}`, async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async (_body, _signal, dispatched) => { calls++; dispatched(); return Response.json(answer); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(1800000);
  expect(calls).toBe(1); expect(f.results).toHaveLength(1); f.manager.close();
});

test("明确 DNS 失败最多三次，只有一个重试预算", async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async () => { calls++; throw Object.assign(new Error("offline-dns"), { code: "ENOTFOUND" }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(900000);
  expect(calls).toBe(3); expect(f.results.every(x => x.sent === false)).toBe(true); f.manager.close();
});

for (const status of [400, 401, 403, 402, 500, 502, 504]) test(`错误不通过换账号或普通恢复链扩散 ${status}`, async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async (_body, _signal, dispatched) => { calls++; dispatched(); return Response.json({ error: { type: "fixture_error" } }, { status }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(900000); expect(calls).toBe(1); f.manager.close();
});

test("限流 Retry-After 在期限内可重试成功", async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async (_body, _signal, dispatched) => { calls++; dispatched(); return calls === 1
    ? Response.json({ error: { type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "1" } })
    : Response.json({ content: [], usage }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(271000);
  expect(calls).toBe(2); expect(f.results.at(-1).reason).toBe("hit"); f.manager.close();
});

for (const retry of ["40", "garbage"]) test(`Retry-After 不能突破原缓存期限 ${retry}`, async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async (_body, _signal, dispatched) => { calls++; dispatched(); return Response.json({ error: { type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": retry } }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(900000); expect(calls).toBe(1); f.manager.close();
});

test("额度耗尽的 429 不重试", async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async (_body, _signal, dispatched) => { calls++; dispatched(); return Response.json({ error: { type: "insufficient_quota" } }, { status: 429 }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(900000); expect(calls).toBe(1); f.manager.close();
});

test("发送后断线结果未知，不盲目再收费", async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async (_body, _signal, dispatched) => { calls++; dispatched(); throw Object.assign(new Error("offline-reset"), { code: "ECONNRESET" }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(900000);
  expect(calls).toBe(1); expect(f.results[0].reason).toBe("unknown"); f.manager.close();
});

test("等待超时结束本轮，不变成反复冷写", async () => {
  const f = fixture(); let calls = 0;
  f.setSend(async (_body, signal, dispatched) => { calls++; dispatched(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("offline-timeout")), { once: true })); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(900000);
  expect(calls).toBe(1); expect(f.results[0].reason).toBe("unknown"); f.manager.close();
});

test("停止在途续期不恢复旧任务计时", async () => {
  const f = fixture(); let finish!: (value: Response) => void;
  f.setSend(async (_body, _signal, dispatched) => { dispatched(); return new Promise(resolve => { finish = resolve; }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(270000);
  f.watches.get("main")!({ running: false, turn: "turn-a" });
  finish(Response.json({ content: [], usage })); await f.clock.advance(900000);
  expect(f.results).toHaveLength(1); expect(f.clock.jobs.size).toBe(0); f.manager.close();
});

test("IPC 只投影运行状态，不持有完整对话", () => {
  const state = { id: "main", threadRuntimeStatus: { type: "active", activeFlags: [] }, latestTurnStartMessageId: "turn-a" };
  expect(projectCacheRuntime(state)).toEqual({ running: true, turn: "turn-a" });
  const patched = applyRuntimePatches(state, [{ op: "replace", path: ["threadRuntimeStatus", "type"], value: "idle" },
    { op: "add", path: ["turns", 100], value: { text: "must-not-be-retained" } }]);
  expect(projectCacheRuntime(patched).running).toBe(false); expect(patched.turns).toBeUndefined();
  expect(() => applyRuntimePatches(state, [{ op: "add", path: ["threadRuntimeStatus", "__proto__"], value: {} }])).toThrow();
});

test("IPC 尚未确认缓存就失联，下一次自然请求可重新登记", async () => {
  const f = fixture(); const old = f.manager.begin("main", f.wire());
  f.watches.get("main")!({ running: false, turn: null }); old(usage);
  await f.clock.advance(100000); f.manager.begin("main", f.wire())(usage);
  await f.clock.advance(370000); expect(f.sent).toHaveLength(1); f.manager.close();
});

test("不响应取消的网络实现也不能挂住重试窗口", async () => {
  const f = fixture(); let finish!: (response: Response) => void;
  f.setSend(async (_body, _signal, dispatched) => { dispatched(); return new Promise(resolve => { finish = resolve; }); });
  f.manager.begin("main", f.wire())(usage); await f.clock.advance(300000);
  expect(f.results).toHaveLength(1); expect(f.results[0].reason).toBe("unknown");
  finish(Response.json({ content: [], usage })); await f.clock.advance(900000);
  expect(f.results).toHaveLength(1); expect(f.clock.jobs.size).toBe(0); f.manager.close();
});
