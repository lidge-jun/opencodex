import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import { restoreRoutedCustomCallsInJson, rewriteRoutedCustomToolsForUpstream } from "../../src/responses/custom-tool-compat";
import { compileCodeModeHelperInput } from "../../src/responses/code-mode-helper-compat";
import { parseRequest } from "../../src/responses/parser";
import { buildToolBridgeMaps } from "../../src/server/responses";
import { createRoutedCustomToolRestoreBlockRewrite } from "../../src/server/responses-custom-tool-repair";
import {
  collectDeclaredBareCustomWireToolNames,
  currentTurnWireToolCatalogBody,
  undeclaredToolCallNameInResponse,
} from "../../src/server/responses-undeclared-tool-guard";
import type { AdapterEvent } from "../../src/types";
import { isCodeModeMcpDirectName, normalizeDeclaredToolName } from "../../src/types/tools";
import { dataPayload, frame } from "../helpers/custom-tool-repair-fixtures";

const CODE_MODE = new Set(["exec"]);
const MCP_NAME = "mcp__codex_app__get_usage_limits";
const CUA_MCP_NAME = "mcp__cua_repl__js";
const CALL = { type: "function_call", id: "fc_mcp", call_id: "call_mcp", name: MCP_NAME, arguments: "{}" };
const CUSTOM_EXEC = { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] };
const FUNCTION_EXEC = { type: "namespace", name: "functions", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] };
const FOREIGN_EXEC = { type: "namespace", name: "mcp__remote", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] };

function mapsFor(tools: unknown[]) {
  const parsed = parseRequest({ model: "test-model", input: "run it", tools });
  return buildToolBridgeMaps(parsed);
}

function eventsFor(name: string): AdapterEvent[] {
  return [
    { type: "tool_call_start", id: "call_mcp", name },
    { type: "tool_call_delta", id: "call_mcp", arguments: "{}" },
    { type: "tool_call_end", id: "call_mcp" },
    { type: "done" },
  ];
}

