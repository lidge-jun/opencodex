import { computeContentHash, computeIdempotencyKey } from "./content-hash";
import { DEFAULT_OPENPOST_BASE_URL, RETRY_BACKOFF_SECONDS } from "./constants";
import { SocialDatabase } from "./db";
import { isSocialPublishingEnabled } from "./enabled";
import { evaluateSocialPolicy } from "./policy";
import { FakeSocialPublishingProvider, OpenPostHttpClient } from "./provider-client";
import { generateRenditions } from "./rendition";
import type {
  AccountReadiness,
  ApprovalDecision,
  OpenPostInstance,
  PlatformCapabilities,
  ProviderHealth,
  PublicationStatus,
  RenditionStatus,
  SocialAccount,
  SocialAnalyticsSnapshot,
  SocialApproval,
  SocialAuditEvent,
  SocialDeliveryJob,
  SocialPolicyEvaluation,
  SocialPublication,
  SocialPublicationAsset,
  SocialPublishingProvider,
  SocialRendition,
} from "./types";

export interface SocialServiceOptions {
  dbPath?: string;
  provider?: SocialPublishingProvider;
  env?: NodeJS.ProcessEnv;
}

export class SocialPublishingService {
  public readonly db: SocialDatabase;
  private readonly env: NodeJS.ProcessEnv;
  private readonly providerOverride?: SocialPublishingProvider;
  private readonly clients = new Map<string, SocialPublishingProvider>();

  constructor(options: SocialServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.db = new SocialDatabase(options.dbPath);
    this.providerOverride = options.provider;
    this.ensureDefaultInstance();
  }

  public enabled(): boolean {
    return isSocialPublishingEnabled(this.env);
  }

