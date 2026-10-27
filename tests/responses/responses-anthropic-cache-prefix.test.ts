import { test, expect } from "bun:test";
import { repoRoot } from "../helpers/repo-root";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
const root = repoRoot();
const cache = await import(`${root}/src/anthropic/cache-renewal.ts`);
const { createResponsesEffects } = await import(`${root}/src/server/responses/response-effects.ts`);
const { guardCompactionSummary } = await import(`${root}/src/responses/compaction-summary.ts`);
const { createTranslatorBudget } = await import(`${root}/src/lib/translator-budget.ts`);
const observations = await import(`${root}/src/lib/anthropic-cache-observation.ts`);
const retain = cache.retainCachePrefix;
test("an optional cache observer failure never breaks a natural response", () => {
  const response = new Response("natural answer");
  let calls = 0;
  observations.attachCacheObservation(response, () => { calls++; throw new Error("synthetic observer failure"); });
  const wrapped = observations.inheritCacheObservation(response, new Response("natural answer"));
  expect(() => observations.observeAnthropicCacheUsage(wrapped, {})).not.toThrow();
  expect(calls).toBe(1);
});
const cc = { type: "ephemeral" };
const wire = (body: any, identity = "one", turnId = "turn") => ({ identity, turnId, model: "claude",
  body: JSON.stringify(body), allowed: () => true, send: async () => { throw new Error("must-not-send"); }, record() {} });
const before = () => ({ model: "claude", max_tokens: 100, stream: true, cache_control: cc,
  tools: [{ name: "read", input_schema: { type: "object" }, cache_control: cc }],
  system: [{ type: "text", text: "stable system", cache_control: cc }],
  messages: [{ role: "user", content: [{ type: "text", text: "old user", cache_control: cc }] },
    { role: "assistant", content: [{ type: "text", text: "old assistant" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "old result" }] }] });
const append = (base = before()) => {
  const next = structuredClone(base) as any;
  for (const message of next.messages) if (Array.isArray(message.content)) for (const block of message.content) delete block.cache_control;
  for (let i = 0; i < 22; i++) next.messages.push({ role: "user", content: `notification ${i}` });
  const point = next.messages.length - 2;
  next.messages[point].content = [{ type: "text", text: next.messages[point].content, cache_control: cc }];
  return next;
};
const strip = (value: any) => JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item);

test("追加22通知后仍保留已确认旧尾断点，工具正文和新通知不变", () => {
  const a = before(), b = append(a), old = wire(a), current = wire(b);
  const changed = JSON.parse(retain(old, current));
  expect(changed.messages[a.messages.length - 1].content.at(-1).cache_control).toEqual(cc);
  expect(strip(changed)).toEqual(strip(b));
  const points: any[] = [];
  JSON.stringify(changed, (key, item) => { if (key === "cache_control") points.push(item); return item; });
  expect(points.length).toBe(4);
  expect(changed.messages.slice(a.messages.length).length).toBe(22);
  expect(changed.messages[changed.messages.length - 2].content[0].cache_control).toBeUndefined();
});
test("字符串和单text块的缓存标记移动不误报正文改变，真实改变仍识别", () => {
  const a = before() as any, b = append(a);
  b.messages[0].content = "old user";
  expect(cache.compareCachePrefix(wire(a), wire(b), 100, 20).firstChangedMessage).toBeNull();
  b.messages[0].content = "actually changed";
  expect(cache.compareCachePrefix(wire(a), wire(b), 100, 20).firstChangedMessage).toBe(0);
  expect(retain(wire(a), wire(b))).toBe(wire(b).body);
});
test("历史图片与签名思考逐字保留，追加新图只移动缓存标记", () => {
  const a = before() as any;
  a.messages[1].content.unshift({ type: "thinking", thinking: "old thought", signature: "old signed bytes" });
  a.messages[2].content = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "old-image-exact-bytes" } }];
  const b = append(a);
  b.messages.push({ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "new-image-exact-bytes" } }] });
  // 重建标准倒数第二用户断点。
  for (const message of b.messages) if (Array.isArray(message.content)) for (const block of message.content) delete block.cache_control;
  b.messages[b.messages.length - 2].content = [{ type: "text", text: "notification 21", cache_control: cc }];
  const fixed = JSON.parse(retain(wire(a), wire(b)));
  expect(strip(fixed)).toBe(strip(b));
  expect(fixed.messages[2].content[0].source.data).toBe("old-image-exact-bytes");
  expect(fixed.messages.at(-1).content[0].source.data).toBe("new-image-exact-bytes");
  expect(fixed.messages[1].content[0].signature).toBe("old signed bytes");
});
test("不在thinking块添加标记，不把已有合法请求扩大到32MB以上", () => {
  const a = before() as any;
  a.messages.at(-1).content = [{ type: "thinking", thinking: "old", signature: "signature" }];
  const b = wire(append(a));
  expect(retain(wire(a), b)).toBe(b.body);
  a.messages.at(-1).content = "old string";
  const large = append(a);
  large.messages.at(-1).content += "x".repeat(32000000 - Buffer.byteLength(JSON.stringify(large)) - 1);
  const current = wire(large);
  expect(Buffer.byteLength(current.body)).toBe(31999999);
  expect(retain(wire(a), current)).toBe(current.body);
});
for (const kind of ["credential", "system", "tools", "model-option", "compacted", "long-ttl", "no-automatic", "external-point", "full-breakpoints"]) {
  test(`不覆盖不兼容或外部断点：${kind}`, () => {
    const a = before() as any, b = append(a);
    let newIdentity = "one";
    if (kind === "credential") newIdentity = "another-account";
    if (kind === "system") b.system[0].text = "changed";
    if (kind === "tools") b.tools[0].name = "changed";
    if (kind === "model-option") b.thinking = { type: "adaptive" };
    if (kind === "compacted") b.messages = [{ role: "user", content: "summary" }];
    if (kind === "long-ttl") { a.cache_control = { ...cc, ttl: "1h" }; b.cache_control = a.cache_control; }
    if (kind === "no-automatic") { delete a.cache_control; delete b.cache_control; }
    if (kind === "external-point") b.messages[1].content[0].cache_control = cc;
    if (kind === "full-breakpoints") { a.tools.push({ ...a.tools[0], name: "extra" }); b.tools.push({ ...b.tools[0], name: "extra" }); }
    const current = wire(b, newIdentity);
    expect(retain(wire(a), current)).toBe(current.body);
  });
}
test("只消费同自身线程、同轮次、未过期的已确认快照；结束后释放", () => {
  let now = 0, notify: any;
  const manager = new cache.AnthropicCacheRenewal({ now: () => now, later: () => 1, clear() {},
    watch(_thread: string, update: any, turn: string) { notify = update; update({ running: true, turn }); return () => {}; } });
  const a = wire(before()), b = wire(append());
  const prepare = (thread: string, current = b) => manager.prepare ? manager.prepare(thread, current) : current.body;
  expect(prepare("main")).toBe(b.body);
  manager.begin("main", a)({ input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 });
  expect(prepare("main")).not.toBe(b.body);
  expect(prepare("child")).toBe(b.body);
  expect(prepare("main", { ...b, allowed: () => false })).toBe(b.body);
  expect(prepare("main", { ...b, turnId: "other-turn" })).toBe(b.body);
  now = 300000;
  expect(prepare("main")).toBe(b.body);
  now = 100;
  notify({ running: false, turn: "turn" });
  expect(prepare("main")).toBe(b.body);
  manager.close();
});

