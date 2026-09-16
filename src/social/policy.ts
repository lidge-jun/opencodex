import type {
  OpenPostInstance,
  SocialAccount,
  SocialPolicyEvaluation,
  SocialPublication,
  SocialPublicationAsset,
  SocialRendition,
} from "./types";

export interface PolicyEvaluationContext {
  publication: SocialPublication;
  renditions: SocialRendition[];
  accounts: SocialAccount[];
  assets?: SocialPublicationAsset[];
  instance?: OpenPostInstance | null;
  action: "create" | "validate" | "schedule" | "publish_now" | "cancel";
}

export function evaluateSocialPolicy(ctx: PolicyEvaluationContext): SocialPolicyEvaluation {
  const ruleResults: SocialPolicyEvaluation["rule_results"] = [];
  const { publication, renditions, accounts, instance, action } = ctx;

  // 1. Account Policy: Every selected account must be enabled and ready
  for (const rendition of renditions) {
    const acc = accounts.find(a => a.id === rendition.account_id);
    if (!acc) {
      ruleResults.push({
        rule_id: "account.exists",
        description: "Destination account must be registered in Pao-hubPro",
        passed: false,
        severity: "blocking",
        message: `Account ${rendition.account_id} is not found`,
      });
      continue;
    }

    if (!acc.enabled) {
      ruleResults.push({
        rule_id: "account.enabled",
        description: "Destination account must be enabled",
        passed: false,
        severity: "blocking",
        message: `Account ${acc.display_name ?? acc.id} is disabled`,
      });
    }

    if (acc.readiness_state !== "READY") {
      ruleResults.push({
        rule_id: "account.readiness",
        description: "Destination account must be in READY state",
        passed: false,
        severity: acc.readiness_state === "REQUIRES_REAUTH" || acc.readiness_state === "DISABLED" ? "blocking" : "warning",
        message: `Account ${acc.display_name ?? acc.id} has readiness state: ${acc.readiness_state}`,
      });
    }
  }

  // 2. OpenPost Instance Health
  if (instance && instance.status === "unavailable") {
    ruleResults.push({
      rule_id: "instance.health",
      description: "Target OpenPost instance must be operational",
      passed: false,
      severity: "blocking",
      message: `OpenPost instance ${instance.name} is currently unavailable`,
    });
  }

  // 3. Content Policy: Content length and format limits
  for (const rendition of renditions) {
    const maxLen = rendition.capability_snapshot.text?.max_length ?? 280;
    const textLen = (rendition.caption ?? "").length + (rendition.title ? rendition.title.length + 1 : 0);
    if (textLen > maxLen) {
      ruleResults.push({
        rule_id: "content.max_length",
        description: `Content length must not exceed platform limit of ${maxLen} characters`,
        passed: false,
        severity: "blocking",
        message: `Rendition for ${rendition.platform} has ${textLen} chars, exceeding limit of ${maxLen}`,
      });
    } else {
      ruleResults.push({
        rule_id: "content.max_length",
        description: "Content length within platform limits",
        passed: true,
        severity: "info",
        message: `Rendition length ${textLen}/${maxLen} chars is within limits`,
      });
    }

    // Media capability check
    if (ctx.assets && ctx.assets.length > 0) {
      const hasVideo = ctx.assets.some(a => a.mime_type.startsWith("video/"));
      const hasImage = ctx.assets.some(a => a.mime_type.startsWith("image/"));

      if (hasVideo && !rendition.capability_snapshot.media?.video?.allowed) {
        ruleResults.push({
          rule_id: "media.video_allowed",
          description: `Platform ${rendition.platform} must support video media`,
          passed: false,
          severity: "blocking",
          message: `Video is not allowed for platform ${rendition.platform}`,
        });
      }

      if (hasImage && !rendition.capability_snapshot.media?.image?.allowed) {
        ruleResults.push({
          rule_id: "media.image_allowed",
          description: `Platform ${rendition.platform} must support image media`,
          passed: false,
          severity: "blocking",
          message: `Images are not allowed for platform ${rendition.platform}`,
        });
      }
    }
  }

  // 4. Scheduling Policy
  if (action === "schedule" || (publication.scheduled_at && action === "create")) {
    if (!publication.scheduled_at) {
      ruleResults.push({
        rule_id: "schedule.timestamp_present",
        description: "Schedule action requires a valid scheduled_at timestamp",
        passed: false,
        severity: "blocking",
        message: "Missing scheduled_at for scheduling operation",
      });
    } else {
      const scheduledTime = new Date(publication.scheduled_at).getTime();
      const now = Date.now();
      if (isNaN(scheduledTime)) {
        ruleResults.push({
          rule_id: "schedule.timestamp_valid",
          description: "Scheduled time must be a parseable ISO date",
          passed: false,
          severity: "blocking",
          message: `Invalid scheduled_at date: ${publication.scheduled_at}`,
        });
      } else if (scheduledTime < now - 60_000) {
        ruleResults.push({
          rule_id: "schedule.future_time",
          description: "Scheduled time must be in the future",
          passed: false,
          severity: "blocking",
          message: `Scheduled time is in the past: ${publication.scheduled_at}`,
        });
      }
    }
  }

  // 5. Human Approval Requirement (Default-Deny for Mutation)
  if (action === "publish_now" || action === "schedule") {
    if (publication.approval_mode === "human_required") {
      const allApproved = renditions.every(r => r.approval_status === "approved");
      if (!allApproved) {
        ruleResults.push({
          rule_id: "approval.human_required",
          description: "Human approval is required before publishing or scheduling",
          passed: false,
          severity: "blocking",
          message: "One or more renditions lack approved human review",
        });
      }
    }
  }

  // Aggregate decision
  const hasBlocking = ruleResults.some(r => !r.passed && r.severity === "blocking");
  const hasApprovalPending = ruleResults.some(r => r.rule_id === "approval.human_required" && !r.passed);

  let result: SocialPolicyEvaluation["result"] = "allow";
  let severity: SocialPolicyEvaluation["severity"] = "info";

  if (hasBlocking) {
    if (hasApprovalPending && ruleResults.filter(r => !r.passed).length === 1) {
      result = "approval_required";
      severity = "warning";
    } else {
      result = "deny";
      severity = "blocking";
    }
  } else if (ruleResults.some(r => !r.passed && r.severity === "warning")) {
    severity = "warning";
  }

  return {
    id: `pol_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    publication_id: publication.id,
    rendition_id: null,
    policy_version: "20.60.1",
    result,
    severity,
    rule_results: ruleResults,
    evaluated_by: "pao_social_policy_engine",
    created_at: new Date().toISOString(),
  };
}

