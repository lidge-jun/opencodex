export type SocialPlatform =
  | "x"
  | "mastodon"
  | "bluesky"
  | "linkedin"
  | "threads"
  | "facebook"
  | "instagram"
  | "tiktok"
  | "youtube"
  | "discord";

export type PublicationStatus =
  | "draft"
  | "preparing"
  | "ready_for_review"
  | "approval_required"
  | "approved"
  | "rejected"
  | "scheduled"
  | "dispatching"
  | "partial_success"
  | "published"
  | "failed"
  | "cancelled";

export type RenditionStatus =
  | "draft"
  | "validating"
  | "approval_required"
  | "approved"
  | "rejected"
  | "scheduled"
  | "queued"
  | "publishing"
  | "published"
  | "failed_retryable"
  | "failed_final"
  | "cancelled"
  | "reconciliation_required"
  | "unknown";

export type AccountReadiness =
  | "READY"
  | "DEGRADED"
  | "REQUIRES_REAUTH"
  | "REQUIRES_SCOPE"
  | "REQUIRES_REVIEW"
  | "UNSUPPORTED_FORMAT"
  | "RATE_LIMITED"
  | "UNKNOWN"
  | "DISABLED";

export type ApprovalMode =
  | "human_required"
  | "policy_automated"
  | "workspace_override";

export type ApprovalDecision = "approved" | "rejected" | "pending";

export type DeliveryJobStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed_retryable"
  | "failed_final"
  | "cancelled";

