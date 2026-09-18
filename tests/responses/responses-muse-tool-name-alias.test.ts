import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../../src/adapters/openai-responses";
import {
  buildMuseToolNameAliasPlan,
  museWireToolName,
  restoreMuseToolNames,
  restoreMuseToolNamesInJson,
  rewriteMuseToolNamesForUpstream,
} from "../../src/responses/muse-tool-name-alias";
import { expandPreviousResponseInput } from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

function sha8(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function hashedName(original: string, salt = 0): string {
  const cleaned = original.replace(/[^a-zA-Z0-9_-]/g, "_");
  const base = cleaned.slice(0, 55) || "tool";
  const hashInput = salt === 0 ? original : original + "#" + salt;
  return base + "_" + sha8(hashInput);
}

describe("muse tool-name alias algorithm", () => {
  test("a 64-char conforming name passes through verbatim", () => {
    const name = "a".repeat(64);
    expect(name.length).toBe(64);
    expect(museWireToolName(name)).toBe(name);
    const plan = buildMuseToolNameAliasPlan([name]);
    expect(plan.wireByOriginal.get(name)).toBe(name);
    expect(plan.aliases.size).toBe(0);
  });

  test("65, 66, and 93-char names map deterministically to a 64-char hashed wire name", () => {
    for (const length of [65, 66, 93]) {
      const original = "n".repeat(length);
      const wire = museWireToolName(original);
      expect(wire).toBe(hashedName(original));
      expect(wire.length).toBe(64);
      expect(wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(museWireToolName(original)).toBe(wire);
    }
  });

  test("non-conforming charset is rewritten through the hashed form, never left with spaces or punctuation", () => {
    const original = "workspace agents_create_agent";
    const wire = museWireToolName(original);
    expect(wire).toBe(hashedName(original));
    expect(wire).not.toContain(" ");
    expect(wire).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  test("all-unsafe characters keep the underscore prefix plus hash of the original", () => {
    const original = "!!!";
    // sanitize("!!!") is "___", which is truthy, so the "tool" fallback does not fire.
    expect(museWireToolName(original)).toBe("____" + sha8(original));
    expect(museWireToolName(original)).toBe(hashedName(original));
  });

  test("empty input falls back to a tool_ prefix plus hash of the original", () => {
    expect(museWireToolName("")).toBe("tool_" + sha8(""));
    expect(museWireToolName("")).toBe(hashedName(""));
  });

  test("two long names sharing a 55-char prefix stay distinct", () => {
    const prefix = "mcp__plugin_android-emulator_android-emulator__android_";
    expect(prefix.length).toBe(55);
    const a = prefix + "install_app_extra_padding";
    const b = prefix + "uninstall_app_extra_pad";
    expect(a.length).toBeGreaterThan(64);
    expect(b.length).toBeGreaterThan(64);
    const sanitizedPrefix = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55);
    expect(sanitizedPrefix(a)).toBe(prefix);
    expect(sanitizedPrefix(b)).toBe(prefix);
    const plan = buildMuseToolNameAliasPlan([a, b]);
    const wireA = plan.wireByOriginal.get(a)!;
    const wireB = plan.wireByOriginal.get(b)!;
    expect(wireA).not.toBe(wireB);
    expect(wireA).toBe(hashedName(a));
    expect(wireB).toBe(hashedName(b));
    expect(wireA.length).toBeLessThanOrEqual(64);
    expect(wireB.length).toBeLessThanOrEqual(64);
    expect(plan.aliases.get(wireA)).toBe(a);
    expect(plan.aliases.get(wireB)).toBe(b);
  });

  test("two-phase claim reserves pass-through names before hashing long ones", () => {
    const long = "L".repeat(70);
    const claimed = hashedName(long);
    expect(claimed.length).toBeLessThanOrEqual(64);
    // Long name is declared first; a later conforming name equals its unsalted hash.
    // Two-phase still gives the conforming name the verbatim identity and salts the long one.
    const plan = buildMuseToolNameAliasPlan([long, claimed]);
    expect(plan.wireByOriginal.get(claimed)).toBe(claimed);
    expect(plan.wireByOriginal.get(long)).toBe(hashedName(long, 1));
    expect(plan.aliases.get(claimed)).toBeUndefined();
    expect(plan.aliases.get(hashedName(long, 1))).toBe(long);
  });

  test("salt loop uses original#N and stays within 64 chars", () => {
    const long = "collision-prefix/" + "x".repeat(80);
    const first = hashedName(long);
    const used = new Set<string>([first]);
    const wire = museWireToolName(long, used);
    expect(wire).toBe(hashedName(long, 1));
    expect(wire.length).toBeLessThanOrEqual(64);
  });
});

describe("muse tool-name body rewrite", () => {
  const longName = "mcp__plugin_huggingface-skills_huggingface-skills__hub_repo_search";
  const shortName = "read_file";

  test("rewrites tools, history calls, tool_choice, additional_tools, and chat-shaped function.name", () => {
    const body = {
      model: "muse-spark-1.3",
      input: [
        { type: "function_call", name: longName, call_id: "c1", arguments: "{\"path\":\"" + longName + "\"}" },
        { type: "custom_tool_call", name: longName, call_id: "c2", input: longName },
        { type: "additional_tools", tools: [{ type: "function", name: longName, parameters: { type: "object", properties: { path: { type: "string" } } } }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "use " + longName }] },
      ],
      tools: [
        { type: "function", name: longName, parameters: { type: "object", properties: { name: { type: "string" } } } },
        { type: "function", name: shortName, parameters: { type: "object" } },
        { type: "function", function: { name: longName, description: "chat-shaped", parameters: { type: "object" } } },
      ],
      tool_choice: { type: "function", name: longName },
    };
    const rewritten = rewriteMuseToolNamesForUpstream(body);
    const wire = hashedName(longName);
    expect(wire.length).toBeLessThanOrEqual(64);
    const tools = rewritten.body as { tools: Array<Record<string, unknown>>; input: Array<Record<string, unknown>>; tool_choice: { name: string } };
    expect((tools.tools[0] as { name: string }).name).toBe(wire);
    expect((tools.tools[1] as { name: string }).name).toBe(shortName);
    expect(((tools.tools[2] as { function: { name: string } }).function).name).toBe(wire);
    expect(tools.tool_choice.name).toBe(wire);
    expect(tools.input[0]).toMatchObject({ type: "function_call", name: wire, arguments: "{\"path\":\"" + longName + "\"}" });
    expect(tools.input[1]).toMatchObject({ type: "custom_tool_call", name: wire, input: longName });
    expect(((tools.input[2].tools as Array<{ name: string }>)[0]).name).toBe(wire);
    expect((tools.input[3].content as Array<{ text: string }>)[0].text).toContain(longName);
    expect(JSON.stringify((tools.tools[0] as { parameters: unknown }).parameters)).toContain('"name"');
    expect(rewritten.aliases.get(wire)).toBe(longName);
  });

  test("allowed_tools selectors are rewritten too", () => {
    const body = {
      tools: [{ type: "function", name: longName, parameters: {} }],
      tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: longName }] },
    };
    const rewritten = rewriteMuseToolNamesForUpstream(body);
    const wire = hashedName(longName);
    expect((rewritten.body as { tool_choice: { tools: Array<{ name: string }> } }).tool_choice.tools[0]!.name).toBe(wire);
  });

  // Codex review on #4422: upstream still sees the whole aliased catalog, but a tool the
  // caller disabled for this turn must not be restorable into an executable client name.
  test("tool_choice narrows what may be restored, matching the namespace layer", () => {
    const other = "mcp__plugin_android-emulator_android-emulator__android_install_app";
    const declare = () => ({
      tools: [
        { type: "function", name: longName, parameters: {} },
        { type: "function", name: other, parameters: {} },
      ],
    });

    expect(rewriteMuseToolNamesForUpstream(declare()).aliases.size).toBe(2);
    expect(rewriteMuseToolNamesForUpstream({ ...declare(), tool_choice: "auto" }).aliases.size).toBe(2);

    const none = rewriteMuseToolNamesForUpstream({ ...declare(), tool_choice: "none" });
    expect(none.aliases.size).toBe(0);
    expect((none.body as { tools: Array<{ name: string }> }).tools[0]!.name).toBe(hashedName(longName));

    const picked = rewriteMuseToolNamesForUpstream({
      ...declare(),
      tool_choice: { type: "function", name: longName },
    });
    expect([...picked.aliases.values()]).toEqual([longName]);

    const allowed = rewriteMuseToolNamesForUpstream({
      ...declare(),
      tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: other }] },
    });
    expect([...allowed.aliases.values()]).toEqual([other]);
  });
});

