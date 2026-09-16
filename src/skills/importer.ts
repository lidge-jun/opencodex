import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { computeDirectoryHash, computeSkillContentHash, sha256 } from "./hasher";
import { evaluateSkillPolicy } from "./policy";
import { assessSkillRisk } from "./risk";
import { scanSkillPackage } from "./scanner";
import type {
  AgentSkillManifest,
  CapabilitySkillPublisherInput,
  SkillRecord,
  SkillSourceType,
  SkillVersionRecord,
} from "./types";
import { DEFAULT_SKILL_LIMITS, parseSkillFrontmatter, validateSkillPackage } from "./validator";

export interface ImportOptions {
  namespace?: string;
  slug?: string;
  version?: string;
  sourceId?: string;
  actor?: string;
  publishImmediately?: boolean;
}

export interface ImportResult {
  skill: SkillRecord;
  version: SkillVersionRecord;
  entryContent: string;
  bundledFiles: Record<string, string | Buffer>;
}

export class SkillImporter {
  /**
   * Import a skill from a local filesystem directory.
   */
  public async importLocal(folderPath: string, options: ImportOptions = {}): Promise<ImportResult> {
    const absPath = resolve(folderPath);
    if (!existsSync(absPath)) {
      throw new Error(`Directory does not exist: ${absPath}`);
    }

    const entryPath = join(absPath, "SKILL.md");
    if (!existsSync(entryPath)) {
      throw new Error(`SKILL.md not found in ${absPath}`);
    }

    const entryContent = readFileSync(entryPath, "utf8");
    const { frontmatter, body } = parseSkillFrontmatter(entryContent);

    // Read bundled files
    const bundledFiles: Record<string, string | Buffer> = {};
    const limits = DEFAULT_SKILL_LIMITS;
    let fileCount = 1; // SKILL.md
    let byteCount = Buffer.byteLength(entryContent, "utf8");

    function walk(curr: string, depth = 0) {
      if (depth > 20) throw new Error("Skill directory structure exceeds maximum depth limit (20).");
      const entries = readdirSync(curr);
      for (const e of entries) {
        const full = join(curr, e);
        const stat = lstatSync(full);
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (stat.isFile()) {
          fileCount++;
          if (fileCount > limits.maxFiles) {
            throw new Error(`Skill package exceeds maximum file count (${limits.maxFiles}).`);
          }
          byteCount += stat.size;
          if (byteCount > limits.maxTotalBytes) {
            throw new Error(`Skill package exceeds maximum total size (${limits.maxTotalBytes} bytes).`);
          }
          const rel = relative(absPath, full).split("\\").join("/");
          if (rel !== "SKILL.md") {
            bundledFiles[rel] = readFileSync(full);
          }
        }
      }
    }
    walk(absPath);

    // Validate package
    const val = validateSkillPackage(entryContent, bundledFiles);
    if (!val.valid) {
      throw new Error(`Skill package validation failed: ${val.issues.map(i => i.message).join("; ")}`);
    }

    const slug = options.slug || frontmatter["name"] || basename(absPath);
    const namespace = options.namespace || "local";
    const skillId = `${namespace}.${slug}`;
    const version = options.version || frontmatter["version"] || "1.0.0";
    const versionId = `${skillId}@${version}`;

    // Scan
    const scan = scanSkillPackage(entryContent, bundledFiles);
    const risk = assessSkillRisk(scan.findings);

    // Compute hashes
    const hashInfo = computeSkillContentHash(entryContent, bundledFiles);

    // Manifest construction
    const manifest: AgentSkillManifest = {
      apiVersion: "pao.dev/v1",
      kind: "AgentSkill",
      metadata: {
        id: skillId,
        namespace,
        slug,
        name: frontmatter["displayName"] || frontmatter["name"] || slug,
        version,
        description: frontmatter["description"] || "",
        tags: frontmatter["tags"] ? frontmatter["tags"].split(",").map(t => t.trim()) : [],
        author: frontmatter["author"],
      },
      source: {
        type: "LOCAL_FOLDER",
        path: absPath,
        imported_at: new Date().toISOString(),
      },
      content: {
        entry_file: "SKILL.md",
        files: ["SKILL.md", ...Object.keys(bundledFiles)],
      },
      compatibility: {
        agents: ["codex", "claude-code", "opencode", "universal"],
        scopes: ["user", "project"],
      },
      risk: {
        level: risk.level,
        score: risk.score,
        findings: risk.findings,
        inferred_capabilities: risk.inferred_capabilities,
      },
      policy: {
        approval_required: risk.level !== "low",
        allowed_environments: ["dev", "test", "staging"],
      },
      deployment: {
        strategy: "managed-copy",
        default_scope: "project",
        overwrite_unmanaged: false,
        verify_after_write: true,
        backup_before_replace: true,
      },
      integrity: {
        content_sha256: hashInfo.contentSha256,
        files_sha256: hashInfo.filesSha256,
      },
    };

    const now = new Date().toISOString();
    const isPublished = options.publishImmediately && risk.level === "low";

    const skill: SkillRecord = {
      id: skillId,
      namespace,
      slug,
      display_name: manifest.metadata.name,
      description: manifest.metadata.description,
      source_id: options.sourceId,
      status: isPublished ? "PUBLISHED" : "IMPORTED",
      current_version: version,
      trust_level: "community",
      risk_level: risk.level,
      tags: manifest.metadata.tags,
      favorite: false,
      created_at: now,
      updated_at: now,
    };

    const versionRecord: SkillVersionRecord = {
      id: versionId,
      skill_id: skillId,
      version,
      source_path: absPath,
      manifest,
      content_sha256: hashInfo.contentSha256,
      scanner_version: scan.scannerVersion,
      scan_status: "scanned",
      risk_score: risk.score,
      risk_level: risk.level,
      approval_status: risk.level === "low" ? "NOT_REQUIRED" : "PENDING",
      immutable: Boolean(isPublished),
      created_by: options.actor ?? "system",
      created_at: now,
      published_at: isPublished ? now : undefined,
      published_by: isPublished ? (options.actor ?? "system") : undefined,
    };

    return {
      skill,
      version: versionRecord,
      entryContent,
      bundledFiles,
    };
  }

