import { describe, expect, test } from "bun:test";
import { measureContextBreakdown, observeContextBreakdown } from "../../src/server/context-breakdown";

/** ASCII only, so a string of n characters is exactly ceil(n / 4) tokens. */
const tok = (s: string): number => Math.ceil(s.length / 4);
const fill = (n: number, ch = "a"): string => ch.repeat(n);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

const CLAUDE_MD_CHUNK = "Contents of /home/dev/.claude/CLAUDE.md (user's private global instructions for all projects):\n\nSENTINEL_MEMORY_BODY rules for the fixture\n";
const REMINDER_PREAMBLE = "As you answer the user's questions, you can use the following context:";
const SKILLS_LIST = "The following skills are available for use with the Skill tool:\n\n- skill-alpha: SENTINEL_SKILL does alpha\n- skill-beta: does beta";
const OTHER_REMINDER = "Other reminder text SENTINEL_REMINDER";

describe("OpenAI Responses (Codex-style)", () => {
  const instructions = fill(400);
  const skillsDev = `<skills_instructions>\n${fill(800)}`;
  const agentsMd = `# AGENTS.md instructions for /work/proj\n\n<INSTRUCTIONS>\nSENTINEL_AGENTS_BODY ${fill(300)}\n</INSTRUCTIONS>`;
  const envContext = `<environment_context>\n<cwd>/work/proj</cwd>\n</environment_context>`;
  const fileOut = fill(400, "f");
  const shellOut = fill(200, "s");
  const body = {
    model: "gpt-6-sol",
    instructions,
    tools: [
      { type: "function", name: "shell", description: "run a command", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } } } },
      { type: "namespace", name: "mcp__github", tools: [{ type: "function", name: "a" }, { type: "function", name: "b" }] },
    ],
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: skillsDev }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: agentsMd }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: envContext }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Fix the bug in the parser SENTINEL_USER" }] },
      { type: "function_call", call_id: "call_read", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "cat src/parser.ts"] }) },
      { type: "function_call_output", call_id: "call_read", output: fileOut },
      { type: "function_call", call_id: "call_test", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm test"] }) },
      { type: "function_call_output", call_id: "call_test", output: shellOut },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found it SENTINEL_ASSISTANT" }] },
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }, { type: "input_text", text: "Here is the screenshot" }] },
    ],
  };

  test("sorts a Codex request into the seven categories", () => {
    const b = measureContextBreakdown(body, "responses")!;
    expect(b.v).toBe(1);
    expect(b.parts.system).toBe(tok(instructions) + tok(envContext));
    expect(b.parts.skills).toBe(tok(skillsDev));
    expect(b.parts.memory).toBe(tok(agentsMd));
    expect(b.parts.files).toBe(tok(fileOut) + 1600);
    expect(b.parts.results).toBe(tok(shellOut));
    expect(b.parts.tools).toBeGreaterThan(40);
    expect(b.toolCount).toBe(3);
    expect(b.held).toBeUndefined();
    expect(b.parts.chat).toBe(sum(b.turns) + (b.turnsEarlier ?? 0));
  });

  test("injected context is not a turn; each real user message begins one", () => {
    const b = measureContextBreakdown(body, "responses")!;
    // turn 1: the bug report, the calls, the reply; turn 2: the screenshot message
    expect(b.turns).toHaveLength(2);
    expect(b.turns[0]).toBeGreaterThan(b.turns[1]!);
    expect(b.turns[1]).toBe(tok("Here is the screenshot"));
  });

  test("a shell command that only reads files makes its output a file, anything else a result", () => {
    const run = (call: Record<string, unknown>) => {
      const b = measureContextBreakdown({
        input: [
          { type: call.type ?? "function_call", call_id: "c", name: "shell", ...call },
          { type: "function_call_output", call_id: "c", output: fill(40, "o") },
        ],
      }, "responses")!;
      return { files: b.parts.files, results: b.parts.results };
    };
    const asFile = { files: 10, results: 0 };
    const asResult = { files: 0, results: 10 };
    expect(run({ arguments: JSON.stringify({ command: "sed -n '1,80p' src/a.ts" }) })).toEqual(asFile);
    expect(run({ arguments: JSON.stringify({ command: ["bash", "-lc", "head -n 40 src/a.ts"] }) })).toEqual(asFile);
    expect(run({ arguments: JSON.stringify({ cmd: "cd /work && cat README.md" }) })).toEqual(asFile);
    expect(run({ arguments: JSON.stringify({ command: "cat a.txt | wc -l" }) })).toEqual(asResult);
    expect(run({ arguments: JSON.stringify({ command: "ls -la" }) })).toEqual(asResult);
    expect(run({ arguments: JSON.stringify({ command: "sed -i s/a/b/ src/a.ts" }) })).toEqual(asResult);
    expect(run({ arguments: "not json at all" })).toEqual(asResult);
    expect(run({ type: "custom_tool_call", input: 'text(await tools.exec_command({cmd:"cat src/x.ts"}))', arguments: undefined })).toEqual(asFile);
  });

  test("a read tool's path argument makes its result a file", () => {
    const b = measureContextBreakdown({
      input: [
        { type: "function_call", call_id: "c", name: "read_file", arguments: JSON.stringify({ path: "src/a.ts" }) },
        { type: "function_call_output", call_id: "c", output: fill(80) },
        { type: "function_call_output", call_id: "orphan", output: fill(80) },
      ],
    }, "responses")!;
    expect(b.parts.files).toBe(20);
    expect(b.parts.results).toBe(20);
  });

  test("previous_response_id marks the earlier turns as held upstream", () => {
    const b = measureContextBreakdown({ previous_response_id: "resp_SENTINEL", input: [{ role: "user", content: "hello there" }] }, "responses")!;
    expect(b.held).toBe(true);
    expect(b.turns).toHaveLength(1);
    expect(measureContextBreakdown({ previous_response_id: "resp_x", input: [] }, "responses")?.held).toBe(true);
  });

  test("a plain string input is one user turn; reasoning and compaction are counted as chat", () => {
    expect(measureContextBreakdown({ input: fill(40) }, "responses")!.turns).toEqual([10]);
    const b = measureContextBreakdown({
      input: [
        { type: "compaction", encrypted_content: fill(400) },
        { role: "user", content: "go" },
        { type: "reasoning", summary: [{ type: "summary_text", text: fill(40) }], encrypted_content: fill(160) },
      ],
    }, "responses")!;
    expect(b.turnsEarlier).toBeGreaterThan(0);
    expect(b.turns).toHaveLength(1);
    expect(b.parts.chat).toBe(b.turns[0]! + b.turnsEarlier!);
    expect(b.turns[0]).toBe(1 + 10 + 30);
  });

  test("an image-only developer message is measured as a file", () => {
    const b = measureContextBreakdown({ input: [{ role: "developer", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] }, "responses")!;
    expect(b).toBeDefined();
    expect(b.parts.files).toBe(1600);
    expect(b.parts.system).toBe(0);
  });

  test("the Codex app's IDE context ahead of '## My request' still counts as the user speaking", () => {
    const b = measureContextBreakdown({
      input: [{ role: "user", content: [{ type: "input_text", text: "# Context from my IDE setup:\nopen tabs\n\n## My request for Codex:\nFix it" }] }],
    }, "responses")!;
    expect(b.turns).toHaveLength(1);
  });

  test("an OpenCode 'Instructions from:' file in the system prompt is memory", () => {
    const file = "Instructions from: /work/AGENTS.md\nSENTINEL_RULES keep tests green\n";
    const lead = fill(40);
    const b = measureContextBreakdown({ instructions: `${lead}\n${file}`, input: "hi" }, "responses")!;
    expect(b.parts.memory).toBe(tok(file));
    expect(b.parts.system).toBe(tok(`${lead}\n`));
  });
});

