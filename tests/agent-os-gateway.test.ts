import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeAgentOsDbForTests } from "../src/agent-os/db";
import {
  getWritePermit,
  issueWritePermit,
  redeemWritePermit,
  requestWritePermit,
  revokeWritePermit,
  scopeHash,
  type PermitScope,
} from "../src/agent-os/gateway";

const tempHomes: string[] = [];

function openFreshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-os-gw-"));
  tempHomes.push(dir);
  closeAgentOsDbForTests();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb(dir);
}

afterEach(() => {
  closeAgentOsDbForTests();
  while (tempHomes.length) rmSync(tempHomes.pop()!, { recursive: true, force: true });
});

/** Grant an approval directly (simulates the human decision in the ledger). */
function grantApproval(approvalId: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../src/agent-os/db").openAgentOsDb()
    .query("UPDATE approvals SET status = 'granted', decided_ms = ? WHERE id = ?")
    .run(Date.now(), approvalId);
}

describe("phase 16 — write permit gateway", () => {
  test("request does not mint a permit; issuance requires a granted approval", () => {
    openFreshDb();
    const scope: PermitScope = { kind: "file", path: "src/index.ts" };
    const { approvalId } = requestWritePermit({ capability: "fs.write", scope, reason: "fix typo", taskId: null });
    const refused = issueWritePermit(approvalId, scope);
    expect("error" in refused && refused.error).toBe("approval_pending");

    grantApproval(approvalId);
    const issued = issueWritePermit(approvalId, scope);
    expect("token" in issued).toBe(true);
    if ("token" in issued) expect(issued.token.startsWith("wp_")).toBe(true);
  });

  test("redemption succeeds once with the right token + scope, then single-use holds", () => {
    openFreshDb();
    const scope: PermitScope = { kind: "file", path: "src/index.ts" };
    const policy = require("../src/agent-os/policy");
    policy.addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "fs.write", effect: "allow" });

    const { approvalId } = requestWritePermit({ capability: "fs.write", scope, reason: "r" });
    grantApproval(approvalId);
    const issued = issueWritePermit(approvalId, scope);
    if (!("token" in issued)) throw new Error("expected issue");

    const first = redeemWritePermit({ permitId: issued.permit.id, token: issued.token, scope, subjectType: "agent", subjectId: "agent_x" });
    expect(first).toEqual({ ok: true, code: "redeemed" });
    // Single use.
    const second = redeemWritePermit({ permitId: issued.permit.id, token: issued.token, scope, subjectType: "agent", subjectId: "agent_x" });
    expect(second).toEqual({ ok: false, code: "already_used" });
  });

  test("a valid token is useless against a different scope (SHA binding)", () => {
    openFreshDb();
    const scope: PermitScope = { kind: "file", path: "src/index.ts" };
    const otherScope: PermitScope = { kind: "file", path: "src/other.ts" };
    const policy = require("../src/agent-os/policy");
    policy.addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "fs.write", effect: "allow" });

    const { approvalId } = requestWritePermit({ capability: "fs.write", scope, reason: "r" });
    grantApproval(approvalId);
    const issued = issueWritePermit(approvalId, scope);
    if (!("token" in issued)) throw new Error("expected issue");

    const attacked = redeemWritePermit({ permitId: issued.permit.id, token: issued.token, scope: otherScope, subjectType: "agent", subjectId: "agent_x" });
    expect(attacked).toEqual({ ok: false, code: "scope_mismatch" });
    // And the original permit is still intact for its own scope.
    const legit = redeemWritePermit({ permitId: issued.permit.id, token: issued.token, scope, subjectType: "agent", subjectId: "agent_x" });
    expect(legit.ok).toBe(true);
  });

  test("wrong token, expiry, and revocation all fail closed", () => {
    openFreshDb();
    const scope: PermitScope = { kind: "task", taskId: "task_1" };
    const policy = require("../src/agent-os/policy");
    policy.addPolicy({ subjectType: "agent", subjectId: "agent_x", capability: "shell.exec", effect: "allow" });

    const { approvalId } = requestWritePermit({ capability: "shell.exec", scope, reason: "r" });
    grantApproval(approvalId);
    const issued = issueWritePermit(approvalId, scope, 5_000);
    if (!("token" in issued)) throw new Error("expected issue");

    expect(redeemWritePermit({ permitId: issued.permit.id, token: "wp_wrong", scope, subjectType: "agent", subjectId: "agent_x" }).code).toBe("bad_token");

    const revoked = revokeWritePermit(issued.permit.id);
    expect(revoked).toBe(true);
    expect(redeemWritePermit({ permitId: issued.permit.id, token: issued.token, scope, subjectType: "agent", subjectId: "agent_x" }).code).toBe("revoked");
  });

  test("expired permits flip to expired and refuse redemption", async () => {
    openFreshDb();
    const scope: PermitScope = { kind: "project", projectId: "proj_1" };
    const policy = require("../src/agent-os/policy");
    policy.addPolicy({ subjectType: "global", capability: "fs.write", effect: "allow" });

    const { approvalId } = requestWritePermit({ capability: "fs.write", scope, reason: "r" });
    grantApproval(approvalId);
    const issued = issueWritePermit(approvalId, scope, 1);
    if (!("token" in issued)) throw new Error("expected issue");
    await new Promise((r) => setTimeout(r, 15));
    const result = redeemWritePermit({ permitId: issued.permit.id, token: issued.token, scope, subjectType: "agent", subjectId: "agent_x" });
    expect(result).toEqual({ ok: false, code: "expired" });
    expect(getWritePermit(issued.permit.id)?.status).toBe("expired");
  });

  test("scope hashing is deterministic and sensitive to the target", () => {
    const a = scopeHash({ kind: "file", path: "x.ts" });
    const b = scopeHash({ kind: "file", path: "x.ts" });
    const c = scopeHash({ kind: "file", path: "y.ts" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("phase 16 — human decision endpoint (decideApproval)", () => {
  test("decide flips a pending approval once and records who decided", () => {
    openFreshDb();
    const scope: PermitScope = { kind: "file", path: "a.ts" };
    const { approvalId } = requestWritePermit({ capability: "fs.write", scope, reason: "r" });
    const gw = require("../src/agent-os/gateway");
    const first = gw.decideApproval(approvalId, "granted", "pao");
    expect(first.ok).toBe(true);
    // Already decided: second call is a no-op failure.
    expect(gw.decideApproval(approvalId, "denied", "pao").ok).toBe(false);
    const row = require("../src/agent-os/db").openAgentOsDb()
      .query("SELECT status, decided_by FROM approvals WHERE id = ?")
      .get(approvalId) as { status: string; decided_by: string };
    expect(row.status).toBe("granted");
    expect(row.decided_by).toBe("pao");
  });

  test("deciding a workflow-gated approval resumes (or cancels) the run", async () => {
    openFreshDb();
    const wf = require("../src/agent-os/workflow");
    const wfId = wf.registerWorkflow({
      name: "gated-release",
      steps: [{ kind: "deploy", title: "Deploy", requiresApproval: true }],
    });
    const run = wf.startWorkflowRun(wfId);
    expect(run.status).toBe("waiting_approval");

    // Request a permit tied to this workflow step, then deny it as a human.
    const scope: PermitScope = { kind: "project", projectId: "proj_1" };
    const { approvalId } = requestWritePermit({
      capability: "deploy",
      scope,
      reason: "release",
      workflowRunId: run.id,
      stepIndex: 0,
    });
    const gw = require("../src/agent-os/gateway");
    const denied = gw.decideApproval(approvalId, "denied", "pao", { workflowRunId: run.id, stepIndex: 0 });
    expect(denied.ok).toBe(true);
    expect(denied.workflowResumed).toBe(false);
    expect(wf.getWorkflowRun(run.id)?.status).toBe("cancelled");
  });
});