test("compaction preserves client tool and system cache prefixes without changing tool choice", () => {
  const parsed: any = { options: { toolChoice: "auto" }, context: {
    tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    systemPrompt: ["stable system"], messages: [],
  }, _rawBody: { input: [] } };
  const original = structuredClone(parsed);
  createResponsesEffects({ options: {}, req: new Request("http://localhost/v1/responses"), config: {} } as any,
    {} as any, { parsed, route: { provider: { adapter: "anthropic" } } } as any,
    { routedCompaction: true, preserveCompactionPrefix: true });
  expect(parsed.context.tools).toEqual(original.context.tools);
  expect(parsed.context.systemPrompt).toEqual(original.context.systemPrompt);
  expect(parsed.options.toolChoice).toBe("auto");
  expect(parsed.context.messages.at(-1).content).toContain("Do not call tools");
});

test("compaction explicitly prohibits hosted server tools while retaining their declarations", async () => {
  const parsed: any = { options: { toolChoice: "auto" }, context: { tools: [], messages: [] },
    _anthropicServerTools: [{ type: "web_search_20250305", name: "web_search" }] };
  createResponsesEffects({ options: {}, req: new Request("http://localhost/v1/responses"), config: {} } as any,
    {} as any, { parsed, route: { provider: { adapter: "anthropic" } } } as any,
    { routedCompaction: true, preserveCompactionPrefix: true });
  expect(parsed.options.toolChoice).toBe("auto");
  expect(parsed._anthropicServerTools).toHaveLength(1);
  parsed.modelId = "claude-sonnet-4-6";
  parsed.context.messages.unshift({ role: "user", content: "earlier turn", timestamp: 1 });
  const adapter = withTestTranslatorBudget(createAnthropicAdapter({ adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "synthetic-test-key" }, "short"));
  const wire = JSON.parse((await adapter.buildRequest(parsed)).body as string);
  expect(wire.tools).toContainEqual(expect.objectContaining({ type: "web_search_20250305", name: "web_search" }));
  expect(wire.tool_choice).toEqual({ type: "none" });
});

for (const kind of ["text", "tool", "empty", "abnormal", "missing-stop"] as const) {
  test(`summary guard admits only a normally completed tool-free summary: ${kind}`, async () => {
    const budget = createTranslatorBudget();
    async function* events(): AsyncGenerator<any> {
      if (kind === "tool") yield { type: "tool_call_start", id: "synthetic-call", name: "read" };
      if (kind !== "empty") yield { type: "text_delta", text: "summary" };
      yield { type: "done", stopReason: kind === "missing-stop" ? undefined : kind === "abnormal" ? "unexpected_stop" : "end_turn", endTurn: true };
    }
    try {
      const output = [];
      for await (const event of guardCompactionSummary(events(), budget)) output.push(event);
      expect(output.some(event => event.type === "tool_call_start")).toBe(false);
      if (kind === "text" || kind === "missing-stop") expect(output.at(-1)?.type).toBe("done");
      else expect(output.at(-1)).toMatchObject({ type: "error", code: "compaction_invalid_summary" });
    } finally { budget.dispose(); }
  });
}
