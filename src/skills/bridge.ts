import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SkillImporter, ImportResult } from "./importer";
import type { CapabilityProvenance, CapabilitySkillPublisherInput } from "./types";

export interface CapabilitySkillPublisher {
  publishGeneratedSkill(input: {
    capabilityId: string;
    capabilityVersion: string;
    artifactPath: string;
    displayName?: string;
    description?: string;
    provenance: CapabilityProvenance;
    tags?: string[];
    bundledFiles?: Record<string, string | Buffer>;
  }): Promise<ImportResult>;
}

export class CapabilityBridge implements CapabilitySkillPublisher {
  constructor(private readonly importer: SkillImporter) {}

  public async publishGeneratedSkill(input: {
    capabilityId: string;
    capabilityVersion: string;
    artifactPath: string;
    displayName?: string;
    description?: string;
    provenance: CapabilityProvenance;
    tags?: string[];
    bundledFiles?: Record<string, string | Buffer>;
  }): Promise<ImportResult> {
    const skillMdPath = join(input.artifactPath, "SKILL.md");
    let skillMarkdown = "";
    if (existsSync(skillMdPath)) {
      skillMarkdown = readFileSync(skillMdPath, "utf8");
    } else {
      skillMarkdown = `# Capability Skill: ${input.capabilityId}\n\nGenerated skill adapter for capability ${input.capabilityId} (v${input.capabilityVersion}).\n`;
    }

    const bundled: Record<string, string | Buffer> = { ...(input.bundledFiles ?? {}) };
    if (existsSync(input.artifactPath) && statSync(input.artifactPath).isDirectory()) {
      for (const entry of readdirSync(input.artifactPath)) {
        if (entry === "SKILL.md") continue;
        const full = join(input.artifactPath, entry);
        if (existsSync(full) && statSync(full).isFile() && !Object.hasOwn(bundled, entry)) {
          bundled[entry] = readFileSync(full);
        }
      }
    }

    const payload: CapabilitySkillPublisherInput = {
      capabilityId: input.capabilityId,
      capabilityVersion: input.capabilityVersion,
      displayName: input.displayName ?? `Capability: ${input.capabilityId}`,
      description: input.description ?? `Generated Skill adapter for ${input.capabilityId}`,
      skillMarkdown,
      bundledFiles: Object.keys(bundled).length > 0 ? bundled : undefined,
      provenance: input.provenance,
      tags: input.tags ?? ["generated", "capability-factory", input.capabilityId],
    };

    return await this.importer.importGenerated(payload);
  }
}

