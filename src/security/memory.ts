import { randomBytes } from "node:crypto";
import { sha256 } from "../skills/hasher";
import { SECRET_PATTERNS } from "./constants";
import type { SecurityDatabase } from "./db";
import { redactSecrets } from "./evidence";
import type {
  CampaignMemoryInput,
  CampaignMemoryQuery,
  MemoryHit,
  PatternQuery,
  RetentionPolicy,
  SanitizedPattern,
  SecurityMemoryBackend,
  SecurityMemoryRef,
} from "./types";

const SENSITIVE_HINTS = [
  /authorization/i,
  /scope.?token/i,
  /password/i,
  /credential/i,
  /secret/i,
  /cookie/i,
  /session.?id/i,
];

export function containsSensitiveMemory(body: string): boolean {
  if (SECRET_PATTERNS.some(p => p.test(body))) return true;
  return SENSITIVE_HINTS.some(p => p.test(body));
}

export function sanitizeReusableMemory(body: string): { body: string; sanitized: boolean; rejected: boolean } {
  if (containsSensitiveMemory(body) && SECRET_PATTERNS.some(p => p.test(body))) {
    return { body: "", sanitized: false, rejected: true };
  }
  const { redacted } = redactSecrets(body);
  const stripped = redacted
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
    .replace(/\b[a-z0-9.-]+\.(?:com|net|org|io|dev|local)\b/gi, "[host]");
  return { body: stripped, sanitized: stripped !== body, rejected: false };
}

export class LocalSecurityMemoryAdapter implements SecurityMemoryBackend {
  constructor(private readonly db: SecurityDatabase) {}

  public async storeCampaignMemory(input: CampaignMemoryInput): Promise<{ id: string }> {
    const now = new Date().toISOString();
    const { redacted } = redactSecrets(input.body);
    const row: SecurityMemoryRef = {
      id: `mem_${randomBytes(8).toString("hex")}`,
      campaign_id: input.campaignId,
      tier: "campaign",
      kind: input.kind,
      body: redacted,
      sanitized: redacted !== input.body,
      sha256: sha256(redacted),
      created_by: input.createdBy,
      created_at: now,
    };
    this.db.insertMemory(row);
    return { id: row.id };
  }

  public async searchCampaignMemory(query: CampaignMemoryQuery): Promise<MemoryHit[]> {
    const needle = query.query.trim().toLowerCase();
    return this.db.listMemory({ campaignId: query.campaignId, tier: "campaign" })
      .filter(m => !needle || m.body.toLowerCase().includes(needle) || m.kind.toLowerCase().includes(needle))
      .slice(0, 20)
      .map(m => ({ id: m.id, tier: m.tier, body: m.body, score: needle ? 1 : 0.5 }));
  }

  public async storeReusablePattern(input: SanitizedPattern): Promise<{ id: string }> {
    const sanitized = sanitizeReusableMemory(input.body);
    if (sanitized.rejected) {
      throw new Error("Reusable memory rejected: contains credentials or secrets.");
    }
    const now = new Date().toISOString();
    const row: SecurityMemoryRef = {
      id: `mem_${randomBytes(8).toString("hex")}`,
      tier: "reusable",
      kind: input.kind,
      body: sanitized.body,
      sanitized: true,
      sha256: sha256(sanitized.body),
      created_by: input.createdBy,
      created_at: now,
    };
    this.db.insertMemory(row);
    return { id: row.id };
  }

  public async searchReusablePatterns(query: PatternQuery): Promise<MemoryHit[]> {
    const needle = query.query.trim().toLowerCase();
    return this.db.listMemory({ tier: "reusable" })
      .filter(m => !needle || m.body.toLowerCase().includes(needle) || m.kind.toLowerCase().includes(needle))
      .slice(0, 20)
      .map(m => ({ id: m.id, tier: m.tier, body: m.body, score: 0.5 }));
  }

  public async deleteOrExpireByPolicy(policy: RetentionPolicy): Promise<void> {
    this.db.deleteMemoryByPolicy({ expireBefore: policy.expireBefore, tier: policy.tier });
  }
}

export class NullSecurityMemoryAdapter implements SecurityMemoryBackend {
  public async storeCampaignMemory(): Promise<{ id: string }> {
    return { id: "mem_null" };
  }
  public async searchCampaignMemory(): Promise<MemoryHit[]> {
    return [];
  }
  public async storeReusablePattern(): Promise<{ id: string }> {
    throw new Error("Reusable memory backend is disabled.");
  }
  public async searchReusablePatterns(): Promise<MemoryHit[]> {
    return [];
  }
  public async deleteOrExpireByPolicy(): Promise<void> { /* no-op */ }
}

/**
 * OpenViking is not present in this repository. The adapter fails closed so a
 * misconfigured integration cannot silently drop secrets into an unknown store.
 */
export class OpenVikingSecurityMemoryAdapter implements SecurityMemoryBackend {
  public async storeCampaignMemory(): Promise<{ id: string }> {
    throw new Error("OpenViking memory backend is not available in this build.");
  }
  public async searchCampaignMemory(): Promise<MemoryHit[]> {
    return [];
  }
  public async storeReusablePattern(): Promise<{ id: string }> {
    throw new Error("OpenViking memory backend is not available in this build.");
  }
  public async searchReusablePatterns(): Promise<MemoryHit[]> {
    return [];
  }
  public async deleteOrExpireByPolicy(): Promise<void> { /* no-op */ }
}
