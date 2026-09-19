import { describe, expect, test } from "bun:test";
import { computeContentHash, computeIdempotencyKey } from "../../src/social/content-hash";
import { PLATFORM_DEFAULTS, RETRY_BACKOFF_SECONDS } from "../../src/social/constants";
import { isSocialPublishingEnabled } from "../../src/social/enabled";
import { evaluateSocialPolicy } from "../../src/social/policy";
import { generateRenditions } from "../../src/social/rendition";
import type { SocialAccount, SocialPublication, SocialRendition } from "../../src/social/types";

describe("social publishing feature flag", () => {
  test("defaults off", () => {
    expect(isSocialPublishingEnabled({})).toBe(false);
    expect(isSocialPublishingEnabled({ SOCIAL_PUBLISHING_ENABLED: "false" })).toBe(false);
  });

  test("enables on truthy env values", () => {
    expect(isSocialPublishingEnabled({ SOCIAL_PUBLISHING_ENABLED: "true" })).toBe(true);
    expect(isSocialPublishingEnabled({ SOCIAL_PUBLISHING_ENABLED: "1" })).toBe(true);
    expect(isSocialPublishingEnabled({ SOCIAL_PUBLISHING_ENABLED: "yes" })).toBe(true);
    expect(isSocialPublishingEnabled({ SOCIAL_PUBLISHING_ENABLED: "on" })).toBe(true);
  });
});

describe("deterministic content hash & idempotency", () => {
  test("content hash changes if caption, destination, media, or schedule changes", () => {
    const base = {
      caption: "Hello World",
      platform: "x",
      accountRef: "acc_1",
      scheduledAt: "2026-09-17T12:00:00Z",
    };
    const hash1 = computeContentHash(base);
    const hash2 = computeContentHash(base);
    expect(hash1).toBe(hash2);

    const hashDiffCaption = computeContentHash({ ...base, caption: "Hello World Updated" });
    expect(hashDiffCaption).not.toBe(hash1);

    const hashDiffPlatform = computeContentHash({ ...base, platform: "mastodon" });
    expect(hashDiffPlatform).not.toBe(hash1);

    const hashDiffSchedule = computeContentHash({ ...base, scheduledAt: "2026-09-17T15:00:00Z" });
    expect(hashDiffSchedule).not.toBe(hash1);

    const hashDiffMedia = computeContentHash({ ...base, mediaSha256s: ["sha256-abc"] });
    expect(hashDiffMedia).not.toBe(hash1);
  });

  test("idempotency key is deterministic and stable", () => {
    const key1 = computeIdempotencyKey("ws_1", "pub_1", "rend_1", "hash_abc", "publish_now", null);
    const key2 = computeIdempotencyKey("ws_1", "pub_1", "rend_1", "hash_abc", "publish_now", null);
    expect(key1).toBe(key2);

    const keyDifferentOp = computeIdempotencyKey("ws_1", "pub_1", "rend_1", "hash_abc", "schedule", "2026-09-17T12:00:00Z");
    expect(keyDifferentOp).not.toBe(key1);
  });
});