describe("Anthropic Messages (Claude Code-style)", () => {
  const sysPrompt = `You are Claude Code. ${fill(380)}`;
  const toolResultRead = fill(800, "r");
  const toolResultBash = fill(400, "b");
  const body = {
    model: "claude-opus-5-5",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=9.9.9; cch=00000;" },
      { type: "text", text: sysPrompt },
    ],
    tools: [
      { name: "Read", description: "Reads a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } },
      { name: "Bash", description: "Runs a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      { name: "mcp__fs__list", description: "Lists", input_schema: { type: "object" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `<system-reminder>\n${REMINDER_PREAMBLE}\n${CLAUDE_MD_CHUNK}</system-reminder>` },
          { type: "text", text: `<system-reminder>\n${SKILLS_LIST}\n\n${OTHER_REMINDER}\n</system-reminder>` },
          { type: "text", text: "Please read the config SENTINEL_USER" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Reading." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/proj/SENTINEL_PATH.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: toolResultRead }] },
      { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "npm test" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: toolResultBash }] }] },
      { role: "assistant", content: "Done." },
      { role: "user", content: [{ type: "text", text: "Thanks, next task" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
    ],
  };

  test("sorts a Claude Code request into the seven categories", () => {
    const b = measureContextBreakdown(body, "messages")!;
    expect(b.parts.system).toBe(tok("x-anthropic-billing-header: cc_version=9.9.9; cch=00000;") + tok(sysPrompt));
    expect(b.parts.skills).toBe(tok(SKILLS_LIST));
    expect(b.parts.memory).toBe(tok(CLAUDE_MD_CHUNK) + tok(REMINDER_PREAMBLE) + tok("Other reminder text SENTINEL_REMINDER"));
    expect(b.parts.files).toBe(tok(toolResultRead) + 1600);
    expect(b.parts.results).toBe(tok(toolResultBash));
    expect(b.toolCount).toBe(3);
    expect(b.parts.tools).toBeGreaterThan(30);
    expect(b.parts.chat).toBe(sum(b.turns) + (b.turnsEarlier ?? 0));
  });

  test("tool results continue a turn; only real user text begins one", () => {
    const b = measureContextBreakdown(body, "messages")!;
    expect(b.turns).toHaveLength(2);
    expect(b.turns[1]).toBe(tok("Thanks, next task"));
  });

  test("keeps the last 48 turns and sums the older ones", () => {
    const messages: unknown[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "user", content: fill(40) });
      messages.push({ role: "assistant", content: fill(20) });
    }
    const b = measureContextBreakdown({ messages }, "messages")!;
    expect(b.turns).toHaveLength(48);
    expect(b.turns.every(t => t === 15)).toBe(true);
    expect(b.turnsEarlier).toBe(30);
    expect(b.parts.chat).toBe(50 * 15);
  });

  test("documents by reference count their source, base64 documents and images 1600, thinking counts as chat", () => {
    const b = measureContextBreakdown({
      messages: [
        { role: "user", content: [{ type: "text", text: "see attachments" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "AAAA" } }, { type: "document", source: { type: "url", url: "https://example.test/a.pdf" } }] },
        { role: "assistant", content: [{ type: "thinking", thinking: fill(40), signature: "sig" }, { type: "redacted_thinking", data: fill(160) }] },
      ],
    }, "messages")!;
    expect(b.parts.files).toBeGreaterThan(1600);
    expect(b.parts.files).toBeLessThan(1700);
    expect(b.parts.chat).toBe(tok("see attachments") + 10 + 10);
  });

  test("text after a reminder in the same block is the user speaking, and begins a turn", () => {
    const b = measureContextBreakdown({
      messages: [{ role: "user", content: [{ type: "text", text: `<system-reminder>${fill(40, "r")}</system-reminder>
${fill(80, "u")}` }] }],
    }, "messages")!;
    expect(b.parts.memory).toBe(10);
    expect(b.turns).toEqual([20]);
    expect(b.parts.chat).toBe(20);
  });

  test("system as a plain string and system-role messages are system", () => {
    const b = measureContextBreakdown({ system: fill(40), messages: [{ role: "system", content: fill(80) }, { role: "user", content: "hi" }] }, "messages")!;
    expect(b.parts.system).toBe(10 + 20);
  });
});