  private ensureDefaultInstance(): void {
    const existing = this.db.listInstances();
    if (existing.length === 0) {
      const defaultInst: OpenPostInstance = {
        id: "main",
        workspace_id: "default",
        name: "Primary OpenPost",
        base_url: this.env.OPENPOST_BASE_URL ?? DEFAULT_OPENPOST_BASE_URL,
        auth_mode: "token",
        secret_ref: "secret://openpost/main/api-token",
        mcp_endpoint: null,
        mcp_scope: "mcp:read",
        status: "healthy",
        version: "4.12.0",
        last_health_at: new Date().toISOString(),
        last_error_code: null,
        last_error_message: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.db.upsertInstance(defaultInst);
    }
  }

  public getProvider(instanceId = "main"): SocialPublishingProvider {
    if (this.providerOverride) return this.providerOverride;
    if (this.clients.has(instanceId)) return this.clients.get(instanceId)!;

    const inst = this.db.getInstance(instanceId);
    if (!inst) {
      // In tests/memory, fall back to FakeSocialPublishingProvider
      const fake = new FakeSocialPublishingProvider();
      this.clients.set(instanceId, fake);
      return fake;
    }

    if (this.env.NODE_ENV === "test" || this.env.BUN_TEST || inst.base_url.includes(".local") || inst.base_url.includes("localhost")) {
      const fake = new FakeSocialPublishingProvider();
      this.clients.set(instanceId, fake);
      return fake;
    }

    const client = new OpenPostHttpClient({
      baseUrl: inst.base_url,
      apiToken: this.env.OPENPOST_API_TOKEN,
    });
    this.clients.set(instanceId, client);
    return client;
  }

  // --- Instances ---
  public async registerInstance(input: {
    id: string;
    workspace_id?: string;
    name: string;
    base_url: string;
    auth_mode?: "token" | "mcp" | "hybrid";
    secret_ref: string;
    mcp_endpoint?: string;
    actor?: string;
  }): Promise<OpenPostInstance> {
    const inst: OpenPostInstance = {
      id: input.id,
      workspace_id: input.workspace_id ?? "default",
      name: input.name,
      base_url: input.base_url,
      auth_mode: input.auth_mode ?? "token",
      secret_ref: input.secret_ref,
      mcp_endpoint: input.mcp_endpoint ?? null,
      mcp_scope: "mcp:read",
      status: "unknown",
      version: null,
      last_health_at: null,
      last_error_code: null,
      last_error_message: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db.upsertInstance(inst);
    this.audit({
      action: "openpost_instance.register",
      resource_type: "openpost_instance",
      resource_id: inst.id,
      actor_type: "human",
      actor_id: input.actor ?? "operator",
      openpost_instance_id: inst.id,
    });
    return inst;
  }

  public async testInstance(id: string): Promise<ProviderHealth> {
    const inst = this.db.getInstance(id);
    if (!inst) throw new Error(`Instance not found: ${id}`);

    const provider = this.getProvider(id);
    const health = await provider.healthCheck();

    inst.status = health.status;
    inst.version = health.version;
    inst.last_health_at = new Date().toISOString();
    inst.last_error_message = health.message ?? null;
    inst.updated_at = new Date().toISOString();
    this.db.upsertInstance(inst);

    return health;
  }

  public async syncAccounts(instanceId = "main", actor = "system"): Promise<SocialAccount[]> {
    const inst = this.db.getInstance(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);

    const provider = this.getProvider(instanceId);
    const remoteAccounts = await provider.listAccounts("default");
    const synced: SocialAccount[] = [];

    for (const remote of remoteAccounts) {
      const existing = this.db.listAccounts({ platform: remote.platform }).find(a => a.openpost_account_ref === remote.id);
      const acc: SocialAccount = {
        id: existing?.id ?? `acc_${remote.platform}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        workspace_id: inst.workspace_id,
        openpost_instance_id: inst.id,
        openpost_workspace_ref: "default",
        openpost_account_ref: remote.id,
        platform: remote.platform,
        display_name: remote.display_name,
        username: remote.username,
        readiness_state: remote.readiness_state,
        capability_json: JSON.stringify(remote.capabilities),
        capabilities: remote.capabilities,
        last_sync_at: new Date().toISOString(),
        enabled: true,
        created_at: existing?.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.db.upsertAccount(acc);
      synced.push(acc);
    }

    this.audit({
      action: "social_accounts.sync",
      resource_type: "openpost_instance",
      resource_id: instanceId,
      actor_type: "system",
      actor_id: actor,
      metadata: { synced_count: synced.length },
    });

    return synced;
  }

  // --- Publications ---
  public createPublication(input: {
    workspace_id?: string;
    source_type: "image" | "video" | "text" | "mixed" | "external";
    master_title?: string | null;
    master_caption?: string | null;
    master_description?: string | null;
    master_tags?: string[];
    scheduled_at?: string | null;
    timezone?: string;
    created_by_type?: "human" | "agent" | "system";
    created_by_id?: string;
  }): SocialPublication {
    const id = `pub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const pub: SocialPublication = {
      id,
      workspace_id: input.workspace_id ?? "default",
      source_type: input.source_type,
      master_title: input.master_title ?? null,
      master_caption: input.master_caption ?? null,
      master_description: input.master_description ?? null,
      master_tags: input.master_tags ?? [],
      master_metadata_json: JSON.stringify({}),
      status: "draft",
      risk_level: "normal",
      approval_mode: "human_required",
      scheduled_at: input.scheduled_at ?? null,
      timezone: input.timezone ?? "UTC",
      created_by_type: input.created_by_type ?? "human",
      created_by_id: input.created_by_id ?? "operator",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.db.upsertPublication(pub);
    this.audit({
      action: "social_publication.create",
      resource_type: "social_publication",
      resource_id: pub.id,
      actor_type: pub.created_by_type,
      actor_id: pub.created_by_id,
    });
    return pub;
  }

  public updatePublication(id: string, updates: Partial<SocialPublication>, actor = "operator"): SocialPublication {
    const existing = this.db.getPublication(id);
    if (!existing) throw new Error(`Publication not found: ${id}`);

    const updated: SocialPublication = {
      ...existing,
      ...updates,
      id: existing.id,
      updated_at: new Date().toISOString(),
    };
    this.db.upsertPublication(updated);

    // If content changed, invalidate existing approvals
    const contentChanged = updates.master_caption !== undefined || updates.master_title !== undefined;
    if (contentChanged) {
      const renditions = this.db.listRenditions(id);
      for (const r of renditions) {
        if (r.approval_status === "approved") {
          r.approval_status = "pending";
          r.delivery_status = "draft";
          // Recompute hash
          r.content_hash = computeContentHash({
            caption: r.caption,
            title: r.title,
            description: r.description,
            hashtags: r.hashtags,
            platform: r.platform,
            accountRef: r.account_id,
            scheduledAt: updated.scheduled_at,
          });
          this.db.upsertRendition(r);
        }
      }
      updated.status = "draft";
      this.db.upsertPublication(updated);
    }

    this.audit({
      action: "social_publication.update",
      resource_type: "social_publication",
      resource_id: id,
      actor_type: "human",
      actor_id: actor,
    });

    return updated;
  }

  public generateRenditionsForPublication(publicationId: string, accountIds: string[]): SocialRendition[] {
    const pub = this.db.getPublication(publicationId);
    if (!pub) throw new Error(`Publication not found: ${publicationId}`);

    const allAccounts = this.db.listAccounts();
    const targetAccounts = allAccounts.filter(a => accountIds.includes(a.id));
    if (targetAccounts.length === 0) throw new Error("No target accounts matched");

    const assets = this.db.listAssets(publicationId);
    const renditions = generateRenditions({
      publication: pub,
      targetAccounts,
      assets,
    });

    for (const r of renditions) {
      this.db.upsertRendition(r);
    }

    pub.status = "preparing";
    this.db.upsertPublication(pub);

    return renditions;
  }

  public validatePublication(publicationId: string): SocialPolicyEvaluation {
    const pub = this.db.getPublication(publicationId);
    if (!pub) throw new Error(`Publication not found: ${publicationId}`);

    const renditions = this.db.listRenditions(publicationId);
    const accounts = this.db.listAccounts();
    const assets = this.db.listAssets(publicationId);
    const instance = this.db.getInstance("main");

    const evaluation = evaluateSocialPolicy({
      publication: pub,
      renditions,
      accounts,
      assets,
      instance,
      action: "validate",
    });

    this.db.insertPolicyEvaluation(evaluation);

    // Update rendition validation statuses
    for (const r of renditions) {
      r.validation_status = evaluation.result === "deny" ? "invalid" : "valid";
      this.db.upsertRendition(r);
    }

    pub.status = evaluation.result === "deny" ? "failed" : "ready_for_review";
    this.db.upsertPublication(pub);

    return evaluation;
  }

  // --- Approvals ---
  public approvePublication(input: {
    publicationId: string;
    renditionId?: string | null;
    decision: ApprovalDecision;
    approverId: string;
    approverType?: "human" | "system";
    scope?: SocialApproval["approval_scope"];
    note?: string;
  }): SocialApproval {
    const pub = this.db.getPublication(input.publicationId);
    if (!pub) throw new Error(`Publication not found: ${input.publicationId}`);

    const renditions = this.db.listRenditions(input.publicationId);
    if (renditions.length === 0) throw new Error("Publication has no renditions to approve");

    const targetRenditions = input.renditionId
      ? renditions.filter(r => r.id === input.renditionId)
      : renditions;

    // Verify content hash
    for (const r of targetRenditions) {
      r.approval_status = input.decision;
      r.updated_at = new Date().toISOString();
      this.db.upsertRendition(r);
    }

    const contentHash = targetRenditions[0]?.content_hash ?? "none";

    const approval: SocialApproval = {
      id: `appr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      publication_id: input.publicationId,
      rendition_id: input.renditionId ?? null,
      decision: input.decision,
      approver_type: input.approverType ?? "human",
      approver_id: input.approverId,
      approval_scope: input.scope ?? "PUBLICATION_ALL_DESTINATIONS",
      content_hash: contentHash,
      note: input.note ?? null,
      created_at: new Date().toISOString(),
    };
    this.db.insertApproval(approval);

    // Update publication status
    const allApproved = renditions.every(r => r.approval_status === "approved");
    const anyRejected = renditions.some(r => r.approval_status === "rejected");

    if (input.decision === "rejected" || anyRejected) {
      pub.status = "rejected";
    } else if (allApproved) {
      pub.status = "approved";
    }
    this.db.upsertPublication(pub);

    this.audit({
      action: `social_approval.${input.decision}`,
      resource_type: "social_publication",
      resource_id: pub.id,
      actor_type: approval.approver_type,
      actor_id: approval.approver_id,
      approval_ref: approval.id,
      metadata: { decision: input.decision, scope: approval.approval_scope },
    });

    return approval;
  }

  // --- Delivery Dispatch ---
  public async schedulePublication(publicationId: string, actor = "operator"): Promise<{
    publication: SocialPublication;
    jobs: SocialDeliveryJob[];
  }> {
    return this.dispatchPublication(publicationId, "schedule", actor);
  }

  public async publishNow(publicationId: string, actor = "operator"): Promise<{
    publication: SocialPublication;
    jobs: SocialDeliveryJob[];
  }> {
    return this.dispatchPublication(publicationId, "publish_now", actor);
  }

  private async dispatchPublication(
    publicationId: string,
    mode: "publish_now" | "schedule",
    actor: string,
  ): Promise<{
    publication: SocialPublication;
    jobs: SocialDeliveryJob[];
  }> {
    const pub = this.db.getPublication(publicationId);
    if (!pub) throw new Error(`Publication not found: ${publicationId}`);

    const renditions = this.db.listRenditions(publicationId);
    if (renditions.length === 0) throw new Error("Publication has no renditions to publish");

    const accounts = this.db.listAccounts();
    const assets = this.db.listAssets(publicationId);
    const instance = this.db.getInstance("main");

    // 1. Policy Evaluation
    const policyEval = evaluateSocialPolicy({
      publication: pub,
      renditions,
      accounts,
      assets,
      instance,
      action: mode,
    });
    this.db.insertPolicyEvaluation(policyEval);

    if (policyEval.result === "deny") {
      throw new Error(`Policy denied: ${policyEval.rule_results.filter(r => !r.passed).map(r => r.message).join("; ")}`);
    }

    if (policyEval.result === "approval_required") {
      throw new Error("Action blocked: Human approval is required before dispatching");
    }

    pub.status = "dispatching";
    this.db.upsertPublication(pub);

    const jobs: SocialDeliveryJob[] = [];
    const provider = this.getProvider(instance?.id ?? "main");

    // 2. Prepare renditions for provider
    const providerRenditions = [];
    for (const r of renditions) {
      const acc = accounts.find(a => a.id === r.account_id);
      if (!acc) continue;

      // Compute idempotency key
      const idempotencyKey = computeIdempotencyKey(
        pub.workspace_id,
        pub.id,
        r.id,
        r.content_hash,
        mode,
        pub.scheduled_at,
      );

      // Check existing job
      let job = this.db.getDeliveryJobByIdempotencyKey(idempotencyKey);
      if (!job) {
        job = {
          id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          publication_id: pub.id,
          rendition_id: r.id,
          idempotency_key: idempotencyKey,
          job_type: mode,
          status: "pending",
          attempt_count: 0,
          max_attempts: 5,
          next_attempt_at: null,
          locked_at: null,
          locked_by: null,
          last_error_class: null,
          last_error_code: null,
          last_error_message: null,
          remote_operation_ref: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        this.db.upsertDeliveryJob(job);
      }
      jobs.push(job);

      providerRenditions.push({
        account_ref: acc.openpost_account_ref,
        platform: r.platform,
        caption: r.caption ?? undefined,
        media_refs: assets.map(a => a.openpost_media_ref).filter((m): m is string => Boolean(m)),
        provider_settings: r.provider_settings,
      });
    }

    // 3. Dispatch to OpenPost
    try {
      const created = await provider.createPublication({
        title: pub.master_title ?? undefined,
        caption: pub.master_caption ?? undefined,
        renditions: providerRenditions,
      });

      let deliveryResult;
      if (mode === "schedule") {
        if (!pub.scheduled_at) throw new Error("Missing scheduled_at date");
        deliveryResult = await provider.schedule({
          publication_ref: created.publication_ref,
          scheduled_at: pub.scheduled_at,
          timezone: pub.timezone,
        });
      } else {
        deliveryResult = await provider.publishNow({
          publication_ref: created.publication_ref,
        });
      }

      // 4. Update local state
      for (const r of renditions) {
        r.openpost_publication_ref = created.publication_ref;
        r.openpost_rendition_ref = created.rendition_refs[r.account_id] ?? null;
        r.delivery_status = deliveryResult.status;
        this.db.upsertRendition(r);
      }

      for (const job of jobs) {
        job.status = "completed";
        job.remote_operation_ref = created.publication_ref;
        job.attempt_count += 1;
        this.db.upsertDeliveryJob(job);
      }

      pub.status = mode === "schedule" ? "scheduled" : "published";
      this.db.upsertPublication(pub);

      this.audit({
        action: `social_publication.${mode}`,
        resource_type: "social_publication",
        resource_id: pub.id,
        actor_type: "human",
        actor_id: actor,
        remote_ref: created.publication_ref,
      });
    } catch (err: unknown) {
      for (const job of jobs) {
        job.status = "failed_retryable";
        job.attempt_count += 1;
        job.last_error_message = err instanceof Error ? err.message : String(err);
        const backoffSec = RETRY_BACKOFF_SECONDS[Math.min(job.attempt_count - 1, RETRY_BACKOFF_SECONDS.length - 1)] ?? 60;
        job.next_attempt_at = new Date(Date.now() + backoffSec * 1000).toISOString();
        this.db.upsertDeliveryJob(job);
      }

      pub.status = "failed";
      this.db.upsertPublication(pub);
      throw err;
    }

    return { publication: pub, jobs };
  }

  public async cancelPublication(publicationId: string, actor = "operator"): Promise<SocialPublication> {
    const pub = this.db.getPublication(publicationId);
    if (!pub) throw new Error(`Publication not found: ${publicationId}`);

    const renditions = this.db.listRenditions(publicationId);
    const remoteRef = renditions.find(r => r.openpost_publication_ref)?.openpost_publication_ref;

    if (remoteRef) {
      const provider = this.getProvider();
      await provider.cancel({ publication_ref: remoteRef });
    }

    pub.status = "cancelled";
    this.db.upsertPublication(pub);

    for (const r of renditions) {
      r.delivery_status = "cancelled";
      this.db.upsertRendition(r);
    }

    this.audit({
      action: "social_publication.cancel",
      resource_type: "social_publication",
      resource_id: publicationId,
      actor_type: "human",
      actor_id: actor,
    });

    return pub;
  }

  // --- Reconciliation & Analytics ---
  public async reconcilePublication(publicationId: string): Promise<SocialPublication> {
    const pub = this.db.getPublication(publicationId);
    if (!pub) throw new Error(`Publication not found: ${publicationId}`);

    const renditions = this.db.listRenditions(publicationId);
    const remoteRef = renditions.find(r => r.openpost_publication_ref)?.openpost_publication_ref;
    if (!remoteRef) return pub;

    const provider = this.getProvider();
    const remoteState = await provider.getPublicationState(remoteRef);

    for (const r of renditions) {
      if (r.openpost_rendition_ref && remoteState.rendition_states[r.openpost_rendition_ref]) {
        r.delivery_status = remoteState.rendition_states[r.openpost_rendition_ref]!;
        this.db.upsertRendition(r);
      }
    }

    pub.status = remoteState.status;
    this.db.upsertPublication(pub);

    this.audit({
      action: "social_publication.reconcile",
      resource_type: "social_publication",
      resource_id: publicationId,
      actor_type: "system",
      actor_id: "reconciliation_worker",
      remote_ref: remoteRef,
    });

    return pub;
  }

  public async syncAnalytics(accountRef: string, publicationRef?: string): Promise<SocialAnalyticsSnapshot> {
    const provider = this.getProvider();
    const metrics = await provider.getAnalytics({ account_ref: accountRef, publication_ref: publicationRef });

    const snap: SocialAnalyticsSnapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      publication_id: publicationRef ?? null,
      rendition_id: null,
      account_id: accountRef,
      captured_at: new Date().toISOString(),
      views: metrics.views,
      impressions: metrics.impressions,
      reach: metrics.reach,
      engagements: metrics.engagements,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      followers_delta: null,
      raw_metrics: metrics.raw,
    };

    this.db.insertAnalyticsSnapshot(snap);
    return snap;
  }

  // --- Audit helper ---
  private audit(event: Omit<SocialAuditEvent, "id" | "timestamp" | "workspace_id"> & { workspace_id?: string }): void {
    this.db.insertAuditEvent({
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      workspace_id: event.workspace_id ?? "default",
      ...event,
    });
  }

  // --- Overview aggregation ---
  public getOverview(): {
    enabled: boolean;
    instances_count: number;
    accounts_count: number;
    ready_accounts_count: number;
    publications_count: number;
    scheduled_count: number;
    pending_approvals_count: number;
    failed_deliveries_count: number;
  } {
    const instances = this.db.listInstances();
    const accounts = this.db.listAccounts();
    const publications = this.db.listPublications();
    const jobs = this.db.listDeliveryJobs();

    return {
      enabled: this.enabled(),
      instances_count: instances.length,
      accounts_count: accounts.length,
      ready_accounts_count: accounts.filter(a => a.readiness_state === "READY").length,
      publications_count: publications.length,
      scheduled_count: publications.filter(p => p.status === "scheduled").length,
      pending_approvals_count: publications.filter(p => p.status === "approval_required" || p.status === "ready_for_review").length,
      failed_deliveries_count: jobs.filter(j => j.status === "failed_final" || j.status === "failed_retryable").length,
    };
  }
}

let singletonService: SocialPublishingService | null = null;

export function getSocialPublishingService(options: SocialServiceOptions = {}): SocialPublishingService {
  if (!singletonService || options.dbPath || options.provider) {
    singletonService = new SocialPublishingService(options);
  }
  return singletonService;
}

export function resetSocialPublishingServiceForTests(): void {
  if (singletonService) {
    singletonService.db.close();
    singletonService = null;
  }
}

