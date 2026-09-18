/**
 * The sub-agent surface advisory, on the dashboard side.
 *
 * The runtime sends `docsUrl` with every `/api/v2` response, so this constant is only the
 * fallback for a runtime older than the advisory. `gui/tests/subagent-surface-warning.test.tsx`
 * pins it to `src/config/multi-agent-surface.ts` so the two cannot drift.
 */
export const SUBAGENT_SURFACE_GUIDE_URL = "https://opencodex.me/guides/subagent-v1-default/";

export type SubagentSurfaceMode = "v1" | "default" | "v2";

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
  if (mode !== "v1" && mode !== "default" && mode !== "v2") return null;
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
  return mode === "default" ? "base" : mode;
}