describe("muse tool-name restore", () => {
  const original = "mcp__plugin_huggingface-skills_huggingface-skills__hub_repo_search";
  const wire = hashedName(original);
  const aliases = new Map([[wire, original]]);

  test("restores a hashed function_call and leaves unknown names alone", () => {
    const restored = restoreMuseToolNames({
      output: [
        { type: "function_call", name: wire, arguments: "{\"x\":1}" },
        { type: "function_call", name: "read_file", arguments: "{}" },
      ],
    }, aliases);
    expect(restored.changed).toBe(true);
    expect(restored.value).toEqual({
      output: [
        { type: "function_call", name: original, arguments: "{\"x\":1}" },
        { type: "function_call", name: "read_file", arguments: "{}" },
      ],
    });
  });

  test("restores tool_choice echo shapes including allowed_tools", () => {
    expect(restoreMuseToolNames({ type: "function", name: wire }, aliases).value)
      .toEqual({ type: "function", name: original });
    expect(restoreMuseToolNames({
      type: "allowed_tools",
      tools: [{ type: "function", name: wire }, { type: "custom", name: wire }],
    }, aliases).value).toEqual({
      type: "allowed_tools",
      tools: [{ type: "function", name: original }, { type: "custom", name: original }],
    });
  });

  test("restores chat-shaped function.name and JSON payloads", () => {
    const payload = { type: "function", function: { name: wire, description: "x" } };
    expect(restoreMuseToolNames(payload, aliases).value)
      .toEqual({ type: "function", function: { name: original, description: "x" } });
    expect(JSON.parse(restoreMuseToolNamesInJson(JSON.stringify({
      type: "response.output_item.added",
      item: { type: "function_call", name: wire, arguments: "{}" },
    }), aliases))).toMatchObject({
      item: { type: "function_call", name: original },
    });
    expect(restoreMuseToolNamesInJson("not-json", aliases)).toBe("not-json");
  });
});

