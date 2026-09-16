import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialRuntimeService } from "../../src/credentials/service";
import { MemoryVault } from "../../src/credentials/vault";
import { CIRCUIT_OPEN_THRESHOLD } from "../../src/credentials/constants";
import { initialBreaker, recordCircuitFailure } from "../../src/credentials/circuit";
import { listCredentialCandidates, acquireCredentialLease, releaseCredentialLease } from "../../src/routing/credential-candidates";
import { resetCredentialRuntimeServiceForTests } from "../../src/credentials/service";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "crd-e2e-")), "credentials.sqlite");
}

const DEMO_SECRET = ["local", "demo", "secret", "value"].join("-");

describe("credential lease e2e", () => {
  afterEach(() => {
    resetCredentialRuntimeServiceForTests();
  });

  test("acquireLease for local fixture; deny quarantined, circuit-open, budget 0; candidates additive", async () => {
    const svc = new CredentialRuntimeService({ dbPath: tempDb(), vault: new MemoryVault() });

    const healthy = await svc.importCredential({
      provider: "local",
      name: "healthy",
      secret: DEMO_SECRET,
      remaining_budget: 50,
      budget_limit: 100,
      actor: "operator",
    });
    expect(healthy.routing_eligible).toBe(true);

    const grant = svc.acquireLease({
      requester_type: "agent",
      requester_id: "agent.demo",
      provider: "local",
      actor_role: "developer",
      ttl_seconds: 30,
    });
    expect(grant.credential_id).toBe(healthy.id);
    expect(grant.lease_id.startsWith("les_")).toBe(true);
    svc.releaseLease(grant.lease_id);

    svc.quarantineCredential(healthy.id, "operator", "e2e");
    expect(() => svc.acquireLease({
      requester_type: "agent",
      requester_id: "agent.demo",
      provider: "local",
      actor_role: "developer",
    })).toThrow();

    const budgeted = await svc.importCredential({
      provider: "local",
      name: "zero-budget",
      secret: DEMO_SECRET,
      remaining_budget: 0,
      budget_limit: 10,
      actor: "operator",
    });
    const zero = svc.listCandidates("local").find(c => c.credential_id === budgeted.id);
    expect(zero?.routing_score).toBe(0);

    const circuitCred = await svc.importCredential({
      provider: "openai-compatible",
      name: "breaker",
      secret: DEMO_SECRET,
      actor: "operator",
    });
    const provider = svc.db.getProvider(circuitCred.provider_id)!;
    const now = new Date();
    let breaker = initialBreaker(provider.id, circuitCred.id, now);
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) breaker = recordCircuitFailure(breaker, now);
    svc.db.upsertBreaker(breaker);
    expect(svc.db.getCredential(circuitCred.id)!.routing_eligible).toBe(true);
    const blocked = svc.listCandidates("openai-compatible").find(c => c.credential_id === circuitCred.id);
    expect(blocked?.routing_score).toBe(0);

    const prevDb = process.env.PAO_CREDENTIAL_DB_PATH;
    process.env.PAO_CREDENTIAL_DB_PATH = tempDb();
    try {
      const additive = listCredentialCandidates("does-not-exist-provider");
      expect(Array.isArray(additive)).toBe(true);
      expect(acquireCredentialLease({
        requester_type: "agent",
        requester_id: "x",
        provider: "does-not-exist-provider",
        actor_role: "agent",
      })).toBeNull();
      expect(() => releaseCredentialLease("les_missing")).not.toThrow();
    } finally {
      if (prevDb === undefined) delete process.env.PAO_CREDENTIAL_DB_PATH;
      else process.env.PAO_CREDENTIAL_DB_PATH = prevDb;
    }
  });
});

