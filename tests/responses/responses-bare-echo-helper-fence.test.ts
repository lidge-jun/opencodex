import { describe, expect, test } from "bun:test";
import { parseRequest } from "../../src/responses/parser";
import { buildToolBridgeMaps } from "../../src/server/responses";
import { collectDeclaredWireToolNames } from "../../src/server/responses-undeclared-tool-guard";
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
 * namespace could then donate the bare name. Fencing the echo path then left the SELECTOR path
 * open one level down: a bare `tool_choice` for a namespaced helper name added the same bare
 * spelling to the same set from a different loop.
 *
 * These cases pin the exclusion to the NAME across both paths, and pin the halves that have to
 * keep working beside it. The line the fence runs along is DECLARATION, not restoration: no
 * declared-name set ever gains a manufactured bare helper spelling, while the `toolNsMap`
 * identity entry an explicit selector creates survives, because passthrough restores an echoed
 * bare name to its namespaced identity before authorizing it and would otherwise refuse a call
 * the caller had both declared and selected. The namespaced tool also stays reachable under the
 * spellings that carry its namespace, selection by bare shorthand still resolves, and non-helper
 * names keep both their #4679 echo fallback and their bare selector alias.
 *
 * Kept out of `bare-echo-alias.test.ts` so the namespace-independence contract has a file of its
 * own rather than growing the file that pins the original collaboration-only behaviour.
 */

function namespacedToolRequest(namespace: string, name: string, choiceNames?: string[]) {
  const parsed = parseRequest({
    model: "claude-opus-5",
    input: "run it",
    tools: [{
      type: "namespace",
      name: namespace,
      tools: [{ type: "function", name, parameters: { type: "object" } }],
    }],
  });
  // Assigned rather than parsed from `tool_choice`, the way the sibling selector cases in
  // `responses-parser.test.ts` do it. The loop under test reads `options.toolChoice` and nothing
  // else, so going through selector validation would only add a second thing that can fail.
  if (choiceNames) parsed.options.toolChoice = { allowedTools: choiceNames, mode: "required" };
  return parsed;
}

const HELPER_SPELLINGS = ["exec", "exec_command", "shell_command", "write_stdin", "apply_patch", "view_image"];

describe("helper spellings are fenced from every declared-name set, in every namespace", () => {
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

  test("an explicit bare tool_choice selector declares no helper spelling", () => {
    // The bypass one level down: the echo path is fenced, so the selector loop was the remaining
    // way to put bare `exec` in the DECLARED set, which is the set that switches nested-helper
    // normalization on.
    const declared = HELPER_SPELLINGS.filter(
      name => buildToolBridgeMaps(namespacedToolRequest("mcp__remote", name, [name])).declaredToolNames.has(name),
    );

    expect(declared).toEqual([]);
  });

  test("but it does keep the identity alias, which is what restores the call", () => {
    // The half that must survive. Passthrough restores an echoed bare name to the namespaced
    // identity BEFORE authorizing it (`authorizedBareNamespaceToolAliases` in
    // passthrough-dispatch.ts reads exactly this map), and the guard then authorizes
    // `ns__name`. Withholding the map entry too refused a call the caller had declared and
    // explicitly selected.
    for (const name of HELPER_SPELLINGS) {
      const maps = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", name, [name]));
      expect([name, maps.toolNsMap.get(name)]).toEqual([name, { namespace: "mcp__remote", name }]);
    }
  });

  test("both tool_choice forms behave the same way", () => {
    // `{name}` and `{allowedTools}` reach the selector loop through the same `bareChoiceNames`
    // set, so both forms are pinned rather than only the one a fixture happened to build.
    const parsed = namespacedToolRequest("mcp__remote", "exec", ["exec"]);
    parsed.options.toolChoice = { name: "exec" };
    const maps = buildToolBridgeMaps(parsed);

    expect(maps.declaredToolNames.has("exec")).toBe(false);
    expect(declaresCodeModeExec(maps.declaredToolNames)).toBe(false);
    expect(maps.toolNsMap.get("exec")).toEqual({ namespace: "mcp__remote", name: "exec" });
  });

  test("a bare selector still SELECTS the helper tool and declares its own spellings", () => {
    // `toolAllowedByChoice` resolves the bare shorthand against the request catalog rather than
    // against this map, so the tool stays authorized and stays forced.
    const maps = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", "exec", ["exec"]));

    expect(maps.declaredToolNames.has("mcp__remote__exec")).toBe(true);
    expect(maps.declaredToolNames.has("mcp__remote.exec")).toBe(true);
    expect(maps.toolNsMap.get("mcp__remote.exec")).toMatchObject({ namespace: "mcp__remote", name: "exec" });
  });

  test("canonical and dotted selectors are unaffected for a helper name", () => {
    for (const selector of ["mcp__remote__exec", "mcp__remote.exec"]) {
      const maps = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", "exec", [selector]));
      expect([selector, maps.declaredToolNames.has(selector)]).toEqual([selector, true]);
      expect([selector, maps.declaredToolNames.has("exec")]).toEqual([selector, false]);
    }
  });

  test("a non-helper name still gains its bare alias through the selector path", () => {
    // Same narrowness check as the echo path: fencing the selector loop must not take the bare
    // selector alias away from every other namespaced tool.
    const maps = buildToolBridgeMaps(namespacedToolRequest("mcp__remote", "list_issues", ["list_issues"]));

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

/**
 * The passthrough guard builds its own declared-name catalog from the outbound body, and it feeds
 * the same consumers: `undeclaredNameInItem` passes it to `normalizeDeclaredToolName`, and
 * custom-tool restoration passes it on to `resolveCodeModeHelperName` and
 * `declaresCodeModeExec`. It had the same fence written as a single name -- `exec` -- so the
 * other five spellings still got a bare alias for an arbitrary namespace. Both sites now read one
 * list, so these cases are the other half of the same invariant.
 */
describe("the passthrough declared-name catalog applies the same fence", () => {
  test("a namespaced helper gets canonical and dotted spellings but no bare alias", () => {
    const withheld = HELPER_SPELLINGS.filter(name => collectDeclaredWireToolNames({
      tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name }] }],
    }).has(name));

    expect(withheld).toEqual([]);
  });

  test("the namespaced spellings themselves are still admitted", () => {
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "namespace", name: "mcp", tools: [{ type: "function", name: "apply_patch" }] }],
    });

    expect([...names]).toEqual(["mcp__apply_patch", "mcp.apply_patch"]);
  });

  test("a genuine top-level helper declaration keeps its bare name", () => {
    // The line the fence must not cross. Here the caller really did declare `apply_patch` as a
    // bare tool; no namespace is being discarded to synthesize the spelling, so withholding it
    // would refuse a call the request plainly authorized.
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "custom", name: "apply_patch" }, { type: "function", name: "exec" }],
    });

    expect([...names].sort()).toEqual(["apply_patch", "exec"]);
  });

  test("a non-helper namespaced tool keeps all three spellings", () => {
    const names = collectDeclaredWireToolNames({
      tools: [{ type: "namespace", name: "linear", tools: [{ type: "function", name: "create_issue" }] }],
    });

    expect([...names].sort()).toEqual(["create_issue", "linear.create_issue", "linear__create_issue"]);
  });
});
