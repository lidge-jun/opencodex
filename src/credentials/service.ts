/**
 * Phase 20.59 — Provider Access Control Plane service.
 *
 * Credentials are leased, never listed as plaintext. This service never
 * implements account registration, CAPTCHA/Turnstile bypass, stuffing, or
 * unauthorized session acquisition. Adapters are fixture/in-process only.
 */
import { randomBytes } from "node:crypto";
import { generatePKCE } from "../oauth/pkce";
import { sha256 } from "../skills/hasher";
import { getProviderAdapter } from "./adapters";
import {
  AUTH_FAILURE_QUARANTINE_THRESHOLD,
  DEFAULT_APPROVAL_TTL_MINUTES,
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_OAUTH_TTL_SECONDS,
  NO_CHECK_HEALTH,
  NO_CHECK_STATUS,
  SENSITIVE_ACTIONS,
} from "./constants";
import {
  breakerId,
  initialBreaker,
  isCircuitBlocking,
  maybeHalfOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
} from "./circuit";
import { CredentialDatabase, getDefaultCredentialDbPath } from "./db";
import { isCredentialRuntimeEnabled } from "./enabled";
import { CredentialHookBus } from "./events";
import { nextCheckAt } from "./health";
import { assertTransition, routingEligibleFor, statusAfterHealth } from "./lifecycle";
import { evaluateCredentialPolicy, routingScore } from "./policy";
import { canExecuteWithoutApproval, parseCredentialRole, requiresApproval } from "./rbac";
import { assertNoSecret, maskSecret, redactRecord } from "./redact";
import { isTransientFailure } from "./retry";
import type {
  ApprovalRequest,
  ApprovalStatus,
  CredentialCandidate,
  CredentialEventName,
  CredentialLease,
  CredentialOverview,
  CredentialPolicy,
  CredentialPublicView,
  CredentialRecord,
  CredentialRole,
  CredentialType,
  HealthResult,
  LeaseGrant,
  LeaseRequest,
  OauthSession,
  PolicyEvaluation,
  ProviderRecord,
  ResolvedCredential,
  SensitiveAction,
} from "./types";
import { createVault, type VaultService } from "./vault";

