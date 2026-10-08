import { serializeSidecarOverride } from "./claude-code-sidecar";
import type { ClaudeCodeState, MapRow } from "./claude-code-types";
import { newClientId } from "./claude-code-types";

/**
 * The Claude Code fields the Save bar owns. Everything else on ClaudeCodeState is either
 * server-derived (aliases, availability, diagnostics) or committed immediately by its own
 * control (`enabled`, the CLI 1P switch), so a read may always refresh it.
 */
export const EDITABLE_KEYS = [
  "authMode",
  "systemEnv",
  "fastMode",
  "autoContext",
  "autoCompactWindow",
  "injectAgents",
  "smallFastModel",
  "webSearchSidecar",
  "visionSidecar",
] as const satisfies readonly (keyof ClaudeCodeState)[];

export type ClaudeCodeEditable = { state: ClaudeCodeState; rows: MapRow[] };

/** Trimmed, non-empty rows; the last duplicate wins, as the server would apply it. Sorted keys. */
export function normalizedModelMap(rows: readonly MapRow[]): Record<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const from = row.from.trim();
    const to = row.to.trim();
    if (from && to) map.set(from, to);
  }
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The PUT body for Save. `enabled` is deliberately absent: the connection switch commits on
 * its own, and the server only writes `enabled` when the body carries it, so a Save built
 * from a stale draft can no longer switch Claude back on or off.
 */
export function claudeCodeSaveBody(state: ClaudeCodeState, rows: readonly MapRow[]) {
  return {
    authMode: state.authMode,
    systemEnv: state.systemEnv,
    fastMode: state.fastMode,
    autoContext: state.autoContext,
    autoCompactWindow: state.autoCompactWindow,
    injectAgents: state.injectAgents,
    smallFastModel: state.smallFastModel,
    modelMap: normalizedModelMap(rows),
    webSearchSidecar: serializeSidecarOverride(state.webSearchSidecar),
    visionSidecar: serializeSidecarOverride(state.visionSidecar),
  };
}

/**
 * A comparable identity for an editable draft: the Save body plus the raw row text, so a
 * blank or half-typed row keeps Revert available instead of vanishing on the next read.
 */
export function claudeCodeDraftKey(draft: ClaudeCodeEditable): string {
  return JSON.stringify([claudeCodeSaveBody(draft.state, draft.rows), draft.rows.map(row => [row.from, row.to])]);
}

/** Whether the draft differs from what the server last confirmed. */
export function isClaudeCodeDraftDirty(draft: ClaudeCodeEditable, baseline: ClaudeCodeEditable): boolean {
  return claudeCodeDraftKey(draft) !== claudeCodeDraftKey(baseline);
}

function pickEditable(state: ClaudeCodeState): Partial<ClaudeCodeState> {
  return Object.fromEntries(EDITABLE_KEYS.map(key => [key, state[key]])) as Partial<ClaudeCodeState>;
}

/** A fresh server read with the user's unsaved editable fields laid back on top. */
export function mergeServerRead(draft: ClaudeCodeState, next: ClaudeCodeState): ClaudeCodeState {
  return { ...next, ...pickEditable(draft) };
}

/** The draft with every editable field restored from the baseline; live fields stay. */
export function revertEditable(draft: ClaudeCodeState, baseline: ClaudeCodeState): ClaudeCodeState {
  return { ...draft, ...pickEditable(baseline) };
}

export type ClaudeCodeEditState = {
  draft: ClaudeCodeEditable;
  baseline: ClaudeCodeEditable;
  /**
   * Set when a Save succeeded and nothing was edited since it was sent. The next read is that
   * Save's acknowledgement and replaces the draft outright, so rows the server normalized
   * (trimmed, blank, duplicate) settle instead of reading as unsaved forever.
   */
  adoptNextRead: boolean;
  /**
   * A Save is out. Until it answers, a read never replaces the draft wholesale: an edit made
   * after submission can equal the old baseline and would otherwise read as clean and vanish.
   */
  savePending?: boolean;
};

/** Fold a successful read into the edit state. */
export function applyServerRead(current: ClaudeCodeEditState | null, next: ClaudeCodeEditable): ClaudeCodeEditState {
  if (!current || current.adoptNextRead || (!current.savePending && !isClaudeCodeDraftDirty(current.draft, current.baseline))) {
    return { draft: next, baseline: next, adoptNextRead: false, savePending: current?.savePending };
  }
  return {
    draft: { state: mergeServerRead(current.draft.state, next.state), rows: current.draft.rows },
    baseline: next,
    adoptNextRead: false,
    savePending: current.savePending,
  };
}

/**
 * What the server holds after a successful Save: the last server copy with the submitted
 * editable fields, and the normalized map (trimmed, no blanks, last duplicate wins).
 */
export function savedCopy(serverState: ClaudeCodeState, submitted: ClaudeCodeEditable): ClaudeCodeEditable {
  return {
    state: { ...serverState, ...pickEditable(submitted.state) },
    rows: Object.entries(normalizedModelMap(submitted.rows)).map(([from, to]) => ({ id: newClientId(), from, to })),
  };
}

/**
 * A successful PUT makes the submitted draft the new baseline right away, before the
 * refresh lands. Otherwise two things go wrong in that window: an edit that happens to
 * return to the OLD baseline reads as clean and is replaced by the saved value, and Revert
 * restores settings the server has already overwritten. The following read still gets the
 * final word through applyServerRead (adoptNextRead when nothing changed since submission).
 */
export function acknowledgeSave(current: ClaudeCodeEditState | null, submitted: ClaudeCodeEditable): ClaudeCodeEditState | null {
  if (!current) return current;
  // The saved copy is the baseline even if the refresh that would show it fails.
  const baseline = savedCopy(current.baseline.state, submitted);
  const rows = baseline.rows;
  const unchanged = claudeCodeDraftKey(current.draft) === claudeCodeDraftKey(submitted);
  // Untouched since submission: show what was stored. Edited meanwhile: keep the edits, dirty.
  return { draft: unchanged ? { state: current.draft.state, rows } : current.draft, baseline, adoptNextRead: unchanged };
}
