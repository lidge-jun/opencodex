import { isCodexReasoningEffort } from "../reasoning-effort";
import type { OcxComboDecisionLevel, OcxComboDefaultEffort } from "../types";
import {
  JEV_DECISION_MODES,
  JEV_LEVEL_SELECTS,
  JEV_LEVEL_IDS,
  JEV_LEVEL_MAX_CANDIDATES,
  JEV_LEVEL_DEFAULT_DESCRIPTIONS,
  type JevDecisionMode,
  type JevLevelId,
} from "./jev-decision-contract";

/**
 * Validation and sparse normalization for the JEV level-mode Combo fields: `decisionMode`,
 * `decisionLevels`, and `decisionFallbackLevel`. The request-time behavior lives in
 * `./jev-level.ts`; this module only decides what a stored Combo may say.
 */

export interface JevLevelConfigIssue {
  path: Array<string | number>;
  message: string;
}

export interface NormalizedJevLevelCandidate {
  provider: string;
  model: string;
  effort?: OcxComboDefaultEffort;
}

export interface NormalizedJevLevel {
  description?: string;
  candidates: NormalizedJevLevelCandidate[];
}

export type NormalizedJevLevels = Partial<Record<JevLevelId, NormalizedJevLevel>>;

const LEVEL_ID_SET = new Set<string>(JEV_LEVEL_IDS);
const MODE_SET = new Set<string>(JEV_DECISION_MODES);
const LEVEL_SELECT_SET = new Set<string>(JEV_LEVEL_SELECTS);
const MAX_DESCRIPTION_CHARS = 512;
// U+2028/U+2029 survive JSON.stringify as raw line breaks, so they count as control text here.
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isJevLevelId(value: unknown): value is JevLevelId {
  return typeof value === "string" && LEVEL_ID_SET.has(value);
}

/** Configured level ids in canonical order; the order the decision model sees them in. */
export function configuredJevLevelIds(levels: NormalizedJevLevels | undefined): JevLevelId[] {
  return levels ? JEV_LEVEL_IDS.filter(id => Object.hasOwn(levels, id)) : [];
}

function targetEfforts(targets: unknown): Map<string, readonly string[] | undefined> {
  const byKey = new Map<string, readonly string[] | undefined>();
  if (!Array.isArray(targets)) return byKey;
  for (const raw of targets) {
    if (!isRecord(raw)) continue;
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    if (!provider || !model) continue;
    const efforts = Array.isArray(raw.reasoningEfforts)
      ? raw.reasoningEfforts.filter((effort): effort is string => typeof effort === "string")
      : undefined;
    byKey.set(`${provider}/${model}`, efforts);
  }
  return byKey;
}

/** How to get out of a stale level list; the dashboard cannot edit levels, so it names the CLI. */
function levelFixHint(comboId: string): string {
  return `; update the levels with \`ocx combo set ${comboId} --decision-levels '<json>'\` or clear them with \`--decision-mode - --decision-levels -\``;
}

