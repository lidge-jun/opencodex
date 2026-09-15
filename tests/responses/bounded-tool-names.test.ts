import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";
import { dottedToolName, namespacedToolName, reserveToolWireNames, toolChoiceAliases } from "../../src/types/tools";

describe("bounded tool wire names (#4679)", () => {
  test("keeps flat names at or under the 64-char wire limit unchanged", () => {
    expect(namespacedToolName(undefined, "exec_command")).toBe("exec_command");
    expect(namespacedToolName("collaboration", "spawn_agent")).toBe("collaboration__spawn_agent");
    expect(dottedToolName("collaboration", "spawn_agent")).toBe("collaboration.spawn_agent");
  });

  test("aliases flattened names past the 64-char gateway bound deterministically", () => {
    const namespace = "mcp__codex_apps__safety_settings";
    const name = "prepare_parental_control_update";
    expect(`${namespace}__${name}`.length).toBe(65);
    const first = namespacedToolName(namespace, name);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first.startsWith("mcp__codex_apps__safety_settings__")).toBe(true);
    // Same identity, same alias — stable across calls and process restarts.
    expect(namespacedToolName(namespace, name)).toBe(first);
    expect(dottedToolName(namespace, name)).toBe(first);
  });

  test("distinct identities keep distinct bounded wire names within one namespace", () => {
    const namespace = "mcp__codex_apps__codex_document_control";
    const a = namespacedToolName(namespace, "get_document_tool_schemas");
    const b = namespacedToolName(namespace, "execute_document_command");
    expect(a.length).toBeLessThanOrEqual(64);
    expect(b.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });

  test("bare names past the bound are aliased too", () => {
    const name = "a_very_long_client_declared_function_name_exceeding_the_gateway_limit";
    expect(name.length).toBeGreaterThan(64);
    const wire = namespacedToolName(undefined, name);
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(namespacedToolName(undefined, name)).toBe(wire);
  });

  test("tool choice aliases collapse to a single entry for a bounded alias", () => {
    const identity = { namespace: "mcp__codex_apps__safety_settings", name: "prepare_parental_control_update" };
    const aliases = toolChoiceAliases(identity);
    expect(aliases.length).toBe(1);
    expect(aliases[0].length).toBeLessThanOrEqual(64);
  });

  test("bounded aliases are stable across fresh processes (restart contract)", () => {
    const identity = { namespace: "mcp__codex_apps__safety_settings", name: "prepare_parental_control_update" };
    const script =
      "(async () => {" +
      `const m = await import(new URL(${JSON.stringify("file://" + repoPath("src", "types", "tools.ts"))}).href);` +
      `console.log(m.namespacedToolName(${JSON.stringify(identity.namespace)}, ${JSON.stringify(identity.name)}));` +
      "})();";
    const run = () => spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const first = run();
    const second = run();
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const alias = first.stdout.trim();
    expect(alias.length).toBeLessThanOrEqual(64);
    // A fresh process derives the same alias for the same identity: no process-local state
    // participates in the derivation, so the restart contract holds.
    expect(second.stdout.trim()).toBe(alias);
    expect(namespacedToolName(identity.namespace, identity.name)).toBe(alias);
  });
});

  test("alias mapping is independent of declaration order (catalog reservation)", () => {
    const catalog = [
      { namespace: "mcp__codex_apps__safety_settings", name: "prepare_parental_control_update" },
      { namespace: "mcp__codex_apps__safety_settings", name: "update_parental_controls" },
      { namespace: "mcp__codex_apps__codex_document_control", name: "get_document_tool_schemas" },
    ];
    const runOrder = (order: number[]) => {
      const tools = JSON.stringify(order.map(i => catalog[i]));
      const script =
        "(async () => {" +
        `const m = await import(new URL(${JSON.stringify("file://" + repoPath("src", "types", "tools.ts"))}).href);` +
        `const tools = ${tools};` +
        "m.reserveToolWireNames(tools);" +
        "console.log(JSON.stringify(tools.map(t => m.namespacedToolName(t.namespace, t.name))));" +
        "})();";
      const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
      expect(r.status).toBe(0);
      return Object.fromEntries(JSON.parse(r.stdout.trim()).map((wire: string, i: number) => [`${catalog[order[i]].namespace}__${catalog[order[i]].name}`, wire]));
    };
    const forward = runOrder([0, 1, 2]);
    const reversed = runOrder([2, 1, 0]);
    expect(reversed).toEqual(forward);
    for (const wire of Object.values(forward)) expect(wire.length).toBeLessThanOrEqual(64);
  });
