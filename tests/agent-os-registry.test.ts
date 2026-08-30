import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  closeAgentOsDbForTests,
  agentOsDbPath,
} from "../src/agent-os/db";
import {
  DEFAULT_PERMISSIONS,
  getAgent,
  listAgents,
  registerAgent,
  setAgentEnabled,
  setAgentHealth,
} from "../src/agent-os/registry";

const tempHomes: string[] = [];

function isolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-registry-"));
  tempHomes.push(dir);
  return dir;
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) {
    const dir = tempHomes.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent os storage", () => {
  test("creates the database under the given config dir with the current schema", () => {
    const dir = isolatedHome();
    openAgentOsDbIn(dir);
    expect(Bun.file(agentOsDbPath(dir)).size > 0).toBe(true);
  });
});

function openAgentOsDbIn(dir: string): void {
  // openAgentOsDb caches per process; the test seam resets it between cases.
  closeAgentOsDbForTests();
  require("../src/agent-os/db").openAgentOsDb(dir);
}

describe("phase 02 — agent registry", () => {
  test("registers an agent with fail-closed default permissions", () => {
    openAgentOsDbIn(isolatedHome());
    const agent = registerAgent({ name: "Codex", provider: "openai", type: "coder" });
    expect(agent.id.startsWith("agent_")).toBe(true);
    expect(agent.permissions).toEqual(DEFAULT_PERMISSIONS);
    expect(agent.permissions.write).toBe(false);
    expect(agent.permissions.terminal).toBe(false);
    expect(agent.enabled).toBe(true);
  });

  test("upsert by explicit id keeps one canonical record", () => {
    openAgentOsDbIn(isolatedHome());
    registerAgent({ id: "agent_codex", name: "Codex", provider: "openai" });
    registerAgent({ id: "agent_codex", name: "Codex renamed", provider: "openai" });
    expect(listAgents()).toHaveLength(1);
    expect(getAgent("agent_codex")?.name).toBe("Codex renamed");
  });

  test("lifecycle updates: health and enable/disable", () => {
    openAgentOsDbIn(isolatedHome());
    const agent = registerAgent({ name: "Claude", provider: "anthropic" });
    expect(setAgentHealth(agent.id, "running")).toBe(true);
    expect(getAgent(agent.id)?.health).toBe("running");
    expect(setAgentEnabled(agent.id, false)).toBe(true);
    expect(getAgent(agent.id)?.enabled).toBe(false);
    expect(listAgents({ enabledOnly: true })).toHaveLength(0);
    expect(setAgentHealth("agent_missing", "failed")).toBe(false);
  });
});
