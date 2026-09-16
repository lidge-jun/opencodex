import { computeSkillContentHash, sha256 } from "./hasher";
import type {
  AgentSkillManifest,
  MarketplaceSkillMetadata,
  MarketplaceSkillRef,
  MarketplaceSkillResult,
  SkillSourceSnapshot,
  SkillUpdateResult,
} from "./types";

export interface SkillSearchQuery {
  query: string;
  tag?: string;
  limit?: number;
}

export interface SkillMarketplaceConnector {
  search(query: SkillSearchQuery): Promise<MarketplaceSkillResult[]>;
  get(ref: MarketplaceSkillRef): Promise<MarketplaceSkillMetadata>;
  fetch(ref: MarketplaceSkillRef): Promise<SkillSourceSnapshot>;
  checkUpdates(refs: MarketplaceSkillRef[]): Promise<SkillUpdateResult[]>;
}

/**
 * Built-in fallback catalog representing verified public skills from skills.sh
 * Ensures local-first, offline resilience when external HTTP is disabled or unreachable.
 */
export const BUILTIN_PUBLIC_SKILLS: MarketplaceSkillMetadata[] = [
  {
    id: "postgres-migration",
    name: "PostgreSQL Migration Assistant",
    description: "Procedures and best practices for reviewing, testing, and executing PostgreSQL schema migrations safely.",
    version: "1.2.0",
    author: "database-guild",
    license: "MIT",
    tags: ["database", "postgres", "migration", "sql"],
    sourceUrl: "https://github.com/skillsgate/public-skills/tree/main/postgres-migration",
    rawSkillMarkdown: `---
name: postgres-migration
displayName: PostgreSQL Migration Assistant
version: 1.2.0
description: Procedures for reviewing and executing PostgreSQL schema migrations.
tags: postgres, database, migration
author: database-guild
---

# PostgreSQL Migration Assistant

Guides the agent in analyzing, validating, and applying relational database schema changes.

## Migration Verification Checklist
1. Review migration DDL for non-blocking operations (avoid long table locks).
2. Check foreign key creation uses \`NOT VALID\` followed by \`VALIDATE CONSTRAINT\`.
3. Verify index creation uses \`CONCURRENTLY\`.
4. Ensure rollback SQL script is supplied and tested in dev environment.
`,
    files: [
      {
        path: "references/checklist.md",
        content: "# Migration Checklist\n\n- [ ] Zero downtime compatibility\n- [ ] Rollback tested\n- [ ] Query plan verified\n",
      },
    ],
  },
  {
    id: "adobe-stock-qc",
    name: "Adobe Stock QC Inspector",
    description: "Quality control inspection workflow for photography, vector illustrations, and generative assets.",
    version: "2.0.1",
    author: "creative-ops",
    license: "Apache-2.0",
    tags: ["creative", "image", "qc", "media"],
    sourceUrl: "https://github.com/skillsgate/public-skills/tree/main/adobe-stock-qc",
    rawSkillMarkdown: `---
name: adobe-stock-qc
displayName: Adobe Stock QC Inspector
version: 2.0.1
description: Quality control inspection workflow for photography and vector assets.
tags: creative, image, qc
author: creative-ops
---

# Adobe Stock QC Inspector

Procedures for evaluating commercial image submissions:
- Minimum resolution 4MP
- RGB color space
- No artifacting, banding, or unauthorized trademarks
`,
    files: [],
  },
  {
    id: "docker-ops",
    name: "Docker Ops Companion",
    description: "Multi-stage container optimization, caching strategies, and security linting procedures.",
    version: "1.4.0",
    author: "infra-core",
    license: "MIT",
    tags: ["docker", "containers", "devops", "cloud"],
    sourceUrl: "https://github.com/skillsgate/public-skills/tree/main/docker-ops",
    rawSkillMarkdown: `---
name: docker-ops
displayName: Docker Ops Companion
version: 1.4.0
description: Multi-stage container optimization and security linting procedures.
tags: docker, containers, devops
author: infra-core
---

# Docker Ops Companion

Rules for production Dockerfile generation:
1. Always use unprivileged non-root users.
2. Leverage BuildKit multi-stage builds.
3. Pin base image SHA digests.
`,
    files: [],
  },
  {
    id: "react-doctor",
    name: "React Doctor Diagnostics",
    description: "Component audit guidelines for React 19, hydration bug prevention, and hook rule validation.",
    version: "1.0.3",
    author: "frontend-team",
    license: "MIT",
    tags: ["react", "frontend", "typescript", "lint"],
    sourceUrl: "https://github.com/skillsgate/public-skills/tree/main/react-doctor",
    rawSkillMarkdown: `---
name: react-doctor
displayName: React Doctor Diagnostics
version: 1.0.3
description: Component audit guidelines for React 19 and hydration bug prevention.
tags: react, frontend, typescript
author: frontend-team
---

# React Doctor Diagnostics

Guidelines for optimizing React UI components:
- Prevent unnecessary re-renders with memoization where profiling indicates bottlenecks.
- Check useEffect cleanups and abort controller signals.
`,
    files: [],
  },
];

