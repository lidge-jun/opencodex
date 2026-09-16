import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { buildToolBridgeMaps } from "../../src/server/responses";
import { normalizeDeclaredToolName, declaresCodeModeExec } from "../../src/types/tools";

/**
 * The bare echo alias is a convenience for providers that drop the namespace prefix. For the six
 * code-mode helper spellings it is also an authorization decision, because bare `exec` in
 * `declaredToolNames` is the single switch that turns on helper normalization
 * (src/types/tools.ts): once it is set, an UNDECLARED `apply_patch`, `exec_command` or
 * `write_stdin` is rewritten onto it.
 *
 * The exclusion that prevents that was once scoped to the `collaboration` namespace, which made
 * the boundary a property of the declaring namespace rather than of the spelling, and any other
 * namespace could then donate the bare name. These cases pin the exclusion to the NAME, and pin
 * the half that has to keep working beside it: the namespaced tool stays reachable under the
 * spellings that carry their namespace, and non-helper names keep their #4679 echo fallback.
 *
 * Kept out of `bare-echo-alias.test.ts` so the namespace-independence contract has a file of its
 * own rather than growing the file that pins the original collaboration-only behaviour.
 */

function namespacedToolRequest(namespace: string, name: string) {
  return parseRequest({
    model: "claude-opus-5",
    input: "run it",
    tools: [{
      type: "namespace",
      name: namespace,
      tools: [{ type: "function", name, parameters: { type: "object" } }],
    }],
  });
}

const HELPER_SPELLINGS = ["exec", "exec_command", "shell_command", "write_stdin", "apply_patch", "view_image"];

describe("helper spellings are fenced from the bare echo alias in every namespace", () => {
  test("a foreign namespace donates no helper spelling", () => {
    const donated = HELPER_SPELLINGS.filter(name => {
      const maps = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", name));
      return maps.declaredToolNames.has(name) || maps.toolNsMap.has(name);
    });

    expect(donated).toEqual([]);
  });

  test("the fence is the spelling, not the namespace that declared it", () => {
    // The original exclusion only fired for `collaboration`. Every surface must agree now.
    const declaringBareExec = ["collaboration", "mcp__remote", "mcp__functions"].filter(
      namespace => buildToolBridgeMaps(namespacedToolRequest(namespace, "exec")).declaredToolNames.has("exec"),
    );

    expect(declaringBareExec).toEqual([]);
  });

  test("a foreign namespaced exec stays usable as itself under its own spellings", () => {
    const maps = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", "exec"));

    // Canonical is unconditional; dotted is added because nothing else claims it here. Withdrawing
    // the bare alias costs the namespace-dropping echo fallback and nothing else.
    expect(maps.declaredToolNames.has("mcp__remote__exec")).toBe(true);
    expect(maps.declaredToolNames.has("mcp__remote.exec")).toBe(true);
    expect(maps.toolNsMap.get("mcp__remote__exec")).toMatchObject({ namespace: "mcp__remote", name: "exec" });
    expect(maps.toolNsMap.get("mcp__remote.exec")).toMatchObject({ namespace: "mcp__remote", name: "exec" });
  });

  test("a non-helper name from the same foreign namespace still gets its bare alias", () => {
    // The fence must not become a blanket refusal outside `collaboration`: widening it that far
    // would take the #4679 echo fallback away from every MCP catalog.
    const maps = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", "list_issues"));

    expect(maps.declaredToolNames.has("list_issues")).toBe(true);
    expect(maps.toolNsMap.get("list_issues")).toMatchObject({ namespace: "mcp__remote", name: "list_issues" });
  });

  test("the withheld name is exactly what would have turned helper normalization on", () => {
    // The consequence, asserted against the consumer rather than restated: a declared set that
    // carries bare `exec` rewrites undeclared helper calls onto it. This is the set the previous
    // narrowing produced for a single `mcp__remote.exec` declaration.
    const donated = new Set(["mcp__remote__exec", "mcp__remote.exec", "exec"]);
    expect(declaresCodeModeExec(donated)).toBe(true);
    expect(["apply_patch", "exec_command", "write_stdin"].map(n => normalizeDeclaredToolName(n, donated)))
      .toEqual(["exec", "exec", "exec"]);

    const fenced = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", "exec")).declaredToolNames;
    expect(declaresCodeModeExec(fenced)).toBe(false);
    expect(["apply_patch", "exec_command", "write_stdin"].map(n => normalizeDeclaredToolName(n, fenced)))
      .toEqual(["apply_patch", "exec_command", "write_stdin"]);
  });
});
