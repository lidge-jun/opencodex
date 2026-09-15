import { randomBytes } from "node:crypto";
import { sha256 } from "../skills/hasher";
import { SECRET_PATTERNS } from "./constants";
import type { EvidenceType, SecurityEvidence } from "./types";

export function redactSecrets(text: string): { redacted: string; redaction_state: SecurityEvidence["redaction_state"] } {
  let redacted = text;
  let hits = 0;
  for (const pattern of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    redacted = redacted.replace(global, () => {
      hits += 1;
      return "[REDACTED]";
    });
  }
  return { redacted, redaction_state: hits === 0 ? "none" : hits < 3 ? "partial" : "redacted" };
}

export function hashEvidenceBody(body: string | Buffer): string {
  return sha256(body);
}

export function ingestEvidence(input: {
  campaign_id: string;
  asset_id?: string;
  execution_id?: string;
  type: EvidenceType;
  body: string;
  mime_type?: string;
  captured_by: string;
  sensitivity?: SecurityEvidence["sensitivity"];
  retention_class?: SecurityEvidence["retention_class"];
  metadata?: Record<string, unknown>;
  now?: Date;
}): SecurityEvidence {
  const now = input.now ?? new Date();
  const digest = hashEvidenceBody(input.body);
  const { redacted, redaction_state } = redactSecrets(input.body);
  const preview = redacted.slice(0, 400);
  return {
    id: `evd_${randomBytes(8).toString("hex")}`,
    campaign_id: input.campaign_id,
    asset_id: input.asset_id,
    execution_id: input.execution_id,
    type: input.type,
    storage_uri: `security://evidence/${digest}`,
    sha256: digest,
    mime_type: input.mime_type ?? "text/plain",
    captured_at: now.toISOString(),
    captured_by: input.captured_by,
    redaction_state,
    sensitivity: input.sensitivity ?? (redaction_state === "none" ? "internal" : "sensitive"),
    retention_class: input.retention_class ?? "campaign",
    metadata_json: JSON.stringify(input.metadata ?? {}),
    raw_preview: undefined,
    redacted_preview: preview,
  };
}
