/**
 * Marker-owned $CODEX_HOME/agents/ocx-*.toml projection of the role catalog.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRolesSyncEffective } from "../src/codex/agent-roles";
import {
  AGENT_ROLE_MARKER,
  syncCodexAgentRoles,
} from "../src/codex/agent-roles-sync";
import type { OcxSubagentRole } from "../src/types";

let tempHome: string | null = null;

afterEach(() => {
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

function home(): string {
  tempHome = mkdtempSync(join(tmpdir(), "ocx-agent-roles-sync-"));
  mkdirSync(join(tempHome, "agents"), { recursive: true });
  return tempHome;
}

const reviewer: OcxSubagentRole = {
  id: "reviewer",
  description: "PR review",
  model: "anthropic/claude-sonnet-5",
  effort: "high",
  developerInstructions: "Review the diff.\nFlag regressions.",
  enabled: true,
};

function roleFile(codexHome: string, id: string): string {
  return join(codexHome, "agents", `ocx-${id}.toml`);
}

describe("agentRolesSyncEffective", () => {
  test("defaults on once any enabled role exists, and explicit false always wins", () => {
    expect(agentRolesSyncEffective({ subagentRoles: [reviewer] })).toBe(true);
    expect(agentRolesSyncEffective({ subagentRoles: [{ ...reviewer, enabled: false }] })).toBe(false);
    expect(agentRolesSyncEffective({ subagentRoles: [] })).toBe(false);
    expect(agentRolesSyncEffective({
      subagentRoles: [reviewer],
      syncCodexAgentRoles: false,
    })).toBe(false);
    expect(agentRolesSyncEffective({
      subagentRoles: [reviewer],
      syncCodexAgentRoles: true,
    })).toBe(true);
  });
});

describe("syncCodexAgentRoles", () => {
  test("writes ocx-reviewer.toml with the ownership marker and allowed keys only", () => {
    const codexHome = home();
    const result = syncCodexAgentRoles(
      { subagentRoles: [reviewer] },
      { codexHome },
    );
    expect(result.warnings).toEqual([]);
    expect(result.written).toEqual(["ocx-reviewer.toml"]);
    const raw = readFileSync(roleFile(codexHome, "reviewer"), "utf8");
    expect(raw.startsWith(AGENT_ROLE_MARKER)).toBe(true);
    expect(raw).toContain('name = "reviewer"');
    expect(raw).toContain('description = "PR review"');
    expect(raw).toContain('model = "anthropic/claude-sonnet-5"');
    expect(raw).toContain('model_reasoning_effort = "high"');
    expect(raw).toContain("developer_instructions = ");
    expect(raw).toContain("Review the diff.");
    expect(raw).not.toContain("model_fallback");
    expect(raw).not.toContain("sandbox_mode");
    expect(raw).not.toContain("mcp_servers");
    expect(raw).not.toContain("skills");
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "reviewer",
      description: "PR review",
      developer_instructions: "Review the diff.\nFlag regressions.",
      model: "anthropic/claude-sonnet-5",
      model_reasoning_effort: "high",
    });
  });

  test("does not touch reviewer.toml even when that file carries the ownership marker", () => {
    const codexHome = home();
    const userFile = join(codexHome, "agents", "reviewer.toml");
    const original = `${AGENT_ROLE_MARKER}\nname = "reviewer"\nmodel_fallback = "gpt-5.4-mini"\n`;
    writeFileSync(userFile, original);
    const result = syncCodexAgentRoles({ subagentRoles: [reviewer] }, { codexHome });
    expect(readFileSync(userFile, "utf8")).toBe(original);
    expect(result.written).toEqual([]);
    expect(result.warnings.some(row => row.includes("reviewer.toml"))).toBe(true);
    expect(() => lstatSync(roleFile(codexHome, "reviewer"))).toThrow();
  });

  test("same-name sibling wins even when the filename is not id.toml", () => {
    const codexHome = home();
    const userFile = join(codexHome, "agents", "mine.toml");
    writeFileSync(userFile, 'name = "reviewer"\nmodel = "gpt-5.4"\n');
    const result = syncCodexAgentRoles({ subagentRoles: [reviewer] }, { codexHome });
    expect(result.written).toEqual([]);
    expect(readFileSync(userFile, "utf8")).toContain("gpt-5.4");
    expect(() => lstatSync(roleFile(codexHome, "reviewer"))).toThrow();
  });

  test("refuses model_fallback even when rewriting an owned file that already had it", () => {
    const codexHome = home();
    writeFileSync(
      roleFile(codexHome, "reviewer"),
      `${AGENT_ROLE_MARKER}\nname = "reviewer"\nmodel_fallback = "gpt-5.4-mini"\n`,
    );
    syncCodexAgentRoles({ subagentRoles: [reviewer] }, { codexHome });
    const raw = readFileSync(roleFile(codexHome, "reviewer"), "utf8");
    expect(raw).toContain(AGENT_ROLE_MARKER);
    expect(raw).not.toContain("model_fallback");
  });

  test("prunes owned files for disabled and removed ids", () => {
    const codexHome = home();
    syncCodexAgentRoles({
      subagentRoles: [
        reviewer,
        { ...reviewer, id: "explorer", description: "Search", model: "gpt-5.6-luna", developerInstructions: "Search only." },
      ],
    }, { codexHome });
    expect(lstatSync(roleFile(codexHome, "reviewer")).isFile()).toBe(true);
    expect(lstatSync(roleFile(codexHome, "explorer")).isFile()).toBe(true);

    const prunedDisabled = syncCodexAgentRoles({
      subagentRoles: [
        { ...reviewer, enabled: false },
        { ...reviewer, id: "explorer", description: "Search", model: "gpt-5.6-luna", developerInstructions: "Search only." },
      ],
    }, { codexHome });
    expect(prunedDisabled.pruned).toContain("ocx-reviewer.toml");
    expect(() => lstatSync(roleFile(codexHome, "reviewer"))).toThrow();
    expect(lstatSync(roleFile(codexHome, "explorer")).isFile()).toBe(true);

    const prunedRemoved = syncCodexAgentRoles({ subagentRoles: [] }, { codexHome });
    expect(prunedRemoved.pruned).toContain("ocx-explorer.toml");
    expect(() => lstatSync(roleFile(codexHome, "explorer"))).toThrow();
  });

  test("explicit syncCodexAgentRoles false prunes owned files and writes nothing", () => {
    const codexHome = home();
    syncCodexAgentRoles({ subagentRoles: [reviewer] }, { codexHome });
    const result = syncCodexAgentRoles({
      subagentRoles: [reviewer],
      syncCodexAgentRoles: false,
    }, { codexHome });
    expect(result.written).toEqual([]);
    expect(result.pruned).toContain("ocx-reviewer.toml");
    expect(() => lstatSync(roleFile(codexHome, "reviewer"))).toThrow();
  });

  test("conflict leaves an unmarked ocx-*.toml file unchanged", () => {
    const codexHome = home();
    const path = roleFile(codexHome, "reviewer");
    const original = 'name = "reviewer"\nmodel_fallback = "keep-me"\n';
    writeFileSync(path, original);
    const result = syncCodexAgentRoles({ subagentRoles: [reviewer] }, { codexHome });
    expect(result.warnings.some(row => row.includes("ocx-reviewer.toml"))).toBe(true);
    expect(result.written).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("fail-closed: does not overwrite a symlink or directory", () => {
    const codexHome = home();
    const target = join(codexHome, "elsewhere.toml");
    writeFileSync(target, "keep\n");
    symlinkSync(target, roleFile(codexHome, "reviewer"));
    mkdirSync(roleFile(codexHome, "explorer"));
    const result = syncCodexAgentRoles({
      subagentRoles: [
        reviewer,
        { ...reviewer, id: "explorer", description: "Search", model: "gpt-5.6-luna", developerInstructions: "Search only." },
      ],
    }, { codexHome });
    expect(result.written).toEqual([]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(lstatSync(roleFile(codexHome, "reviewer")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    expect(lstatSync(roleFile(codexHome, "explorer")).isDirectory()).toBe(true);
  });

  test("fail-closed when agents is a regular file rather than a directory", () => {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-agent-roles-sync-"));
    const agentsAsFile = join(tempHome, "agents");
    writeFileSync(agentsAsFile, "not-a-dir\n");
    const result = syncCodexAgentRoles({ subagentRoles: [reviewer] }, { codexHome: tempHome });
    expect(result.written).toEqual([]);
    expect(result.warnings.some(row => /fail|closed|agents/i.test(row))).toBe(true);
    expect(readFileSync(agentsAsFile, "utf8")).toBe("not-a-dir\n");
  });

  test("follows a symlink agents directory and still writes owned files", () => {
    tempHome = mkdtempSync(join(tmpdir(), "ocx-agent-roles-sync-"));
    const realDir = join(tempHome, "real-agents");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(tempHome, "agents"));
    const result = syncCodexAgentRoles({ subagentRoles: [reviewer] }, { codexHome: tempHome });
    expect(result.warnings).toEqual([]);
    expect(result.written).toEqual(["ocx-reviewer.toml"]);
    expect(readFileSync(join(realDir, "ocx-reviewer.toml"), "utf8").startsWith(AGENT_ROLE_MARKER)).toBe(true);
  });

  test("encodes quotes, backslashes, and newlines in developer instructions", () => {
    const codexHome = home();
    const role: OcxSubagentRole = {
      ...reviewer,
      developerInstructions: 'Say "done". Path: C:\\tmp\\roles\nNext line.',
    };
    syncCodexAgentRoles({ subagentRoles: [role] }, { codexHome });
    const parsed = Bun.TOML.parse(readFileSync(roleFile(codexHome, "reviewer"), "utf8")) as {
      developer_instructions: string;
    };
    expect(parsed.developer_instructions).toBe(role.developerInstructions);
  });
});
