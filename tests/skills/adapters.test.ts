import { describe, expect, test } from "bun:test";
import { defaultAgentRegistry } from "../../src/skills/adapters/registry";

describe("Agent Adapters & Target Resolution", () => {
  test("registry includes Codex, Claude Code, OpenCode, and Universal adapters", () => {
    expect(defaultAgentRegistry.get("codex")).toBeDefined();
    expect(defaultAgentRegistry.get("claude-code")).toBeDefined();
    expect(defaultAgentRegistry.get("claude")).toBeDefined(); // alias
    expect(defaultAgentRegistry.get("opencode")).toBeDefined();
    expect(defaultAgentRegistry.get("universal")).toBeDefined();
  });

  test("resolves target paths accurately for user and project scopes", async () => {
    const codex = defaultAgentRegistry.get("codex")!;
    const userTarget = await codex.resolveTarget("postgres-migration", {
      scope: "user",
      homeDir: "/mock/home",
    });
    expect(userTarget.targetPath.replace(/\\/g, "/")).toContain("/mock/home/.codex/skills/postgres-migration");

    const projectTarget = await codex.resolveTarget("postgres-migration", {
      scope: "project",
      projectPath: "/mock/project",
    });
    expect(projectTarget.targetPath.replace(/\\/g, "/")).toContain("/mock/project/.codex/skills/postgres-migration");
  });

  test("rejects invalid slugs or traversal in target resolution", async () => {
    const codex = defaultAgentRegistry.get("codex")!;
    expect(codex.resolveTarget("../escaped", { scope: "user" })).rejects.toThrow();
    expect(codex.resolveTarget("nested/path", { scope: "user" })).rejects.toThrow();
  });

  test("detectAll discovers available agent runtimes", async () => {
    const detected = await defaultAgentRegistry.detectAll({ cwd: process.cwd() });
    expect(detected.length).toBeGreaterThan(0);
    expect(detected.some(d => d.agentType === "universal")).toBe(true);
  });
});

