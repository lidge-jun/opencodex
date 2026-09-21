import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { getConfigDir } from "../config/paths";
import type {
  SkillRecord,
  SkillVersionRecord,
  SkillSourceRecord,
  SkillFileRecord,
  SkillScanFinding,
  SkillAgentRecord,
  SkillNodeRecord,
  SkillDeploymentRecord,
  SkillDeploymentSnapshot,
  SkillDriftEvent,
  SkillApprovalRecord,
  SkillAuditEvent,
} from "./types";

export function getDefaultSkillsDbPath(customDir?: string): string {
  const dir = customDir ?? getConfigDir();
  return join(dir, "skills.sqlite");
}

export class SkillsDatabase {
  public readonly db: Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? getDefaultSkillsDbPath();
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    this.db = new Database(resolvedPath);
    try {
      (this.db as Database & { timeout?: number }).timeout = 2000;
    } catch {
      /* best effort */
    }
    this.db.exec("PRAGMA busy_timeout = 2000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_sources (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        base_url TEXT,
        repository_url TEXT,
        default_ref TEXT,
        auth_ref TEXT,
        trust_level TEXT NOT NULL DEFAULT 'unknown',
        enabled INTEGER NOT NULL DEFAULT 1,
        refresh_policy TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT,
        source_id TEXT REFERENCES skill_sources(id),
        status TEXT NOT NULL,
        current_version TEXT,
        publisher TEXT,
        license_spdx TEXT,
        trust_level TEXT NOT NULL DEFAULT 'unknown',
        risk_level TEXT,
        tags TEXT,
        favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(namespace, slug)
      );

      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        source_ref TEXT,
        source_commit TEXT,
        source_path TEXT,
        manifest TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        source_snapshot_sha256 TEXT,
        scanner_version TEXT,
        scan_status TEXT NOT NULL,
        risk_score INTEGER,
        risk_level TEXT,
        approval_status TEXT,
        immutable INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT,
        published_by TEXT,
        UNIQUE(skill_id, version)
      );

      CREATE TABLE IF NOT EXISTS skill_files (
        id TEXT PRIMARY KEY,
        skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(skill_version_id, relative_path)
      );

      CREATE TABLE IF NOT EXISTS skill_scan_findings (
        id TEXT PRIMARY KEY,
        skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        file_path TEXT,
        line_start INTEGER,
        line_end INTEGER,
        evidence_hash TEXT,
        message TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_agents (
        id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        capabilities TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        hostname TEXT,
        port INTEGER,
        username TEXT,
        auth_ref TEXT,
        host_key_fingerprint TEXT,
        os TEXT,
        architecture TEXT,
        environment TEXT,
        status TEXT NOT NULL,
        allowed_roots TEXT,
        tags TEXT,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_deployments (
        id TEXT PRIMARY KEY,
        skill_version_id TEXT NOT NULL REFERENCES skill_versions(id),
        node_id TEXT NOT NULL REFERENCES skill_nodes(id),
        agent_id TEXT NOT NULL REFERENCES skill_agents(id),
        scope TEXT NOT NULL,
        project_ref TEXT,
        target_path TEXT NOT NULL,
        deployment_mode TEXT NOT NULL,
        desired_sha256 TEXT NOT NULL,
        actual_sha256 TEXT,
        status TEXT NOT NULL,
        managed INTEGER NOT NULL DEFAULT 1,
        deployed_by TEXT,
        deployed_at TEXT,
        verified_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_deployment_snapshots (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        manifest TEXT,
        file_index TEXT NOT NULL,
        storage_ref TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_drift_events (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL REFERENCES skill_deployments(id) ON DELETE CASCADE,
        drift_type TEXT NOT NULL,
        expected_sha256 TEXT,
        actual_sha256 TEXT,
        details TEXT,
        status TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS skill_reviews (
        id TEXT PRIMARY KEY,
        skill_version_id TEXT NOT NULL REFERENCES skill_versions(id),
        requested_action TEXT NOT NULL,
        requested_targets TEXT,
        policy_snapshot TEXT,
        risk_snapshot TEXT,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reviewed_by TEXT,
        decision_reason TEXT,
        constraints TEXT,
        content_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS skill_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        skill_id TEXT,
        skill_version_id TEXT,
        deployment_id TEXT,
        node_id TEXT,
        trace_id TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skills_status ON skills(status);
      CREATE INDEX IF NOT EXISTS idx_skills_namespace ON skills(namespace);
      CREATE INDEX IF NOT EXISTS idx_versions_skill ON skill_versions(skill_id);
      CREATE INDEX IF NOT EXISTS idx_findings_version ON skill_scan_findings(skill_version_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_version ON skill_reviews(skill_version_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_deployment ON skill_deployment_snapshots(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_node ON skill_deployments(node_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_agent ON skill_deployments(agent_id);
      CREATE INDEX IF NOT EXISTS idx_drift_active ON skill_drift_events(status);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON skill_audit_events(created_at);
    `);
  }

  // --- Skills ---
  public listSkills(options: { status?: string; namespace?: string; tag?: string } = {}): SkillRecord[] {
    let sql = "SELECT * FROM skills WHERE 1=1";
    const params: (string | number | null)[] = [];
    if (options.status) {
      sql += " AND status = ?";
      params.push(options.status);
    }
    if (options.namespace) {
      sql += " AND namespace = ?";
      params.push(options.namespace);
    }
    if (options.tag) {
      sql += " AND EXISTS (SELECT 1 FROM json_each(skills.tags) WHERE json_each.value = ?)";
      params.push(options.tag);
    }
    sql += " ORDER BY updated_at DESC";

    const rows = (params.length > 0 ? this.db.prepare(sql).all(...params) : this.db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      namespace: String(r.namespace),
      slug: String(r.slug),
      display_name: String(r.display_name),
      description: String(r.description ?? ""),
      source_id: r.source_id ? String(r.source_id) : undefined,
      status: r.status as SkillRecord["status"],
      current_version: String(r.current_version ?? ""),
      publisher: r.publisher ? String(r.publisher) : undefined,
      license_spdx: r.license_spdx ? String(r.license_spdx) : undefined,
      trust_level: r.trust_level as SkillRecord["trust_level"],
      risk_level: r.risk_level ? (r.risk_level as SkillRecord["risk_level"]) : undefined,
      tags: r.tags ? (JSON.parse(String(r.tags)) as string[]) : [],
      favorite: Boolean(r.favorite),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    }));
  }

  public getSkill(id: string): SkillRecord | null {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      namespace: String(row.namespace),
      slug: String(row.slug),
      display_name: String(row.display_name),
      description: String(row.description ?? ""),
      source_id: row.source_id ? String(row.source_id) : undefined,
      status: row.status as SkillRecord["status"],
      current_version: String(row.current_version ?? ""),
      publisher: row.publisher ? String(row.publisher) : undefined,
      license_spdx: row.license_spdx ? String(row.license_spdx) : undefined,
      trust_level: row.trust_level as SkillRecord["trust_level"],
      risk_level: row.risk_level ? (row.risk_level as SkillRecord["risk_level"]) : undefined,
      tags: row.tags ? (JSON.parse(String(row.tags)) as string[]) : [],
      favorite: Boolean(row.favorite),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  public upsertSkill(skill: SkillRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO skills (id, namespace, slug, display_name, description, source_id, status, current_version, publisher, license_spdx, trust_level, risk_level, tags, favorite, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        source_id = excluded.source_id,
        status = excluded.status,
        current_version = excluded.current_version,
        publisher = excluded.publisher,
        license_spdx = excluded.license_spdx,
        trust_level = excluded.trust_level,
        risk_level = excluded.risk_level,
        tags = excluded.tags,
        favorite = excluded.favorite,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      skill.id,
      skill.namespace,
      skill.slug,
      skill.display_name,
      skill.description,
      skill.source_id ?? null,
      skill.status,
      skill.current_version,
      skill.publisher ?? null,
      skill.license_spdx ?? null,
      skill.trust_level,
      skill.risk_level ?? null,
      JSON.stringify(skill.tags),
      skill.favorite ? 1 : 0,
      skill.created_at,
      skill.updated_at,
    );
  }

  public deleteSkill(id: string): boolean {
    const res = this.db.prepare("DELETE FROM skills WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // --- Versions ---
  public getSkillVersion(versionId: string): SkillVersionRecord | null {
    const row = this.db.prepare("SELECT * FROM skill_versions WHERE id = ?").get(versionId) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      skill_id: String(row.skill_id),
      version: String(row.version),
      source_ref: row.source_ref ? String(row.source_ref) : undefined,
      source_commit: row.source_commit ? String(row.source_commit) : undefined,
      source_path: row.source_path ? String(row.source_path) : undefined,
      manifest: JSON.parse(String(row.manifest)),
      content_sha256: String(row.content_sha256),
      source_snapshot_sha256: row.source_snapshot_sha256 ? String(row.source_snapshot_sha256) : undefined,
      scanner_version: row.scanner_version ? String(row.scanner_version) : undefined,
      scan_status: row.scan_status as SkillVersionRecord["scan_status"],
      risk_score: row.risk_score !== null && row.risk_score !== undefined ? Number(row.risk_score) : undefined,
      risk_level: row.risk_level ? (row.risk_level as SkillVersionRecord["risk_level"]) : undefined,
      approval_status: row.approval_status ? (row.approval_status as SkillVersionRecord["approval_status"]) : undefined,
      immutable: Boolean(row.immutable),
      created_by: row.created_by ? String(row.created_by) : undefined,
      created_at: String(row.created_at),
      published_at: row.published_at ? String(row.published_at) : undefined,
      published_by: row.published_by ? String(row.published_by) : undefined,
    };
  }

  public listVersionsForSkill(skillId: string): SkillVersionRecord[] {
    const rows = this.db.prepare("SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC").all(skillId) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id),
      skill_id: String(row.skill_id),
      version: String(row.version),
      source_ref: row.source_ref ? String(row.source_ref) : undefined,
      source_commit: row.source_commit ? String(row.source_commit) : undefined,
      source_path: row.source_path ? String(row.source_path) : undefined,
      manifest: JSON.parse(String(row.manifest)),
      content_sha256: String(row.content_sha256),
      source_snapshot_sha256: row.source_snapshot_sha256 ? String(row.source_snapshot_sha256) : undefined,
      scanner_version: row.scanner_version ? String(row.scanner_version) : undefined,
      scan_status: row.scan_status as SkillVersionRecord["scan_status"],
      risk_score: row.risk_score !== null && row.risk_score !== undefined ? Number(row.risk_score) : undefined,
      risk_level: row.risk_level ? (row.risk_level as SkillVersionRecord["risk_level"]) : undefined,
      approval_status: row.approval_status ? (row.approval_status as SkillVersionRecord["approval_status"]) : undefined,
      immutable: Boolean(row.immutable),
      created_by: row.created_by ? String(row.created_by) : undefined,
      created_at: String(row.created_at),
      published_at: row.published_at ? String(row.published_at) : undefined,
      published_by: row.published_by ? String(row.published_by) : undefined,
    }));
  }

  public upsertSkillVersion(version: SkillVersionRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_versions (id, skill_id, version, source_ref, source_commit, source_path, manifest, content_sha256, source_snapshot_sha256, scanner_version, scan_status, risk_score, risk_level, approval_status, immutable, created_by, created_at, published_at, published_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_ref = excluded.source_ref,
        source_commit = excluded.source_commit,
        source_path = excluded.source_path,
        manifest = excluded.manifest,
        content_sha256 = excluded.content_sha256,
        source_snapshot_sha256 = excluded.source_snapshot_sha256,
        scanner_version = excluded.scanner_version,
        scan_status = excluded.scan_status,
        risk_score = excluded.risk_score,
        risk_level = excluded.risk_level,
        approval_status = excluded.approval_status,
        immutable = excluded.immutable,
        published_at = excluded.published_at,
        published_by = excluded.published_by
    `);
    stmt.run(
      version.id,
      version.skill_id,
      version.version,
      version.source_ref ?? null,
      version.source_commit ?? null,
      version.source_path ?? null,
      JSON.stringify(version.manifest),
      version.content_sha256,
      version.source_snapshot_sha256 ?? null,
      version.scanner_version ?? null,
      version.scan_status,
      version.risk_score ?? null,
      version.risk_level ?? null,
      version.approval_status ?? null,
      version.immutable ? 1 : 0,
      version.created_by ?? null,
      version.created_at,
      version.published_at ?? null,
      version.published_by ?? null,
    );
  }

  // --- Scan Findings ---
  public saveFindings(versionId: string, findings: SkillScanFinding[]): void {
    const del = this.db.prepare("DELETE FROM skill_scan_findings WHERE skill_version_id = ?");
    const insert = this.db.prepare(`
      INSERT INTO skill_scan_findings (id, skill_version_id, rule_id, severity, file_path, line_start, line_end, evidence_hash, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = new Date().toISOString();
    this.db.transaction(() => {
      del.run(versionId);
      for (let i = 0; i < findings.length; i++) {
        const f = findings[i];
        insert.run(
          f.id ?? `find_${versionId}_${i}`,
          versionId,
          f.rule_id,
          f.severity,
          f.file_path,
          f.line_start ?? null,
          f.line_end ?? null,
          f.evidence_hash,
          f.message,
          f.metadata ? JSON.stringify(f.metadata) : null,
          now,
        );
      }
    })();
  }

  public getFindings(versionId: string): SkillScanFinding[] {
    const rows = this.db.prepare("SELECT * FROM skill_scan_findings WHERE skill_version_id = ?").all(versionId) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      rule_id: String(r.rule_id),
      severity: r.severity as SkillScanFinding["severity"],
      file_path: String(r.file_path),
      line_start: r.line_start !== null ? Number(r.line_start) : undefined,
      line_end: r.line_end !== null ? Number(r.line_end) : undefined,
      evidence_hash: String(r.evidence_hash),
      message: String(r.message),
      metadata: r.metadata ? JSON.parse(String(r.metadata)) : undefined,
    }));
  }

  // --- Deployments ---
  public upsertDeployment(dep: SkillDeploymentRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_deployments (id, skill_version_id, node_id, agent_id, scope, project_ref, target_path, deployment_mode, desired_sha256, actual_sha256, status, managed, deployed_by, deployed_at, verified_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        skill_version_id = excluded.skill_version_id,
        desired_sha256 = excluded.desired_sha256,
        actual_sha256 = excluded.actual_sha256,
        status = excluded.status,
        managed = excluded.managed,
        deployed_by = excluded.deployed_by,
        deployed_at = excluded.deployed_at,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      dep.id,
      dep.skill_version_id,
      dep.node_id,
      dep.agent_id,
      dep.scope,
      dep.project_ref ?? null,
      dep.target_path,
      dep.deployment_mode,
      dep.desired_sha256,
      dep.actual_sha256 ?? null,
      dep.status,
      dep.managed ? 1 : 0,
      dep.deployed_by ?? null,
      dep.deployed_at ?? null,
      dep.verified_at ?? null,
      dep.updated_at,
    );
  }

  public getDeployment(id: string): SkillDeploymentRecord | null {
    const r = this.db.prepare("SELECT * FROM skill_deployments WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      skill_version_id: String(r.skill_version_id),
      node_id: String(r.node_id),
      agent_id: String(r.agent_id),
      scope: r.scope as SkillDeploymentRecord["scope"],
      project_ref: r.project_ref ? String(r.project_ref) : undefined,
      target_path: String(r.target_path),
      deployment_mode: r.deployment_mode as SkillDeploymentRecord["deployment_mode"],
      desired_sha256: String(r.desired_sha256),
      actual_sha256: r.actual_sha256 ? String(r.actual_sha256) : undefined,
      status: r.status as SkillDeploymentRecord["status"],
      managed: Boolean(r.managed),
      deployed_by: r.deployed_by ? String(r.deployed_by) : undefined,
      deployed_at: r.deployed_at ? String(r.deployed_at) : undefined,
      verified_at: r.verified_at ? String(r.verified_at) : undefined,
      updated_at: String(r.updated_at),
    };
  }

  public listDeployments(filter: { skillVersionId?: string; agentId?: string; nodeId?: string } = {}): SkillDeploymentRecord[] {
    let sql = "SELECT * FROM skill_deployments WHERE 1=1";
    const params: (string | number | null)[] = [];
    if (filter.skillVersionId) {
      sql += " AND skill_version_id = ?";
      params.push(filter.skillVersionId);
    }
    if (filter.agentId) {
      sql += " AND agent_id = ?";
      params.push(filter.agentId);
    }
    if (filter.nodeId) {
      sql += " AND node_id = ?";
      params.push(filter.nodeId);
    }
    sql += " ORDER BY updated_at DESC";

    const rows = (params.length > 0 ? this.db.prepare(sql).all(...params) : this.db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      skill_version_id: String(r.skill_version_id),
      node_id: String(r.node_id),
      agent_id: String(r.agent_id),
      scope: r.scope as SkillDeploymentRecord["scope"],
      project_ref: r.project_ref ? String(r.project_ref) : undefined,
      target_path: String(r.target_path),
      deployment_mode: r.deployment_mode as SkillDeploymentRecord["deployment_mode"],
      desired_sha256: String(r.desired_sha256),
      actual_sha256: r.actual_sha256 ? String(r.actual_sha256) : undefined,
      status: r.status as SkillDeploymentRecord["status"],
      managed: Boolean(r.managed),
      deployed_by: r.deployed_by ? String(r.deployed_by) : undefined,
      deployed_at: r.deployed_at ? String(r.deployed_at) : undefined,
      verified_at: r.verified_at ? String(r.verified_at) : undefined,
      updated_at: String(r.updated_at),
    }));
  }

  public deleteDeployment(id: string): boolean {
    const res = this.db.prepare("DELETE FROM skill_deployments WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // --- Snapshots ---
  public insertSnapshot(snap: SkillDeploymentSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_deployment_snapshots (id, deployment_id, reason, manifest, file_index, storage_ref, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      snap.id,
      snap.deployment_id,
      snap.reason,
      snap.manifest ? JSON.stringify(snap.manifest) : null,
      JSON.stringify(snap.file_index),
      snap.storage_ref,
      snap.created_by ?? null,
      snap.created_at,
    );
  }

  public getSnapshot(id: string): SkillDeploymentSnapshot | null {
    const r = this.db.prepare("SELECT * FROM skill_deployment_snapshots WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      deployment_id: String(r.deployment_id),
      reason: r.reason as SkillDeploymentSnapshot["reason"],
      manifest: r.manifest ? JSON.parse(String(r.manifest)) : undefined,
      file_index: JSON.parse(String(r.file_index)),
      storage_ref: String(r.storage_ref),
      created_by: r.created_by ? String(r.created_by) : undefined,
      created_at: String(r.created_at),
    };
  }

  public getLatestSnapshotForDeployment(deploymentId: string): SkillDeploymentSnapshot | null {
    const r = this.db.prepare("SELECT * FROM skill_deployment_snapshots WHERE deployment_id = ? ORDER BY created_at DESC LIMIT 1").get(deploymentId) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      deployment_id: String(r.deployment_id),
      reason: r.reason as SkillDeploymentSnapshot["reason"],
      manifest: r.manifest ? JSON.parse(String(r.manifest)) : undefined,
      file_index: JSON.parse(String(r.file_index)),
      storage_ref: String(r.storage_ref),
      created_by: r.created_by ? String(r.created_by) : undefined,
      created_at: String(r.created_at),
    };
  }

  // --- Drift Events ---
  public insertDriftEvent(event: SkillDriftEvent): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_drift_events (id, deployment_id, drift_type, expected_sha256, actual_sha256, details, status, detected_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        resolved_at = excluded.resolved_at
    `);
    stmt.run(
      event.id,
      event.deployment_id,
      event.drift_type,
      event.expected_sha256 ?? null,
      event.actual_sha256 ?? null,
      event.details ? JSON.stringify(event.details) : null,
      event.status,
      event.detected_at,
      event.resolved_at ?? null,
    );
  }

  public listDriftEvents(status?: string): SkillDriftEvent[] {
    let sql = "SELECT * FROM skill_drift_events";
    const params: string[] = [];
    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY detected_at DESC";
    const rows = (params.length > 0 ? this.db.prepare(sql).all(...params) : this.db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      deployment_id: String(r.deployment_id),
      drift_type: r.drift_type as SkillDriftEvent["drift_type"],
      expected_sha256: r.expected_sha256 ? String(r.expected_sha256) : undefined,
      actual_sha256: r.actual_sha256 ? String(r.actual_sha256) : undefined,
      details: r.details ? JSON.parse(String(r.details)) : undefined,
      status: r.status as SkillDriftEvent["status"],
      detected_at: String(r.detected_at),
      resolved_at: r.resolved_at ? String(r.resolved_at) : undefined,
    }));
  }

  // --- Reviews / Approvals ---
  public insertReview(review: SkillApprovalRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_reviews (id, skill_version_id, requested_action, requested_targets, policy_snapshot, risk_snapshot, status, requested_by, reviewed_by, decision_reason, constraints, content_sha256, created_at, decided_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        reviewed_by = excluded.reviewed_by,
        decision_reason = excluded.decision_reason,
        constraints = excluded.constraints,
        decided_at = excluded.decided_at
    `);
    stmt.run(
      review.id,
      review.skill_version_id,
      review.requested_action,
      review.requested_targets ? JSON.stringify(review.requested_targets) : null,
      review.policy_snapshot ? JSON.stringify(review.policy_snapshot) : null,
      review.risk_snapshot ? JSON.stringify(review.risk_snapshot) : null,
      review.status,
      review.requested_by,
      review.reviewed_by ?? null,
      review.decision_reason ?? null,
      review.constraints ? JSON.stringify(review.constraints) : null,
      review.content_sha256,
      review.created_at,
      review.decided_at ?? null,
      review.expires_at ?? null,
    );
  }

  public getReview(id: string): SkillApprovalRecord | null {
    const r = this.db.prepare("SELECT * FROM skill_reviews WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      skill_version_id: String(r.skill_version_id),
      requested_action: r.requested_action as SkillApprovalRecord["requested_action"],
      requested_targets: r.requested_targets ? JSON.parse(String(r.requested_targets)) : undefined,
      policy_snapshot: r.policy_snapshot ? JSON.parse(String(r.policy_snapshot)) : undefined,
      risk_snapshot: r.risk_snapshot ? JSON.parse(String(r.risk_snapshot)) : undefined,
      status: r.status as SkillApprovalRecord["status"],
      requested_by: String(r.requested_by),
      reviewed_by: r.reviewed_by ? String(r.reviewed_by) : undefined,
      decision_reason: r.decision_reason ? String(r.decision_reason) : undefined,
      constraints: r.constraints ? JSON.parse(String(r.constraints)) : undefined,
      content_sha256: String(r.content_sha256),
      created_at: String(r.created_at),
      decided_at: r.decided_at ? String(r.decided_at) : undefined,
      expires_at: r.expires_at ? String(r.expires_at) : undefined,
    };
  }

  public getLatestApprovalForVersion(versionId: string): SkillApprovalRecord | null {
    const r = this.db.prepare("SELECT * FROM skill_reviews WHERE skill_version_id = ? ORDER BY created_at DESC LIMIT 1").get(versionId) as Record<string, unknown> | null;
    if (!r) return null;
    return this.getReview(String(r.id));
  }

  public listReviews(status?: string): SkillApprovalRecord[] {
    let sql = "SELECT * FROM skill_reviews";
    const params: string[] = [];
    if (status) {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC";
    const rows = (params.length > 0 ? this.db.prepare(sql).all(...params) : this.db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      skill_version_id: String(r.skill_version_id),
      requested_action: r.requested_action as SkillApprovalRecord["requested_action"],
      requested_targets: r.requested_targets ? JSON.parse(String(r.requested_targets)) : undefined,
      policy_snapshot: r.policy_snapshot ? JSON.parse(String(r.policy_snapshot)) : undefined,
      risk_snapshot: r.risk_snapshot ? JSON.parse(String(r.risk_snapshot)) : undefined,
      status: r.status as SkillApprovalRecord["status"],
      requested_by: String(r.requested_by),
      reviewed_by: r.reviewed_by ? String(r.reviewed_by) : undefined,
      decision_reason: r.decision_reason ? String(r.decision_reason) : undefined,
      constraints: r.constraints ? JSON.parse(String(r.constraints)) : undefined,
      content_sha256: String(r.content_sha256),
      created_at: String(r.created_at),
      decided_at: r.decided_at ? String(r.decided_at) : undefined,
      expires_at: r.expires_at ? String(r.expires_at) : undefined,
    }));
  }

  // --- Sources ---
  public upsertSource(source: SkillSourceRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_sources (id, source_type, display_name, base_url, repository_url, default_ref, auth_ref, trust_level, enabled, refresh_policy, last_checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        base_url = excluded.base_url,
        repository_url = excluded.repository_url,
        default_ref = excluded.default_ref,
        auth_ref = excluded.auth_ref,
        trust_level = excluded.trust_level,
        enabled = excluded.enabled,
        refresh_policy = excluded.refresh_policy,
        last_checked_at = excluded.last_checked_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      source.id,
      source.source_type,
      source.display_name,
      source.base_url ?? null,
      source.repository_url ?? null,
      source.default_ref ?? null,
      source.auth_ref ?? null,
      source.trust_level,
      source.enabled ? 1 : 0,
      source.refresh_policy ? JSON.stringify(source.refresh_policy) : null,
      source.last_checked_at ?? null,
      source.created_at,
      source.updated_at,
    );
  }

  public listSources(): SkillSourceRecord[] {
    const rows = this.db.prepare("SELECT * FROM skill_sources ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      source_type: r.source_type as SkillSourceRecord["source_type"],
      display_name: String(r.display_name),
      base_url: r.base_url ? String(r.base_url) : undefined,
      repository_url: r.repository_url ? String(r.repository_url) : undefined,
      default_ref: r.default_ref ? String(r.default_ref) : undefined,
      auth_ref: r.auth_ref ? String(r.auth_ref) : undefined,
      trust_level: r.trust_level as SkillSourceRecord["trust_level"],
      enabled: Boolean(r.enabled),
      refresh_policy: r.refresh_policy ? JSON.parse(String(r.refresh_policy)) : undefined,
      last_checked_at: r.last_checked_at ? String(r.last_checked_at) : undefined,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    }));
  }

  public getSource(id: string): SkillSourceRecord | null {
    const r = this.db.prepare("SELECT * FROM skill_sources WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      source_type: r.source_type as SkillSourceRecord["source_type"],
      display_name: String(r.display_name),
      base_url: r.base_url ? String(r.base_url) : undefined,
      repository_url: r.repository_url ? String(r.repository_url) : undefined,
      default_ref: r.default_ref ? String(r.default_ref) : undefined,
      auth_ref: r.auth_ref ? String(r.auth_ref) : undefined,
      trust_level: r.trust_level as SkillSourceRecord["trust_level"],
      enabled: Boolean(r.enabled),
      refresh_policy: r.refresh_policy ? JSON.parse(String(r.refresh_policy)) : undefined,
      last_checked_at: r.last_checked_at ? String(r.last_checked_at) : undefined,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  // --- Nodes ---
  public upsertNode(node: SkillNodeRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_nodes (id, name, kind, hostname, port, username, auth_ref, host_key_fingerprint, os, architecture, environment, status, allowed_roots, tags, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        hostname = excluded.hostname,
        port = excluded.port,
        username = excluded.username,
        auth_ref = excluded.auth_ref,
        host_key_fingerprint = excluded.host_key_fingerprint,
        os = excluded.os,
        architecture = excluded.architecture,
        environment = excluded.environment,
        status = excluded.status,
        allowed_roots = excluded.allowed_roots,
        tags = excluded.tags,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      node.id,
      node.name,
      node.kind,
      node.hostname ?? null,
      node.port ?? null,
      node.username ?? null,
      node.auth_ref ?? null,
      node.host_key_fingerprint ?? null,
      node.os ?? null,
      node.architecture ?? null,
      node.environment,
      node.status,
      JSON.stringify(node.allowed_roots),
      JSON.stringify(node.tags),
      node.last_seen_at ?? null,
      node.created_at,
      node.updated_at,
    );
  }

  public listNodes(): SkillNodeRecord[] {
    const rows = this.db.prepare("SELECT * FROM skill_nodes ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as SkillNodeRecord["kind"],
      hostname: r.hostname ? String(r.hostname) : undefined,
      port: r.port !== null && r.port !== undefined ? Number(r.port) : undefined,
      username: r.username ? String(r.username) : undefined,
      auth_ref: r.auth_ref ? String(r.auth_ref) : undefined,
      host_key_fingerprint: r.host_key_fingerprint ? String(r.host_key_fingerprint) : undefined,
      os: r.os ? (r.os as SkillNodeRecord["os"]) : undefined,
      architecture: r.architecture ? String(r.architecture) : undefined,
      environment: r.environment as SkillNodeRecord["environment"],
      status: r.status as SkillNodeRecord["status"],
      allowed_roots: r.allowed_roots ? JSON.parse(String(r.allowed_roots)) : [],
      tags: r.tags ? JSON.parse(String(r.tags)) : [],
      last_seen_at: r.last_seen_at ? String(r.last_seen_at) : undefined,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    }));
  }

  public getNode(id: string): SkillNodeRecord | null {
    const r = this.db.prepare("SELECT * FROM skill_nodes WHERE id = ? OR name = ?").get(id, id) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as SkillNodeRecord["kind"],
      hostname: r.hostname ? String(r.hostname) : undefined,
      port: r.port !== null && r.port !== undefined ? Number(r.port) : undefined,
      username: r.username ? String(r.username) : undefined,
      auth_ref: r.auth_ref ? String(r.auth_ref) : undefined,
      host_key_fingerprint: r.host_key_fingerprint ? String(r.host_key_fingerprint) : undefined,
      os: r.os ? (r.os as SkillNodeRecord["os"]) : undefined,
      architecture: r.architecture ? String(r.architecture) : undefined,
      environment: r.environment as SkillNodeRecord["environment"],
      status: r.status as SkillNodeRecord["status"],
      allowed_roots: r.allowed_roots ? JSON.parse(String(r.allowed_roots)) : [],
      tags: r.tags ? JSON.parse(String(r.tags)) : [],
      last_seen_at: r.last_seen_at ? String(r.last_seen_at) : undefined,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  public deleteNode(id: string): boolean {
    const res = this.db.prepare("DELETE FROM skill_nodes WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // --- Agents ---
  public upsertAgent(agent: SkillAgentRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO skill_agents (id, agent_type, display_name, adapter_version, enabled, capabilities, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        adapter_version = excluded.adapter_version,
        enabled = excluded.enabled,
        capabilities = excluded.capabilities,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      agent.id,
      agent.agent_type,
      agent.display_name,
      agent.adapter_version,
      agent.enabled ? 1 : 0,
      agent.capabilities ? JSON.stringify(agent.capabilities) : null,
      agent.created_at,
      agent.updated_at,
    );
  }

  public listAgents(): SkillAgentRecord[] {
    const rows = this.db.prepare("SELECT * FROM skill_agents ORDER BY display_name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      agent_type: String(r.agent_type),
      display_name: String(r.display_name),
      adapter_version: String(r.adapter_version),
      enabled: Boolean(r.enabled),
      capabilities: r.capabilities ? JSON.parse(String(r.capabilities)) : [],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    }));
  }

  // --- Audit ---
  public logAudit(event: Omit<SkillAuditEvent, "id" | "created_at">): void {
    const id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO skill_audit_events (id, event_type, actor_type, actor_id, skill_id, skill_version_id, deployment_id, node_id, trace_id, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      event.event_type,
      event.actor_type,
      event.actor_id ?? null,
      event.skill_id ?? null,
      event.skill_version_id ?? null,
      event.deployment_id ?? null,
      event.node_id ?? null,
      event.trace_id ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      now,
    );
  }

  public listAuditEvents(limit = 100): SkillAuditEvent[] {
    const rows = this.db.prepare("SELECT * FROM skill_audit_events ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      event_type: String(r.event_type),
      actor_type: r.actor_type as SkillAuditEvent["actor_type"],
      actor_id: r.actor_id ? String(r.actor_id) : undefined,
      skill_id: r.skill_id ? String(r.skill_id) : undefined,
      skill_version_id: r.skill_version_id ? String(r.skill_version_id) : undefined,
      deployment_id: r.deployment_id ? String(r.deployment_id) : undefined,
      node_id: r.node_id ? String(r.node_id) : undefined,
      trace_id: r.trace_id ? String(r.trace_id) : undefined,
      metadata: r.metadata ? JSON.parse(String(r.metadata)) : undefined,
      created_at: String(r.created_at),
    }));
  }

  public close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