function id(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

function secretIdFor(credentialId: string): string {
  return `sec_${credentialId}`;
}

function secretRefFor(credentialId: string): string {
  return `secret://credential/${credentialId}`;
}

export interface CredentialRuntimeServiceOptions {
  dbPath?: string;
  vault?: VaultService;
  now?: () => Date;
}

export class CredentialRuntimeService {
  public readonly db: CredentialDatabase;
  public readonly hooks = new CredentialHookBus();
  public readonly vault: VaultService;
  private readonly clock: () => Date;

  constructor(options: CredentialRuntimeServiceOptions = {}) {
    this.db = new CredentialDatabase(options.dbPath ?? getDefaultCredentialDbPath());
    this.vault = options.vault ?? createVault();
    this.clock = options.now ?? (() => new Date());
    this.bootstrap();
  }

  private bootstrap(): void {
    if (this.db.listPolicies().length === 0) {
      const ts = nowIso(this.clock());
      this.db.upsertPolicy({
        id: "pol_default_lease",
        name: "Default lease allow for healthy credentials",
        policy_type: "lease",
        enabled: true,
        priority: 100,
        policy: {
          requirements: {
            status: ["active", "degraded", "valid"],
            minimum_health_score: 40,
          },
        },
        created_at: ts,
        updated_at: ts,
      });
    }
  }

  public enabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return isCredentialRuntimeEnabled(env);
  }

  public overview(): CredentialOverview {
    const rows = this.db.listCredentials();
    const soon = this.clock().getTime() + 24 * 3600_000;
    let vaultAvailable = true;
    try { this.vault.keyId(); } catch { vaultAvailable = false; }
    return {
      enabled: this.enabled(),
      total: rows.length,
      healthy: rows.filter(r => r.health_status === "healthy").length,
      degraded: rows.filter(r => r.health_status === "degraded" || r.status === "degraded").length,
      rate_limited: rows.filter(r => r.health_status === "rate_limited").length,
      quota_exhausted: rows.filter(r => r.health_status === "quota_exhausted").length,
      expiring_soon: rows.filter(r => r.expires_at && Date.parse(r.expires_at) < soon && Date.parse(r.expires_at) > this.clock().getTime()).length,
      quarantined: rows.filter(r => r.status === "quarantined").length,
      revoked: rows.filter(r => r.status === "revoked").length,
      active_leases: this.db.listLeases("active").length,
      circuit_open: this.db.listBreakers().filter(b => b.state === "open").length,
      vault_available: vaultAvailable,
    };
  }

  public toPublicView(row: CredentialRecord, provider?: ProviderRecord | null): CredentialPublicView {
    const prv = provider ?? this.db.getProvider(row.provider_id);
    return {
      id: row.id,
      provider_id: row.provider_id,
      provider_slug: prv?.slug ?? "unknown",
      name: row.name,
      credential_type: row.credential_type,
      owner_type: row.owner_type,
      owner_id: row.owner_id,
      environment: row.environment,
      status: row.status,
      health_status: row.health_status,
      health_score: row.health_score,
      secret_ref: row.secret_ref,
      scopes: row.scopes,
      tags: row.tags,
      provider_account_id: row.provider_account_id,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
      last_validated_at: row.last_validated_at,
      routing_eligible: row.routing_eligible,
      remaining_budget: row.remaining_budget,
      budget_limit: row.budget_limit,
      metadata: redactRecord(row.metadata) as Record<string, unknown>,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  public listPublic(filter?: { provider_id?: string; status?: string; environment?: string }): CredentialPublicView[] {
    return this.db.listCredentials(filter).map(row => this.toPublicView(row));
  }

  public audit(event: {
    actor_type?: string;
    actor_id?: string | null;
    action: string;
    target_type?: string | null;
    target_id?: string | null;
    decision?: string | null;
    correlation_id?: string | null;
    metadata?: Record<string, unknown>;
  }): void {
    const metadata = redactRecord(event.metadata ?? {}) as Record<string, unknown>;
    const row = {
      id: id("aud"),
      actor_type: event.actor_type ?? "operator",
      actor_id: event.actor_id ?? null,
      action: event.action,
      target_type: event.target_type ?? null,
      target_id: event.target_id ?? null,
      decision: event.decision ?? null,
      correlation_id: event.correlation_id ?? null,
      metadata,
      created_at: nowIso(this.clock()),
    };
    this.db.insertAudit(row);
  }

  private emit(name: CredentialEventName, extra: { credential_id?: string | null; lease_id?: string | null; actor_id?: string | null; metadata?: Record<string, unknown> } = {}): void {
    this.hooks.emit({ name, ...extra, metadata: redactRecord(extra.metadata ?? {}) as Record<string, unknown> });
    this.audit({
      action: name,
      actor_id: extra.actor_id ?? null,
      target_type: extra.credential_id ? "credential" : extra.lease_id ? "lease" : null,
      target_id: extra.credential_id ?? extra.lease_id ?? null,
      metadata: extra.metadata,
    });
  }

  private persistSecret(credentialId: string, plaintext: string): string {
    const envelope = this.vault.write(plaintext);
    const ts = nowIso(this.clock());
    const sid = secretIdFor(credentialId);
    this.db.upsertSecret({
      id: sid,
      envelope_json: JSON.stringify(envelope),
      key_id: envelope.key_id,
      created_at: ts,
      updated_at: ts,
    });
    return secretRefFor(credentialId);
  }

  private readSecret(credentialId: string): string {
    const sid = secretIdFor(credentialId);
    const row = this.db.getSecret(sid);
    if (!row) throw new Error(`Secret envelope not found for ${credentialId}`);
    return this.vault.read(this.db.parseEnvelope(row));
  }

  public resolveForTrustedBackend(credentialId: string): ResolvedCredential {
    const record = this.db.getCredential(credentialId);
    if (!record) throw new Error(`Credential not found: ${credentialId}`);
    const provider = this.db.getProvider(record.provider_id);
    if (!provider) throw new Error(`Provider not found: ${record.provider_id}`);
    return { record, provider, secret: this.readSecret(credentialId) };
  }

  private remember(idempotencyKey: string | undefined, action: string, result: unknown): unknown | null {
    if (!idempotencyKey) return null;
    const existing = this.db.getIdempotency(idempotencyKey);
    if (existing) return JSON.parse(existing.result_json);
    this.db.putIdempotency({
      key: idempotencyKey,
      action,
      result_json: JSON.stringify(result),
      created_at: nowIso(this.clock()),
    });
    return null;
  }

  public async importCredential(input: {
    provider: string;
    name: string;
    secret: string;
    credential_type?: CredentialType;
    environment?: string;
    owner_type?: string;
    owner_id?: string | null;
    scopes?: string[];
    tags?: string[];
    expires_at?: string | null;
    remaining_budget?: number | null;
    budget_limit?: number | null;
    actor?: string;
    actor_role?: CredentialRole;
    idempotency_key?: string;
    validate?: boolean;
  }): Promise<CredentialPublicView> {
    if (input.idempotency_key) {
      const hit = this.db.getIdempotency(input.idempotency_key);
      if (hit) return JSON.parse(hit.result_json) as CredentialPublicView;
    }
    const provider = this.db.getProviderBySlug(input.provider) ?? this.db.getProvider(input.provider);
    if (!provider) throw new Error(`Unknown provider: ${input.provider}`);
    const ts = nowIso(this.clock());
    const credId = id("crd");
    const secretRef = this.persistSecret(credId, input.secret);
    const row: CredentialRecord = {
      id: credId,
      provider_id: provider.id,
      name: input.name,
      credential_type: input.credential_type ?? "api_key",
      owner_type: input.owner_type ?? "operator",
      owner_id: input.owner_id ?? input.actor ?? null,
      environment: input.environment ?? "local",
      status: "new",
      health_status: "unknown",
      health_score: 0,
      secret_ref: secretRef,
      scopes: input.scopes ?? [],
      tags: input.tags ?? [],
      provider_account_id: null,
      expires_at: input.expires_at ?? null,
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
      routing_eligible: false,
      remaining_budget: input.remaining_budget ?? null,
      budget_limit: input.budget_limit ?? null,
      metadata: {},
      created_at: ts,
      updated_at: ts,
    };
    this.db.upsertCredential(row);
    this.emit("credential.created", { credential_id: credId, actor_id: input.actor ?? "operator", metadata: { provider: provider.slug } });
    let publicView = this.toPublicView(row, provider);
    assertNoSecret(publicView, input.secret);
    if (input.validate !== false) {
      publicView = await this.validateCredential(credId, input.actor ?? "operator");
    }
    if (input.idempotency_key) {
      this.remember(input.idempotency_key, "credential.import", publicView);
    }
    return publicView;
  }

  public async validateCredential(credentialId: string, actor = "operator"): Promise<CredentialPublicView> {
    const record = this.requireCredential(credentialId);
    if (record.status !== "validating") {
      assertTransition(record.status, "validating");
    }
    const ts = nowIso(this.clock());
    const validating = { ...record, status: "validating" as const, updated_at: ts };
    this.db.upsertCredential(validating);
    const resolved = this.resolveForTrustedBackend(credentialId);
    const adapter = getProviderAdapter(resolved.provider.adapter_type);
    const result = await adapter.validate(resolved);
    const nextStatus = result.ok ? "valid" : (result.status === "degraded" ? "degraded" : "quarantined");
    assertTransition("validating", nextStatus);
    const health = result.health_status;
    const next: CredentialRecord = {
      ...validating,
      status: nextStatus,
      health_status: health,
      health_score: result.health_score,
      last_validated_at: ts,
      last_checked_at: ts,
      next_check_at: nextCheckAt(health, this.clock()),
      last_latency_ms: result.latency_ms,
      last_http_status: result.http_status,
      last_error_code: result.error_code,
      last_error_class: result.error_class,
      failure_count: result.ok ? 0 : validating.failure_count + 1,
      success_count: result.ok ? validating.success_count + 1 : validating.success_count,
      routing_eligible: false,
      updated_at: ts,
    };
    this.db.upsertCredential(next);
    this.recordHealthSample(next, result.ok, result);
    this.emit("credential.validated", { credential_id: credentialId, actor_id: actor, metadata: { ok: result.ok, health } });
    if (result.ok) return this.activateCredential(credentialId, actor);
    this.emit("credential.quarantined", { credential_id: credentialId, actor_id: actor, metadata: { reason: result.error_code } });
    return this.toPublicView(next, resolved.provider);
  }

  public activateCredential(credentialId: string, actor = "operator"): CredentialPublicView {
    const record = this.requireCredential(credentialId);
    const target = record.status === "active" ? "active" : "active";
    if (record.status !== "active") assertTransition(record.status, "active");
    const ts = nowIso(this.clock());
    const circuitOpen = this.isBlocking(record);
    const next: CredentialRecord = {
      ...record,
      status: target,
      routing_eligible: routingEligibleFor(target, record.health_status, circuitOpen),
      updated_at: ts,
    };
    this.db.upsertCredential(next);
    this.emit("credential.activated", { credential_id: credentialId, actor_id: actor });
    return this.toPublicView(next);
  }

  public quarantineCredential(credentialId: string, actor = "operator", reason = "operator"): CredentialPublicView {
    const record = this.requireCredential(credentialId);
    if (record.status !== "quarantined") assertTransition(record.status, "quarantined");
    const ts = nowIso(this.clock());
    const next: CredentialRecord = {
      ...record,
      status: "quarantined",
      routing_eligible: false,
      last_error_class: "quarantine",
      last_error_code: reason,
      updated_at: ts,
    };
    this.db.upsertCredential(next);
    this.emit("credential.quarantined", { credential_id: credentialId, actor_id: actor, metadata: { reason } });
    return this.toPublicView(next);
  }

  public revokeCredential(credentialId: string, actor = "operator", actorRole: CredentialRole = "operator", idempotencyKey?: string): CredentialPublicView | ApprovalRequest {
    if (idempotencyKey) {
      const hit = this.db.getIdempotency(idempotencyKey);
      if (hit) return JSON.parse(hit.result_json);
    }
    if (requiresApproval(actorRole, "credential.revoke")) {
      return this.requestApproval("credential.revoke", "credential", credentialId, actor, { reason: "revoke" });
    }
    const record = this.requireCredential(credentialId);
    assertTransition(record.status, "revoked");
    const ts = nowIso(this.clock());
    const next: CredentialRecord = { ...record, status: "revoked", routing_eligible: false, updated_at: ts };
    this.db.upsertCredential(next);
    this.emit("credential.revoked", { credential_id: credentialId, actor_id: actor });
    const view = this.toPublicView(next);
    if (idempotencyKey) this.remember(idempotencyKey, "credential.revoke", view);
    return view;
  }

  public disableCredential(credentialId: string, actor = "operator"): CredentialPublicView {
    const record = this.requireCredential(credentialId);
    assertTransition(record.status, "disabled");
    const ts = nowIso(this.clock());
    const next: CredentialRecord = { ...record, status: "disabled", routing_eligible: false, updated_at: ts };
    this.db.upsertCredential(next);
    this.audit({ action: "credential.disabled", actor_id: actor, target_type: "credential", target_id: credentialId });
    return this.toPublicView(next);
  }

  public async rotateCredential(input: {
    credential_id: string;
    secret: string;
    actor?: string;
    actor_role?: CredentialRole;
    idempotency_key?: string;
  }): Promise<CredentialPublicView | ApprovalRequest> {
    const actor = input.actor ?? "operator";
    const role = input.actor_role ?? "operator";
    if (input.idempotency_key) {
      const hit = this.db.getIdempotency(input.idempotency_key);
      if (hit) return JSON.parse(hit.result_json);
    }
    if (requiresApproval(role, "credential.rotate")) {
      return this.requestApproval("credential.rotate", "credential", input.credential_id, actor, { has_secret: true });
    }
    const current = this.requireCredential(input.credential_id);
    assertTransition(current.status, "rotating");
    const ts = nowIso(this.clock());
    this.db.upsertCredential({ ...current, status: "rotating", updated_at: ts });
    this.persistSecret(current.id, input.secret);
    const view = await this.validateCredential(current.id, actor);
    this.emit("credential.rotated", { credential_id: current.id, actor_id: actor });
    if (input.idempotency_key) this.remember(input.idempotency_key, "credential.rotate", view);
    return view;
  }

  public deleteCredential(credentialId: string, actor = "operator", actorRole: CredentialRole = "operator"): CredentialPublicView | ApprovalRequest {
    if (requiresApproval(actorRole, "credential.delete")) {
      return this.requestApproval("credential.delete", "credential", credentialId, actor, {});
    }
    const record = this.requireCredential(credentialId);
    this.db.deleteSecret(secretIdFor(credentialId));
    this.db.deleteCredential(credentialId);
    this.audit({ action: "credential.deleted", actor_id: actor, target_type: "credential", target_id: credentialId });
    return this.toPublicView({ ...record, status: "disabled", routing_eligible: false });
  }

  public async runHealthCheck(credentialId: string): Promise<CredentialPublicView> {
    const record = this.requireCredential(credentialId);
    if (NO_CHECK_STATUS.includes(record.status) || NO_CHECK_HEALTH.includes(record.health_status)) {
      return this.toPublicView(record);
    }
    const resolved = this.resolveForTrustedBackend(credentialId);
    const adapter = getProviderAdapter(resolved.provider.adapter_type);
    let result: HealthResult;
    try {
      result = await adapter.healthCheck(resolved);
    } catch (error) {
      result = {
        ok: false,
        status: "degraded",
        health_status: "provider_down",
        health_score: 20,
        http_status: 503,
        error_code: "adapter_error",
        error_class: "availability",
        latency_ms: null,
        message: error instanceof Error ? error.message : String(error),
        next_check_at: nextCheckAt("provider_down", this.clock()),
      };
    }
    return this.applyHealthResult(record, resolved.provider, result);
  }

  public async runHealthPass(): Promise<number> {
    const rows = this.db.listCredentials();
    let n = 0;
    for (const row of rows) {
      if (NO_CHECK_STATUS.includes(row.status) || NO_CHECK_HEALTH.includes(row.health_status)) continue;
      await this.runHealthCheck(row.id);
      n += 1;
    }
    return n;
  }

  public runExpiryPass(): number {
    const now = this.clock().getTime();
    let n = 0;
    for (const row of this.db.listCredentials()) {
      if (!row.expires_at) continue;
      const exp = Date.parse(row.expires_at);
      if (Number.isNaN(exp)) continue;
      if (exp <= now && row.status !== "expired" && row.status !== "revoked" && row.status !== "disabled") {
        assertTransition(row.status, "expired");
        const next = { ...row, status: "expired" as const, routing_eligible: false, updated_at: nowIso(this.clock()) };
        this.db.upsertCredential(next);
        this.emit("credential.expired", { credential_id: row.id });
        n += 1;
      } else if (exp > now && exp - now < 24 * 3600_000) {
        this.emit("credential.expiring", { credential_id: row.id, metadata: { expires_at: row.expires_at } });
      }
    }
    for (const lease of this.db.listLeases("active")) {
      if (Date.parse(lease.expires_at) <= now) {
        this.db.upsertLease({ ...lease, status: "expired", released_at: nowIso(this.clock()) });
        this.emit("lease.expired", { lease_id: lease.id, credential_id: lease.credential_id });
      }
    }
    return n;
  }

  public acquireLease(request: LeaseRequest): LeaseGrant {
    const provider = this.db.getProviderBySlug(request.provider) ?? this.db.getProvider(request.provider);
    if (!provider) throw new Error(`Unknown provider: ${request.provider}`);
    const candidates = this.listCandidates(provider.slug).filter(c => c.routing_score > 0);
    if (candidates.length === 0) {
      this.emit("policy.denied", { metadata: { provider: provider.slug, reason: "no-eligible-credential" } });
      throw new Error(`No eligible credential for provider ${provider.slug}`);
    }
    const picked = candidates.sort((a, b) => b.routing_score - a.routing_score)[0]!;
    const record = this.requireCredential(picked.credential_id);
    const circuitOpen = this.isBlocking(record);
    const evaluation = evaluateCredentialPolicy(this.db.listPolicies(), {
      credential: record,
      provider,
      agentId: request.agent_id,
      model: request.model,
      purpose: request.purpose,
      requiredScope: request.required_scope,
      estimatedCost: request.estimated_cost,
      remainingBudget: record.remaining_budget,
      actorRole: request.actor_role,
      circuitOpen,
      action: "lease",
    });
    if (evaluation.decision !== "allow") {
      this.emit("policy.denied", { credential_id: record.id, metadata: { reasons: evaluation.reasons } });
      throw new Error(`Lease denied: ${evaluation.reasons.join(",")}`);
    }
    this.emit("policy.allowed", { credential_id: record.id, metadata: { policy_id: evaluation.policy_id } });
    const ttl = request.ttl_seconds ?? DEFAULT_LEASE_TTL_SECONDS;
    const ts = this.clock();
    const lease: CredentialLease = {
      id: id("les"),
      credential_id: record.id,
      requester_type: request.requester_type,
      requester_id: request.requester_id,
      agent_id: request.agent_id ?? null,
      provider_slug: provider.slug,
      model: request.model ?? null,
      purpose: request.purpose ?? null,
      status: "active",
      created_at: nowIso(ts),
      expires_at: new Date(ts.getTime() + ttl * 1000).toISOString(),
      released_at: null,
      metadata: { correlation_id: request.correlation_id ?? null },
    };
    this.db.upsertLease(lease);
    this.db.upsertCredential({ ...record, last_used_at: nowIso(ts), updated_at: nowIso(ts) });
    this.emit("lease.created", { lease_id: lease.id, credential_id: record.id, actor_id: request.requester_id });
    return {
      lease_id: lease.id,
      credential_id: record.id,
      provider: provider.slug,
      expires_at: lease.expires_at,
      health_score: record.health_score,
      routing_weight: picked.routing_score,
    };
  }

  public releaseLease(leaseId: string, actor = "system"): CredentialLease {
    const lease = this.db.getLease(leaseId);
    if (!lease) throw new Error(`Lease not found: ${leaseId}`);
    const next: CredentialLease = { ...lease, status: "released", released_at: nowIso(this.clock()) };
    this.db.upsertLease(next);
    this.emit("lease.released", { lease_id: leaseId, credential_id: lease.credential_id, actor_id: actor });
    return next;
  }

  public listCandidates(providerSlug?: string): CredentialCandidate[] {
    const out: CredentialCandidate[] = [];
    for (const row of this.db.listCredentials()) {
      const provider = this.db.getProvider(row.provider_id);
      if (!provider) continue;
      if (providerSlug && provider.slug !== providerSlug) continue;
      const circuitOpen = this.isBlocking(row);
      const eligible = routingEligibleFor(row.status, row.health_status, circuitOpen) && row.routing_eligible;
      const quotaFactor = row.health_status === "quota_exhausted" ? 0 : row.health_status === "rate_limited" ? 0.4 : 1;
      const remaining = row.remaining_budget;
      const budgetFactor = remaining == null ? 1 : remaining <= 0 ? 0 : Math.min(1, remaining / Math.max(1, row.budget_limit ?? remaining));
      const reliabilityFactor = Math.max(0.2, 1 - row.failure_count * 0.1);
      const policyFactor = eligible ? 1 : 0;
      const score = routingScore({
        healthScore: row.health_score,
        quotaFactor,
        budgetFactor,
        reliabilityFactor,
        policyFactor,
      });
      out.push({
        credential_id: row.id,
        provider: provider.slug,
        health_score: row.health_score,
        quota_factor: quotaFactor,
        budget_factor: budgetFactor,
        reliability_factor: reliabilityFactor,
        policy_factor: policyFactor,
        routing_score: eligible ? score : 0,
        status: row.status,
        health_status: row.health_status,
        lease_count: this.db.countActiveLeases(row.id),
      });
    }
    return out.sort((a, b) => b.routing_score - a.routing_score);
  }

  public evaluatePolicy(input: {
    credential_id: string;
    agent_id?: string;
    model?: string;
    purpose?: string;
    required_scope?: string;
    actor_role?: CredentialRole;
    action?: SensitiveAction | "lease";
  }): PolicyEvaluation {
    const record = this.requireCredential(input.credential_id);
    const provider = this.db.getProvider(record.provider_id);
    if (!provider) throw new Error("Provider missing");
    return evaluateCredentialPolicy(this.db.listPolicies(), {
      credential: record,
      provider,
      agentId: input.agent_id,
      model: input.model,
      purpose: input.purpose,
      requiredScope: input.required_scope,
      actorRole: input.actor_role,
      circuitOpen: this.isBlocking(record),
      action: input.action ?? "lease",
    });
  }

  public upsertPolicy(input: {
    id?: string;
    name: string;
    policy_type?: string;
    enabled?: boolean;
    priority?: number;
    policy: CredentialPolicy["policy"];
  }): CredentialPolicy {
    const ts = nowIso(this.clock());
    const row: CredentialPolicy = {
      id: input.id ?? id("pol"),
      name: input.name,
      policy_type: input.policy_type ?? "lease",
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      policy: input.policy,
      created_at: ts,
      updated_at: ts,
    };
    const existing = input.id ? this.db.getPolicy(input.id) : null;
    if (existing) row.created_at = existing.created_at;
    this.db.upsertPolicy(row);
    return row;
  }

  public requestApproval(action: SensitiveAction | string, targetType: string, targetId: string, requesterId: string, payload: Record<string, unknown> = {}): ApprovalRequest {
    const ts = this.clock();
    const row: ApprovalRequest = {
      id: id("apr"),
      action,
      target_type: targetType,
      target_id: targetId,
      requester_id: requesterId,
      status: "pending",
      request_payload: redactRecord(payload) as Record<string, unknown>,
      approved_by: null,
      approved_at: null,
      rejected_by: null,
      rejected_at: null,
      expires_at: new Date(ts.getTime() + DEFAULT_APPROVAL_TTL_MINUTES * 60_000).toISOString(),
      created_at: nowIso(ts),
    };
    this.db.upsertApproval(row);
    this.emit("approval.requested", { actor_id: requesterId, metadata: { action, target_id: targetId } });
    return row;
  }

  public decideApproval(approvalId: string, decision: "approved" | "rejected", actor: string): ApprovalRequest {
    const row = this.db.getApproval(approvalId);
    if (!row) throw new Error(`Approval not found: ${approvalId}`);
    if (row.status !== "pending") throw new Error(`Approval is ${row.status}`);
    if (row.expires_at && Date.parse(row.expires_at) <= this.clock().getTime()) {
      const expired = { ...row, status: "expired" as ApprovalStatus };
      this.db.upsertApproval(expired);
      throw new Error("Approval expired");
    }
    const ts = nowIso(this.clock());
    const next: ApprovalRequest = decision === "approved"
      ? { ...row, status: "approved", approved_by: actor, approved_at: ts }
      : { ...row, status: "rejected", rejected_by: actor, rejected_at: ts };
    this.db.upsertApproval(next);
    this.emit(decision === "approved" ? "approval.approved" : "approval.rejected", { actor_id: actor, metadata: { approval_id: approvalId } });
    return next;
  }

  public executeApproval(approvalId: string, actor: string, extra: { secret?: string } = {}): unknown {
    const row = this.db.getApproval(approvalId);
    if (!row) throw new Error(`Approval not found: ${approvalId}`);
    if (row.status !== "approved") throw new Error("Approval is not approved");
    if (row.expires_at && Date.parse(row.expires_at) <= this.clock().getTime()) throw new Error("Approval expired");
    let result: unknown = { ok: true };
    if (row.action === "credential.revoke") {
      const current = this.requireCredential(row.target_id);
      assertTransition(current.status, "revoked");
      const next = { ...current, status: "revoked" as const, routing_eligible: false, updated_at: nowIso(this.clock()) };
      this.db.upsertCredential(next);
      this.emit("credential.revoked", { credential_id: row.target_id, actor_id: actor });
      result = this.toPublicView(next);
    } else if (row.action === "credential.delete") {
      this.db.deleteSecret(secretIdFor(row.target_id));
      this.db.deleteCredential(row.target_id);
      result = { deleted: row.target_id };
    } else if (row.action === "credential.rotate") {
      if (!extra.secret) throw new Error("Rotation requires a replacement secret supplied to executeApproval.");
      this.persistSecret(row.target_id, extra.secret);
      result = { rotated: row.target_id };
    } else if (row.action === "provider.disable") {
      const provider = this.db.getProvider(row.target_id) ?? this.db.getProviderBySlug(row.target_id);
      if (!provider) throw new Error("Provider not found");
      this.db.upsertProvider({ ...provider, enabled: false, updated_at: nowIso(this.clock()) });
      result = { disabled: provider.slug };
    } else if (row.action === "vault.reveal") {
      throw new Error("Ordinary vault reveal is not implemented. Resolve secrets only inside trusted backend execution.");
    }
    this.db.upsertApproval({ ...row, status: "executed" });
    return result;
  }

  public async startOauth(input: {
    provider: string;
    redirect_uri?: string;
    scopes?: string[];
    actor?: string;
  }): Promise<{ session: OauthSession; authorize_url: string; state: string }> {
    const provider = this.db.getProviderBySlug(input.provider) ?? this.db.getProvider(input.provider);
    if (!provider) throw new Error(`Unknown provider: ${input.provider}`);
    if (!provider.oauth_supported) throw new Error(`Provider ${provider.slug} does not support OAuth in this plane.`);
    const pkce = await generatePKCE();
    const state = randomBytes(24).toString("hex");
    const stateHash = sha256(state);
    const sessionId = id("oas");
    const verifierRef = this.persistSecret(sessionId, pkce.verifier);
    const ts = this.clock();
    const session: OauthSession = {
      id: sessionId,
      provider_id: provider.id,
      state_token_hash: stateHash,
      redirect_uri: input.redirect_uri ?? "http://127.0.0.1/oauth/callback",
      requested_scopes: input.scopes ?? [],
      status: "pending",
      code_verifier_ref: verifierRef,
      credential_id: null,
      expires_at: new Date(ts.getTime() + DEFAULT_OAUTH_TTL_SECONDS * 1000).toISOString(),
      completed_at: null,
      created_at: nowIso(ts),
    };
    this.db.upsertOauth(session);
    this.emit("oauth.started", { actor_id: input.actor ?? "operator", metadata: { provider: provider.slug, session_id: session.id } });
    const authorize_url = `https://local.invalid/oauth/${provider.slug}?state=${state}&code_challenge=${pkce.challenge}`;
    return { session, authorize_url, state };
  }

  public async completeOauth(input: {
    state: string;
    code: string;
    actor?: string;
    idempotency_key?: string;
  }): Promise<CredentialPublicView> {
    if (input.idempotency_key) {
      const hit = this.db.getIdempotency(input.idempotency_key);
      if (hit) return JSON.parse(hit.result_json) as CredentialPublicView;
    }
    const hash = sha256(input.state);
    const session = this.db.getOauthByStateHash(hash);
    if (!session) throw new Error("OAuth state mismatch.");
    if (session.status !== "pending") throw new Error(`OAuth session is ${session.status}`);
    if (Date.parse(session.expires_at) <= this.clock().getTime()) {
      this.db.upsertOauth({ ...session, status: "expired" });
      throw new Error("OAuth session expired.");
    }
    const provider = this.db.getProvider(session.provider_id);
    if (!provider) throw new Error("Provider missing");
    let verifier: string | undefined;
    try {
      verifier = this.readSecret(session.id);
    } catch {
      verifier = undefined;
    }
    const adapter = getProviderAdapter(provider.adapter_type);
    if (!adapter.exchangeOauth) throw new Error("Adapter cannot exchange OAuth.");
    const tokens = await adapter.exchangeOauth({
      code: input.code,
      redirect_uri: session.redirect_uri,
      code_verifier: verifier,
    });
    const bundle = JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token ?? null });
    const view = await this.importCredential({
      provider: provider.slug,
      name: `${provider.slug} oauth`,
      secret: bundle,
      credential_type: "oauth_bundle",
      actor: input.actor ?? "operator",
      expires_at: tokens.expires_at ?? null,
      validate: true,
    });
    const completed: OauthSession = {
      ...session,
      status: "completed",
      credential_id: view.id,
      completed_at: nowIso(this.clock()),
    };
    this.db.upsertOauth(completed);
    this.emit("oauth.completed", { credential_id: view.id, actor_id: input.actor ?? "operator", metadata: { session_id: session.id } });
    if (input.idempotency_key) this.remember(input.idempotency_key, "oauth.callback", view);
    return view;
  }

  public async refreshCredential(credentialId: string, actor = "system"): Promise<CredentialPublicView> {
    const resolved = this.resolveForTrustedBackend(credentialId);
    const adapter = getProviderAdapter(resolved.provider.adapter_type);
    if (!adapter.refresh) throw new Error("Adapter cannot refresh.");
    const result = await adapter.refresh(resolved);
    if (!result.ok) {
      this.emit("oauth.refresh_failed", { credential_id: credentialId, actor_id: actor, metadata: { message: result.message } });
      return this.quarantineCredential(credentialId, actor, "refresh_failed");
    }
    const ts = nowIso(this.clock());
    const next = { ...resolved.record, expires_at: result.expires_at, updated_at: ts, last_validated_at: ts };
    this.db.upsertCredential(next);
    return this.toPublicView(next, resolved.provider);
  }

  public setProviderEnabled(slug: string, enabled: boolean, actor = "operator", actorRole: CredentialRole = "operator"): ProviderRecord | ApprovalRequest {
    const provider = this.db.getProviderBySlug(slug) ?? this.db.getProvider(slug);
    if (!provider) throw new Error(`Unknown provider: ${slug}`);
    if (!enabled && requiresApproval(actorRole, "provider.disable")) {
      return this.requestApproval("provider.disable", "provider", provider.id, actor, { slug: provider.slug });
    }
    const next = { ...provider, enabled, updated_at: nowIso(this.clock()) };
    this.db.upsertProvider(next);
    this.audit({ action: enabled ? "provider.enabled" : "provider.disabled", actor_id: actor, target_type: "provider", target_id: provider.id });
    return next;
  }

  public sensitiveActionRequiresApproval(role: CredentialRole, action: SensitiveAction): boolean {
    return SENSITIVE_ACTIONS.includes(action) && !canExecuteWithoutApproval(role, action);
  }

  public parseRole(raw: string | undefined | null): CredentialRole {
    return parseCredentialRole(raw);
  }

  private requireCredential(idValue: string): CredentialRecord {
    const row = this.db.getCredential(idValue);
    if (!row) throw new Error(`Credential not found: ${idValue}`);
    return row;
  }

  private isBlocking(record: CredentialRecord): boolean {
    const breaker = this.db.getBreaker(breakerId(record.provider_id, record.id));
    if (!breaker) return false;
    const advanced = maybeHalfOpen(breaker, this.clock());
    if (advanced !== breaker) this.db.upsertBreaker(advanced);
    return isCircuitBlocking(advanced.state);
  }

  private recordHealthSample(record: CredentialRecord, success: boolean, result: { health_status: CredentialRecord["health_status"]; health_score: number; latency_ms: number | null; http_status: number | null; error_code: string | null; error_class: string | null; message?: string }): void {
    this.db.insertHealth({
      id: id("hlt"),
      credential_id: record.id,
      health_status: result.health_status,
      health_score: result.health_score,
      success,
      latency_ms: result.latency_ms,
      http_status: result.http_status,
      error_code: result.error_code,
      error_class: result.error_class,
      provider_message: result.message ?? null,
      metadata: {},
      checked_at: nowIso(this.clock()),
    });
  }

  private applyHealthResult(record: CredentialRecord, provider: ProviderRecord, result: HealthResult): CredentialPublicView {
    const ts = nowIso(this.clock());
    const previousHealth = record.health_status;
    let breaker = this.db.getBreaker(breakerId(provider.id, record.id)) ?? initialBreaker(provider.id, record.id, this.clock());
    const authFail = result.health_status === "auth_failed" || result.error_code === "invalid_token" || result.error_code === "revoked_token";
    const transient = isTransientFailure(result.http_status, result.error_code);
    if (result.ok) {
      breaker = recordCircuitSuccess(breaker, this.clock());
    } else if (!authFail && transient) {
      breaker = recordCircuitFailure(breaker, this.clock());
    } else if (authFail) {
      breaker = recordCircuitFailure(breaker, this.clock());
    }
    this.db.upsertBreaker(breaker);

    let nextStatus = statusAfterHealth(record.status, result.health_status);
    let failureCount = result.ok ? 0 : record.failure_count + 1;
    if (authFail && failureCount >= AUTH_FAILURE_QUARANTINE_THRESHOLD) {
      nextStatus = "quarantined";
    }
    if (nextStatus !== record.status) {
      try { assertTransition(record.status, nextStatus); } catch { nextStatus = record.status; }
    }
    const circuitOpen = isCircuitBlocking(maybeHalfOpen(breaker, this.clock()).state);
    const next: CredentialRecord = {
      ...record,
      status: nextStatus,
      health_status: result.health_status,
      health_score: result.health_score,
      last_checked_at: ts,
      next_check_at: result.next_check_at,
      last_latency_ms: result.latency_ms,
      last_http_status: result.http_status,
      last_error_code: result.error_code,
      last_error_class: result.error_class,
      failure_count: failureCount,
      success_count: result.ok ? record.success_count + 1 : record.success_count,
      routing_eligible: routingEligibleFor(nextStatus, result.health_status, circuitOpen),
      updated_at: ts,
    };
    this.db.upsertCredential(next);
    this.recordHealthSample(next, result.ok, result);
    if (previousHealth !== next.health_status) {
      this.emit("credential.health.changed", { credential_id: record.id, metadata: { from: previousHealth, to: next.health_status } });
    }
    if (next.status === "degraded" && record.status !== "degraded") {
      this.emit("credential.degraded", { credential_id: record.id });
    }
    if (next.status === "quarantined" && record.status !== "quarantined") {
      this.emit("credential.quarantined", { credential_id: record.id, metadata: { reason: result.error_code } });
    }
    return this.toPublicView(next, provider);
  }
}

let defaultInstance: CredentialRuntimeService | null = null;

export function getCredentialRuntimeService(): CredentialRuntimeService {
  if (!defaultInstance) {
    const dbPath = process.env.PAO_CREDENTIAL_DB_PATH;
    defaultInstance = new CredentialRuntimeService({ dbPath });
  }
  return defaultInstance;
}

export function resetCredentialRuntimeServiceForTests(): void {
  if (defaultInstance) {
    try { defaultInstance.db.close(); } catch { /* ignore */ }
  }
  defaultInstance = null;
}

