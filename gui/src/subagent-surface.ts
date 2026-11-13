/**
 * The sub-agent surface advisory, on the dashboard side.
 *
 * The runtime sends `docsUrl` with every `/api/v2` response, so this constant is only the
 * fallback for a runtime older than the advisory. `gui/tests/subagent-surface-warning.test.tsx`
 * pins it to `src/config/multi-agent-surface.ts` so the two cannot drift.
 */
export const SUBAGENT_SURFACE_GUIDE_URL = "https://opencodex.me/guides/subagent-v1-default/";

export type SubagentSurfaceMode = "v1" | "default" | "v2" | "v2-plaintext";

export type SubagentSurfaceAdvisory = {
  required: boolean;
  mode: SubagentSurfaceMode;
  recommended: "v1";
  version: number;
  docsUrl: string;
};

/** Narrow an unknown `/api/v2` field; a runtime that does not send it yields null. */
export function readSubagentSurfaceAdvisory(value: unknown): SubagentSurfaceAdvisory | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const mode = raw.mode;
  if (mode !== "v1" && mode !== "default" && mode !== "v2" && mode !== "v2-plaintext") return null;
  if (typeof raw.required !== "boolean") return null;
  return {
    required: raw.required,
    mode,
    recommended: "v1",
    version: typeof raw.version === "number" ? raw.version : 0,
    docsUrl: typeof raw.docsUrl === "string" && raw.docsUrl ? raw.docsUrl : SUBAGENT_SURFACE_GUIDE_URL,
  };
}

/** What the operator sees for a mode. The stored `"default"` is called base in the UI. */
export function subagentSurfaceLabel(mode: SubagentSurfaceMode): string {
  if (mode === "v2-plaintext") return "v2 \u00b7 plaintext";
  return mode === "default" ? "base" : mode;
}

/**
 * The segmented mode options, in display order. `"v2-plaintext"` exists only on runtimes
 * that advertise `supportsPlaintextV2Mode`; an older server must not be offered a value
 * it would reject, and a hidden option cannot be clicked into a bad request.
 */
export function subagentSurfaceModes(supportsPlaintextV2: boolean): readonly SubagentSurfaceMode[] {
  return supportsPlaintextV2
    ? ["v1", "default", "v2", "v2-plaintext"]
    : ["v1", "default", "v2"];
}

/** A successful HTTP status alone does not confirm the requested plaintext mode. */
export function confirmsPlaintextV2Mode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return state.ok === true && state.multiAgentMode === "v2-plaintext" && state.supportsPlaintextV2Mode === true
    && state.plaintextAgentMessagesEnabled === true && state.enabled === false;
}
