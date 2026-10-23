/** Wire shape of GET|PUT /api/fallback (ocx.fallback/1), as the dashboard reads it. */
export type FallbackKind = "model" | "provider";
export type FallbackSwitches = { model?: boolean; provider?: boolean };
export type FallbackDeviceRow = { id: string; kind: "link" | "key"; alias?: string; localFallback: boolean; model: boolean | null; provider: boolean | null };
export type FallbackEventRow = { at: string; route: string; kind: FallbackKind; from: string; to: string; trigger: string; outcome: "taken" | "refused" };
export type FallbackState = {
  schema: "ocx.fallback/1";
  global: { model: boolean; provider: boolean };
  providers: Record<string, FallbackSwitches>;
  routes: Record<string, FallbackSwitches>;
  devices: FallbackDeviceRow[];
  last: FallbackEventRow | null;
};
export type FallbackWrite = {
  scope: "global" | "provider" | "route" | "device";
  key?: string;
  setting: FallbackKind | "localFallback";
  value: boolean | null;
};

export function parseFallbackState(value: unknown): FallbackState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<FallbackState>;
  if (raw.schema !== "ocx.fallback/1" || !raw.global || !Array.isArray(raw.devices)) return null;
  return {
    schema: raw.schema,
    global: { model: raw.global.model !== false, provider: raw.global.provider !== false },
    providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
    routes: raw.routes && typeof raw.routes === "object" ? raw.routes : {},
    devices: raw.devices.filter((row): row is FallbackDeviceRow => !!row && typeof row.id === "string"),
    last: raw.last && typeof raw.last === "object" ? raw.last : null,
  };
}