describe("OpenAI Chat Completions", () => {
  test("sorts messages, tool calls, tool results and image parts", () => {
    const result = fill(120, "t");
    const b = measureContextBreakdown({
      model: "gpt-6-sol",
      tools: [{ type: "function", function: { name: "read_file", description: "Reads", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
      messages: [
        { role: "system", content: fill(80) },
        { role: "user", content: "Open the notes SENTINEL_CHAT" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "notes.md" }) } }] },
        { role: "tool", tool_call_id: "call_1", content: result },
        { role: "assistant", content: "Here they are" },
        { role: "user", content: [{ type: "text", text: "and this picture" }, { type: "image_url", image_url: { url: "https://example.test/a.png" } }] },
      ],
    }, "chat")!;
    expect(b.parts.system).toBe(20);
    expect(b.parts.files).toBe(tok(result) + 1600);
    expect(b.parts.results).toBe(0);
    expect(b.toolCount).toBe(1);
    expect(b.turns).toHaveLength(2);
    expect(b.parts.chat).toBe(sum(b.turns));
  });

  test("legacy functions and function_call count as tools and the call, the result as a result", () => {
    const fn = { name: "lookup", description: "Looks things up", parameters: { type: "object", properties: { q: { type: "string" } } } };
    const args = JSON.stringify({ q: fill(40) });
    const b = measureContextBreakdown({
      functions: [fn],
      messages: [
        { role: "user", content: "look it up" },
        { role: "assistant", content: null, function_call: { name: "lookup", arguments: args } },
        { role: "function", name: "lookup", content: fill(80, "f") },
      ],
    }, "chat")!;
    expect(b.toolCount).toBe(1);
    expect(b.parts.tools).toBeGreaterThan(0);
    expect(b.parts.results).toBe(20);
    expect(b.turns).toEqual([tok("look it up") + tok("lookup") + tok(args)]);
  });
});

