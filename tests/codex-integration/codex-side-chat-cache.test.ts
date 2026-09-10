import { describe, expect, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { SideChatCache, SIDE_CHAT_RULES, SIDE_CHAT_BOUNDARY, completeSideChatCache, prepareSideChatCache } from "../../src/codex/side-chat-cache";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { codexWsReuseIdentity } from "../../src/server/responses/codex-ws-pool";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
import { splitExecCacheReference } from "../../src/codex/exec-cache-reference";

const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const history = [message("developer", "Parent developer rules"), message("user", "Parent question")];
const boundary = message("user", SIDE_CHAT_BOUNDARY);
const headers = (thread = "parent", parent?: string) => ({
  authorization: "Bearer fixture-credential", "chatgpt-account-id": "fixture-account", "session-id": thread, "thread-id": thread,
  "x-client-request-id": `request-${thread}`,
  ...(parent ? { "x-codex-turn-metadata": JSON.stringify({ forked_from_thread_id: parent, session_id: thread, turn_id: `turn-${thread}` }) } : {}),
});
const body = (thread = "parent", input = history) => ({
  model: "gpt-5.6-luna", instructions: "Base instructions", input, tools: [], reasoning: { effort: "low" }, stream: true,
  store: false, prompt_cache_key: thread, client_metadata: { session_id: thread, thread_id: thread, turn_id: `turn-${thread}` },
});
const side = (thread = "child") => body(thread, [message("developer", `Parent developer rules\n\n${SIDE_CHAT_RULES}`), history[1]!, message("assistant", "Parent answer"), boundary, message("user", "Child question")]);
function seeded(cache = new SideChatCache()) { cache.prepare(body(), headers()).complete(); return cache; }

const methodSection = (name: string, description = "Method contract") => `### \`${name}\`\n${description}\n\ndeclare const tools: { ${name}(args: {}): Promise<unknown>; };\n\n`;
const execDescription = (sideChat: boolean) => "Run JavaScript code to orchestrate/compose tool calls\nALL_TOOLS\nShared MCP Types\n\n"
  + methodSection("apply_patch") + (sideChat ? "" : methodSection("create_goal") + methodSection("request_permissions")) + methodSection("exec_command")
  + (sideChat ? "" : "## clock\nClock methods\n\n" + methodSection("clock__curr_time"))
  + "## mcp__codex_app\nApp methods\n\n" + (sideChat ? methodSection("mcp__codex_app__fire_confetti") : "") + methodSection("mcp__codex_app__read_thread");
const execCatalog = (description: string) => ({ type: "additional_tools", role: "developer", tools: [{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", description, format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] }] });

describe("side-chat cache lineage", () => {
  test("splits only known Desktop context methods, including an emptied namespace", () => {
    const parent = splitExecCacheReference(execDescription(false))!;
    const child = splitExecCacheReference(execDescription(true))!;
    expect(parent.stable).toBe(child.stable);
    expect(parent.dynamic).toContain("create_goal"); expect(parent.dynamic).toContain("## clock");
    expect(parent.dynamic).toContain("request_permissions");
    expect(child.dynamic).toContain("fire_confetti"); expect(child.dynamic).not.toContain("create_goal");
    expect(child.dynamic).not.toContain("request_permissions");
    expect(parent.stable.length + parent.dynamic.length).toBe(execDescription(false).length);
    expect(splitExecCacheReference(execDescription(false).replace("declare const tools: { create_goal", "other declaration { create_goal"))).toBeUndefined();
  });
  test("side chats reuse history with their own context methods and developer boundary", () => {
    const cache = new SideChatCache();
    const parent = body("parent", [execCatalog(execDescription(false)), ...history] as never);
    const beforeParent = structuredClone(parent);
    const first = cache.prepare(parent, headers()); first.complete();
    const child = body("child", [execCatalog(execDescription(true)), ...history, message("assistant", "Parent answer"), boundary, message("user", "Side question")] as never);
    const beforeChild = structuredClone(child);
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-with-developer-boundary");
    expect(result.body.prompt_cache_key).toBe("parent");
    const parentInput = first.body.input as unknown[];
    const childInput = result.body.input as unknown[];
    expect(childInput.slice(0, 3)).toEqual(parentInput.slice(0, -1));
    expect(childInput[4]).toEqual(message("developer", SIDE_CHAT_BOUNDARY));
    expect(JSON.stringify(childInput.at(-1))).toContain("fire_confetti");
    expect(JSON.stringify(childInput.at(-1))).not.toContain("create_goal");
    expect(parent).toEqual(beforeParent); expect(child).toEqual(beforeChild);
    const changed = structuredClone(child);
    (changed.input[0] as unknown as ReturnType<typeof execCatalog>).tools[0]!.tools[0]!.description = execDescription(true).replace("### `exec_command`\nMethod contract", "### `exec_command`\nDifferent current permission");
    const skipped = cache.prepare(changed, headers("child", "parent"));
    expect(skipped.body.prompt_cache_key).toBe("child");
    expect(JSON.stringify(skipped.body.input)).toContain("Different current permission");
  });
  test("requires completed parents and explicit fork metadata", () => {
    const cache = new SideChatCache();
    const parent = cache.prepare(body(), headers());
    expect(cache.prepare(side(), headers("child", "parent")).reason).toBe("missing-parent");
    parent.complete();
    expect(cache.prepare(side(), headers("child")).body.prompt_cache_key).toBe("child");
    expect(cache.prepare(side(), headers("child", "parent")).body.prompt_cache_key).toBe("parent");
  });
  test("restores the exact prefix and preserves every side rule at the developer boundary", () => {
    const cache = seeded(); const input = side(); const incoming = headers("child", "parent");
    const before = structuredClone({ input, incoming });
    const result = cache.prepare(input, incoming);
    expect(result.reason).toBe("inherited-with-tail-rules");
    expect((result.body.input as unknown[]).slice(0, 2)).toEqual(history);
    expect((result.body.input as unknown[]).slice(2)).toEqual([message("assistant", "Parent answer"), message("developer", SIDE_CHAT_RULES), boundary, message("user", "Child question")]);
    expect({ input, incoming }).toEqual(before);
    expect(result.headers["thread-id"]).toBe("child");
    expect(result.headers["x-client-request-id"]).toBe("request-child");
    expect(result.headers["session-id"]).toBe("parent");
    expect(result.headers["x-codex-parent-thread-id"]).toBeUndefined();
    expect(JSON.parse(result.headers["x-codex-turn-metadata"]!)).toEqual({ forked_from_thread_id: "parent", session_id: "parent", turn_id: "turn-child" });
    expect(result.body.client_metadata).toEqual({ session_id: "parent", thread_id: "child", turn_id: "turn-child" });
  });
  test("supports an exact initial-instructions suffix and separate developer block", () => {
    for (const placement of ["instructions", "separate"]) {
      const cache = seeded(); const child = body("child", [...history, boundary, message("user", "Question")]);
      if (placement === "instructions") child.instructions += `\n\n${SIDE_CHAT_RULES}`;
      else child.input.splice(1, 0, message("developer", SIDE_CHAT_RULES));
      expect(cache.prepare(child, headers("child", "parent")).reason).toBe("inherited-with-tail-rules");
    }
  });
  test("ordinary forks inherit only when their prefix already matches", () => {
    const child = body("child", [...history, message("user", "Fork question")]);
    const result = seeded().prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-exact-prefix");
    expect(result.body.input).toEqual(child.input);
  });
  test("restores catalog order only when every tool definition remains exactly equal", () => {
    const cache = new SideChatCache();
    const a = { type: "function", name: "inspect", parameters: { type: "object" } };
    const b = { type: "function", name: "read", parameters: { type: "object" } };
    const parent = body() as Record<string, any>;
    parent.input = [{ type: "additional_tools", role: "developer", tools: [a, b] }, ...history];
    cache.prepare(parent, headers()).complete();
    const child = { ...parent, prompt_cache_key: "child", client_metadata: body("child").client_metadata,
      input: [{ type: "additional_tools", role: "developer", tools: [b, a] }, ...history, message("user", "Question")] };
    const before = structuredClone(child);
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-exact-prefix");
    expect((result.body.input as unknown[])[0]).toEqual(parent.input[0]);
    expect(child).toEqual(before);
    for (const tools of [[a], [a, { ...b, description: "Changed instruction" }], [a, b, { ...a, name: "extra" }]]) {
      const incompatible = { ...child, input: [{ ...child.input[0], tools }, ...history] };
      expect(cache.prepare(incompatible, headers("child", "parent")).body).toBe(incompatible);
    }
  });
  test("does not reorder conflicting declarations with the same tool name", () => {
    const cache = new SideChatCache();
    const a = { type: "function", name: "inspect", description: "First contract" };
    const b = { ...a, description: "Second contract" };
    const parent = body() as Record<string, any>;
    parent.input = [{ type: "additional_tools", role: "developer", tools: [a, b] }, ...history];
    cache.prepare(parent, headers()).complete();
    const child = { ...parent, prompt_cache_key: "child", client_metadata: body("child").client_metadata,
      input: [{ type: "additional_tools", role: "developer", tools: [b, a] }, ...history] };
    expect(cache.prepare(child, headers("child", "parent")).body).toBe(child);
  });
  test("moves an interior side block while preserving all following instructions", () => {
    const cache = new SideChatCache();
    const parent = body("parent", [message("developer", "Parent rules\n\nTrailing platform restrictions"), history[1]!]);
    cache.prepare(parent, headers()).complete();
    const child = body("child", [message("developer", `Parent rules\n\n${SIDE_CHAT_RULES}\n\nTrailing platform restrictions`), history[1]!, boundary, message("user", "Question")]);
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-with-tail-rules");
    expect((result.body.input as unknown[])[0]).toEqual(parent.input[0]);
    const changed = structuredClone(child);
    changed.input[0] = message("developer", `Parent rules\n\n${SIDE_CHAT_RULES}\n\nUnknown changed restrictions`);
    expect(cache.prepare(changed, headers("child", "parent")).body).toBe(changed);
  });
  test("supports developer messages with multiple text parts without altering other parts", () => {
    const cache = new SideChatCache();
    const first = { type: "message", role: "developer", content: [{ type: "input_text", text: "Parent rules" }, { type: "input_text", text: "Other rules" }] };
    const parent = body("parent", [first, history[1]!]);
    cache.prepare(parent, headers()).complete();
    for (const separate of [true, false]) {
      const next = structuredClone(first);
      if (separate) next.content.splice(1, 0, { type: "input_text", text: SIDE_CHAT_RULES });
      else next.content[0]!.text += `\n\n${SIDE_CHAT_RULES}`;
      const child = body("child", [next, history[1]!, boundary, message("user", "Question")]);
      const before = structuredClone(child);
      const result = cache.prepare(child, headers("child", "parent"));
      expect(result.reason).toBe("inherited-with-tail-rules");
      expect((result.body.input as unknown[])[0]).toEqual(first);
      expect(child).toEqual(before);
    }
  });
  test("supports private input_text content objects and leaves encrypted content untouched", () => {
    const cache = new SideChatCache();
    const parent = body() as Record<string, any>;
    parent.input = [{ type: "message", role: "developer", content: { type: "input_text", text: "Parent developer rules" } }, history[1]];
    cache.prepare(parent, headers()).complete();
    const child = side() as Record<string, any>;
    child.input[0] = { type: "message", role: "developer", content: { type: "input_text", text: `Parent developer rules\n\n${SIDE_CHAT_RULES}` } };
    child.input[3] = { type: "message", role: "user", content: { type: "input_text", text: SIDE_CHAT_BOUNDARY } };
    expect(cache.prepare(child, headers("child", "parent")).reason).toBe("inherited-with-tail-rules");
    child.input[0].content = { type: "encrypted_content", encrypted_content: "opaque" };
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.body).toBe(child);
    expect((result.body.input as typeof child.input)[0].content.encrypted_content).toBe("opaque");
  });
  test("supports flat developer text and flat side boundaries", () => {
    const cache = new SideChatCache();
    const parent = body() as Record<string, any>;
    parent.input = [{ type: "message", role: "developer", text: "Parent developer rules" }, history[1]];
    cache.prepare(parent, headers()).complete();
    const child = side() as Record<string, any>;
    child.input[0] = { type: "message", role: "developer", text: `Parent developer rules\n\n${SIDE_CHAT_RULES}` };
    child.input[3] = { type: "message", role: "user", text: SIDE_CHAT_BOUNDARY };
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-with-tail-rules");
    expect((result.body.input as unknown[])[0]).toEqual(parent.input[0]);
  });
  test("JSON object key order does not change prompt identity; text and array order do", () => {
    const cache = seeded();
    const reversed = history.map(item => ({ content: item.content.map(part => ({ text: part.text, type: part.type })), role: item.role, type: item.type }));
    expect(cache.prepare(body("child", reversed), headers("child", "parent")).reason).toBe("inherited-exact-prefix");
    expect(cache.prepare(body("child", [...reversed].reverse()), headers("child", "parent")).reason).toBe("input-prefix-change");
  });
  test("keeps the child boundary fixed when the parent continues", () => {
    const cache = seeded(); const child = side(); const first = cache.prepare(child, headers("child", "parent")); first.complete();
    cache.prepare(body("parent", [...history, message("user", "Later parent work")]), headers()).complete();
    const continued = { ...child, input: [...child.input, message("assistant", "Child answer"), message("user", "Next question")] };
    const next = cache.prepare(continued, headers("child", "parent"));
    expect((next.body.input as unknown[]).slice(0, 6)).toEqual(first.body.input);
    expect(next.reason).toBe("inherited-with-tail-rules");
  });
  test("an older side-chat fork can match a later parent snapshot through its explicit boundary", () => {
    const cache = new SideChatCache();
    const inherited = [...history, message("assistant", "Parent answer")];
    cache.prepare(body("parent", [...inherited, message("user", "Later parent question")]), headers()).complete();
    const child = side();
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-with-tail-rules");
    expect(result.matchedItems).toBe(inherited.length);
    expect((result.body.input as unknown[]).slice(0, inherited.length)).toEqual(inherited);
    expect((result.body.input as unknown[])[inherited.length]).toEqual(message("developer", SIDE_CHAT_RULES));
    const changed = structuredClone(child);
    changed.input[2] = message("assistant", "Different inherited answer");
    expect(cache.prepare(changed, headers("child", "parent")).body).toBe(changed);
  });
  test("reuses only the proven history before a diverging reasoning suffix", () => {
    const cache = new SideChatCache();
    const parentReasoning = { type: "reasoning", encrypted_content: "parent-owned-ciphertext", summary: [] };
    const childReasoning = { type: "reasoning", encrypted_content: "child-owned-ciphertext", summary: [] };
    cache.prepare(body("parent", [...history, parentReasoning] as never), headers()).complete();
    const child = body("child", [...history, childReasoning, message("assistant", "Child inherited answer"), boundary, message("user", "Side question")] as never);
    const before = structuredClone(child);
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-with-developer-boundary");
    expect(result.matchedItems).toBe(2);
    expect((result.body.input as unknown[])[2]).toEqual(childReasoning);
    expect(JSON.stringify(result.body)).not.toContain("parent-owned-ciphertext");
    expect(child).toEqual(before);
    const delegated = new SideChatCache();
    const toolMessage = { type: "agent_message", author: "caller", recipient: "root", content: [{ type: "input_text", text: "Delegated question" }] };
    delegated.prepare(body("parent", [history[0], toolMessage, parentReasoning] as never), headers()).complete();
    expect(delegated.prepare(body("child", [history[0], toolMessage, childReasoning, boundary] as never), headers("child", "parent")).body.prompt_cache_key).toBe("parent");
    const noBoundary = { ...child, input: [...history, childReasoning] };
    expect(cache.prepare(noBoundary, headers("child", "parent")).body.prompt_cache_key).toBe("child");
    const noUserHistory = new SideChatCache();
    noUserHistory.prepare(body("parent", [history[0], parentReasoning] as never), headers()).complete();
    expect(noUserHistory.prepare(body("child", [history[0], childReasoning, boundary] as never), headers("child", "parent")).body.prompt_cache_key).toBe("child");
  });
  test("siblings never acquire one another's history or continuation state", () => {
    const cache = seeded();
    const first = cache.prepare(side("one"), { ...headers("one", "parent"), "x-codex-turn-state": "child-one-state" }); first.complete();
    const second = cache.prepare(side("two"), headers("two", "parent"));
    expect(second.headers["thread-id"]).toBe("two");
    expect(second.headers["x-codex-turn-state"]).toBeUndefined();
    expect(first.headers["x-codex-turn-state"]).toBe("child-one-state");
    expect(second.body.previous_response_id).toBeUndefined();
    const url = "https://chatgpt.com/backend-api/codex/responses";
    const a = codexWsReuseIdentity(url, first.headers, JSON.stringify(first.body));
    const b = codexWsReuseIdentity(url, second.headers, JSON.stringify(second.body));
    expect(a).not.toBeNull(); expect(b).not.toBeNull(); expect(a!.scope).not.toBe(b!.scope);
  });
  test("nested exact forks resolve their parent's provider identity", () => {
    const cache = seeded(); const child = body("child", [...history, message("user", "Child question")]);
    cache.prepare(child, headers("child", "parent")).complete();
    const nested = cache.prepare(body("nested", [...child.input, message("user", "Nested question")]), headers("nested", "child"));
    expect(nested.body.prompt_cache_key).toBe("parent"); expect(nested.headers["thread-id"]).toBe("nested");
  });
  test("Desktop embedded transport metadata keeps child ownership while inheriting session identity", () => {
    const cache = new SideChatCache();
    const parent = { ...body(), client_metadata: { ...body().client_metadata, "x-codex-turn-metadata": JSON.stringify({ session_id: "parent", thread_id: "parent", turn_id: "parent-turn" }), "x-codex-turn-state": "parent-state", "x-codex-window-id": "parent-window", parent_turn_id: "parent-parent-turn", root_turn_id: "parent-root-turn", ws_request_header_traceparent: "parent-trace", ws_request_header_tracestate: "parent-tracestate" } };
    cache.prepare(parent, headers()).complete();
    const child = { ...side(), client_metadata: { ...body("child").client_metadata, "x-codex-turn-metadata": JSON.stringify({ session_id: "child", thread_id: "child", turn_id: "child-turn", forked_from_thread_id: "parent" }), "x-codex-turn-state": "child-state", "x-codex-window-id": "child-window", parent_turn_id: "child-parent-turn", root_turn_id: "child-root-turn", ws_request_header_traceparent: "child-trace", ws_request_header_tracestate: "child-tracestate" } };
    const result = cache.prepare(child, headers("child", "parent"));
    expect(result.reason).toBe("inherited-with-tail-rules");
    const metadata = result.body.client_metadata as Record<string, string>;
    expect(JSON.parse(metadata["x-codex-turn-metadata"]!)).toEqual({ session_id: "parent", thread_id: "child", turn_id: "child-turn", forked_from_thread_id: "parent" });
    expect(metadata["x-codex-turn-state"]).toBe("child-state");
    expect(metadata.ws_request_header_traceparent).toBe("child-trace");
    expect(metadata.ws_request_header_tracestate).toBe("child-tracestate");
    expect(metadata["x-codex-window-id"]).toBe("child-window");
  });
  test("nested side chats with unmatched inherited normalization safely skip", () => {
    const cache = seeded(); cache.prepare(side(), headers("child", "parent")).complete();
    const nested = side("nested"); nested.input.push(boundary, message("user", "Nested question"));
    expect(cache.prepare(nested, headers("nested", "child")).body).toBe(nested);
  });
  for (const change of ["model", "account", "credential", "tools", "reasoning", "instructions", "unknown-developer", "history", "compaction", "continuation", "ambiguous-boundary", "missing-boundary", "conflicting-lineage", "conflicting-thread"]) {
    test(`skips ${change} without removing any instructions`, () => {
      const cache = seeded(); const child: Record<string, any> = side(); const incoming: Record<string, string> = headers("child", "parent");
      if (change === "model") child.model = "another-model";
      if (change === "account") incoming["chatgpt-account-id"] = "another-account";
      if (change === "credential") incoming.authorization = "Bearer another-credential";
      if (change === "tools") child.tools = [{ type: "function", name: "new_tool" }];
      if (change === "reasoning") child.reasoning.effort = "high";
      if (change === "instructions") child.instructions += " Unknown rule";
      if (change === "unknown-developer") child.input[0] = message("developer", `Changed developer rules\n\n${SIDE_CHAT_RULES}`);
      if (change === "history") child.input[1] = message("user", "Changed history");
      if (change === "compaction") child.input.push({ type: "compaction", encrypted_content: "opaque" });
      if (change === "continuation") child.previous_response_id = "resp_child";
      if (change === "ambiguous-boundary") child.input.push(boundary);
      if (change === "missing-boundary") child.input.splice(3, 1);
      if (change === "conflicting-lineage") child.client_metadata.forked_from_thread_id = "another-parent";
      if (change === "conflicting-thread") child.client_metadata.thread_id = "another-thread";
      const before = structuredClone(child);
      expect(cache.prepare(child, incoming).body).toBe(child); expect(child).toEqual(before);
    });
  }
  test("expires snapshots, bounds storage, and ignores late completion after expiration", () => {
    let now = 0; const cache = new SideChatCache(() => now, 2, 100);
    const pending = cache.prepare(body(), headers()); pending.complete();
    cache.prepare(body("two"), headers("two")).complete(); cache.prepare(body("three"), headers("three")).complete();
    expect(cache.size).toBe(2); expect(cache.prepare(side(), headers("child", "parent")).reason).toBe("missing-parent");
    const late = cache.prepare(body(), headers()); now = 101; late.complete(); expect(cache.size).toBe(0);
  });
  test("retries apply once and do not mutate the reusable input", () => {
    const cache = seeded(); const child = side();
    const a = cache.prepare(child, headers("child", "parent")); const b = cache.prepare(child, headers("child", "parent"));
    expect(a.body).toEqual(b.body); a.complete(); a.complete(); b.complete();
    expect(cache.prepare(child, headers("child", "parent")).body).toEqual(a.body);
  });
});

test("adapter integration records completion, isolates replay input, and honors the off switch", () => {
  const provider = { adapter: "openai-responses", authMode: "forward" as const, baseUrl: "https://chatgpt.com/backend-api/codex", experimentalCodexSideChatCache: true };
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const build = (raw: ReturnType<typeof body>, h: Record<string, string>, previousResponseId?: string) => adapter.buildRequest({ modelId: raw.model, context: { messages: [] }, stream: true, options: {}, _rawBody: raw, previousResponseId }, { headers: new Headers(h) });
  const parent = build(body(), headers()); parent.releaseBodyObservation?.();
  completeSideChatCache(parent, { status: "failed" });
  const before = build(side(), headers("child", "parent")); before.releaseBodyObservation?.(); expect(JSON.parse(before.body).prompt_cache_key).toBe("child");
  completeSideChatCache(parent, { status: "completed" });
  const raw = side(); const child = build(raw, headers("child", "parent")); child.releaseBodyObservation?.();
  expect(JSON.parse(child.body).prompt_cache_key).toBe("parent"); expect(raw.prompt_cache_key).toBe("child");
  const chained = build(raw, headers("child", "parent"), "resp_own"); chained.releaseBodyObservation?.(); expect(JSON.parse(chained.body).prompt_cache_key).toBe("child");
  provider.experimentalCodexSideChatCache = false;
  const off = build(raw, headers("child", "parent")); off.releaseBodyObservation?.(); expect(JSON.parse(off.body).prompt_cache_key).toBe("child");
});


test("side-chat cache configuration is explicit, boolean, and canonical-provider only", () => {
  const config = getDefaultConfig();
  expect(config.providers.openai!.experimentalCodexSideChatCache).toBeUndefined();
  expect(validateConfigCandidate(config).ok).toBe(true);
  for (const enabled of [true, false]) {
    config.providers.openai!.experimentalCodexSideChatCache = enabled;
    const result = validateConfigCandidate(config);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.providers.openai!.experimentalCodexSideChatCache).toBe(enabled);
  }
  expect(validateConfigCandidate({ ...config, providers: { ...config.providers,
    openai: { ...config.providers.openai, experimentalCodexSideChatCache: "true" },
  } }).ok).toBe(false);
  config.providers.other = { ...config.providers.openai! };
  expect(validateConfigCandidate(config).ok).toBe(false);
  delete config.providers.other;
  config.providers.openai!.baseUrl = "https://example.com/v1";
  expect(validateConfigCandidate(config).ok).toBe(false);
});


test("disabled preparation leaves the tool reference and request untouched", () => {
  const raw = body("parent", [execCatalog(execDescription(false)), ...history] as never);
  const before = structuredClone(raw);
  expect(prepareSideChatCache(raw, headers(), false)).toBeUndefined();
  expect(raw).toEqual(before);
});

test("unknown executor formats and method contracts remain unchanged", () => {
  const cache = new SideChatCache();
  for (const description of ["Unknown format", execDescription(false).replace("create_goal(args", "create_goal_v2(args")]) {
    const raw = body("parent", [execCatalog(description), ...history] as never);
    expect(cache.prepare(raw, headers()).body).toEqual(raw);
  }
});

test("an old completion cannot seed a newly enabled runtime", () => {
  const provider = { adapter: "openai-responses", authMode: "forward" as const,
    baseUrl: "https://chatgpt.com/backend-api/codex", experimentalCodexSideChatCache: true };
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter(provider));
  const build = (raw: ReturnType<typeof body>, h: Record<string, string>) => {
    const request = adapter.buildRequest({ modelId: raw.model, context: { messages: [] }, stream: true,
      options: {}, _rawBody: raw }, { headers: new Headers(h) });
    request.releaseBodyObservation?.();
    return request;
  };
  prepareSideChatCache({}, {}, false);
  const parent = build(body(), headers());
  prepareSideChatCache({}, {}, false);
  build(body("other"), headers("other"));
  completeSideChatCache(parent, { status: "completed" });
  expect(JSON.parse(build(side(), headers("child", "parent")).body).prompt_cache_key).toBe("child");
  prepareSideChatCache({}, {}, false);
});


test("stream delivery differences preserve each wire's options while allowing parent reuse", () => {
  const cache = new SideChatCache();
  const parent = { ...body(), stream_options: { include_obfuscation: false, reasoning_summary_delivery: "sequential" } };
  cache.prepare(parent, headers()).complete();
  for (const options of [undefined, {}, { include_obfuscation: true, reasoning_summary_delivery: "concurrent" }]) {
    const raw = { ...side(), ...(options === undefined ? {} : { stream_options: options }) };
    const before = structuredClone(raw);
    const result = cache.prepare(raw, headers("child", "parent"));
    expect(result.body.prompt_cache_key).toBe("parent");
    expect(result.body.stream_options).toEqual(options);
    expect(raw).toEqual(before);
  }
  expect(parent.stream_options).toEqual({ include_obfuscation: false, reasoning_summary_delivery: "sequential" });
});

test("unknown stream settings and malformed known options still prevent parent reuse", () => {
  const cache = seeded();
  for (const options of [{ future_option: true }, { include_obfuscation: "false" }, { reasoning_summary_delivery: "unknown" }, { reasoning_summary_delivery: ["concurrent"] }]) {
    const raw = { ...side(), stream_options: options };
    const result = cache.prepare(raw, headers("child", "parent"));
    expect(result.reason).toBe("settings-change");
    expect(result.body.prompt_cache_key).toBe("child");
    expect(result.body.stream_options).toEqual(options);
  }
});


test.each(["developer", "user"])("extra inherited %s items remain an unmatched suffix of a verified prefix", role => {
  const cache = seeded();
  const extra = message(role, "Additional reference history");
  const raw = body("child", [...history, extra, boundary, message("user", "Child question")]);
  const before = structuredClone(raw);
  const result = cache.prepare(raw, headers("child", "parent"));
  expect(result.body.prompt_cache_key).toBe("parent");
  expect(result.matchedItems).toBe(history.length);
  expect(result.body.input).toEqual([...history, extra, message("developer", SIDE_CHAT_BOUNDARY), boundary, message("user", "Child question")]);
  expect(raw).toEqual(before);
  const changedPrefix = structuredClone(raw);
  changedPrefix.input[1] = message("user", "Different parent question");
  expect(cache.prepare(changedPrefix, headers("child", "parent")).reason).toBe("input-prefix-change");
});