describe("rendition generator", () => {
  test("generates destination renditions and truncates long captions per platform limit", () => {
    const pub: SocialPublication = {
      id: "pub_1",
      workspace_id: "default",
      source_type: "text",
      master_title: "Announcement",
      master_caption: "A".repeat(400),
      master_description: null,
      master_tags: ["pao", "update"],
      master_metadata_json: "{}",
      status: "draft",
      risk_level: "normal",
      approval_mode: "human_required",
      scheduled_at: null,
      timezone: "UTC",
      created_by_type: "human",
      created_by_id: "op",
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const xAccount: SocialAccount = {
      id: "acc_x",
      workspace_id: "default",
      openpost_instance_id: "main",
      openpost_workspace_ref: "default",
      openpost_account_ref: "remote_x",
      platform: "x",
      display_name: "X Account",
      username: "x_user",
      readiness_state: "READY",
      capability_json: JSON.stringify(PLATFORM_DEFAULTS.x),
      capabilities: PLATFORM_DEFAULTS.x,
      last_sync_at: null,
      enabled: true,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const mastodonAccount: SocialAccount = {
      id: "acc_masto",
      workspace_id: "default",
      openpost_instance_id: "main",
      openpost_workspace_ref: "default",
      openpost_account_ref: "remote_masto",
      platform: "mastodon",
      display_name: "Mastodon Account",
      username: "masto_user",
      readiness_state: "READY",
      capability_json: JSON.stringify(PLATFORM_DEFAULTS.mastodon),
      capabilities: PLATFORM_DEFAULTS.mastodon,
      last_sync_at: null,
      enabled: true,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const renditions = generateRenditions({
      publication: pub,
      targetAccounts: [xAccount, mastodonAccount],
    });

    expect(renditions).toHaveLength(2);
    const xRend = renditions.find(r => r.platform === "x")!;
    const mastoRend = renditions.find(r => r.platform === "mastodon")!;

    expect(xRend.caption!.length).toBeLessThanOrEqual(280);
    expect(xRend.caption!.endsWith("…")).toBe(true);
    expect(mastoRend.caption!.length).toBe(400); // 400 < 500 max length
    expect(xRend.content_hash).toBeDefined();
    expect(mastoRend.content_hash).toBeDefined();
    expect(xRend.content_hash).not.toBe(mastoRend.content_hash);
  });
});

describe("policy evaluation", () => {
  test("blocks publishing when human approval is missing under human_required mode", () => {
    const pub: SocialPublication = {
      id: "pub_1",
      workspace_id: "default",
      source_type: "text",
      master_title: null,
      master_caption: "Policy check caption",
      master_description: null,
      master_tags: [],
      master_metadata_json: "{}",
      status: "draft",
      risk_level: "normal",
      approval_mode: "human_required",
      scheduled_at: null,
      timezone: "UTC",
      created_by_type: "human",
      created_by_id: "op",
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const acc: SocialAccount = {
      id: "acc_1",
      workspace_id: "default",
      openpost_instance_id: "main",
      openpost_workspace_ref: "default",
      openpost_account_ref: "rem_1",
      platform: "x",
      display_name: "X",
      username: "x",
      readiness_state: "READY",
      capability_json: JSON.stringify(PLATFORM_DEFAULTS.x),
      capabilities: PLATFORM_DEFAULTS.x,
      last_sync_at: null,
      enabled: true,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const rend: SocialRendition = {
      id: "rend_1",
      publication_id: "pub_1",
      account_id: "acc_1",
      platform: "x",
      format: "text",
      title: null,
      caption: "Policy check caption",
      description: null,
      hashtags: [],
      provider_settings: {},
      capability_snapshot: PLATFORM_DEFAULTS.x,
      validation_status: "valid",
      approval_status: "pending",
      delivery_status: "draft",
      openpost_publication_ref: null,
      openpost_rendition_ref: null,
      scheduled_at: null,
      content_hash: "hash123",
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const evaluation = evaluateSocialPolicy({
      publication: pub,
      renditions: [rend],
      accounts: [acc],
      action: "publish_now",
    });

    expect(evaluation.result).toBe("approval_required");
  });

  test("denies policy when account is disabled or degraded with REQUIRES_REAUTH", () => {
    const pub: SocialPublication = {
      id: "pub_1",
      workspace_id: "default",
      source_type: "text",
      master_title: null,
      master_caption: "Short caption",
      master_description: null,
      master_tags: [],
      master_metadata_json: "{}",
      status: "draft",
      risk_level: "normal",
      approval_mode: "human_required",
      scheduled_at: null,
      timezone: "UTC",
      created_by_type: "human",
      created_by_id: "op",
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const degradedAcc: SocialAccount = {
      id: "acc_degraded",
      workspace_id: "default",
      openpost_instance_id: "main",
      openpost_workspace_ref: "default",
      openpost_account_ref: "rem_deg",
      platform: "x",
      display_name: "Degraded X",
      username: "x_deg",
      readiness_state: "REQUIRES_REAUTH",
      capability_json: JSON.stringify(PLATFORM_DEFAULTS.x),
      capabilities: PLATFORM_DEFAULTS.x,
      last_sync_at: null,
      enabled: true,
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const rend: SocialRendition = {
      id: "rend_1",
      publication_id: "pub_1",
      account_id: "acc_degraded",
      platform: "x",
      format: "text",
      title: null,
      caption: "Short caption",
      description: null,
      hashtags: [],
      provider_settings: {},
      capability_snapshot: PLATFORM_DEFAULTS.x,
      validation_status: "valid",
      approval_status: "approved",
      delivery_status: "draft",
      openpost_publication_ref: null,
      openpost_rendition_ref: null,
      scheduled_at: null,
      content_hash: "hash123",
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
    };

    const evaluation = evaluateSocialPolicy({
      publication: pub,
      renditions: [rend],
      accounts: [degradedAcc],
      action: "validate",
    });

    expect(evaluation.result).toBe("deny");
    expect(evaluation.rule_results.some(r => r.rule_id === "account.readiness" && !r.passed)).toBe(true);
  });
});

