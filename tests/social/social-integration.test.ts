import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSocialPublishingProvider } from "../../src/social/provider-client";
import { SocialPublishingService } from "../../src/social/service";

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "pao-social-test-")), "social.sqlite");
}

describe("social publishing service integration", () => {
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

  test("syncs connected accounts from OpenPost and refreshes capabilities", async () => {
    const synced = await service.syncAccounts("main", "test");
    expect(synced.length).toBeGreaterThan(0);

    const xAcc = synced.find(a => a.platform === "x")!;
    expect(xAcc.readiness_state).toBe("READY");
    expect(xAcc.capabilities.text.max_length).toBe(280);

    const accountsInDb = service.db.listAccounts();
    expect(accountsInDb.length).toBe(synced.length);
  });

  test("full flow: publication -> renditions -> validation -> human approval -> publish", async () => {
    await service.syncAccounts("main");
    const accounts = service.db.listAccounts({ readiness: "READY" });
    const targetAccounts = accounts.slice(0, 2);

    const pub = service.createPublication({
      source_type: "text",
      master_title: "Product Launch",
      master_caption: "Announcing our new agentic social publishing integration!",
      master_tags: ["launch", "ai"],
    });
    expect(pub.status).toBe("draft");

    const renditions = service.generateRenditionsForPublication(pub.id, targetAccounts.map(a => a.id));
    expect(renditions).toHaveLength(2);
    expect(renditions[0]?.approval_status).toBe("pending");

    const evaluation = service.validatePublication(pub.id);
    expect(evaluation.result).not.toBe("deny");

    const approval = service.approvePublication({
      publicationId: pub.id,
      decision: "approved",
      approverId: "human_reviewer_42",
      scope: "PUBLICATION_ALL_DESTINATIONS",
    });
    expect(approval.decision).toBe("approved");

    const updatedPub = service.db.getPublication(pub.id)!;
    expect(updatedPub.status).toBe("approved");

    const dispatchResult = await service.publishNow(pub.id, "operator");
    expect(dispatchResult.publication.status).toBe("published");
    expect(dispatchResult.jobs).toHaveLength(2);
    expect(dispatchResult.jobs.every(j => j.status === "completed")).toBe(true);

    const renditionsAfter = service.db.listRenditions(pub.id);
    expect(renditionsAfter.every(r => r.delivery_status === "published")).toBe(true);
    expect(renditionsAfter.every(r => r.openpost_publication_ref !== null)).toBe(true);
  });

  test("editing master content after approval invalidates approval and returns to draft", async () => {
    await service.syncAccounts("main");
    const accounts = service.db.listAccounts({ readiness: "READY" });

    const pub = service.createPublication({
      source_type: "text",
      master_title: "Initial Title",
      master_caption: "Initial Caption",
    });

    service.generateRenditionsForPublication(pub.id, [accounts[0]!.id]);
    service.approvePublication({
      publicationId: pub.id,
      decision: "approved",
      approverId: "reviewer",
    });

    expect(service.db.getPublication(pub.id)!.status).toBe("approved");

    // Edit master caption
    service.updatePublication(pub.id, { master_caption: "Updated Caption" });

    const pubAfterEdit = service.db.getPublication(pub.id)!;
    expect(pubAfterEdit.status).toBe("draft");

    const renditionsAfter = service.db.listRenditions(pub.id);
    expect(renditionsAfter[0]?.approval_status).toBe("pending");

    // Trying to publish without re-approving throws
    await expect(service.publishNow(pub.id)).rejects.toThrow(/Human approval is required/);
  });

  test("transient provider error marks delivery job failed_retryable with backoff", async () => {
    await service.syncAccounts("main");
    const account = service.db.listAccounts({ readiness: "READY" })[0]!;

    const pub = service.createPublication({
      source_type: "text",
      master_caption: "Will fail temporarily",
    });

    service.generateRenditionsForPublication(pub.id, [account.id]);
    service.approvePublication({
      publicationId: pub.id,
      decision: "approved",
      approverId: "reviewer",
    });

    // Simulate transient error
    fakeProvider.transientFailuresLeft = 1;

    await expect(service.publishNow(pub.id)).rejects.toThrow(/500 Service Unavailable/);

    const jobs = service.db.listDeliveryJobs({ publication_id: pub.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("failed_retryable");
    expect(jobs[0]?.attempt_count).toBe(1);
    expect(jobs[0]?.next_attempt_at).toBeDefined();

    // Now fake provider is healthy again, retry job
    const result = await service.publishNow(pub.id);
    expect(result.publication.status).toBe("published");
  });

  test("analytics sync ingests metrics without fabricating missing values as zero", async () => {
    await service.syncAccounts("main");
    const account = service.db.listAccounts()[0]!;

    const snapshot = await service.syncAnalytics(account.openpost_account_ref);
    expect(snapshot.account_id).toBe(account.openpost_account_ref);
    expect(snapshot.views).toBe(1250);
    expect(snapshot.likes).toBe(95);
    expect(snapshot.followers_delta).toBeNull(); // Missing metric is null, not 0!

    const list = service.db.listAnalyticsSnapshots({ account_id: account.openpost_account_ref });
    expect(list).toHaveLength(1);
  });

  test("audit trail records lifecycle operations with timestamps and actors", async () => {
    await service.syncAccounts("main", "cron_worker");
    const pub = service.createPublication({
      source_type: "text",
      master_caption: "Audited post",
      created_by_id: "agent_alpha",
    });

    const events = service.db.listAuditEvents();
    expect(events.some(e => e.action === "social_accounts.sync")).toBe(true);
    expect(events.some(e => e.action === "social_publication.create" && e.resource_id === pub.id)).toBe(true);
  });
});