describe("estimator", () => {
  test("ASCII is four characters a token, everything else a token a character", () => {
    expect(measureContextBreakdown({ input: "abcdefgh" }, "responses")!.parts.chat).toBe(2);
    expect(measureContextBreakdown({ input: "abcde" }, "responses")!.parts.chat).toBe(2);
    expect(measureContextBreakdown({ input: "你好世界你好世界你好abcdefgh" }, "responses")!.parts.chat).toBe(10 + 2);
    // an astral character (a surrogate pair) is one character
    expect(measureContextBreakdown({ input: "\u{1F600}\u{1F600}" }, "responses")!.parts.chat).toBe(2);
  });

  test("tool schemas are sized by walking them, not serializing them", () => {
    const schema = { name: "t", description: fill(1000), input_schema: { type: "object", properties: { a: { type: "string", description: fill(1000) } } } };
    const walked = measureContextBreakdown({ tools: [schema], messages: [] }, "messages")!.parts.tools;
    const serialized = Math.ceil(JSON.stringify(schema).length / 4);
    expect(walked).toBeGreaterThan(serialized * 0.9);
    expect(walked).toBeLessThan(serialized * 1.2);
  });

  test("a very deep tool schema does not overflow the stack", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 20000; i++) deep = { n: deep };
    expect(() => measureContextBreakdown({ tools: [deep], messages: [] }, "messages")).not.toThrow();
  });
});