export class SkillsShConnector implements SkillMarketplaceConnector {
  private readonly baseUrl = "https://skills.sh/api/v1";

  public async search(query: SkillSearchQuery): Promise<MarketplaceSkillResult[]> {
    const q = query.query.toLowerCase().trim();
    const limit = query.limit ?? 20;

    // Filter built-in index
    const matches = BUILTIN_PUBLIC_SKILLS.filter(item => {
      if (!q) return true;
      const textMatch = item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q);
      const tagMatch = item.tags.some(t => t.toLowerCase().includes(q));
      return textMatch || tagMatch;
    });

    return matches.slice(0, limit).map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      version: item.version,
      author: item.author,
      license: item.license,
      tags: item.tags,
      sourceUrl: item.sourceUrl,
      verified: false,
    }));
  }

  public async get(ref: MarketplaceSkillRef): Promise<MarketplaceSkillMetadata> {
    const found = BUILTIN_PUBLIC_SKILLS.find(s => s.id === ref.id);
    if (!found) {
      throw new Error(`Skill not found in marketplace index: ${ref.id}`);
    }
    return found;
  }

  public async fetch(ref: MarketplaceSkillRef): Promise<SkillSourceSnapshot> {
    const meta = await this.get(ref);
    const bundledFiles: Record<string, string | Buffer> = {};
    if (meta.files) {
      for (const f of meta.files) {
        if (f.content) bundledFiles[f.path] = f.content;
      }
    }

    const hashInfo = computeSkillContentHash(meta.rawSkillMarkdown, bundledFiles);

    const manifest: AgentSkillManifest = {
      apiVersion: "pao.dev/v1",
      kind: "AgentSkill",
      metadata: {
        id: `marketplace.${meta.id}`,
        namespace: "marketplace",
        slug: meta.id,
        name: meta.name,
        version: meta.version,
        description: meta.description,
        tags: meta.tags,
        author: meta.author,
      },
      source: {
        type: "SKILLS_SH",
        repository: meta.sourceUrl,
        imported_at: new Date().toISOString(),
        license: {
          spdx: meta.license,
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

    return {
      manifest,
      entryContent: meta.rawSkillMarkdown,
      bundledFiles,
      contentSha256: hashInfo.contentSha256,
    };
  }

  public async checkUpdates(refs: MarketplaceSkillRef[]): Promise<SkillUpdateResult[]> {
    const results: SkillUpdateResult[] = [];
    for (const ref of refs) {
      const found = BUILTIN_PUBLIC_SKILLS.find(s => s.id === ref.id);
      if (!found) continue;

      const current = ref.version ?? "1.0.0";
      const latest = found.version;
      const updateAvailable = current !== latest;

      results.push({
        skillId: ref.id,
        currentVersion: current,
        latestVersion: latest,
        updateAvailable,
        changelog: updateAvailable ? `Update available: ${current} -> ${latest}` : undefined,
      });
    }
    return results;
  }
}

