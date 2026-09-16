import type { OcxConfig } from "../../types";
import { isDeclaredReasoningEffort } from "../../reasoning-effort";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function applyManualCompactionOverride(body: unknown, headers: Headers, config: OcxConfig, transport?: "websocket"): boolean {
  const override = config.manualCompaction;
  const raw = record(body);
  if (!raw || typeof raw.model !== "string" || !raw.model.trim()
    || typeof override?.model !== "string" || !override.model.trim()) return false;
  if (override.reasoningEffort !== undefined
    && (typeof override.reasoningEffort !== "string" || !isDeclaredReasoningEffort(override.reasoningEffort))) return false;

  const metadata: unknown[] = [];
  const header = headers.get("x-codex-turn-metadata");
  if (transport !== "websocket" && header !== null) metadata.push(header);
  const client = record(raw.client_metadata);
  if (client && Object.hasOwn(client, "x-codex-turn-metadata")) metadata.push(client["x-codex-turn-metadata"]);
  if (metadata.length === 0) return false;
  for (const value of metadata) {
    if (typeof value !== "string") return false;
    try {
      const parsed = record(JSON.parse(value));
      if (parsed?.request_kind !== "compaction" || record(parsed.compaction)?.trigger !== "manual") return false;
    } catch {
      return false;
    }
  }

  raw.model = override.model.trim();
  if (override.reasoningEffort !== undefined) {
    raw.reasoning = { ...record(raw.reasoning), effort: override.reasoningEffort };
  }
  return true;
}
