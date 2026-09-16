import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialRuntimeService } from "../../src/credentials/service";
import { MemoryVault } from "../../src/credentials/vault";
import { handleCredentialRoutes } from "../../src/server/management/credential-routes";
import { resetCredentialRuntimeServiceForTests } from "../../src/credentials/service";
import type { ManagementContext } from "../../src/server/management/context";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "crd-db-")), "credentials.sqlite");
}

function service(): CredentialRuntimeService {
  return new CredentialRuntimeService({ dbPath: tempDb(), vault: new MemoryVault() });
}

const DEMO_SECRET = ["local", "demo", "secret", "value"].join("-");
const AUTHFAIL_SECRET = ["authfail", "local", "demo"].join("-");
const QUOTA_SECRET = ["quota", "local", "demo"].join("-");

describe("credential runtime integration", () => {
  const prev = process.env.CREDENTIAL_RUNTIME_ENABLED;
  const prevDb = process.env.PAO_CREDENTIAL_DB_PATH;
  afterEach(() => {
    if (prev === undefined) delete process.env.CREDENTIAL_RUNTIME_ENABLED;
    else process.env.CREDENTIAL_RUNTIME_ENABLED = prev;
    if (prevDb === undefined) delete process.env.PAO_CREDENTIAL_DB_PATH;
    else process.env.PAO_CREDENTIAL_DB_PATH = prevDb;
    resetCredentialRuntimeServiceForTests();
  });

  test("import → validate → activate → lease → release", async () => {
    const svc = service();
    const created = await svc.importCredential({
      provider: "local",
      name: "demo",
      secret: DEMO_SECRET,
      actor: "operator",
    });
    expect(created.status).toBe("active");
    expect(created.health_status).toBe("healthy");
    expect(created.routing_eligible).toBe(true);
    expect(created.secret_ref).toBeDefined();
    expect(JSON.stringify(created)).not.toContain(DEMO_SECRET);

    const grant = svc.acquireLease({
      requester_type: "agent",
      requester_id: "agent.demo",
      agent_id: "agent.demo",
      provider: "local",
      purpose: "test",
      actor_role: "agent",
    });
    expect(grant.credential_id).toBe(created.id);
    const released = svc.releaseLease(grant.lease_id, "agent.demo");
    expect(released.status).toBe("released");
  });

  test("authfail secret quarantines and is not listed as plaintext", async () => {
    const svc = service();
    const created = await svc.importCredential({
      provider: "local",
      name: "bad",
      secret: AUTHFAIL_SECRET,
      actor: "operator",
    });
    expect(created.status).toBe("quarantined");
    expect(created.health_status).toBe("auth_failed");
    expect(created.routing_eligible).toBe(false);
    expect(JSON.stringify(svc.listPublic())).not.toContain(AUTHFAIL_SECRET);
    expect(() => svc.acquireLease({
      requester_type: "agent",
      requester_id: "agent.demo",
      provider: "local",
      actor_role: "agent",
    })).toThrow(/No eligible credential/);
  });

  test("quota secret is routing-ineligible", async () => {
    const svc = service();
    const created = await svc.importCredential({
      provider: "local",
      name: "quota",
      secret: QUOTA_SECRET,
      actor: "operator",
    });
    expect(created.health_status).toBe("quota_exhausted");
    const candidates = svc.listCandidates("local");
    expect(candidates.every(c => c.routing_score === 0)).toBe(true);
  });

  test("expiry pass expires credentials and active leases", async () => {
    let now = new Date("2026-09-15T12:00:00Z");
    const svc = new CredentialRuntimeService({
      dbPath: tempDb(),
      vault: new MemoryVault(),
      now: () => now,
    });
    const created = await svc.importCredential({
      provider: "local",
      name: "expiring",
      secret: DEMO_SECRET,
      expires_at: "2026-09-15T12:00:01Z",
      actor: "operator",
    });
    const grant = svc.acquireLease({
      requester_type: "agent",
      requester_id: "agent.demo",
      provider: "local",
      actor_role: "agent",
      ttl_seconds: 5,
    });
    now = new Date("2026-09-15T12:01:00Z");
    const n = svc.runExpiryPass();
    expect(n).toBeGreaterThan(0);
    expect(svc.db.getCredential(created.id)?.status).toBe("expired");
    expect(svc.db.getLease(grant.lease_id)?.status).toBe("expired");
  });

  test("admin rotate succeeds; operator revoke requests approval", async () => {
    const svc = service();
    const created = await svc.importCredential({
      provider: "local",
      name: "rotate-me",
      secret: DEMO_SECRET,
      actor: "operator",
    });
    const rotated = await svc.rotateCredential({
      credential_id: created.id,
      secret: ["local", "rotated", "secret"].join("-"),
      actor: "admin",
      actor_role: "admin",
    });
    expect("status" in rotated && rotated.status === "active").toBe(true);

    const approval = svc.revokeCredential(created.id, "operator", "operator");
    expect("action" in approval && approval.action === "credential.revoke").toBe(true);
    expect("status" in approval && approval.status === "pending").toBe(true);
  });

  test("idempotent import returns the same public view", async () => {
    const svc = service();
    const first = await svc.importCredential({
      provider: "local",
      name: "idem",
      secret: DEMO_SECRET,
      actor: "operator",
      idempotency_key: "imp-1",
    });
    const second = await svc.importCredential({
      provider: "local",
      name: "idem",
      secret: DEMO_SECRET,
      actor: "operator",
      idempotency_key: "imp-1",
    });
    expect(second.id).toBe(first.id);
    expect(svc.listPublic().filter(r => r.name === "idem").length).toBe(1);
  });

  test("overview reports vault availability from the injected vault", () => {
    delete process.env.CREDENTIAL_RUNTIME_ENABLED;
    const svc = service();
    expect(svc.overview().vault_available).toBe(true);
    expect(svc.overview().enabled).toBe(false);
  });

  test("list API never contains plaintext", async () => {
    const svc = service();
    await svc.importCredential({
      provider: "local",
      name: "listed",
      secret: DEMO_SECRET,
      actor: "operator",
    });
    const dumped = JSON.stringify(svc.listPublic());
    expect(dumped).not.toContain(DEMO_SECRET);
    expect(dumped).toContain("secret://credential/");
  });

  test("OAuth state mismatch is rejected", async () => {
    const svc = service();
    await svc.startOauth({ provider: "xai", actor: "operator" });
    await expect(svc.completeOauth({ state: "wrong-state", code: "abc", actor: "operator" }))
      .rejects.toThrow(/OAuth state mismatch/);
  });

  test("mutating API refuses when feature flag is off", async () => {
    process.env.PAO_CREDENTIAL_DB_PATH = tempDb();
    resetCredentialRuntimeServiceForTests();
    delete process.env.CREDENTIAL_RUNTIME_ENABLED;
    const url = new URL("http://127.0.0.1:10100/api/credentials");
    const req = new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local", name: "x", secret: DEMO_SECRET }),
    });
    const ctx = {
      req,
      url,
      config: {} as never,
      deps: {} as never,
      version: "test",
      convergeCodexCatalog: async () => ({} as never),
      syncClaudeAgentDefsBestEffort: async () => {},
    } as ManagementContext;
    const res = await handleCredentialRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

