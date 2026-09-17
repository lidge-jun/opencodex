import type { OcxConfig } from "../../types";
import { isDeclaredReasoningEffort } from "../../reasoning-effort";
import { routeConcreteModel, type RouteResult } from "../../router";
import { resolveComboId } from "../../combos/identifiers";
import { recallComboForLane } from "./combo-session-recall";
import { sessionLaneIdFromRequest } from "../request-log-conversation";

/** `sourceModel` is the conversation's own selector before the rewrite. */
export interface ManualCompactionOverride {
  sourceModel: string;
  /** Combo the lane remembers for a bare `sourceModel` (#3891); the conversation resumes there, not on the bare route. */
  sourceCombo?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface ManualCompactionOverrideOptions {
  /** `responses` requires a `compaction_trigger` input item; the native compact endpoint carries none. */
  endpoint?: "responses" | "compact";
  transport?: "websocket";
}

export function applyManualCompactionOverride(
  body: unknown,
  headers: Headers,
  config: OcxConfig,
  options: ManualCompactionOverrideOptions = {},
): ManualCompactionOverride | null {
  const override = config.manualCompaction;
  const raw = record(body);
  if (!raw || typeof raw.model !== "string" || !raw.model.trim()
    || typeof override?.model !== "string" || !override.model.trim()) return null;
  if (override.reasoningEffort !== undefined
    && (typeof override.reasoningEffort !== "string" || !isDeclaredReasoningEffort(override.reasoningEffort))) return null;
  if (options.endpoint !== "compact"
    && !(Array.isArray(raw.input) && raw.input.some(item => record(item)?.type === "compaction_trigger"))) return null;

  const metadata: unknown[] = [];
  const header = headers.get("x-codex-turn-metadata");
  if (options.transport !== "websocket" && header !== null) metadata.push(header);
  const client = record(raw.client_metadata);
  if (client && Object.hasOwn(client, "x-codex-turn-metadata")) metadata.push(client["x-codex-turn-metadata"]);
  if (metadata.length === 0) return null;
  for (const value of metadata) {
    if (typeof value !== "string") return null;
    try {
      const parsed = record(JSON.parse(value));
      if (parsed?.request_kind !== "compaction" || record(parsed.compaction)?.trigger !== "manual") return null;
    } catch {
      return null;
    }
  }

  const sourceModel = raw.model;
  const sourceCombo = recallComboForLane(config, sessionLaneIdFromRequest(headers), sourceModel);
  raw.model = override.model.trim();
  if (override.reasoningEffort !== undefined) {
    raw.reasoning = { ...record(raw.reasoning), effort: override.reasoningEffort };
  }
  return sourceCombo ? { sourceModel, sourceCombo } : { sourceModel };
}

/** Same provider identity keeps caller auth and may use native compact; its ciphertext replays only there. */
export function manualCompactionKeepsProviderIdentity(
  config: OcxConfig,
  override: ManualCompactionOverride,
  route: RouteResult,
): boolean {
  if (route.combo || override.sourceCombo || resolveComboId(config, override.sourceModel)) return false;
  let source: RouteResult;
  try {
    source = routeConcreteModel(config, override.sourceModel);
  } catch {
    return false;
  }
  return source.providerName === route.providerName
    && source.codexAccountMode === route.codexAccountMode
    && source.codexAccountNamespace === route.codexAccountNamespace;
}