function levelIssues(
  id: JevLevelId,
  raw: unknown,
  targets: Map<string, readonly string[] | undefined>,
  fixHint: string,
): JevLevelConfigIssue[] {
  const path = ["decisionLevels", id];
  if (!isRecord(raw)) return [{ path, message: `decisionLevels.${id} must be an object with a candidates array` }];
  const issues: JevLevelConfigIssue[] = [];
  if (raw.description !== undefined
    && (typeof raw.description !== "string"
      || raw.description.trim().length === 0
      || raw.description.length > MAX_DESCRIPTION_CHARS
      || DISALLOWED_CONTROL_CHARS.test(raw.description))) {
    issues.push({
      path: [...path, "description"],
      message: `decisionLevels.${id}.description must be a non-empty string of at most ${MAX_DESCRIPTION_CHARS} characters; only tab, line feed and carriage return are allowed among control and line-separator characters`,
    });
  }
  const candidates = raw.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > JEV_LEVEL_MAX_CANDIDATES) {
    issues.push({
      path: [...path, "candidates"],
      message: `decisionLevels.${id}.candidates must be an array of 1 to ${JEV_LEVEL_MAX_CANDIDATES} candidates`,
    });
    return issues;
  }
  const seen = new Set<string>();
  candidates.forEach((candidate, index) => {
    const at = `decisionLevels.${id}.candidates[${index}]`;
    const candidatePath = [...path, "candidates", index];
    if (!isRecord(candidate)) {
      issues.push({ path: candidatePath, message: `${at} must be an object with provider and model` });
      return;
    }
    const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
    const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
    const key = `${provider}/${model}`;
    if (!provider || !model || !targets.has(key)) {
      issues.push({ path: candidatePath, message: `${at} must name one of the combo targets by provider and model${fixHint}` });
      return;
    }
    const effort = candidate.effort;
    if (effort !== undefined) {
      if (typeof effort !== "string" || !isCodexReasoningEffort(effort)) {
        issues.push({
          path: [...candidatePath, "effort"],
          message: `${at}.effort must be one of: low, medium, high, xhigh, max, ultra`,
        });
        return;
      }
      const allowed = targets.get(key);
      if (allowed !== undefined && !allowed.includes(effort)) {
        issues.push({
          path: [...candidatePath, "effort"],
          message: `${at}.effort "${effort}" is not in the reasoningEfforts of target "${key}"${fixHint}`,
        });
        return;
      }
    }
    const identity = `${key}:${typeof effort === "string" ? effort : ""}`;
    if (seen.has(identity)) {
      issues.push({ path: candidatePath, message: `${at} duplicates an earlier candidate of this level` });
      return;
    }
    seen.add(identity);
  });
  return issues;
}

/** Issues for the four level-mode fields of one raw Combo body. */
export function jevLevelConfigIssues(body: Record<string, unknown>, comboId = "<id>"): JevLevelConfigIssue[] {
  const issues: JevLevelConfigIssue[] = [];
  const jev = body.strategy === "jev";
  const mode = body.decisionMode;
  if (mode !== undefined && mode !== null) {
    if (typeof mode !== "string" || !MODE_SET.has(mode)) {
      issues.push({ path: ["decisionMode"], message: 'decisionMode must be "route" or "level"' });
    } else if (!jev) {
      issues.push({ path: ["decisionMode"], message: 'decisionMode is only valid with strategy "jev"' });
    } else if (mode === "level" && (body.decisionLevels === undefined || body.decisionLevels === null)) {
      issues.push({ path: ["decisionLevels"], message: 'decisionMode "level" requires decisionLevels' });
    }
  }

  const levels = body.decisionLevels;
  let configured: Set<string> | undefined;
  if (levels !== undefined && levels !== null) {
    if (!isRecord(levels)) {
      issues.push({
        path: ["decisionLevels"],
        message: "decisionLevels must be an object mapping level ids to { description?, candidates }",
      });
    } else if (!jev) {
      issues.push({ path: ["decisionLevels"], message: 'decisionLevels is only valid with strategy "jev"' });
    } else {
      const ids = Object.keys(levels);
      const unknown = ids.filter(id => !isJevLevelId(id));
      for (const id of unknown) {
        issues.push({
          path: ["decisionLevels", id],
          message: `decisionLevels.${id} is not a level; use: ${JEV_LEVEL_IDS.join(", ")}`,
        });
      }
      configured = new Set(ids.filter(isJevLevelId));
      // A choice question needs two options; self-hosted System One services refuse fewer.
      if (unknown.length === 0 && configured.size < 2) {
        issues.push({ path: ["decisionLevels"], message: "decisionLevels must configure at least two levels" });
      }
      const targets = targetEfforts(body.targets);
      for (const id of JEV_LEVEL_IDS) {
        if (configured.has(id)) issues.push(...levelIssues(id, levels[id], targets, levelFixHint(comboId)));
      }
    }
  }

  const fallback = body.decisionFallbackLevel;
  if (fallback !== undefined && fallback !== null) {
    if (!isJevLevelId(fallback)) {
      issues.push({
        path: ["decisionFallbackLevel"],
        message: `decisionFallbackLevel must be one of: ${JEV_LEVEL_IDS.join(", ")}`,
      });
    } else if (!jev) {
      issues.push({ path: ["decisionFallbackLevel"], message: 'decisionFallbackLevel is only valid with strategy "jev"' });
    } else if (!configured) {
      issues.push({ path: ["decisionFallbackLevel"], message: "decisionFallbackLevel requires decisionLevels" });
    } else if (!configured.has(fallback)) {
      issues.push({
        path: ["decisionFallbackLevel"],
        message: `decisionFallbackLevel "${fallback}" is not configured in decisionLevels`,
      });
    }
  }
  const select = body.decisionLevelSelect;
  if (select !== undefined && select !== null) {
    if (typeof select !== "string" || !LEVEL_SELECT_SET.has(select)) {
      issues.push({ path: ["decisionLevelSelect"], message: 'decisionLevelSelect must be "order" or "route"' });
    } else if (!jev) {
      issues.push({ path: ["decisionLevelSelect"], message: 'decisionLevelSelect is only valid with strategy "jev"' });
    } else if (mode !== "level" || !configured || issues.some(issue => issue.path[0] === "decisionLevels")) {
      issues.push({
        path: ["decisionLevelSelect"],
        message: 'decisionLevelSelect requires decisionMode "level" and valid decisionLevels',
      });
    }
  }
  return issues;
}

