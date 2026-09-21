import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { getConfigDir } from "../config/paths";
import { PAO_SOCIAL_DB_PATH_ENV } from "./constants";
import type {
  OpenPostInstance,
  SocialAccount,
  SocialAnalyticsSnapshot,
  SocialApproval,
  SocialAuditEvent,
  SocialDeliveryJob,
  SocialPolicyEvaluation,
  SocialPublication,
  SocialPublicationAsset,
  SocialRendition,
} from "./types";

export function getDefaultSocialDbPath(customDir?: string): string {
  const custom = process.env[PAO_SOCIAL_DB_PATH_ENV]?.trim();
  if (custom) return custom;
  const dir = customDir ?? getConfigDir();
  return join(dir, "social.sqlite");
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

function asBool(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === "1";
}

export class SocialDatabase {
  private readonly db: Database;
  public readonly path: string;

  constructor(customPath?: string) {
    this.path = customPath ?? getDefaultSocialDbPath();
    if (this.path !== ":memory:") {
      const parent = dirname(this.path);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    }
    this.db = new Database(this.path);
    this.init();
  }

  public close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS openpost_instances (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        name                TEXT NOT NULL,
        base_url            TEXT NOT NULL,
        auth_mode           TEXT NOT NULL,
        secret_ref          TEXT NOT NULL,
        mcp_endpoint        TEXT NULL,
        mcp_scope           TEXT NULL,
        status              TEXT NOT NULL DEFAULT 'unknown',
        version             TEXT NULL,
        last_health_at      TEXT NULL,
        last_error_code     TEXT NULL,
        last_error_message  TEXT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_accounts (
        id                     TEXT PRIMARY KEY,
        workspace_id           TEXT NOT NULL,
        openpost_instance_id   TEXT NOT NULL,
        openpost_workspace_ref TEXT NOT NULL,
        openpost_account_ref   TEXT NOT NULL,
        platform               TEXT NOT NULL,
        display_name           TEXT NULL,
        username               TEXT NULL,
        readiness_state        TEXT NOT NULL DEFAULT 'UNKNOWN',
        capability_json        TEXT NOT NULL,
        last_sync_at           TEXT NULL,
        enabled                INTEGER NOT NULL DEFAULT 1,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL,
        UNIQUE(openpost_instance_id, openpost_account_ref),
        FOREIGN KEY (openpost_instance_id) REFERENCES openpost_instances(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_publications (
        id                  TEXT PRIMARY KEY,
        workspace_id        TEXT NOT NULL,
        source_type         TEXT NOT NULL,
        master_title        TEXT NULL,
        master_caption      TEXT NULL,
        master_description  TEXT NULL,
        master_tags_json    TEXT NOT NULL,
        master_metadata_json TEXT NOT NULL,
        status              TEXT NOT NULL,
        risk_level          TEXT NOT NULL DEFAULT 'normal',
        approval_mode       TEXT NOT NULL DEFAULT 'human_required',
        scheduled_at        TEXT NULL,
        timezone            TEXT NOT NULL,
        created_by_type     TEXT NOT NULL,
        created_by_id       TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_publication_assets (
        id                TEXT PRIMARY KEY,
        publication_id    TEXT NOT NULL,
        local_asset_id    TEXT NOT NULL,
        openpost_media_ref TEXT NULL,
        sha256            TEXT NOT NULL,
        mime_type         TEXT NOT NULL,
        byte_size         INTEGER NOT NULL,
        width             INTEGER NULL,
        height            INTEGER NULL,
        duration_ms       INTEGER NULL,
        provenance_json   TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        UNIQUE(publication_id, local_asset_id),
        FOREIGN KEY (publication_id) REFERENCES social_publications(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_renditions (
        id                       TEXT PRIMARY KEY,
        publication_id           TEXT NOT NULL,
        account_id               TEXT NOT NULL,
        platform                 TEXT NOT NULL,
        format                   TEXT NOT NULL,
        title                    TEXT NULL,
        caption                  TEXT NULL,
        description              TEXT NULL,
        hashtags_json            TEXT NOT NULL,
        provider_settings_json   TEXT NOT NULL,
        capability_snapshot_json TEXT NOT NULL,
        validation_status        TEXT NOT NULL,
        approval_status          TEXT NOT NULL,
        delivery_status          TEXT NOT NULL,
        openpost_publication_ref TEXT NULL,
        openpost_rendition_ref   TEXT NULL,
        scheduled_at             TEXT NULL,
        content_hash             TEXT NOT NULL,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        UNIQUE(publication_id, account_id),
        FOREIGN KEY (publication_id) REFERENCES social_publications(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_policy_evaluations (
        id                TEXT PRIMARY KEY,
        publication_id    TEXT NOT NULL,
        rendition_id      TEXT NULL,
        policy_version    TEXT NOT NULL,
        result            TEXT NOT NULL,
        severity          TEXT NOT NULL,
        rule_results_json TEXT NOT NULL,
        evaluated_by      TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_approvals (
        id                 TEXT PRIMARY KEY,
        publication_id     TEXT NOT NULL,
        rendition_id       TEXT NULL,
        decision           TEXT NOT NULL,
        approver_type      TEXT NOT NULL,
        approver_id        TEXT NOT NULL,
        approval_scope     TEXT NOT NULL,
        content_hash       TEXT NOT NULL,
        note               TEXT NULL,
        created_at         TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_delivery_jobs (
        id                    TEXT PRIMARY KEY,
        publication_id        TEXT NOT NULL,
        rendition_id          TEXT NOT NULL,
        idempotency_key       TEXT NOT NULL UNIQUE,
        job_type              TEXT NOT NULL,
        status                TEXT NOT NULL,
        attempt_count         INTEGER NOT NULL DEFAULT 0,
        max_attempts          INTEGER NOT NULL DEFAULT 5,
        next_attempt_at       TEXT NULL,
        locked_at             TEXT NULL,
        locked_by             TEXT NULL,
        last_error_class      TEXT NULL,
        last_error_code       TEXT NULL,
        last_error_message    TEXT NULL,
        remote_operation_ref  TEXT NULL,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        FOREIGN KEY (publication_id) REFERENCES social_publications(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_analytics_snapshots (
        id                    TEXT PRIMARY KEY,
        publication_id        TEXT NULL,
        rendition_id          TEXT NULL,
        account_id            TEXT NOT NULL,
        captured_at           TEXT NOT NULL,
        views                 INTEGER NULL,
        impressions           INTEGER NULL,
        reach                 INTEGER NULL,
        engagements           INTEGER NULL,
        likes                 INTEGER NULL,
        comments              INTEGER NULL,
        shares                INTEGER NULL,
        followers_delta       INTEGER NULL,
        raw_metrics_json      TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS social_audit_events (
        id                    TEXT PRIMARY KEY,
        timestamp             TEXT NOT NULL,
        workspace_id          TEXT NOT NULL,
        actor_type            TEXT NOT NULL,
        actor_id              TEXT NOT NULL,
        action                TEXT NOT NULL,
        resource_type         TEXT NOT NULL,
        resource_id           TEXT NOT NULL,
        request_id            TEXT NULL,
        correlation_id        TEXT NULL,
        policy_decision       TEXT NULL,
        approval_ref          TEXT NULL,
        openpost_instance_id  TEXT NULL,
        remote_ref            TEXT NULL,
        before_hash           TEXT NULL,
        after_hash            TEXT NULL,
        metadata_json         TEXT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_social_jobs_due ON social_delivery_jobs(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_social_jobs_pub ON social_delivery_jobs(publication_id);
      CREATE INDEX IF NOT EXISTS idx_social_renditions_pub ON social_renditions(publication_id);
      CREATE INDEX IF NOT EXISTS idx_social_pubs_status ON social_publications(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_social_audit_ts ON social_audit_events(timestamp DESC);
    `);
  }

  // --- Instances ---
  public upsertInstance(inst: OpenPostInstance): void {
    this.db.run(
      `INSERT INTO openpost_instances (
        id, workspace_id, name, base_url, auth_mode, secret_ref, mcp_endpoint, mcp_scope,
        status, version, last_health_at, last_error_code, last_error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        name=excluded.name,
        base_url=excluded.base_url,
        auth_mode=excluded.auth_mode,
        secret_ref=excluded.secret_ref,
        mcp_endpoint=excluded.mcp_endpoint,
        mcp_scope=excluded.mcp_scope,
        status=excluded.status,
        version=excluded.version,
        last_health_at=excluded.last_health_at,
        last_error_code=excluded.last_error_code,
        last_error_message=excluded.last_error_message,
        updated_at=excluded.updated_at;`,
      [
        inst.id,
        inst.workspace_id,
        inst.name,
        inst.base_url,
        inst.auth_mode,
        inst.secret_ref,
        inst.mcp_endpoint,
        inst.mcp_scope,
        inst.status,
        inst.version,
        inst.last_health_at,
        inst.last_error_code,
        inst.last_error_message,
        inst.created_at,
        inst.updated_at,
      ],
    );
  }

  public getInstance(id: string): OpenPostInstance | null {
    const row = this.db.query("SELECT * FROM openpost_instances WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return row as unknown as OpenPostInstance;
  }

  public listInstances(): OpenPostInstance[] {
    const rows = this.db.query("SELECT * FROM openpost_instances ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows as unknown as OpenPostInstance[];
  }

  public deleteInstance(id: string): boolean {
    const res = this.db.run("DELETE FROM openpost_instances WHERE id = ?", [id]);
    return res.changes > 0;
  }

  // --- Accounts ---
  public upsertAccount(acc: SocialAccount): void {
    this.db.run(
      `INSERT INTO social_accounts (
        id, workspace_id, openpost_instance_id, openpost_workspace_ref, openpost_account_ref,
        platform, display_name, username, readiness_state, capability_json, last_sync_at,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(openpost_instance_id, openpost_account_ref) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        platform=excluded.platform,
        display_name=excluded.display_name,
        username=excluded.username,
        readiness_state=excluded.readiness_state,
        capability_json=excluded.capability_json,
        last_sync_at=excluded.last_sync_at,
        enabled=excluded.enabled,
        updated_at=excluded.updated_at;`,
      [
        acc.id,
        acc.workspace_id,
        acc.openpost_instance_id,
        acc.openpost_workspace_ref,
        acc.openpost_account_ref,
        acc.platform,
        acc.display_name,
        acc.username,
        acc.readiness_state,
        acc.capability_json,
        acc.last_sync_at,
        acc.enabled ? 1 : 0,
        acc.created_at,
        acc.updated_at,
      ],
    );
  }

  public getAccount(id: string): SocialAccount | null {
    const row = this.db.query("SELECT * FROM social_accounts WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapAccount(row);
  }

  public listAccounts(filter?: { platform?: string; readiness?: string }): SocialAccount[] {
    let sql = "SELECT * FROM social_accounts WHERE 1=1";
    const params: any[] = [];
    if (filter?.platform) {
      sql += " AND platform = ?";
      params.push(filter.platform);
    }
    if (filter?.readiness) {
      sql += " AND readiness_state = ?";
      params.push(filter.readiness);
    }
    sql += " ORDER BY platform ASC, display_name ASC";
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapAccount(r));
  }

  private mapAccount(row: Record<string, unknown>): SocialAccount {
    return {
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      openpost_instance_id: String(row.openpost_instance_id),
      openpost_workspace_ref: String(row.openpost_workspace_ref),
      openpost_account_ref: String(row.openpost_account_ref),
      platform: row.platform as any,
      display_name: row.display_name ? String(row.display_name) : null,
      username: row.username ? String(row.username) : null,
      readiness_state: row.readiness_state as any,
      capability_json: String(row.capability_json),
      capabilities: parseJson(row.capability_json, {} as any),
      last_sync_at: row.last_sync_at ? String(row.last_sync_at) : null,
      enabled: asBool(row.enabled),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // --- Publications ---
  public upsertPublication(pub: SocialPublication): void {
    this.db.run(
      `INSERT INTO social_publications (
        id, workspace_id, source_type, master_title, master_caption, master_description,
        master_tags_json, master_metadata_json, status, risk_level, approval_mode,
        scheduled_at, timezone, created_by_type, created_by_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        source_type=excluded.source_type,
        master_title=excluded.master_title,
        master_caption=excluded.master_caption,
        master_description=excluded.master_description,
        master_tags_json=excluded.master_tags_json,
        master_metadata_json=excluded.master_metadata_json,
        status=excluded.status,
        risk_level=excluded.risk_level,
        approval_mode=excluded.approval_mode,
        scheduled_at=excluded.scheduled_at,
        timezone=excluded.timezone,
        updated_at=excluded.updated_at;`,
      [
        pub.id,
        pub.workspace_id,
        pub.source_type,
        pub.master_title,
        pub.master_caption,
        pub.master_description,
        jsonText(pub.master_tags),
        pub.master_metadata_json,
        pub.status,
        pub.risk_level,
        pub.approval_mode,
        pub.scheduled_at,
        pub.timezone,
        pub.created_by_type,
        pub.created_by_id,
        pub.created_at,
        pub.updated_at,
      ],
    );
  }

  public getPublication(id: string): SocialPublication | null {
    const row = this.db.query("SELECT * FROM social_publications WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapPublication(row);
  }

  public listPublications(filter?: { status?: string }): SocialPublication[] {
    let sql = "SELECT * FROM social_publications WHERE 1=1";
    const params: any[] = [];
    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    sql += " ORDER BY created_at DESC";
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapPublication(r));
  }

  private mapPublication(row: Record<string, unknown>): SocialPublication {
    return {
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      source_type: row.source_type as any,
      master_title: row.master_title ? String(row.master_title) : null,
      master_caption: row.master_caption ? String(row.master_caption) : null,
      master_description: row.master_description ? String(row.master_description) : null,
      master_tags: parseJson(row.master_tags_json, []),
      master_metadata_json: String(row.master_metadata_json),
      status: row.status as any,
      risk_level: row.risk_level as any,
      approval_mode: row.approval_mode as any,
      scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
      timezone: String(row.timezone),
      created_by_type: row.created_by_type as any,
      created_by_id: String(row.created_by_id),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // --- Assets ---
  public upsertAsset(asset: SocialPublicationAsset): void {
    this.db.run(
      `INSERT INTO social_publication_assets (
        id, publication_id, local_asset_id, openpost_media_ref, sha256, mime_type,
        byte_size, width, height, duration_ms, provenance_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(publication_id, local_asset_id) DO UPDATE SET
        openpost_media_ref=excluded.openpost_media_ref,
        sha256=excluded.sha256,
        mime_type=excluded.mime_type,
        byte_size=excluded.byte_size,
        width=excluded.width,
        height=excluded.height,
        duration_ms=excluded.duration_ms,
        provenance_json=excluded.provenance_json;`,
      [
        asset.id,
        asset.publication_id,
        asset.local_asset_id,
        asset.openpost_media_ref,
        asset.sha256,
        asset.mime_type,
        asset.byte_size,
        asset.width,
        asset.height,
        asset.duration_ms,
        asset.provenance_json,
        asset.created_at,
      ],
    );
  }

  public listAssets(publicationId: string): SocialPublicationAsset[] {
    const rows = this.db.query("SELECT * FROM social_publication_assets WHERE publication_id = ?").all(publicationId) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: String(r.id),
      publication_id: String(r.publication_id),
      local_asset_id: String(r.local_asset_id),
      openpost_media_ref: r.openpost_media_ref ? String(r.openpost_media_ref) : null,
      sha256: String(r.sha256),
      mime_type: String(r.mime_type),
      byte_size: Number(r.byte_size),
      width: r.width != null ? Number(r.width) : null,
      height: r.height != null ? Number(r.height) : null,
      duration_ms: r.duration_ms != null ? Number(r.duration_ms) : null,
      provenance_json: String(r.provenance_json),
      created_at: String(r.created_at),
    }));
  }

  // --- Renditions ---
  public upsertRendition(rend: SocialRendition): void {
    this.db.run(
      `INSERT INTO social_renditions (
        id, publication_id, account_id, platform, format, title, caption, description,
        hashtags_json, provider_settings_json, capability_snapshot_json, validation_status,
        approval_status, delivery_status, openpost_publication_ref, openpost_rendition_ref,
        scheduled_at, content_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(publication_id, account_id) DO UPDATE SET
        id=excluded.id,
        platform=excluded.platform,
        format=excluded.format,
        title=excluded.title,
        caption=excluded.caption,
        description=excluded.description,
        hashtags_json=excluded.hashtags_json,
        provider_settings_json=excluded.provider_settings_json,
        capability_snapshot_json=excluded.capability_snapshot_json,
        validation_status=excluded.validation_status,
        approval_status=excluded.approval_status,
        delivery_status=excluded.delivery_status,
        openpost_publication_ref=excluded.openpost_publication_ref,
        openpost_rendition_ref=excluded.openpost_rendition_ref,
        scheduled_at=excluded.scheduled_at,
        content_hash=excluded.content_hash,
        updated_at=excluded.updated_at;`,
      [
        rend.id,
        rend.publication_id,
        rend.account_id,
        rend.platform,
        rend.format,
        rend.title,
        rend.caption,
        rend.description,
        jsonText(rend.hashtags),
        jsonText(rend.provider_settings),
        jsonText(rend.capability_snapshot),
        rend.validation_status,
        rend.approval_status,
        rend.delivery_status,
        rend.openpost_publication_ref,
        rend.openpost_rendition_ref,
        rend.scheduled_at,
        rend.content_hash,
        rend.created_at,
        rend.updated_at,
      ],
    );
  }

  public getRendition(id: string): SocialRendition | null {
    const row = this.db.query("SELECT * FROM social_renditions WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapRendition(row);
  }

  public listRenditions(publicationId?: string): SocialRendition[] {
    let sql = "SELECT * FROM social_renditions WHERE 1=1";
    const params: any[] = [];
    if (publicationId) {
      sql += " AND publication_id = ?";
      params.push(publicationId);
    }
    sql += " ORDER BY platform ASC";
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapRendition(r));
  }

  private mapRendition(row: Record<string, unknown>): SocialRendition {
    return {
      id: String(row.id),
      publication_id: String(row.publication_id),
      account_id: String(row.account_id),
      platform: row.platform as any,
      format: String(row.format),
      title: row.title ? String(row.title) : null,
      caption: row.caption ? String(row.caption) : null,
      description: row.description ? String(row.description) : null,
      hashtags: parseJson(row.hashtags_json, []),
      provider_settings: parseJson(row.provider_settings_json, {}),
      capability_snapshot: parseJson(row.capability_snapshot_json, {} as any),
      validation_status: row.validation_status as any,
      approval_status: row.approval_status as any,
      delivery_status: row.delivery_status as any,
      openpost_publication_ref: row.openpost_publication_ref ? String(row.openpost_publication_ref) : null,
      openpost_rendition_ref: row.openpost_rendition_ref ? String(row.openpost_rendition_ref) : null,
      scheduled_at: row.scheduled_at ? String(row.scheduled_at) : null,
      content_hash: String(row.content_hash),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // --- Policy Evaluations ---
  public insertPolicyEvaluation(evalRecord: SocialPolicyEvaluation): void {
    this.db.run(
      `INSERT INTO social_policy_evaluations (
        id, publication_id, rendition_id, policy_version, result, severity,
        rule_results_json, evaluated_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        evalRecord.id,
        evalRecord.publication_id,
        evalRecord.rendition_id,
        evalRecord.policy_version,
        evalRecord.result,
        evalRecord.severity,
        jsonText(evalRecord.rule_results),
        evalRecord.evaluated_by,
        evalRecord.created_at,
      ],
    );
  }

  public listPolicyEvaluations(publicationId: string): SocialPolicyEvaluation[] {
    const rows = this.db.query("SELECT * FROM social_policy_evaluations WHERE publication_id = ? ORDER BY created_at DESC").all(publicationId) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: String(r.id),
      publication_id: String(r.publication_id),
      rendition_id: r.rendition_id ? String(r.rendition_id) : null,
      policy_version: String(r.policy_version),
      result: r.result as any,
      severity: r.severity as any,
      rule_results: parseJson(r.rule_results_json, []),
      evaluated_by: String(r.evaluated_by),
      created_at: String(r.created_at),
    }));
  }

  // --- Approvals ---
  public insertApproval(appr: SocialApproval): void {
    this.db.run(
      `INSERT INTO social_approvals (
        id, publication_id, rendition_id, decision, approver_type, approver_id,
        approval_scope, content_hash, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        appr.id,
        appr.publication_id,
        appr.rendition_id,
        appr.decision,
        appr.approver_type,
        appr.approver_id,
        appr.approval_scope,
        appr.content_hash,
        appr.note,
        appr.created_at,
      ],
    );
  }

  public listApprovals(publicationId: string): SocialApproval[] {
    const rows = this.db.query("SELECT * FROM social_approvals WHERE publication_id = ? ORDER BY created_at DESC").all(publicationId) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: String(r.id),
      publication_id: String(r.publication_id),
      rendition_id: r.rendition_id ? String(r.rendition_id) : null,
      decision: r.decision as any,
      approver_type: r.approver_type as any,
      approver_id: String(r.approver_id),
      approval_scope: r.approval_scope as any,
      content_hash: String(r.content_hash),
      note: r.note ? String(r.note) : null,
      created_at: String(r.created_at),
    }));
  }

  public listAllApprovals(): SocialApproval[] {
    const rows = this.db.query("SELECT * FROM social_approvals ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: String(r.id),
      publication_id: String(r.publication_id),
      rendition_id: r.rendition_id ? String(r.rendition_id) : null,
      decision: r.decision as any,
      approver_type: r.approver_type as any,
      approver_id: String(r.approver_id),
      approval_scope: r.approval_scope as any,
      content_hash: String(r.content_hash),
      note: r.note ? String(r.note) : null,
      created_at: String(r.created_at),
    }));
  }

  public getLatestApproval(publicationId: string, renditionId?: string | null): SocialApproval | null {
    let sql = "SELECT * FROM social_approvals WHERE publication_id = ?";
    const params: any[] = [publicationId];
    if (renditionId) {
      sql += " AND (rendition_id = ? OR rendition_id IS NULL)";
      params.push(renditionId);
    }
    sql += " ORDER BY created_at DESC LIMIT 1";
    const row = this.db.query(sql).get(...params) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      publication_id: String(row.publication_id),
      rendition_id: row.rendition_id ? String(row.rendition_id) : null,
      decision: row.decision as any,
      approver_type: row.approver_type as any,
      approver_id: String(row.approver_id),
      approval_scope: row.approval_scope as any,
      content_hash: String(row.content_hash),
      note: row.note ? String(row.note) : null,
      created_at: String(row.created_at),
    };
  }

  // --- Delivery Jobs ---
  public upsertDeliveryJob(job: SocialDeliveryJob): void {
    this.db.run(
      `INSERT INTO social_delivery_jobs (
        id, publication_id, rendition_id, idempotency_key, job_type, status,
        attempt_count, max_attempts, next_attempt_at, locked_at, locked_by,
        last_error_class, last_error_code, last_error_message, remote_operation_ref,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        id=excluded.id,
        status=excluded.status,
        attempt_count=max(social_delivery_jobs.attempt_count, excluded.attempt_count),
        next_attempt_at=excluded.next_attempt_at,
        locked_at=excluded.locked_at,
        locked_by=excluded.locked_by,
        last_error_class=excluded.last_error_class,
        last_error_code=excluded.last_error_code,
        last_error_message=excluded.last_error_message,
        remote_operation_ref=excluded.remote_operation_ref,
        updated_at=excluded.updated_at;`,
      [
        job.id,
        job.publication_id,
        job.rendition_id,
        job.idempotency_key,
        job.job_type,
        job.status,
        job.attempt_count,
        job.max_attempts,
        job.next_attempt_at,
        job.locked_at,
        job.locked_by,
        job.last_error_class,
        job.last_error_code,
        job.last_error_message,
        job.remote_operation_ref,
        job.created_at,
        job.updated_at,
      ],
    );
  }

  public getDeliveryJobByIdempotencyKey(key: string): SocialDeliveryJob | null {
    const row = this.db.query("SELECT * FROM social_delivery_jobs WHERE idempotency_key = ?").get(key) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapDeliveryJob(row);
  }

  public listDeliveryJobs(filter?: { status?: string; publication_id?: string }): SocialDeliveryJob[] {
    let sql = "SELECT * FROM social_delivery_jobs WHERE 1=1";
    const params: any[] = [];
    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.publication_id) {
      sql += " AND publication_id = ?";
      params.push(filter.publication_id);
    }
    sql += " ORDER BY created_at DESC";
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => this.mapDeliveryJob(r));
  }

  private mapDeliveryJob(row: Record<string, unknown>): SocialDeliveryJob {
    return {
      id: String(row.id),
      publication_id: String(row.publication_id),
      rendition_id: String(row.rendition_id),
      idempotency_key: String(row.idempotency_key),
      job_type: row.job_type as any,
      status: row.status as any,
      attempt_count: Number(row.attempt_count),
      max_attempts: Number(row.max_attempts),
      next_attempt_at: row.next_attempt_at ? String(row.next_attempt_at) : null,
      locked_at: row.locked_at ? String(row.locked_at) : null,
      locked_by: row.locked_by ? String(row.locked_by) : null,
      last_error_class: row.last_error_class ? String(row.last_error_class) : null,
      last_error_code: row.last_error_code ? String(row.last_error_code) : null,
      last_error_message: row.last_error_message ? String(row.last_error_message) : null,
      remote_operation_ref: row.remote_operation_ref ? String(row.remote_operation_ref) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  // --- Analytics ---
  public insertAnalyticsSnapshot(snap: SocialAnalyticsSnapshot): void {
    this.db.run(
      `INSERT INTO social_analytics_snapshots (
        id, publication_id, rendition_id, account_id, captured_at,
        views, impressions, reach, engagements, likes, comments, shares,
        followers_delta, raw_metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        snap.id,
        snap.publication_id,
        snap.rendition_id,
        snap.account_id,
        snap.captured_at,
        snap.views,
        snap.impressions,
        snap.reach,
        snap.engagements,
        snap.likes,
        snap.comments,
        snap.shares,
        snap.followers_delta,
        jsonText(snap.raw_metrics),
      ],
    );
  }

  public listAnalyticsSnapshots(filter?: { account_id?: string; publication_id?: string }): SocialAnalyticsSnapshot[] {
    let sql = "SELECT * FROM social_analytics_snapshots WHERE 1=1";
    const params: any[] = [];
    if (filter?.account_id) {
      sql += " AND account_id = ?";
      params.push(filter.account_id);
    }
    if (filter?.publication_id) {
      sql += " AND publication_id = ?";
      params.push(filter.publication_id);
    }
    sql += " ORDER BY captured_at DESC";
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: String(r.id),
      publication_id: r.publication_id ? String(r.publication_id) : null,
      rendition_id: r.rendition_id ? String(r.rendition_id) : null,
      account_id: String(r.account_id),
      captured_at: String(r.captured_at),
      views: r.views != null ? Number(r.views) : null,
      impressions: r.impressions != null ? Number(r.impressions) : null,
      reach: r.reach != null ? Number(r.reach) : null,
      engagements: r.engagements != null ? Number(r.engagements) : null,
      likes: r.likes != null ? Number(r.likes) : null,
      comments: r.comments != null ? Number(r.comments) : null,
      shares: r.shares != null ? Number(r.shares) : null,
      followers_delta: r.followers_delta != null ? Number(r.followers_delta) : null,
      raw_metrics: parseJson(r.raw_metrics_json, {}),
    }));
  }

  // --- Audit ---
  public insertAuditEvent(event: SocialAuditEvent): void {
    this.db.run(
      `INSERT INTO social_audit_events (
        id, timestamp, workspace_id, actor_type, actor_id, action, resource_type,
        resource_id, request_id, correlation_id, policy_decision, approval_ref,
        openpost_instance_id, remote_ref, before_hash, after_hash, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        event.id,
        event.timestamp,
        event.workspace_id,
        event.actor_type,
        event.actor_id,
        event.action,
        event.resource_type,
        event.resource_id,
        event.request_id ?? null,
        event.correlation_id ?? null,
        event.policy_decision ?? null,
        event.approval_ref ?? null,
        event.openpost_instance_id ?? null,
        event.remote_ref ?? null,
        event.before_hash ?? null,
        event.after_hash ?? null,
        jsonText(event.metadata),
      ],
    );
  }

  public listAuditEvents(limit = 100): SocialAuditEvent[] {
    const rows = this.db.query("SELECT * FROM social_audit_events ORDER BY timestamp DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: String(r.id),
      timestamp: String(r.timestamp),
      workspace_id: String(r.workspace_id),
      actor_type: r.actor_type as any,
      actor_id: String(r.actor_id),
      action: String(r.action),
      resource_type: String(r.resource_type),
      resource_id: String(r.resource_id),
      request_id: r.request_id ? String(r.request_id) : undefined,
      correlation_id: r.correlation_id ? String(r.correlation_id) : undefined,
      policy_decision: r.policy_decision ? String(r.policy_decision) : undefined,
      approval_ref: r.approval_ref ? String(r.approval_ref) : undefined,
      openpost_instance_id: r.openpost_instance_id ? String(r.openpost_instance_id) : undefined,
      remote_ref: r.remote_ref ? String(r.remote_ref) : undefined,
      before_hash: r.before_hash ? String(r.before_hash) : undefined,
      after_hash: r.after_hash ? String(r.after_hash) : undefined,
      metadata: parseJson(r.metadata_json, {}),
    }));
  }
}

