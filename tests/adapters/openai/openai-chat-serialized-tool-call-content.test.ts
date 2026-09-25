import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../../src/adapters/openai-chat";
import { SerializedToolCallContentBuffer } from "../../../src/adapters/openai-chat/serialized-tool-call-content";
import type { AdapterEvent } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

const provider = { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "key" } as const;
const execTool = { name: "exec", description: "Run JavaScript", parameters: { type: "object", properties: { input: { type: "string" } } }, freeform: true };

test("buffered Chat responses reconcile matching serialized and structured tool calls", async () => {
  const script = "text('ok');";
  const content = `Running it.\n<tool_call><function=exec>${script}\n</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content,
        tool_calls: [{
          id: "call_exec",
          function: { name: "exec", arguments: script + JSON.stringify({ input: script }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([
    { type: "text_delta", text: "Running it.\n" },
  ]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta",
    arguments: JSON.stringify({ input: script }),
  });
});

test("buffered Chat responses reconcile two identical echoed blocks and doubled input", async () => {
  const script = "const names = []; text(names);";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content: block + block,
        tool_calls: [{
          id: "call_exec",
          function: { name: "exec", arguments: JSON.stringify({ input: script + script }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta",
    arguments: JSON.stringify({ input: script }),
  });
});

test("buffered Chat responses suppress two echoed blocks when structured input is already single", async () => {
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content: block + block,
        tool_calls: [{
          id: "call_exec",
          function: { name: "exec", arguments: JSON.stringify({ input: script }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta",
    arguments: JSON.stringify({ input: script }),
  });
});

test("buffered Chat responses suppress an empty repeated body with one empty input", async () => {
  const argumentsText = JSON.stringify({ input: "" });
  const block = "<tool_call><function=exec></parameter></function></tool_call>";
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{ message: { content: block + block, tool_calls: [
      { id: "call_exec", function: { name: "exec", arguments: argumentsText } },
    ] }, finish_reason: "tool_calls" }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({ type: "tool_call_delta", arguments: argumentsText });
});

test("buffered Chat responses suppress two echoed blocks with a trailing newline", async () => {
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content: block + block + "\n",
        tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input: script }) } }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta", arguments: JSON.stringify({ input: script }),
  });
});

test("buffered Chat responses repair two echoed blocks with newline-joined input", async () => {
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content: block + block,
        tool_calls: [{
          id: "call_exec",
          function: { name: "exec", arguments: JSON.stringify({ input: script + "\n" + script }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta",
    arguments: JSON.stringify({ input: script }),
  });
});

test("buffered Chat responses suppress a repeated echo beside an unrelated structured call", async () => {
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content: block + block,
        tool_calls: [
          { id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input: script }) } },
          { id: "call_other", function: { name: "other", arguments: JSON.stringify({ input: "other" }) } },
        ],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: JSON.stringify({ input: script }) },
    { type: "tool_call_delta", arguments: JSON.stringify({ input: "other" }) },
  ]);
});

test("buffered Chat responses preserve repeated markup when two structured calls match", async () => {
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const content = block + block;
  const argumentsText = JSON.stringify({ input: script });
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content,
        tool_calls: [
          { id: "call_one", function: { name: "exec", arguments: argumentsText } },
          { id: "call_two", function: { name: "exec", arguments: argumentsText } },
        ],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: argumentsText },
    { type: "tool_call_delta", arguments: argumentsText },
  ]);
});

test("buffered Chat responses preserve repeated markup when the structured input differs", async () => {
  const script = "text('example');";
  const content = `<tool_call><function=exec>${script}</function></tool_call>`.repeat(2);
  const argumentsText = JSON.stringify({ input: script + "text('other');" });
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content,
        tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: argumentsText } }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.find(event => event.type === "text_delta")).toEqual({ type: "text_delta", text: content });
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta",
    arguments: argumentsText,
  });
});

test("buffered Chat responses preserve a raw freeform block when arguments differ", async () => {
  const content = "<tool_call><function=exec>text('example');</parameter></function></tool_call>";
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{ message: { content, tool_calls: [
      { id: "call_exec", function: { name: "exec", arguments: "text('other');" } },
    ] }, finish_reason: "tool_calls" }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta", arguments: "text('other');",
  });
});

test.each(["42", '["text(1)"]', '{"value":1}', '{"input":42}'])(
  "buffered Chat responses suppress matching valid JSON freeform input %s",
  async argumentsText => {
    const block = `<tool_call><function=exec>${argumentsText}</parameter></function></tool_call>`;
    const adapter = createOpenAIChatAdapter(provider);
    adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: false, options: {}, context: {
      messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [execTool],
    } });
    const events = await adapter.parseResponse!(Response.json({
      choices: [{ message: { content: block, tool_calls: [
        { id: "call_exec", function: { name: "exec", arguments: argumentsText } },
      ] }, finish_reason: "tool_calls" }],
    }), createTestTranslatorBudget());

    expect(events.filter(event => event.type === "text_delta")).toEqual([]);
    expect(events.find(event => event.type === "tool_call_delta")).toEqual({ type: "tool_call_delta", arguments: argumentsText });
  },
);

test("buffered Chat responses preserve JSON markup that the bridge unwraps to a different input", async () => {
  const argumentsText = '{"cmd":"pwd"}';
  const block = `<tool_call><function=exec>${argumentsText}</parameter></function></tool_call>`;
  const adapter = createOpenAIChatAdapter(provider);
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: false, options: {}, context: {
    messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [execTool],
  } });
  const events = await adapter.parseResponse!(Response.json({
    choices: [{ message: { content: block, tool_calls: [
      { id: "call_exec", function: { name: "exec", arguments: argumentsText } },
    ] }, finish_reason: "tool_calls" }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: block }]);
});

test.each(["buffered", "streamed"] as const)(
  "%s Chat responses preserve namespaced JSON markup when exec dispatches its cmd field",
  async mode => {
    const argumentsText = '{"cmd":"pwd"}';
    const name = "functions__exec";
    const block = `<tool_call><function=${name}>${argumentsText}</parameter></function></tool_call>`;
    const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
    adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: mode === "streamed", options: {}, context: {
      messages: [{ role: "user", content: "ping", timestamp: 0 }],
      tools: [{ ...execTool, namespace: "functions" }],
    } });
    const events: AdapterEvent[] = [];
    if (mode === "buffered") {
      events.push(...await adapter.parseResponse!(Response.json({
        choices: [{ message: { content: block, tool_calls: [
          { id: "call_exec", function: { name, arguments: argumentsText } },
        ] }, finish_reason: "tool_calls" }],
      }), createTestTranslatorBudget()));
    } else {
      const frames = [
        { choices: [{ delta: { content: block } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_exec", function: { name, arguments: argumentsText } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ];
      const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
      for await (const event of adapter.parseStream(new Response(body))) if (event.type !== "heartbeat") events.push(event);
    }
    expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: block }]);
    expect(events.filter(event => event.type === "tool_call_delta")).toEqual([{ type: "tool_call_delta", arguments: argumentsText }]);
  },
);

test("buffered Chat responses keep matching text for malformed ordinary JSON arguments", async () => {
  const malformed = '{"cmd":"pwd"';
  const content = `<tool_call><function=exec>${malformed}</parameter></function></tool_call>`;
  const adapter = createOpenAIChatAdapter(provider);
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: false, options: {}, context: {
    messages: [{ role: "user", content: "ping", timestamp: 0 }],
    tools: [{ ...execTool, freeform: false }],
  } });
  const events = await adapter.parseResponse!(Response.json({
    choices: [{ message: { content, tool_calls: [
      { id: "call_exec", function: { name: "exec", arguments: malformed } },
    ] }, finish_reason: "tool_calls" }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
});

test("buffered Chat responses keep valid JSON markup for an ordinary function", async () => {
  const argumentsText = "42";
  const block = `<tool_call><function=exec>${argumentsText}</parameter></function></tool_call>`;
  const adapter = createOpenAIChatAdapter(provider);
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: false, options: {}, context: {
    messages: [{ role: "user", content: "ping", timestamp: 0 }],
    tools: [{ ...execTool, freeform: false }],
  } });
  const events = await adapter.parseResponse!(Response.json({
    choices: [{ message: { content: block, tool_calls: [
      { id: "call_exec", function: { name: "exec", arguments: argumentsText } },
    ] }, finish_reason: "tool_calls" }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: block }]);
});

test("buffered Chat responses reduce a doubled input behind the MiMo wrapping newline", async () => {
  // The canonical MiMo layout puts one template newline after the function header, so the block
  // body and the doubled structured input only agree once both sides are freeform-normalized.
  const script = "text('ok');";
  const block = `<tool_call><function=exec>\n${script}\n</parameter></function></tool_call>`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content: block + block,
        tool_calls: [{
          id: "call_exec",
          function: { name: "exec", arguments: JSON.stringify({ input: script + script }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([]);
  expect(events.find(event => event.type === "tool_call_delta")).toEqual({
    type: "tool_call_delta",
    arguments: JSON.stringify({ input: script }),
  });
});

test("buffered Chat responses keep doubled input when two structured calls qualify", async () => {
  // Two qualifying calls leave the repeated block ambiguous, so rewriting either argument would
  // execute something the response never proved. Both keep their input and the markup stays visible.
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const content = block + block;
  const argumentsText = JSON.stringify({ input: script + script });
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: { content, tool_calls: [
        { id: "call_one", function: { name: "exec", arguments: argumentsText } },
        { id: "call_two", function: { name: "exec", arguments: argumentsText } },
      ] },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: argumentsText },
    { type: "tool_call_delta", arguments: argumentsText },
  ]);
});

test("buffered Chat responses keep two competing doubled calls with a raw trailing newline", async () => {
  const script = "text('ok');";
  const content = `<tool_call><function=exec>${script}</parameter></function></tool_call>`.repeat(2);
  const jsonArguments = JSON.stringify({ input: script + script });
  const rawArguments = script + script + "\n";
  const adapter = createOpenAIChatAdapter(provider);
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: false, options: {}, context: {
    messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [execTool],
  } });
  const events = await adapter.parseResponse!(Response.json({
    choices: [{ message: { content, tool_calls: [
      { id: "call_json", function: { name: "exec", arguments: jsonArguments } },
      { id: "call_raw", function: { name: "exec", arguments: rawArguments } },
    ] }, finish_reason: "tool_calls" }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: jsonArguments },
    { type: "tool_call_delta", arguments: rawArguments },
  ]);
});

test("buffered Chat responses keep a doubled input and markup when another call already agrees with the blocks", async () => {
  // The single-input call explains the repeated pair on its own, so the doubled call beside it is a
  // competing reading rather than the unique one, and neither argument is rewritten. Exactly one
  // call still agrees with the blocks, so the range matcher suppresses the pair: the markup is
  // unsettled, the doubled input is not.
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const content = block + block;
  const doubledArguments = `{"input":"${script}${script}"}`;
  const singleArguments = `{"input":"${script}"}`;
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: { content, tool_calls: [
        { id: "call_doubled", function: { name: "exec", arguments: doubledArguments } },
        { id: "call_single", function: { name: "exec", arguments: singleArguments } },
      ] },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: doubledArguments },
    { type: "tool_call_delta", arguments: singleArguments },
  ]);
});

test.each(["json", "raw", "multi-key"] as const)("buffered Chat responses preserve markup when raw and %s doubled calls compete", async kind => {
  const script = "text('ok');";
  const content = `<tool_call><function=exec>${script}</parameter></function></tool_call>`.repeat(2);
  const doubledArguments = kind === "raw" ? script + script : JSON.stringify({ input: script + script, ...(kind === "multi-key" ? { mode: "fast" } : {}) });
  const adapter = createOpenAIChatAdapter(provider);
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: false, options: {}, context: {
    messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [execTool],
  } });
  const events = await adapter.parseResponse!(Response.json({
    choices: [{ message: { content, tool_calls: [
      { id: "call_doubled", function: { name: "exec", arguments: doubledArguments } },
      { id: "call_raw", function: { name: "exec", arguments: script } },
    ] }, finish_reason: "tool_calls" }],
  }), createTestTranslatorBudget());

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: doubledArguments },
    { type: "tool_call_delta", arguments: script },
  ]);
});

test("streamed Chat responses keep doubled input when two structured calls qualify", async () => {
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const content = block + block;
  const argumentsText = JSON.stringify({ input: script + script });
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {}, context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] } });
  const frames = [
    { choices: [{ delta: { content: content.slice(0, 40) } }] },
    { choices: [{ delta: { content: content.slice(40) } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_one", function: { name: "exec", arguments: argumentsText } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_two", function: { name: "exec", arguments: argumentsText } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response(body))) if (event.type !== "heartbeat") events.push(event);

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: argumentsText },
    { type: "tool_call_delta", arguments: argumentsText },
  ]);
});

test("streamed Chat responses keep two competing doubled calls with a raw trailing newline", async () => {
  const script = "text('ok');";
  const content = `<tool_call><function=exec>${script}</parameter></function></tool_call>`.repeat(2);
  const jsonArguments = JSON.stringify({ input: script + script });
  const rawArguments = script + script + "\n";
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {}, context: {
    messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [execTool],
  } });
  const frames = [
    { choices: [{ delta: { content: content.slice(0, 40) } }] },
    { choices: [{ delta: { content: content.slice(40) } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_json", function: { name: "exec", arguments: jsonArguments } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_raw", function: { name: "exec", arguments: rawArguments } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n"))) {
    if (event.type !== "heartbeat") events.push(event);
  }

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: jsonArguments },
    { type: "tool_call_delta", arguments: rawArguments },
  ]);
});

test.each([["json", "json"], ["raw", "json"], ["raw", "raw"], ["raw", "multi-key"]] as const)("streamed Chat responses keep markup beside a %s agreeing call and %s doubled input", async (agreeKind, doubledKind) => {
  const script = "text('ok');";
  const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
  const content = block + block;
  const doubledArguments = doubledKind === "raw" ? script + script : JSON.stringify({ input: script + script, ...(doubledKind === "multi-key" ? { mode: "fast" } : {}) });
  const singleArguments = agreeKind === "raw" ? script : `{"input":"${script}"}`;
  const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
  adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {}, context: { messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [execTool] } });
  const frames = [
    { choices: [{ delta: { content: content.slice(0, 40) } }] },
    { choices: [{ delta: { content: content.slice(40) } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_doubled", function: { name: "exec", arguments: doubledArguments } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_single", function: { name: "exec", arguments: singleArguments } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(new Response(body))) if (event.type !== "heartbeat") events.push(event);

  expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: content }]);
  expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
    { type: "tool_call_delta", arguments: doubledArguments },
    { type: "tool_call_delta", arguments: singleArguments },
  ]);
});

test("buffered Chat responses preserve serialized markup for a different function", async () => {
  const content = "<tool_call><function=other>literal example</function></tool_call>";
  const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
    choices: [{
      message: {
        content,
        tool_calls: [{ id: "call_exec", function: { name: "exec", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }],
  }), createTestTranslatorBudget());

  expect(events.find(event => event.type === "text_delta")).toEqual({ type: "text_delta", text: content });
});

test("an open serialized block charges only its appended bytes", () => {
  const open = "<tool_call><function=exec>";
  const body = "x".repeat(open.length);
  // Rebuilding the whole buffer would reserve the new total beside the retained
  // text, so this exact budget only admits the append when it charges the delta.
  const budget = createTestTranslatorBudget({ maxTurnBytes: open.length + body.length });
  const buffer = new SerializedToolCallContentBuffer(budget);

  expect(buffer.ingest(open)).toBe("");
  expect(buffer.ingest(body)).toBe("");
  expect(buffer.current()).toBe(open + body);
  expect(budget.snapshot()).toMatchObject({ currentBytes: open.length + body.length, overflows: 0 });

  expect(buffer.flush([])).toBe(open + body);
  expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 0 });
});
describe("MiMo echo variants (#5724)", () => {
  const script = 'const r = await tools.exec_command({cmd:"Get-Content a.txt"}); text(r.output);';
  const call = (input: string) => ({ index: 0, id: "call_exec", function: { name: "exec", arguments: JSON.stringify({ input }) } });

  async function streamed(content: string, input: string): Promise<AdapterEvent[]> {
    const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
    adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {}, context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] } });
    const frames = [
      { choices: [{ delta: { content: content.slice(0, 30) } }] },
      { choices: [{ delta: { content: content.slice(30) } }] },
      { choices: [{ delta: { tool_calls: [call(input)] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body))) if (event.type !== "heartbeat") events.push(event);
    return events;
  }
  async function buffered(content: string, input: string): Promise<AdapterEvent[]> {
    return createOpenAIChatAdapter(provider).parseResponse!(Response.json({
      choices: [{ message: { content, tool_calls: [call(input)] }, finish_reason: "tool_calls" }],
    }), createTestTranslatorBudget());
  }
  const visible = (events: AdapterEvent[]): string => events
    .map(event => (event.type === "text_delta" ? event.text : ""))
    .join("");

  test.each([
    ["the header is followed by a template newline", `<tool_call><function=exec>\n${script}\n</parameter></function></tool_call>`],
    ["the echo omits </function>", `<tool_call><function=exec>${script}</parameter></tool_call>`],
  ])("a matching block is removed when %s", async (_label, block) => {
    for (const events of [await streamed(`Reading.\n${block}`, script), await buffered(`Reading.\n${block}`, script)]) {
      expect(visible(events)).toBe("Reading.\n");
      expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(1);
    }
  });

  test("an unclosed block with a different body stays visible", async () => {
    const block = "<tool_call><function=exec>text('other');</parameter></tool_call>";
    for (const events of [await streamed(block, script), await buffered(block, script)]) {
      expect(visible(events)).toBe(block);
    }
  });

  test("a repeated block pair inside a Markdown fence keeps its doubled input and stays visible", async () => {
    // The fence opener lands in the first streamed chunk, so the buffer carries an open fence
    // when the identical pair arrives. Fenced markup is user-visible, so neither the arguments
    // nor the text may change: the reduction and the suppression scan must read the same context.
    const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
    const content = `Look at this example here\n\`\`\`\n${block}${block}`;
    for (const events of [await streamed(content, script + script), await buffered(content, script + script)]) {
      expect(visible(events)).toBe(content);
      expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
        { type: "tool_call_delta", arguments: JSON.stringify({ input: script + script }) },
      ]);
    }
  });

  test("a fenced echo does not repair the malformed argument prefix beside it", async () => {
    // The prefix repair reads the same held text through its own `callsIn` scan, so the fenced
    // pair must not prove an echo there either: the arguments the gateway sent stay untouched.
    const block = `<tool_call><function=exec>${script}</parameter></function></tool_call>`;
    const argumentsText = script + JSON.stringify({ input: script });
    const content = `Look at this example here\n\`\`\`\n${block}${block}`;
    const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(provider));
    adapter.buildRequest({ modelId: "mimo-v2.6-pro", stream: true, options: {}, context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] } });
    const frames = [
      { choices: [{ delta: { content: content.slice(0, 30) } }] },
      { choices: [{ delta: { content: content.slice(30) } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_exec", function: { name: "exec", arguments: argumentsText } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ];
    const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(body))) if (event.type !== "heartbeat") events.push(event);

    expect(visible(events)).toBe(content);
    expect(events.filter(event => event.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", arguments: argumentsText },
    ]);
  });

  test("a closed block whose body carries literal tool-call tags is still matched whole", async () => {
    for (const input of [
      "text('</tool_call>');",
      "text('<tool_call>');",
      'text("<tool_call><function=exec>");',
      'const s = `\n<tool_call><function=exec>`;\ntext(s);',
    ]) {
      const block = `<tool_call><function=exec>${input}</parameter></function></tool_call>`;
      for (const events of [await streamed(block, input), await buffered(block, input)]) {
        expect(visible(events)).toBe("");
      }
    }
  });

  test("an unclosed block followed by a closed block is read as two blocks", async () => {
    const first = "text('a');";
    const second = "text('b');";
    const content = `<tool_call><function=exec>${first}</parameter></tool_call>\n<tool_call><function=exec>${second}</parameter></function></tool_call>`;
    const events = await createOpenAIChatAdapter(provider).parseResponse!(Response.json({
      choices: [{
        message: { content, tool_calls: [call(first), { ...call(second), index: 1, id: "call_exec_2" }] },
        finish_reason: "tool_calls",
      }],
    }), createTestTranslatorBudget());
    expect(visible(events)).toBe("\n");
    expect(events.filter(event => event.type === "tool_call_start")).toHaveLength(2);
  });
});