function normalizedLevel(raw: OcxComboDecisionLevel, id: JevLevelId): NormalizedJevLevel {
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  return {
    ...(description && description !== JEV_LEVEL_DEFAULT_DESCRIPTIONS[id] ? { description } : {}),
    candidates: (Array.isArray(raw.candidates) ? raw.candidates : []).map(candidate => ({
      provider: String(candidate.provider).trim(),
      model: String(candidate.model).trim(),
      ...(typeof candidate.effort === "string" && isCodexReasoningEffort(candidate.effort)
        ? { effort: candidate.effort as OcxComboDefaultEffort }
        : {}),
    })),
  };
}

/**
 * Sparse normalized level fields. The defaults, `decisionMode: "route"` and
 * `decisionLevelSelect: "order"`, are stored as omission; levels keep canonical order; a fallback
 * level equal to the default is still stored when explicit.
 */
export function normalizeJevLevelFields(raw: {
  decisionMode?: unknown;
  decisionLevels?: unknown;
  decisionFallbackLevel?: unknown;
  decisionLevelSelect?: unknown;
}): { decisionMode?: Exclude<JevDecisionMode, "route">; decisionLevels?: NormalizedJevLevels; decisionFallbackLevel?: JevLevelId; decisionLevelSelect?: "route" } {
  let decisionLevels: NormalizedJevLevels | undefined;
  if (isRecord(raw.decisionLevels)) {
    decisionLevels = {};
    for (const id of JEV_LEVEL_IDS) {
      const level = raw.decisionLevels[id];
      if (isRecord(level)) decisionLevels[id] = normalizedLevel(level as unknown as OcxComboDecisionLevel, id);
    }
  }
  return {
    ...(raw.decisionMode === "level" ? { decisionMode: "level" as const } : {}),
    ...(raw.decisionMode === "level" && decisionLevels && raw.decisionLevelSelect === "route" ? { decisionLevelSelect: "route" as const } : {}),
    ...(decisionLevels ? { decisionLevels } : {}),
    ...(isJevLevelId(raw.decisionFallbackLevel) ? { decisionFallbackLevel: raw.decisionFallbackLevel } : {}),
  };
}