  /**
   * Import generated skill from Phase 20.56 Capability Factory.
   */
  public async importGenerated(
    input: CapabilitySkillPublisherInput,
    options: ImportOptions = {},
  ): Promise<ImportResult> {
    const entryContent = input.skillMarkdown;
    const bundledFiles = input.bundledFiles ?? {};

    const val = validateSkillPackage(entryContent, bundledFiles);
    if (!val.valid) {
      throw new Error(`Generated skill validation failed: ${val.issues.map(i => i.message).join("; ")}`);
    }

    const slug = options.slug || input.capabilityId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const namespace = options.namespace || "generated";
    const skillId = `${namespace}.${slug}`;
    const version = options.version || input.capabilityVersion;
    const versionId = `${skillId}@${version}`;

    // Scan
    const scan = scanSkillPackage(entryContent, bundledFiles);
    const risk = assessSkillRisk(scan.findings);

    // Hashes
    const hashInfo = computeSkillContentHash(entryContent, bundledFiles);

    const manifest: AgentSkillManifest = {
      apiVersion: "pao.dev/v1",
      kind: "AgentSkill",
      metadata: {
        id: skillId,
        namespace,
        slug,
        name: input.displayName,
        version,
        description: input.description,
        tags: input.tags ?? ["generated", "capability-factory"],
        author: input.author ?? input.provenance.author,
      },
      source: {
        type: "GENERATED",
        imported_at: new Date().toISOString(),
        provenance: {
          capabilityId: input.provenance.capabilityId,
          capabilityVersion: input.provenance.capabilityVersion,
          recipe: input.provenance.recipe,
          generatedAt: input.provenance.generatedAt,
          sourceHash: input.provenance.sourceHash,
        },
      },
      content: {
        entry_file: "SKILL.md",
        files: ["SKILL.md", ...Object.keys(bundledFiles)],
      },
      compatibility: {
        agents: ["codex", "claude-code", "opencode", "universal"],
        scopes: ["user", "project"],
      },
      risk: {
        level: risk.level,
        score: risk.score,
        findings: risk.findings,
        inferred_capabilities: risk.inferred_capabilities,
      },
      policy: {
        approval_required: risk.level !== "low",
        allowed_environments: ["dev", "test"],
      },
      deployment: {
        strategy: "managed-copy",
        default_scope: "project",
        overwrite_unmanaged: false,
        verify_after_write: true,
        backup_before_replace: true,
      },
      integrity: {
        content_sha256: hashInfo.contentSha256,
        files_sha256: hashInfo.filesSha256,
      },
    };

    const now = new Date().toISOString();
    const isPublished = options.publishImmediately && risk.level === "low";

    const skill: SkillRecord = {
      id: skillId,
      namespace,
      slug,
      display_name: manifest.metadata.name,
      description: manifest.metadata.description,
      source_id: options.sourceId,
      status: isPublished ? "PUBLISHED" : "IMPORTED",
      current_version: version,
      trust_level: "verified",
      risk_level: risk.level,
      tags: manifest.metadata.tags,
      favorite: false,
      created_at: now,
      updated_at: now,
    };

    const versionRecord: SkillVersionRecord = {
      id: versionId,
      skill_id: skillId,
      version,
      manifest,
      content_sha256: hashInfo.contentSha256,
      scanner_version: scan.scannerVersion,
      scan_status: "scanned",
      risk_score: risk.score,
      risk_level: risk.level,
      approval_status: risk.level === "low" ? "NOT_REQUIRED" : "PENDING",
      immutable: Boolean(isPublished),
      created_by: options.actor ?? "capability-factory",
      created_at: now,
      published_at: isPublished ? now : undefined,
      published_by: isPublished ? (options.actor ?? "capability-factory") : undefined,
    };

    return {
      skill,
      version: versionRecord,
      entryContent,
      bundledFiles,
    };
  }

