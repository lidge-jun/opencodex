import { describe, expect, test } from "bun:test";
import { restoreRoutedCustomCallsInJson } from "../../src/responses/custom-tool-compat";
import { compileCodeModeHelperInput } from "../../src/responses/code-mode-helper-compat";
import { undeclaredToolCallNameInResponse } from "../../src/server/responses-undeclared-tool-guard";
import { normalizeDeclaredToolName } from "../../src/types/tools";

const CODE_MODE = new Set(["exec"]);

describe("code-mode goal helper recovery", () => {
  test("maps bare and default-prefixed goal helpers only through a declared exec", () => {
    for (const name of ["create_goal", "get_goal", "update_goal"]) {
      expect(normalizeDeclaredToolName(name, CODE_MODE)).toBe("exec");
      expect(normalizeDeclaredToolName(`default.${name}`, CODE_MODE)).toBe("exec");
      expect(normalizeDeclaredToolName(`default.${name}`, new Set([name]))).toBe(name);
      expect(normalizeDeclaredToolName(`default.${name}`, new Set())).toBe(`default.${name}`);
    }
  });

  test("compiles every helper to its matching nested host call", () => {
    const cases = [
      ["create_goal", { objective: "ship the fix" }],
      ["get_goal", {}],
      ["update_goal", { status: "complete" }],
    ] as const;
    for (const [name, args] of cases) {
      expect(compileCodeModeHelperInput(JSON.stringify(args), name)).toBe(
        `const result = await tools.${name}(${JSON.stringify(args)});\ntext(result);`,
      );
    }
  });

  test("restores default.update_goal as the declared exec and keeps the guard fail-closed", () => {
    const source = {
      output: [{
        type: "function_call",
        id: "fc_goal",
        call_id: "call_goal",
        name: "default.update_goal",
        arguments: JSON.stringify({ status: "complete" }),
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
      call_id: "call_goal",
      input: 'const result = await tools.update_goal({"status":"complete"});\ntext(result);',
    }]);
    expect(undeclaredToolCallNameInResponse(restored, CODE_MODE)).toBeUndefined();
    // The original, unrestored wire name must also pass the guard when exec is declared:
    // this is the exact input #5495 was rejected on.
    expect(undeclaredToolCallNameInResponse(source, CODE_MODE)).toBeUndefined();
    expect(undeclaredToolCallNameInResponse(source, new Set())).toBe("default.update_goal");
  });

  test("an unlisted helper-like name is not admitted through exec", () => {
    for (const name of ["delete_goal", "default.delete_goal", "set_goal"]) {
      expect(normalizeDeclaredToolName(name, CODE_MODE)).toBe(name);
      const source = {
        output: [{ type: "function_call", id: "fc_x", call_id: "call_x", name, arguments: "{}" }],
      };
      expect(undeclaredToolCallNameInResponse(source, CODE_MODE)).toBe(name);
    }
  });

  test("a genuinely declared bare goal tool keeps its identity through restoration", () => {
    const declared = new Set(["exec", "update_goal"]);
    const source = {
      output: [{
        type: "function_call",
        id: "fc_goal",
        call_id: "call_goal",
        name: "default.update_goal",
        arguments: JSON.stringify({ status: "complete" }),
      }],
    };
    const restored = JSON.parse(restoreRoutedCustomCallsInJson(
      JSON.stringify(source),
      CODE_MODE,
      new Set(),
      declared,
    ));
    expect(restored.output[0].type).toBe("function_call");
    expect(restored.output[0].name).not.toBe("exec");
    expect(normalizeDeclaredToolName("default.update_goal", declared)).toBe("update_goal");
    expect(undeclaredToolCallNameInResponse(restored, declared)).toBeUndefined();
  });
});
