import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSocialPublishingProvider } from "../../src/social/provider-client";
import { SocialPublishingService } from "../../src/social/service";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "pao-social-e2e-")), "social.sqlite");
}

describe("social publishing E2E workflow", () => {
  let service: SocialPublishingService;
  let fakeProvider: FakeSocialPublishingProvider;

  beforeEach(() => {
    fakeProvider = new FakeSocialPublishingProvider();
    service = new SocialPublishingService({
      dbPath: tempDb(),
      provider: fakeProvider,
      env: { SOCIAL_PUBLISHING_ENABLED: "true" },
    });
  });

  afterEach(() => {
    service.db.close();
  });

  test("E2E 1: Complete end-to-end publishing flow matching Definition of Done", async () => {
    // 1. Discover and sync accounts from OpenPost
    const accounts = await service.syncAccounts("main");
    const readyAccounts = accounts.filter(a => a.readiness_state === "READY");
    expect(readyAccounts.length).toBeGreaterThanOrEqual(2);

    // 2. Select an uploaded asset and create publication
    const pub = service.createPublication({
      source_type: "mixed",
      master_title: "OpenCodeX 20.60 Release",
      master_caption: "Full agentic orchestration integrated with OpenPost!",
      master_tags: ["pao", "opencodex", "openpost"],
      timezone: "America/New_York",
    });

    service.db.upsertAsset({
      id: "ast_1",
      publication_id: pub.id,
      local_asset_id: "asset_hero_image",
      openpost_media_ref: "media_hero_123",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      mime_type: "image/png",
      byte_size: 1024 * 50,
      width: 1200,
      height: 630,
      duration_ms: null,
      provenance_json: JSON.stringify({ source: "pao-image-factory" }),
      created_at: new Date().toISOString(),
    });

    // 3. Generate destination-specific renditions
    const targetAccountIds = readyAccounts.slice(0, 2).map(a => a.id);
    const renditions = service.generateRenditionsForPublication(pub.id, targetAccountIds);
    expect(renditions).toHaveLength(2);

    // 4. Validate policy and account capabilities
    const validation = service.validatePublication(pub.id);
    expect(validation.result).not.toBe("deny");

    // 5. Human reviewer inspects renditions and approves
    const approval = service.approvePublication({
      publicationId: pub.id,
      decision: "approved",
      approverId: "human_admin_1",
      scope: "PUBLICATION_ALL_DESTINATIONS",
      note: "LGTM for X and Mastodon",
    });
    expect(approval.decision).toBe("approved");

    // 6. Dispatch immediate publication
    const dispatch = await service.publishNow(pub.id, "human_admin_1");
    expect(dispatch.publication.status).toBe("published");
    expect(dispatch.jobs).toHaveLength(2);

    // 7. Reconcile publication status from remote OpenPost state
    const reconciled = await service.reconcilePublication(pub.id);
    expect(reconciled.status).toBe("published");

    // 8. Capture analytics from OpenPost
    const snap = await service.syncAnalytics(readyAccounts[0]!.openpost_account_ref, pub.id);
    expect(snap.views).toBeGreaterThan(0);
    expect(snap.engagements).toBeGreaterThan(0);

    // 9. Verify full audit trail
    const auditLogs = service.db.listAuditEvents();
    const actionNames = auditLogs.map(a => a.action);
    expect(actionNames).toContain("social_accounts.sync");
    expect(actionNames).toContain("social_publication.create");
    expect(actionNames).toContain("social_approval.approved");
    expect(actionNames).toContain("social_publication.publish_now");
    expect(actionNames).toContain("social_publication.reconcile");
  });

  test("E2E 2: Edit after approval invalidates approval and blocks scheduled dispatch", async () => {
    const accounts = await service.syncAccounts("main");
    const readyAccount = accounts.find(a => a.readiness_state === "READY")!;

    const pub = service.createPublication({
      source_type: "text",
      master_caption: "Approved caption",
      scheduled_at: new Date(Date.now() + 86400_000).toISOString(),
    });

    service.generateRenditionsForPublication(pub.id, [readyAccount.id]);
    service.validatePublication(pub.id);
    service.approvePublication({
      publicationId: pub.id,
      decision: "approved",
      approverId: "admin",
    });

    // Content edit occurs
    service.updatePublication(pub.id, { master_caption: "Altered caption after approval!" });

    // Stale approval prevents dispatch
    await expect(service.schedulePublication(pub.id)).rejects.toThrow(/Human approval is required/);
  });

  test("E2E 3: Degraded account readiness blocks publication and logs failure", async () => {
    const accounts = await service.syncAccounts("main");
    const degradedAccount = accounts.find(a => a.readiness_state === "REQUIRES_REAUTH")!;
    expect(degradedAccount).toBeDefined();

    const pub = service.createPublication({
      source_type: "text",
      master_caption: "Test caption for degraded account",
    });

    service.generateRenditionsForPublication(pub.id, [degradedAccount.id]);

    const evalResult = service.validatePublication(pub.id);
    expect(evalResult.result).toBe("deny");
    expect(evalResult.rule_results.some(r => r.rule_id === "account.readiness" && !r.passed)).toBe(true);

    // Cannot approve an invalid publication
    await expect(service.publishNow(pub.id)).rejects.toThrow(/Policy denied/);
  });
});