describe("muse tool-name inbound restore through handleResponses", () => {
  const original = "mcp__plugin_huggingface-skills_huggingface-skills__hub_repo_search";
  const wire = hashedName(original);
  const config = {
    port: 0,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-responses",
        baseUrl: "https://api.meta.ai/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;

  const frame = (event: string, payload: Record<string, unknown>): string =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...payload })}`;

  test("non-stream function_call and tool_choice restore the original MCP name", async () => {
    const savedFetch = globalThis.fetch;
    let outbound: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      outbound = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "resp_json",
        status: "completed",
        tool_choice: { type: "function", name: wire },
        output: [{ type: "function_call", name: wire, call_id: "c1", arguments: "{\"q\":\"x\"}" }],
      }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/muse-spark-1.3",
          stream: false,
          input: "search",
          tools: [{ type: "function", name: original, parameters: { type: "object" } }],
          tool_choice: { type: "function", name: original },
        }),
      }), config, { model: "", provider: "" });
      const json = await response.json() as { output: Array<Record<string, unknown>>; tool_choice?: { name: string } };
      expect((outbound?.tools as Array<{ name: string }>)[0]!.name).toBe(wire);
      expect((outbound?.tool_choice as { name: string }).name).toBe(wire);
      expect(json.output[0]).toMatchObject({ type: "function_call", name: original });
      expect(json.tool_choice?.name).toBe(original);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("streamed output_item.added with a hashed name restores the original", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const item = { type: "function_call", name: wire, call_id: "c1", arguments: "{}", status: "completed" };
      const upstream = [
        frame("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }),
        frame("response.output_item.done", { output_index: 0, item }),
        frame("response.completed", { response: { id: "resp_stream", status: "completed", output: [item] } }),
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/muse-spark-1.3",
          stream: true,
          input: "search",
          tools: [{ type: "function", name: original, parameters: { type: "object" } }],
        }),
      }), config, { model: "", provider: "" });
      const clientSse = await response.text();
      expect(clientSse).toContain(`"name":"${original}"`);
      expect(clientSse).not.toContain(`"name":"${wire}"`);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  // #4410: the undeclared-tool guard reads `name` straight off this event, outside any
  // function_call item, so a hashed alias here would still look like an undeclared tool.
  test("streamed response.function_call_arguments.done restores the original name", async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const item = { type: "function_call", name: wire, call_id: "c1", arguments: "{}", status: "completed" };
      const upstream = [
        frame("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }),
        frame("response.function_call_arguments.done", { item_id: "fc_1", output_index: 0, name: wire, arguments: "{}" }),
        frame("response.output_item.done", { output_index: 0, item }),
        frame("response.completed", { response: { id: "resp_args", status: "completed", output: [item] } }),
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/muse-spark-1.3",
          stream: true,
          input: "search",
          tools: [{ type: "function", name: original, parameters: { type: "object" } }],
        }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      const clientSse = await response.text();
      expect(clientSse).toContain("response.function_call_arguments.done");
      expect(clientSse).toContain(`"name":"${original}"`);
      expect(clientSse).not.toContain(`"name":"${wire}"`);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("undeclared-tool guard does not fire on a continuation that echoes the hashed name", async () => {
    const savedFetch = globalThis.fetch;
    let turn = 1;
    const outboundBodies: Array<Record<string, unknown>> = [];
    const item = {
      type: "function_call",
      id: "fc_1",
      call_id: "c1",
      name: wire,
      arguments: "{}",
      status: "completed",
    };
    globalThis.fetch = (async (_input, init) => {
      outboundBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (turn === 2) {
        return new Response(JSON.stringify({
          id: "resp_turn2",
          status: "completed",
          output: [{ type: "function_call", name: wire, call_id: "c2", arguments: "{}" }],
        }), { headers: { "content-type": "application/json" } });
      }
      turn += 1;
      const upstream = [
        frame("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }),
        frame("response.output_item.done", { output_index: 0, item }),
        frame("response.completed", { response: { id: "resp_turn1", status: "completed", output: [item] } }),
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
      return new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      const turn1 = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/muse-spark-1.3",
          stream: true,
          input: "search",
          tools: [{ type: "function", name: original, parameters: { type: "object" } }],
        }),
      }), config, { model: "", provider: "" });
      expect(turn1.status).toBe(200);
      const turn1Text = await turn1.text();
      expect(turn1Text).toContain('"name":"' + original + '"');
      expect(turn1Text).not.toContain('"name":"' + wire + '"');

      const deadline = Date.now() + 2_000;
      let cachedInput: Array<Record<string, unknown>> | undefined;
      while (Date.now() < deadline) {
        const expanded = expandPreviousResponseInput({
          previous_response_id: "resp_turn1",
          input: [{ type: "function_call_output", call_id: "c1", output: "ok" }],
        }) as { input?: Array<Record<string, unknown>> };
        const items = expanded.input ?? [];
        if (items.some(entry => entry.type === "function_call" && entry.call_id === "c1")) {
          cachedInput = items;
          break;
        }
        await Bun.sleep(5);
      }
      if (!cachedInput) {
        throw new Error("continuation cache did not record resp_turn1");
      }
      expect(cachedInput).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "search" }),
        expect.objectContaining({ type: "function_call", id: "fc_1", call_id: "c1", name: original }),
        expect.objectContaining({ type: "function_call_output", call_id: "c1", output: "ok" }),
      ]));

      const response = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fixture/muse-spark-1.3",
          stream: false,
          previous_response_id: "resp_turn1",
          input: [
            { type: "function_call_output", call_id: "c1", output: "ok" },
          ],
          tools: [{ type: "function", name: original, parameters: { type: "object" } }],
        }),
      }), config, { model: "", provider: "" });
      expect(response.status).toBe(200);
      const json = await response.json() as { output: Array<Record<string, unknown>>; error?: unknown };
      expect(json.error).toBeUndefined();
      expect(json.output[0]).toMatchObject({ type: "function_call", name: original });
      expect(outboundBodies).toHaveLength(2);
      const replayed = outboundBodies[1]!.input as Array<Record<string, unknown>>;
      expect(replayed).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "search" }),
        expect.objectContaining({ type: "function_call", id: "fc_1", call_id: "c1", name: wire }),
        expect.objectContaining({ type: "function_call_output", call_id: "c1", output: "ok" }),
      ]));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test("adapter sidecar is populated for api.meta.ai and omitted otherwise", () => {
    const meta = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.meta.ai/v1",
      apiKey: "test-key",
    } as never);
    const other = createResponsesPassthroughAdapter({
      adapter: "openai-responses",
      baseUrl: "https://api.x.ai/v1",
      apiKey: "test-key",
    } as never);
    const parsed = {
      modelId: "muse-spark-1.3",
      context: { messages: [] },
      stream: false,
      options: {},
      _rawBody: {
        model: "muse-spark-1.3",
        input: "ping",
        tools: [{ type: "function", name: original, parameters: { type: "object" } }],
      },
    };
    const metaReq = meta.buildRequest(parsed as never, { headers: new Headers() });
    const otherReq = other.buildRequest(parsed as never, { headers: new Headers() });
    expect(metaReq.convertedMuseToolNameAliases?.get(wire)).toBe(original);
    expect(otherReq.convertedMuseToolNameAliases).toBeUndefined();
    expect(JSON.parse(otherReq.body).tools[0].name).toBe(original);
  });
});
