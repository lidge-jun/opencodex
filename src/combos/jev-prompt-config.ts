import {
  JEV_EFFORT_DEFAULT_PROFILES,
  JEV_PROMPT_MAX_FIELD_CHARS,
  JEV_ROUTE_DEFAULT_INSTRUCTIONS,
} from "./jev-decision-contract";
import type { ComboValidationIssue } from "./types";

// U+2028/U+2029 survive JSON.stringify as raw line breaks, so they count as control text here.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;
const ROUTE_FIELDS = Object.keys(JEV_ROUTE_DEFAULT_INSTRUCTIONS) as Array<keyof typeof JEV_ROUTE_DEFAULT_INSTRUCTIONS>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Strict text validation at config and management boundaries; empty objects mean defaults. */
export function jevPromptConfigIssues(body: Record<string, unknown>): ComboValidationIssue[] {
  const raw = body.decisionPrompt;
  if (raw === undefined || raw === null) return [];
  const issues: ComboValidationIssue[] = [];
  if (body.strategy !== "jev") issues.push({ path: ["decisionPrompt"], message: 'decisionPrompt is only valid with strategy "jev"' });
  function object(value: unknown, path: string[], keys: readonly string[]): value is Record<string, unknown> {
    if (!isRecord(value)) {
      issues.push({ path, message: `${path.join(".")} must be an object` });
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) issues.push({ path: [...path, key], message: `${[...path, key].join(".")} is not a supported prompt field` });
    }
    return true;
  }
  function text(value: unknown, path: string[]) {
    if (value === undefined) return;
    if (typeof value !== "string" || !value.trim() || value.length > JEV_PROMPT_MAX_FIELD_CHARS || CONTROL_CHARS.test(value)) {
      issues.push({ path, message: `${path.join(".")} must be a non-empty string of at most ${JEV_PROMPT_MAX_FIELD_CHARS} characters; only tab, line feed and carriage return are allowed among control and line-separator characters` });
    }
  }
  if (!object(raw, ["decisionPrompt"], ["levelInstructions", "route"])) return issues;
  text(raw.levelInstructions, ["decisionPrompt", "levelInstructions"]);
  if (raw.route !== undefined && object(raw.route, ["decisionPrompt", "route"], [...ROUTE_FIELDS, "effortProfiles"])) {
    for (const field of ROUTE_FIELDS) text(raw.route[field], ["decisionPrompt", "route", field]);
    if (raw.route.effortProfiles !== undefined && object(raw.route.effortProfiles, ["decisionPrompt", "route", "effortProfiles"], Object.keys(JEV_EFFORT_DEFAULT_PROFILES))) {
      for (const effort of Object.keys(JEV_EFFORT_DEFAULT_PROFILES)) text(raw.route.effortProfiles[effort], ["decisionPrompt", "route", "effortProfiles", effort]);
    }
  }
  return issues;
}

export { normalizeJevPromptFields } from "./jev-decision-contract";