describe("failure behaviour", () => {
  test("a body that is not a readable request is undefined, never a throw", () => {
    const bad: Array<[unknown, "responses" | "messages" | "chat"]> = [
      [null, "responses"], [undefined, "messages"], ["text", "chat"], [42, "responses"], [[], "messages"],
      [{}, "responses"], [{}, "messages"], [{}, "chat"],
      [{ messages: "nope" }, "messages"], [{ messages: [null, 7, "x", []] }, "chat"],
      [{ input: 42 }, "responses"], [{ input: [null, 1, "s"] }, "responses"],
      [{ messages: [{ role: "user", content: { weird: true } }] }, "messages"],
      [{ messages: [{ role: "assistant", tool_calls: "x" }] }, "chat"],
      [{ input: "x" }, "unknown" as "responses"],
    ];
    for (const [body, wire] of bad) expect(() => measureContextBreakdown(body, wire)).not.toThrow();
    expect(measureContextBreakdown(null, "responses")).toBeUndefined();
    expect(measureContextBreakdown({}, "responses")).toBeUndefined();
    expect(measureContextBreakdown({ messages: "nope" }, "messages")).toBeUndefined();
    expect(measureContextBreakdown({ messages: [null, 7, "x"] }, "chat")).toBeUndefined();
    expect(measureContextBreakdown({ input: 42 }, "responses")).toBeUndefined();
    expect(measureContextBreakdown({ input: "x" }, "unknown" as "responses")).toBeUndefined();
  });

  test("a hostile getter that throws is swallowed", () => {
    const body = { get messages(): unknown { throw new Error("boom"); } };
    expect(measureContextBreakdown(body, "messages")).toBeUndefined();
  });
});

describe("privacy", () => {
  test("the result holds numbers only: no fixture text, path or id survives", () => {
    const messagesBody = {
      system: [{ type: "text", text: "SENTINEL_SYSTEM prompt" }],
      tools: [{ name: "SENTINEL_TOOL", description: "SENTINEL_TOOL_DESC", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: `<system-reminder>\n${CLAUDE_MD_CHUNK}</system-reminder>` }, { type: "text", text: "SENTINEL_USER_TEXT" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "SENTINEL_TOOL_USE_ID", name: "Read", input: { file_path: "/SENTINEL/path.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "SENTINEL_TOOL_USE_ID", content: "SENTINEL_FILE_CONTENT" }] },
      ],
    };
    const responsesBody = {
      previous_response_id: "SENTINEL_RESP_ID",
      instructions: "SENTINEL_INSTRUCTIONS",
      input: [
        { type: "function_call", call_id: "SENTINEL_CALL", name: "SENTINEL_FN", arguments: '{"path":"SENTINEL_ARG"}' },
        { type: "function_call_output", call_id: "SENTINEL_CALL", output: "SENTINEL_OUT" },
      ],
    };
    const out = [measureContextBreakdown(messagesBody, "messages"), measureContextBreakdown(responsesBody, "responses")];
    for (const b of out) {
      expect(b).toBeDefined();
      expect(JSON.stringify(b)).not.toMatch(/SENTINEL|CLAUDE\.md|\/home\/|\.ts/);
      const allNumbers = (v: unknown): boolean =>
        typeof v === "number" || typeof v === "boolean" || (Array.isArray(v) ? v.every(allNumbers) : typeof v === "object" && v !== null && Object.values(v).every(allNumbers));
      expect(allNumbers({ ...b, v: 1 })).toBe(true);
      for (const key of Object.keys(b!)) expect(["v", "parts", "turns", "turnsEarlier", "toolCount", "held"]).toContain(key);
    }
  });
});

describe("observeContextBreakdown", () => {
  test("the first observer wins and a later one never overwrites", () => {
    const ctx: { contextBreakdown?: ReturnType<typeof measureContextBreakdown> } = {};
    observeContextBreakdown(ctx as never, { messages: [{ role: "user", content: fill(40) }] }, "messages");
    const first = ctx.contextBreakdown;
    expect(first?.parts.chat).toBe(10);
    observeContextBreakdown(ctx as never, { input: fill(400) }, "responses");
    expect(ctx.contextBreakdown).toBe(first);
  });

  test("an unreadable body leaves the slot open for a later observer", () => {
    const ctx: { contextBreakdown?: ReturnType<typeof measureContextBreakdown> } = {};
    observeContextBreakdown(ctx as never, "garbage", "messages");
    expect(ctx.contextBreakdown).toBeUndefined();
    observeContextBreakdown(ctx as never, { input: fill(40) }, "responses");
    expect(ctx.contextBreakdown?.parts.chat).toBe(10);
  });
});
