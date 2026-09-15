import { readFileSync } from "node:fs";
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
  }): Promise<ImportResult> {
    const skillMdPath = join(input.artifactPath, "SKILL.md");
    let skillMarkdown = "";
    try {
      skillMarkdown = readFileSync(skillMdPath, "utf8");
    } catch {
      skillMarkdown = `# Capability Skill: ${input.capabilityId}\n\nGenerated skill adapter for capability ${input.capabilityId} (v${input.capabilityVersion}).\n`;
    }

    const payload: CapabilitySkillPublisherInput = {
      capabilityId: input.capabilityId,
      capabilityVersion: input.capabilityVersion,
      displayName: input.displayName ?? `Capability: ${input.capabilityId}`,
      description: input.description ?? `Generated Skill adapter for ${input.capabilityId}`,
      skillMarkdown,
      provenance: input.provenance,
      tags: input.tags ?? ["generated", "capability-factory", input.capabilityId],
    };

    return await this.importer.importGenerated(payload);
  }
}

