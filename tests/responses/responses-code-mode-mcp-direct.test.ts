import { describe, expect, test } from "bun:test";
import { restoreRoutedCustomCallsInJson } from "../../src/responses/custom-tool-compat";
import { compileCodeModeHelperInput } from "../../src/responses/code-mode-helper-compat";
import { undeclaredToolCallNameInResponse } from "../../src/server/responses-undeclared-tool-guard";
import { isCodeModeMcpDirectName, normalizeDeclaredToolName } from "../../src/types/tools";

const CODE_MODE = new Set(["exec"]);

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

  test("maps a direct mcp call through a declared exec only", () => {
    expect(normalizeDeclaredToolName("mcp__codex_app__get_usage_limits", CODE_MODE)).toBe("exec");
    expect(normalizeDeclaredToolName("mcp__codex_app__get_usage_limits", new Set())).toBe("mcp__codex_app__get_usage_limits");
    // A catalog that declares the name itself keeps the call's own identity.
    expect(normalizeDeclaredToolName(
      "mcp__codex_app__get_usage_limits",
      new Set(["exec", "mcp__codex_app__get_usage_limits"]),
    )).toBe("mcp__codex_app__get_usage_limits");
    // The flat-bridge shape (legacy shell names declared next to exec) is not code mode.
    expect(normalizeDeclaredToolName(
      "mcp__codex_app__get_usage_limits",
      new Set(["exec", "exec_command"]),
    )).toBe("mcp__codex_app__get_usage_limits");
    // Malformed mcp-ish names stay undeclared.
    expect(normalizeDeclaredToolName("mcp__server", CODE_MODE)).toBe("mcp__server");
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
  });

  test("keeps the undeclared-tool guard admit/block boundary unchanged elsewhere", () => {
    const source = {
      output: [{
        type: "function_call",
        id: "fc_mcp",
        call_id: "call_mcp",
        name: "mcp__codex_app__get_usage_limits",
        arguments: "{}",
      }],
    };
    expect(undeclaredToolCallNameInResponse(source, CODE_MODE)).toBeUndefined();
    expect(undeclaredToolCallNameInResponse(source, new Set())).toBe("mcp__codex_app__get_usage_limits");
    // A name that only looks mcp-ish is still blocked under a code-mode catalog.
    const malformed = {
      output: [{ type: "function_call", id: "fc_x", call_id: "call_x", name: "mcp__solo", arguments: "{}" }],
    };
    expect(undeclaredToolCallNameInResponse(malformed, CODE_MODE)).toBe("mcp__solo");
  });

  test("restores a recorded direct mcp call as the declared exec", () => {
    const source = {
      output: [{
        type: "function_call",
        id: "fc_mcp",
        call_id: "call_mcp",
        name: "mcp__codex_app__get_usage_limits",
        arguments: "{}",
      }],
    };
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
});

