import type { OcxConfig } from "../../types";
import { isDeclaredReasoningEffort } from "../../reasoning-effort";
import { COMPACTION_TRIGGERS } from "../../config/schema/compaction-triggers";
import { routeConcreteModel, type RouteResult } from "../../router";
import { resolveComboId } from "../../combos/identifiers";
import { resolvePolicyProfileId } from "../../routing/profile";
import { parseSyntheticRowId } from "../fast-row";
import { recallComboForLane } from "./combo-session-recall";
import { sessionLaneIdFromRequest } from "../request-log-conversation";

/** `sourceModel` is the conversation's own selector before the rewrite. */
export interface CompactionRoutingOverride {
  sourceModel: string;
  /** Combo the lane remembers for a bare `sourceModel` (#3891); the conversation resumes there, not on the bare route. */
  sourceCombo?: string;
  /** Combo the configured override resolves to; its children route concretely but stay portable. */
  targetCombo?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Triggers this override covers. Absent means manual only, which is the narrowest
 * reading of the setting and leaves automatic compaction exactly as it routes today.
 * A hand-edited value the schema would have rejected disables the override rather
 * than widening it, so a malformed edit can never route more than it names.
 */
function configuredTriggers(value: unknown): readonly string[] | null {
  if (value === undefined) return ["manual"];
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(entry => typeof entry === "string" && (COMPACTION_TRIGGERS as readonly string[]).includes(entry))) return null;
  if (new Set(value).size !== value.length) return null;
  return value as readonly string[];
}

export interface CompactionRoutingOverrideOptions {
  /** `responses` requires a `compaction_trigger` input item; the native compact endpoint carries none. */
  endpoint?: "responses" | "compact";
  transport?: "websocket";
}

export function applyCompactionRoutingOverride(
  body: unknown,
  headers: Headers,
  config: OcxConfig,
  options: CompactionRoutingOverrideOptions = {},
): CompactionRoutingOverride | null {
  const override = config.compactionRouting;
  const raw = record(body);
  if (!raw || typeof raw.model !== "string" || !raw.model.trim()
    || typeof override?.model !== "string" || !override.model.trim()) return null;
  if (override.reasoningEffort !== undefined
    && (typeof override.reasoningEffort !== "string" || !isDeclaredReasoningEffort(override.reasoningEffort))) return null;
  const triggers = configuredTriggers(override.triggers);
  if (!triggers) return null;
  if (options.endpoint !== "compact"
    && !(Array.isArray(raw.input) && raw.input.some(item => record(item)?.type === "compaction_trigger"))) return null;

  const metadata: unknown[] = [];
  const header = headers.get("x-codex-turn-metadata");
  if (options.transport !== "websocket" && header !== null) metadata.push(header);
  const client = record(raw.client_metadata);
  if (client && Object.hasOwn(client, "x-codex-turn-metadata")) metadata.push(client["x-codex-turn-metadata"]);
  if (metadata.length === 0) return null;
  let trigger: string | undefined;
  for (const value of metadata) {
    if (typeof value !== "string") return null;
    try {
      const parsed = record(JSON.parse(value));
      if (parsed?.request_kind !== "compaction") return null;
      const carried = record(parsed.compaction)?.trigger;
      if (typeof carried !== "string" || !triggers.includes(carried)) return null;
      // Copies that name different triggers are not agreement, and picking either one would
      // let a caller widen an override by disagreeing with itself.
      if (trigger !== undefined && trigger !== carried) return null;
      trigger = carried;
    } catch {
      return null;
    }
  }
  if (trigger === undefined) return null;

  const sourceModel = raw.model;
  const sourceCombo = recallComboForLane(config, sessionLaneIdFromRequest(headers), sourceSelectorOf(config, sourceModel));
  const targetCombo = resolveComboId(config, override.model.trim()) ?? undefined;
  raw.model = override.model.trim();
  if (override.reasoningEffort !== undefined) {
    raw.reasoning = { ...record(raw.reasoning), effort: override.reasoningEffort };
  }
  return { sourceModel, ...(sourceCombo ? { sourceCombo } : {}), ...(targetCombo ? { targetCombo } : {}) };
}

/**
 * The selector a synthetic-row grammar actually routed on. `--fast`/`--effort` suffixes are
 * decoration applied at ingress; identity checks must see the base id or a decorated
 * virtual selector (`alias--fast`) slips past them.
 */
function sourceSelectorOf(config: OcxConfig, sourceModel: string): string {
  const { fastRow, effortRow } = parseSyntheticRowId(sourceModel, config);
  return fastRow?.baseId ?? effortRow?.baseId ?? sourceModel;
}

/** Same provider identity keeps caller auth and may use native compact; its ciphertext replays only there. */
export function compactionRoutingKeepsProviderIdentity(
  config: OcxConfig,
  override: CompactionRoutingOverride,
  route: RouteResult,
): boolean {
  // `sourceModel` is the selector as the client sent it, so a synthetic `--fast` or
  // effort suffix can still be attached. The base id is what the conversation routed on,
  // and only the base can match the combo/policy guards below.
  const sourceSelector = sourceSelectorOf(config, override.sourceModel);
  if (route.combo || override.sourceCombo || override.targetCombo || resolveComboId(config, sourceSelector)) return false;
  // A policy selector does not identify one stable serving backend: its route depends on
  // request evidence and live candidate state that this post-rewrite check no longer has.
  // Treat it as crossing identity rather than reconstructing it through concrete routing,
  // which deliberately bypasses policy evaluation and may fall through to defaultProvider.
  if (resolvePolicyProfileId(config, sourceSelector) !== null) return false;
  let source: RouteResult;
  try {
    source = routeConcreteModel(config, sourceSelector);
  } catch {
    return false;
  }
  // The default-provider branch is where every unrecognized selector lands — including a
  // policy/combo alias that was renamed or deleted since the conversation began. Such a
  // selector cannot prove which backend served it, so it can never match an identity.
  if (source.routeReason === "default-provider") return false;
  return source.providerName === route.providerName
    && source.codexAccountMode === route.codexAccountMode
    && source.codexAccountNamespace === route.codexAccountNamespace;
}
