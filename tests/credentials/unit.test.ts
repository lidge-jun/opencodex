import { describe, expect, test } from "bun:test";
import { AesGcmVault, MemoryVault, UnavailableVault, VaultIntegrityError, VaultUnavailableError } from "../../src/credentials/vault";
import { canTransitionStatus } from "../../src/credentials/lifecycle";
import { evaluateCredentialPolicy } from "../../src/credentials/policy";
import { isCredentialRuntimeEnabled, allowLegacySecretFallback } from "../../src/credentials/enabled";
import { maskSecret, redactRecord, redactText, assertNoSecret } from "../../src/credentials/redact";
import { canCreateLease, requiresApproval } from "../../src/credentials/rbac";
import { isTransientFailure } from "../../src/credentials/retry";
import { recordCircuitFailure, initialBreaker, isCircuitBlocking, maybeHalfOpen } from "../../src/credentials/circuit";
import { CIRCUIT_OPEN_THRESHOLD } from "../../src/credentials/constants";
import type { CredentialPolicy, CredentialRecord, ProviderRecord } from "../../src/credentials/types";

const provider: ProviderRecord = {
  id: "prv_local",
  slug: "local",
  name: "Local",
  adapter_type: "local",
  oauth_supported: false,
  quota_inspection_supported: false,
  revocation_supported: false,
  enabled: true,
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function credential(overrides: Partial<CredentialRecord> = {}): CredentialRecord {
  return {
    id: "crd_1",
    provider_id: provider.id,
    name: "demo",
    credential_type: "api_key",
    owner_type: "operator",
    owner_id: "op",
    environment: "local",
    status: "active",
    health_status: "healthy",
    health_score: 100,
    secret_ref: "secret://credential/crd_1",
    scopes: [],
    tags: [],
    provider_account_id: null,
    expires_at: null,
    last_used_at: null,
    last_validated_at: null,
    last_checked_at: null,
    next_check_at: null,
    failure_count: 0,
    success_count: 0,
    last_latency_ms: null,
    last_http_status: null,
    last_error_code: null,
    last_error_class: null,
    routing_eligible: true,
    remaining_budget: 10,
    budget_limit: 10,
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("feature flag", () => {
  test("defaults off", () => {
    expect(isCredentialRuntimeEnabled({})).toBe(false);
    expect(isCredentialRuntimeEnabled({ CREDENTIAL_RUNTIME_ENABLED: "true" })).toBe(true);
    expect(isCredentialRuntimeEnabled({ CREDENTIAL_RUNTIME_ENABLED: "yes" })).toBe(true);
    expect(isCredentialRuntimeEnabled({ CREDENTIAL_RUNTIME_ENABLED: "1" })).toBe(true);
    expect(isCredentialRuntimeEnabled({ CREDENTIAL_RUNTIME_ENABLED: "false" })).toBe(false);
    expect(allowLegacySecretFallback({})).toBe(false);
  });
});

describe("vault", () => {
  test("round-trips plaintext", () => {
    const vault = new AesGcmVault("unit-master-key", "master-v1");
    const envelope = vault.write("plain-secret-value");
    expect(envelope.algorithm).toBe("aes-256-gcm");
    expect(envelope.ciphertext).not.toContain("plain-secret-value");
    expect(vault.read(envelope)).toBe("plain-secret-value");
  });

  test("tampered ciphertext fails", () => {
    const vault = new AesGcmVault("unit-master-key", "master-v1");
    const envelope = vault.write("plain-secret-value");
    envelope.ciphertext = Buffer.from("tampered").toString("base64");
    expect(() => vault.read(envelope)).toThrow(VaultIntegrityError);
  });

  test("wrong master key fails", () => {
    const a = new AesGcmVault("unit-master-key-a", "master-v1");
    const b = new AesGcmVault("unit-master-key-b", "master-v1");
    const envelope = a.write("plain-secret-value");
    expect(() => b.read(envelope)).toThrow(VaultIntegrityError);
  });

  test("missing master key throws outside tests", () => {
    const prev = process.env.CREDENTIAL_MASTER_KEY;
    delete process.env.CREDENTIAL_MASTER_KEY;
    try {
      expect(() => new AesGcmVault()).toThrow(VaultUnavailableError);
    } finally {
      if (prev === undefined) delete process.env.CREDENTIAL_MASTER_KEY;
      else process.env.CREDENTIAL_MASTER_KEY = prev;
    }
  });

  test("memory vault is usable in tests", () => {
    const vault = new MemoryVault();
    expect(vault.read(vault.write("abc"))).toBe("abc");
  });

  test("UnavailableVault fails closed without a master key", () => {
    const vault = new UnavailableVault();
    expect(() => vault.keyId()).toThrow(VaultUnavailableError);
    expect(() => vault.write("x")).toThrow(VaultUnavailableError);
  });
});

describe("lifecycle", () => {
  test("legal and illegal transitions", () => {
    expect(canTransitionStatus("new", "validating")).toBe(true);
    expect(canTransitionStatus("validating", "valid")).toBe(true);
    expect(canTransitionStatus("valid", "active")).toBe(true);
    expect(canTransitionStatus("active", "quarantined")).toBe(true);
    expect(canTransitionStatus("revoked", "active")).toBe(false);
    expect(canTransitionStatus("quarantined", "validating")).toBe(true);
    expect(canTransitionStatus("rotating", "validating")).toBe(true);
  });
});

describe("policy", () => {
  const policies: CredentialPolicy[] = [];

  test("quarantined and revoked deny", () => {
    expect(evaluateCredentialPolicy(policies, {
      credential: credential({ status: "quarantined" }),
      provider,
      action: "lease",
    }).decision).toBe("deny");
    expect(evaluateCredentialPolicy(policies, {
      credential: credential({ status: "revoked" }),
      provider,
      action: "lease",
    }).reasons).toContain("credential-revoked");
  });

  test("sensitive actions require approval even with a matching lease policy", () => {
    const matching: CredentialPolicy[] = [{
      id: "pol",
      name: "lease",
      policy_type: "lease",
      enabled: true,
      priority: 1,
      policy: { requirements: { status: ["active"] } },
      created_at: "",
      updated_at: "",
    }];
    const result = evaluateCredentialPolicy(matching, {
      credential: credential(),
      provider,
      action: "credential.revoke",
    });
    expect(result.decision).toBe("approval_required");
    expect(result.reasons).toContain("default-deny-sensitive");
  });

  test("lease with no matching policy default-allows", () => {
    const result = evaluateCredentialPolicy([], {
      credential: credential(),
      provider,
      action: "lease",
      actorRole: "developer",
    });
    expect(result.decision).toBe("allow");
  });
});

describe("redaction", () => {
  test("mask never equals plaintext for long secrets", () => {
    const secret = "local-demo-secret-value";
    expect(maskSecret(secret)).not.toBe(secret);
    expect(maskSecret(secret)).toContain(secret.slice(-4));
  });

  test("redactRecord strips secret keys", () => {
    const redacted = redactRecord({ secret: "local-demo-secret-value", ok: true }) as Record<string, unknown>;
    expect(redacted.secret).toBe("********");
    expect(redacted.ok).toBe(true);
  });

  test("assertNoSecret throws when payload contains plaintext", () => {
    const secret = "local-demo-secret-value";
    expect(() => assertNoSecret({ secret }, secret)).toThrow(/Secret leakage/);
    expect(() => assertNoSecret({ secret: maskSecret(secret) }, secret)).not.toThrow();
  });

  test("redactText masks bearer-looking strings assembled from fragments", () => {
    const token = ["Bear", "er local"].join("") + "-demo-token-value";
    expect(redactText(token)).not.toContain("demo-token-value");
  });
});

describe("rbac", () => {
  test("agent and developer can lease; viewer cannot", () => {
    expect(canCreateLease("agent")).toBe(true);
    expect(canCreateLease("developer")).toBe(true);
    expect(canCreateLease("viewer")).toBe(false);
  });

  test("revoke/rotate require approval below admin; vault.reveal always", () => {
    expect(requiresApproval("operator", "credential.revoke")).toBe(true);
    expect(requiresApproval("admin", "credential.revoke")).toBe(false);
    expect(requiresApproval("owner", "vault.reveal")).toBe(true);
    expect(requiresApproval("owner", "credential.delete")).toBe(false);
    expect(requiresApproval("admin", "credential.delete")).toBe(true);
  });
});

describe("retry and circuit", () => {
  test("auth failures are not transient", () => {
    expect(isTransientFailure(401, "invalid_token")).toBe(false);
    expect(isTransientFailure(403, null)).toBe(false);
    expect(isTransientFailure(429, null)).toBe(true);
    expect(isTransientFailure(503, null)).toBe(true);
  });

  test("circuit opens after threshold and blocks routing", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    let breaker = initialBreaker("prv_local", "crd_1", now);
    for (let i = 0; i < CIRCUIT_OPEN_THRESHOLD; i++) {
      breaker = recordCircuitFailure(breaker, now);
    }
    expect(breaker.state).toBe("open");
    expect(isCircuitBlocking(breaker.state)).toBe(true);
    const later = new Date(now.getTime() + 61_000);
    expect(maybeHalfOpen(breaker, later).state).toBe("half_open");
  });
});