// Codex Desktop code mode declares only the freeform `exec` shell; every nested host tool
// (`tools.mcp__codex_app__get_usage_limits`, ...) is reachable through it but undeclared.
// Routed models (observed: Kimi K3, GLM 5.3) sometimes call the flattened MCP name directly
// instead of wrapping it in exec JavaScript, and the undeclared-tool guard failed those turns
// closed — visible in the desktop client as "reconnecting N/5" banners. These pin the
// normalization that compiles such a call into the exec body the model could have written.
describe("code-mode direct mcp tool-call recovery", () => {
  test("recognizes only well-formed flattened mcp names", () => {
    expect(isCodeModeMcpDirectName("mcp__codex_app__get_usage_limits")).toBe(true);
    expect(isCodeModeMcpDirectName("mcp__my-server__do_thing")).toBe(true);
    for (const name of ["mcp__", "mcp__server", "mcp____tool", "mcp__server__", "exec_command", "mcp_x__y"]) {
      expect(isCodeModeMcpDirectName(name)).toBe(false);
    }
  });

  test("maps a direct mcp call only through an explicitly custom exec", () => {
    expect(normalizeDeclaredToolName(MCP_NAME, CODE_MODE, undefined, CODE_MODE)).toBe("exec");
    expect(normalizeDeclaredToolName(`default.${MCP_NAME}`, CODE_MODE, undefined, CODE_MODE)).toBe("exec");
    expect(normalizeDeclaredToolName(MCP_NAME, CODE_MODE)).toBe(MCP_NAME);
    expect(normalizeDeclaredToolName(`default.${MCP_NAME}`, CODE_MODE)).toBe(`default.${MCP_NAME}`);
    expect(normalizeDeclaredToolName("mcp__codex_app__get_usage_limits", new Set())).toBe("mcp__codex_app__get_usage_limits");
    // A catalog that declares the name itself keeps the call's own identity.
    expect(normalizeDeclaredToolName(
      "mcp__codex_app__get_usage_limits",
      new Set(["exec", MCP_NAME]), undefined, CODE_MODE,
    )).toBe("mcp__codex_app__get_usage_limits");
    // The flat-bridge shape (legacy shell names declared next to exec) is not code mode.
    expect(normalizeDeclaredToolName(
      "mcp__codex_app__get_usage_limits",
      new Set(["exec", "exec_command"]), undefined, CODE_MODE,
    )).toBe("mcp__codex_app__get_usage_limits");
    // Malformed mcp-ish names stay undeclared.
    expect(normalizeDeclaredToolName("mcp__server", CODE_MODE, undefined, CODE_MODE)).toBe("mcp__server");
    expect(normalizeDeclaredToolName(`default.${MCP_NAME}`, new Set(["exec", `default.${MCP_NAME}`]), undefined, CODE_MODE))
      .toBe(`default.${MCP_NAME}`);
  });

  test("catalog provenance excludes JSON functions and foreign namespace aliases", () => {
    const custom = mapsFor([CUSTOM_EXEC]);
    const ordinary = mapsFor([FUNCTION_EXEC]);
    const foreign = mapsFor([FOREIGN_EXEC]);
    expect(custom.bareCustomToolNames).toEqual(CODE_MODE);
    expect(ordinary.declaredToolNames.has("exec")).toBe(true);
    expect(ordinary.bareCustomToolNames.has("exec")).toBe(false);
    expect(foreign.declaredToolNames.has("exec")).toBe(false);
    expect(foreign.bareCustomToolNames.has("exec")).toBe(false);
    expect(foreign.declaredToolNames.has("mcp__remote__exec")).toBe(true);
    for (const maps of [ordinary, foreign]) {
      expect(normalizeDeclaredToolName(MCP_NAME, maps.declaredToolNames, undefined, maps.bareCustomToolNames)).toBe(MCP_NAME);
    }
  });

  test("an explicitly declared MCP function keeps its namespaced identity", () => {
    const maps = mapsFor([CUSTOM_EXEC, {
      type: "namespace", name: "mcp__codex_app",
      tools: [{ type: "function", name: "get_usage_limits", parameters: { type: "object" } }],
    }]);
    expect(buildResponseJSON(eventsFor(MCP_NAME), "fixture", {
      ...maps, enforceDeclaredToolNames: true,
    }).output).toMatchObject([{
      type: "function_call", name: "get_usage_limits", namespace: "mcp__codex_app", arguments: "{}",
    }]);
  });

  test("compiles the call to the matching nested host tool", () => {
    expect(compileCodeModeHelperInput('{"limit":3}', "mcp__codex_app__list_threads")).toBe(
      'const result = await tools.mcp__codex_app__list_threads({"limit":3});\ntext(result);',
    );
    // A hyphenated name is not one identifier: bracket access addresses the same tool.
    expect(compileCodeModeHelperInput("{}", "mcp__my-server__do_thing")).toBe(
      'const result = await tools["mcp__my-server__do_thing"]({});\ntext(result);',
    );
    // Malformed provider text stays data; nested-tool validation rejects it, not JavaScript.
    expect(compileCodeModeHelperInput("not json", "mcp__x__y")).toBe(
      'const result = await tools.mcp__x__y("not json");\ntext(result);',
    );
    expect(compileCodeModeHelperInput("{}", `default.${MCP_NAME}`)).toBe(
      `const result = await tools.${MCP_NAME}({});\ntext(result);`,
    );
  });

  test("generated JavaScript uses host tool lookup and keeps arguments as data", async () => {
    const args = { query: '"; throw new Error("injected") //', limit: 3 };
    const input = compileCodeModeHelperInput(JSON.stringify(args), MCP_NAME);
    const run = new Function("tools", "text", `return (async () => { ${input} })();`);
    const calls: unknown[] = [];
    const output: unknown[] = [];
    await run({ [MCP_NAME]: async (value: unknown) => { calls.push(value); return "ok"; } }, (value: unknown) => output.push(value));
    expect(calls).toEqual([args]);
    expect(output).toEqual(["ok"]);
    await expect(run({}, () => {})).rejects.toThrow();
  });

  test("guard admits direct calls only with current bare custom provenance", () => {
    const source = { output: [CALL] };
    expect(undeclaredToolCallNameInResponse(source, CODE_MODE, undefined, undefined, undefined, CODE_MODE)).toBeUndefined();
    expect(undeclaredToolCallNameInResponse(
      { output: [{ ...CALL, name: `default.${MCP_NAME}` }] }, CODE_MODE,
      undefined, undefined, undefined, CODE_MODE,
    )).toBeUndefined();
    expect(undeclaredToolCallNameInResponse(source, CODE_MODE)).toBe(MCP_NAME);
    expect(undeclaredToolCallNameInResponse(source, new Set())).toBe(MCP_NAME);
    const current = { tools: [FUNCTION_EXEC], input: [{ type: "additional_tools", tools: [CUSTOM_EXEC] }] };
    expect(collectDeclaredBareCustomWireToolNames(current)).toEqual(CODE_MODE);
    expect(collectDeclaredBareCustomWireToolNames(currentTurnWireToolCatalogBody(current, 1))).toEqual(new Set());
    expect(collectDeclaredBareCustomWireToolNames({ tools: [FOREIGN_EXEC] })).toEqual(new Set());
    expect(undeclaredToolCallNameInResponse(
      { output: [{ ...CALL, name: "get_usage_limits", namespace: "mcp__codex_app" }] },
      CODE_MODE, undefined, undefined, undefined, CODE_MODE,
    )).toBe("get_usage_limits");
    // A name that only looks mcp-ish is still blocked under a code-mode catalog.
    const malformed = {
      output: [{ type: "function_call", id: "fc_x", call_id: "call_x", name: "mcp__solo", arguments: "{}" }],
    };
    expect(undeclaredToolCallNameInResponse(malformed, CODE_MODE, undefined, undefined, undefined, CODE_MODE)).toBe("mcp__solo");
  });

  test("restores a recorded direct mcp call as the declared exec", () => {
    const source = { output: [CALL] };
    const restored = JSON.parse(restoreRoutedCustomCallsInJson(
      JSON.stringify(source),
      CODE_MODE,
      new Set(),
      CODE_MODE,
    ));
    expect(restored.output).toMatchObject([{
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_mcp",
      input: 'const result = await tools.mcp__codex_app__get_usage_limits({});\ntext(result);',
    }]);
    expect(undeclaredToolCallNameInResponse(restored, CODE_MODE)).toBeUndefined();
  });

  test("restores a direct cua_repl call when exec stays native custom", () => {
    const native = rewriteRoutedCustomToolsForUpstream(
      { tools: [CUSTOM_EXEC] },
      undefined,
      CODE_MODE,
    );
    expect(native.names).toEqual(new Set());
    expect(native.repairNames).toEqual(CODE_MODE);

    const source = {
      output: [{
        type: "function_call",
        id: "fc_cua",
        call_id: "call_cua",
        name: CUA_MCP_NAME,
        arguments: '{"code":"1+1"}',
      }],
    };
    const withoutRecovery = restoreRoutedCustomCallsInJson(
      JSON.stringify(source),
      native.names,
      native.repairNames,
      CODE_MODE,
    );
    expect(JSON.parse(withoutRecovery).output[0]).toMatchObject({
      type: "function_call",
      name: CUA_MCP_NAME,
    });

    const restored = JSON.parse(restoreRoutedCustomCallsInJson(
      JSON.stringify(source),
      native.names,
      native.repairNames,
      CODE_MODE,
      CODE_MODE,
    ));
    expect(restored.output[0]).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_cua",
      input: 'const result = await tools.mcp__cua_repl__js({"code":"1+1"});\ntext(result);',
    });
  });

  test("native custom exec SSE recovery compiles direct cua_repl into exec", () => {
    const native = rewriteRoutedCustomToolsForUpstream(
      { tools: [CUSTOM_EXEC] },
      undefined,
      CODE_MODE,
    );
    const rewrite = createRoutedCustomToolRestoreBlockRewrite(
      native.names,
      undefined,
      native.repairNames,
      CODE_MODE,
      CODE_MODE,
    );
    const added = rewrite(frame("response.output_item.added", {
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_cua",
        call_id: "call_cua",
        name: CUA_MCP_NAME,
        arguments: "",
        status: "in_progress",
      },
    }));
    expect(dataPayload(added[0]!).item).toMatchObject({
      type: "custom_tool_call",
      name: "exec",
      call_id: "call_cua",
    });
    const done = rewrite(frame("response.function_call_arguments.done", {
      output_index: 0,
      item_id: "fc_cua",
      arguments: '{"code":"1+1"}',
    }));
    expect(dataPayload(done[0]!)).toMatchObject({
      type: "response.custom_tool_call_input.done",
      item_id: "ctc_cua",
      input: 'const result = await tools.mcp__cua_repl__js({"code":"1+1"});\ntext(result);',
    });
    rewrite.dispose?.();
  });

  test("native SSE restoration compiles only a converted custom exec call", () => {
    for (const name of [MCP_NAME, `default.${MCP_NAME}`]) {
      const customNames = rewriteRoutedCustomToolsForUpstream({ tools: [CUSTOM_EXEC] }, false).names;
      const rewrite = createRoutedCustomToolRestoreBlockRewrite(customNames, undefined, new Set(), CODE_MODE);
      const added = rewrite(frame("response.output_item.added", {
        output_index: 0,
        item: { ...CALL, id: "fc_native", name, arguments: "", status: "in_progress" },
      }));
      expect(dataPayload(added[0]!).item).toMatchObject({ type: "custom_tool_call", name: "exec" });
      const done = rewrite(frame("response.function_call_arguments.done", {
        output_index: 0, item_id: "fc_native", arguments: "{}",
      }));
      expect(dataPayload(done[0]!).input).toBe(`const result = await tools.${MCP_NAME}({});\ntext(result);`);
      rewrite.dispose?.();
    }
  });

  test("JSON, SSE and historical restoration agree on custom, ordinary and foreign exec", async () => {
    for (const [tools, accepted] of [
      [[CUSTOM_EXEC], true],
      [[FUNCTION_EXEC], false],
      [[FOREIGN_EXEC], false],
    ] as const) {
      const maps = mapsFor([...tools]);
      const options = { ...maps, enforceDeclaredToolNames: true };
      for (const name of [MCP_NAME, `default.${MCP_NAME}`]) {
        const expectedInput = `const result = await tools.${MCP_NAME}({});\ntext(result);`;
        const json = buildResponseJSON(eventsFor(name), "fixture", options);
        async function* streamEvents(): AsyncGenerator<AdapterEvent> { yield* eventsFor(name); }
        const stream = bridgeToResponsesSSE(
          streamEvents(), "fixture", maps.toolNsMap, maps.freeformToolNames,
          maps.toolSearchToolNames, undefined, 50_000, options,
        );
        const text = await new Response(stream).text();
        const payloads = text.split(/\r?\n\r?\n/).filter(block => block.includes("data: {")).map(dataPayload);
        const historical = JSON.parse(restoreRoutedCustomCallsInJson(
          JSON.stringify({ output: [{ ...CALL, name }] }),
          rewriteRoutedCustomToolsForUpstream({ tools }, false).names,
          new Set(), maps.declaredToolNames,
        )) as { output: Array<Record<string, unknown>> };
        if (accepted) {
          expect(json.output).toMatchObject([{ type: "custom_tool_call", name: "exec", input: expectedInput }]);
          expect(payloads.find(p => p.type === "response.custom_tool_call_input.done")?.input).toBe(expectedInput);
          expect(historical.output[0]).toMatchObject({ type: "custom_tool_call", name: "exec", input: expectedInput });
        } else {
          expect(json.status).toBe("failed");
          expect(payloads.some(p => p.type === "response.failed")).toBe(true);
          expect(historical.output[0]).toMatchObject({ type: "function_call", name });
        }
      }
    }
  });
});
