import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import { addPolicy, clearPolicies, evaluateCapability } from "../src/agent-os/policy";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-policy-"));
  tempHomes.push(dir);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  closeAgentOsDbForTests();
  require("../src/agent-os/db").openAgentOsDb(dir);
}

afterEach(() => {
  closeAgentOsDbForTests();
  clearPolicies();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
});

describe("phase 05 — deny-by-default capability policy", () => {
  test("unknown capability and subject default-deny", () => {
    openFreshDb();
    expect(evaluateCapability("agent", "agent_x", "fs.write")).toEqual({ allowed: false, reason: "default_deny" });
    expect(evaluateCapability("agent", "agent_x", "fs.read")).toEqual({ allowed: false, reason: "default_deny" });
  });

  test("an explicit allow grants read-only capabilities without approval", () => {
    openFreshDb();
    addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "fs.read", effect: "allow" });
    expect(evaluateCapability("agent", "agent_x", "fs.read")).toEqual({ allowed: true, reason: "policy_allow" });
  });

  test("write-class capabilities need a granted approval even with an allow policy", () => {
    openFreshDb();
    addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "shell.exec", effect: "allow" });
    expect(evaluateCapability("agent", "agent_x", "shell.exec")).toEqual({
      allowed: false,
      reason: "approval_required",
    });
  });

  test("deny beats allow, and a subject-specific deny beats a global allow", () => {
    openFreshDb();
    addPolicy({ subjectType: "global", capability: "net.fetch", effect: "allow" });
    expect(evaluateCapability("agent", "agent_x", "net.fetch")).toEqual({ allowed: true, reason: "policy_allow" });
    addPolicy({ subjectType: "agent", subjectId: "agent_blocked", capability: "net.fetch", effect: "deny" });
    expect(evaluateCapability("agent", "agent_blocked", "net.fetch")).toEqual({ allowed: false, reason: "policy_deny" });
    // Other agents still get the global allow.
    expect(evaluateCapability("agent", "agent_other", "net.fetch")).toEqual({ allowed: true, reason: "policy_allow" });
  });
});