export interface OpenPostInstance {
  id: string;
  workspace_id: string;
  name: string;
  base_url: string;
  auth_mode: "token" | "mcp" | "hybrid";
  secret_ref: string;
  mcp_endpoint: string | null;
  mcp_scope: string | null;
  status: "healthy" | "degraded" | "unavailable" | "unknown";
  version: string | null;
  last_health_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlatformCapabilities {
  platform: SocialPlatform;
  formats: string[];
  text: {
    max_length: number;
    title: boolean;
    caption: boolean;
    description: boolean;
  };
  media: {
    image: {
      allowed: boolean;
      max_count?: number;
      max_bytes?: number;
    };
    video: {
      allowed: boolean;
      max_bytes?: number;
      max_duration_ms?: number;
    };
  };
  scheduling: {
    supported: boolean;
  };
  review: {
    provider_review_required: boolean;
  };
  raw?: Record<string, unknown>;
}

export interface SocialAccount {
  id: string;
  workspace_id: string;
  openpost_instance_id: string;
  openpost_workspace_ref: string;
  openpost_account_ref: string;
  platform: SocialPlatform;
  display_name: string | null;
  username: string | null;
  readiness_state: AccountReadiness;
  capability_json: string;
  capabilities: PlatformCapabilities;
  last_sync_at: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SocialPublication {
  id: string;
  workspace_id: string;
  source_type: "image" | "video" | "text" | "mixed" | "external";
  master_title: string | null;
  master_caption: string | null;
  master_description: string | null;
  master_tags: string[];
  master_metadata_json: string;
  status: PublicationStatus;
  risk_level: "low" | "normal" | "high";
  approval_mode: ApprovalMode;
  scheduled_at: string | null;
  timezone: string;
  created_by_type: "human" | "agent" | "system";
  created_by_id: string;
  created_at: string;
  updated_at: string;
}

export interface SocialPublicationAsset {
  id: string;
  publication_id: string;
  local_asset_id: string;
  openpost_media_ref: string | null;
  sha256: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  provenance_json: string;
  created_at: string;
}

export interface SocialRendition {
  id: string;
  publication_id: string;
  account_id: string;
  platform: SocialPlatform;
  format: string;
  title: string | null;
  caption: string | null;
  description: string | null;
  hashtags: string[];
  provider_settings: Record<string, unknown>;
  capability_snapshot: PlatformCapabilities;
  validation_status: "pending" | "valid" | "invalid";
  approval_status: ApprovalDecision;
  delivery_status: RenditionStatus;
  openpost_publication_ref: string | null;
  openpost_rendition_ref: string | null;
  scheduled_at: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SocialPolicyEvaluation {
  id: string;
  publication_id: string;
  rendition_id: string | null;
  policy_version: string;
  result: "allow" | "deny" | "approval_required";
  severity: "info" | "warning" | "blocking";
  rule_results: Array<{
    rule_id: string;
    description: string;
    passed: boolean;
    severity: "info" | "warning" | "blocking";
    message: string;
  }>;
  evaluated_by: string;
  created_at: string;
}

export interface SocialApproval {
  id: string;
  publication_id: string;
  rendition_id: string | null;
  decision: ApprovalDecision;
  approver_type: "human" | "system";
  approver_id: string;
  approval_scope: "PUBLICATION_ALL_DESTINATIONS" | "RENDITION_ONLY" | "SCHEDULE_ONLY" | "PUBLISH_NOW_ONLY";
  content_hash: string;
  note: string | null;
  created_at: string;
}

export interface SocialDeliveryJob {
  id: string;
  publication_id: string;
  rendition_id: string;
  idempotency_key: string;
  job_type: "publish_now" | "schedule" | "cancel";
  status: DeliveryJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  locked_at: string | null;
  locked_by: string | null;
  last_error_class: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  remote_operation_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface SocialAnalyticsSnapshot {
  id: string;
  publication_id: string | null;
  rendition_id: string | null;
  account_id: string;
  captured_at: string;
  views: number | null;
  impressions: number | null;
  reach: number | null;
  engagements: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  followers_delta: number | null;
  raw_metrics: Record<string, unknown>;
}

export interface SocialAuditEvent {
  id: string;
  timestamp: string;
  workspace_id: string;
  actor_type: "human" | "agent" | "system";
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  request_id?: string;
  correlation_id?: string;
  policy_decision?: string;
  approval_ref?: string;
  openpost_instance_id?: string;
  remote_ref?: string;
  before_hash?: string;
  after_hash?: string;
  metadata?: Record<string, unknown>;
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unavailable";
  version: string | null;
  latency_ms: number;
  message?: string;
}

export interface RemoteWorkspace {
  id: string;
  name: string;
}

export interface RemoteAccount {
  id: string;
  platform: SocialPlatform;
  display_name: string;
  username: string;
  readiness_state: AccountReadiness;
  capabilities: PlatformCapabilities;
}

export interface RemoteMedia {
  id: string;
  url?: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
}

export interface RemoteDeliveryState {
  remote_publication_ref: string;
  remote_rendition_ref?: string;
  status: RenditionStatus;
  scheduled_at?: string;
  published_at?: string;
  error_message?: string;
}

export interface SocialPublishingProvider {
  healthCheck(): Promise<ProviderHealth>;
  getServerInfo(): Promise<{ version: string; status: string }>;
  listWorkspaces(): Promise<RemoteWorkspace[]>;
  listAccounts(workspaceRef: string): Promise<RemoteAccount[]>;
  getAccountCapabilities(accountRef: string): Promise<PlatformCapabilities>;
  uploadMedia(input: {
    content: Buffer | Uint8Array;
    mime_type: string;
    filename: string;
    sha256: string;
  }): Promise<RemoteMedia>;
  getMedia(mediaRef: string): Promise<RemoteMedia>;
  createPublication(input: {
    title?: string;
    caption?: string;
    renditions: Array<{
      account_ref: string;
      platform: SocialPlatform;
      caption?: string;
      media_refs?: string[];
      provider_settings?: Record<string, unknown>;
    }>;
  }): Promise<{ publication_ref: string; rendition_refs: Record<string, string> }>;
  schedule(input: {
    publication_ref: string;
    scheduled_at: string;
    timezone: string;
  }): Promise<RemoteDeliveryState>;
  publishNow(input: {
    publication_ref: string;
  }): Promise<RemoteDeliveryState>;
  cancel(input: {
    publication_ref: string;
  }): Promise<RemoteDeliveryState>;
  getPublicationState(publicationRef: string): Promise<{
    publication_ref: string;
    status: PublicationStatus;
    rendition_states: Record<string, RenditionStatus>;
  }>;
  getAnalytics(input: {
    account_ref: string;
    publication_ref?: string;
  }): Promise<{
    views: number | null;
    impressions: number | null;
    reach: number | null;
    engagements: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    raw: Record<string, unknown>;
  }>;
}