  /**
   * Import from marketplace content or repository payload.
   */
  public async importRaw(
    name: string,
    skillMarkdown: string,
    bundledFiles: Record<string, string | Buffer> = {},
    sourceType: SkillSourceType = "SKILLS_SH",
    options: ImportOptions = {},
  ): Promise<ImportResult> {
    const val = validateSkillPackage(skillMarkdown, bundledFiles);
    if (!val.valid) {
      throw new Error(`Raw skill validation failed: ${val.issues.map(i => i.message).join("; ")}`);
    }

    const { frontmatter } = parseSkillFrontmatter(skillMarkdown);
    const slug = options.slug || frontmatter["name"] || name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const namespace = options.namespace || (sourceType === "SKILLS_SH" ? "marketplace" : "custom");
    const skillId = `${namespace}.${slug}`;
    const version = options.version || frontmatter["version"] || "1.0.0";
    const versionId = `${skillId}@${version}`;

    const scan = scanSkillPackage(skillMarkdown, bundledFiles);
    const risk = assessSkillRisk(scan.findings);
    const hashInfo = computeSkillContentHash(skillMarkdown, bundledFiles);

    const manifest: AgentSkillManifest = {
      apiVersion: "pao.dev/v1",
      kind: "AgentSkill",
      metadata: {
        id: skillId,
        namespace,
        slug,
        name: frontmatter["displayName"] || frontmatter["name"] || name,
        version,
        description: frontmatter["description"] || "",
        tags: frontmatter["tags"] ? frontmatter["tags"].split(",").map(t => t.trim()) : [],
        author: frontmatter["author"],
      },
      source: {
        type: sourceType,
        imported_at: new Date().toISOString(),
      },
      content: {
        entry_file: "SKILL.md",
        files: ["SKILL.md", ...Object.keys(bundledFiles)],
      },
      compatibility: {
        agents: ["codex", "claude-code", "opencode", "universal"],
        scopes: ["user", "project"],
      },
      risk: {
        level: risk.level,
        score: risk.score,
        findings: risk.findings,
        inferred_capabilities: risk.inferred_capabilities,
      },
      policy: {
        approval_required: risk.level !== "low",
        allowed_environments: ["dev", "test"],
      },
      deployment: {
        strategy: "managed-copy",
        default_scope: "project",
        overwrite_unmanaged: false,
        verify_after_write: true,
        backup_before_replace: true,
      },
      integrity: {
        content_sha256: hashInfo.contentSha256,
        files_sha256: hashInfo.filesSha256,
      },
    };

    const now = new Date().toISOString();
    const isPublished = options.publishImmediately && risk.level === "low";

    const skill: SkillRecord = {
      id: skillId,
      namespace,
      slug,
      display_name: manifest.metadata.name,
      description: manifest.metadata.description,
      source_id: options.sourceId,
      status: isPublished ? "PUBLISHED" : "IMPORTED",
      current_version: version,
      trust_level: "community",
      risk_level: risk.level,
      tags: manifest.metadata.tags,
      favorite: false,
      created_at: now,
      updated_at: now,
    };

    const versionRecord: SkillVersionRecord = {
      id: versionId,
      skill_id: skillId,
      version,
      manifest,
      content_sha256: hashInfo.contentSha256,
      scanner_version: scan.scannerVersion,
      scan_status: "scanned",
      risk_score: risk.score,
      risk_level: risk.level,
      approval_status: risk.level === "low" ? "NOT_REQUIRED" : "PENDING",
      immutable: Boolean(isPublished),
      created_by: options.actor ?? "system",
      created_at: now,
      published_at: isPublished ? now : undefined,
      published_by: isPublished ? (options.actor ?? "system") : undefined,
    };

    return {
      skill,
      version: versionRecord,
      entryContent: skillMarkdown,
      bundledFiles,
    };
  }
}

