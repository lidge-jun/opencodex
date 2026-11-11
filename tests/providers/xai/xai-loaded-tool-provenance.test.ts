import { expect, test } from "bun:test";
import { createResponsesPassthroughAdapter } from "../../../src/adapters/openai-responses";
import { promoteClientLoadedTools } from "../../../src/adapters/openai-responses/tool-schema";
import { tagHistoricalInputItems } from "../../../src/responses/item-provenance";
import { handleResponses } from "../../../src/server/responses";
import type { OcxConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const live = { type: "function", name: "live", parameters: { type: "object", properties: {} } };
const retired = { type: "web_search", name: "retired_search" };
const current = { type: "web_search", name: "current_search" };
const wrap = (tools: unknown[]) => ({ type: "additional_tools", tools });
const discovery = (tools: unknown[]) => ({ type: "tool_search_output", call_id: "search", tools });
const provider = {
  adapter: "openai-responses", baseUrl: "https://api.x.ai/v1", authMode: "key",
  apiKey: "fixture-key", xaiResponsesXSearch: true,
};

for (const catalog of ["wrapper", "top-level", "fallback"] as const) {
  for (const historical of [true, false]) {
    test(`${catalog}: ${historical ? "historical" : "current"} discoveries keep their authority boundary`, () => {
      const input = [discovery([retired]), ...(catalog === "wrapper" ? [wrap([live])] : [])];
      const raw = { input, ...(catalog === "top-level" ? { tools: [live] } : {}) };
      const before = JSON.stringify(raw);
      const body = JSON.parse(withTestTranslatorBudget(createResponsesPassthroughAdapter(provider)).buildRequest({
        modelId: "grok-4.7", context: { messages: [] }, stream: false, options: {},
        _rawBody: raw, _replayPrefixLen: historical ? 1 : 0,
      }, { headers: new Headers() }).body);
      const declared = catalog === "fallback" ? [] : [live];
      const active = catalog === "wrapper" ? [{ type: "x_search" }, ...declared, retired]
        : [...declared, retired, { type: "x_search" }];
      expect(body.tools ?? []).toEqual(historical ? declared : active);
      expect(JSON.stringify(raw)).toBe(before);
      expect(input.every(item => Object.getOwnPropertySymbols(item).length === 0)).toBe(true);
    });
  }

  test(`${catalog}: source tags override stale positions after reordering`, () => {
    const [oldResult, liveResult, wrapper] = tagHistoricalInputItems([
      discovery([retired]), discovery([current]), wrap([live]),
    ], 1);
    const body = {
      input: [liveResult, oldResult, ...(catalog === "wrapper" ? [wrapper] : [])],
      ...(catalog === "top-level" ? { tools: [live] } : {}),
    };
    const loaded = promoteClientLoadedTools(body, body.input.length) as {
      tools?: unknown[]; input: Array<{ type: string; tools?: unknown[] }>;
    };
    const declared = catalog === "fallback" ? [] : [live];
    expect(catalog === "wrapper" ? loaded.input.at(-1)?.tools : loaded.tools).toEqual([...declared, current]);
    expect(body.input).toEqual([liveResult, oldResult, ...(catalog === "wrapper" ? [wrapper] : [])]);
  });

  test(`${catalog}: untagged callers use the original replay prefix for discoveries`, () => {
    const body = {
      input: [discovery([retired]), discovery([current]), ...(catalog === "wrapper" ? [wrap([live])] : [])],
      ...(catalog === "top-level" ? { tools: [live] } : {}),
    };
    const loaded = promoteClientLoadedTools(body, 1) as {
      tools?: unknown[]; input: Array<{ type: string; tools?: unknown[] }>;
    };
    expect(catalog === "wrapper" ? loaded.input.at(-1)?.tools : loaded.tools)
      .toEqual([...(catalog === "fallback" ? [] : [live]), current]);
  });
}

for (const catalog of ["wrapper", "top-level", "fallback"] as const) {
  for (const source of ["historical", "current", "absent"] as const) {
    test(`two-turn ${catalog}: ${source} discovery retains only current hosted declarations`, async () => {
      const savedFetch = globalThis.fetch;
      const releaseHome = acquireOwnedSpendHome();
      const responseId = `resp_loaded_provenance_${catalog}_${source}`;
      const outbound: Array<{ tools?: Array<Record<string, unknown>> }> = [];
      const hostedCall = {
        type: "custom_tool_call", id: "ctc_provenance", call_id: "xs_call-round3",
        name: "x_keyword_search", input: "{}", status: "completed",
      };
      globalThis.fetch = (async (_input, init) => {
        outbound.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: outbound.length === 1 ? responseId : `${responseId}_next`, status: "completed",
          output: outbound.length === 1
            ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]
            : [hostedCall],
        });
      }) as typeof fetch;
      const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: provider } };
      const post = (body: Record<string, unknown>) => handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture/grok-4.7", stream: false, ...body }),
      }), config, { model: "", provider: "" });
      try {
        const first = await post({ input: [
          wrap([{ type: "web_search" }]), ...(source === "historical" ? [discovery([retired])] : []),
          { role: "user", content: "old search" },
        ] });
        expect(first.status).toBe(200);
        await first.text();
        const second = await post({
          previous_response_id: responseId,
          input: [
            ...(catalog === "wrapper" ? [wrap([live])] : []),
            ...(source === "current" ? [discovery([current])] : []),
            { role: "user", content: "continue" },
          ],
          ...(catalog === "top-level" ? { tools: [live] } : {}),
        });
        const result = await second.json() as { output?: unknown[]; error?: { code?: string } };
        expect(outbound).toHaveLength(2);
        // An omitted catalog leaves call handling to the client; an explicit live catalog
        // activates the server guard. Both paths must exclude historical outbound authority.
        const accepted = source === "current" || catalog === "fallback";
        expect(second.status).toBe(accepted ? 200 : 502);
        if (accepted) expect(result.output).toEqual([hostedCall]);
        else expect(result.error?.code).toBe("undeclared_tool_call");
        const declared = catalog === "fallback" ? [] : [live];
        const active = catalog === "wrapper" ? [{ type: "x_search" }, ...declared, current]
          : [...declared, current, { type: "x_search" }];
        expect(outbound[1]?.tools ?? [])
          .toEqual(source === "current" ? active : declared);
      } finally {
        globalThis.fetch = savedFetch;
        releaseHome();
      }
    });
  }
}
