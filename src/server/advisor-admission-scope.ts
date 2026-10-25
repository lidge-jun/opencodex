import type { AdmissionModelScope } from "./admission-model-scope";

/** Scope metadata accepted only alongside the process-owned Advisor capability. */
export const ADVISOR_ADMISSION_SCOPE_HEADER = "x-opencodex-advisor-admission-scope";

export function encodeAdvisorAdmissionScope(scope: AdmissionModelScope): string {
  return Buffer.from(JSON.stringify({ providers: scope.providers, models: scope.models }), "utf8").toString("base64url");
}

export function decodeAdvisorAdmissionScope(value: string | null): AdmissionModelScope | undefined {
  if (!value || value.length > 16_384) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const { providers, models } = parsed as { providers?: unknown; models?: unknown };
    if (!Array.isArray(providers) || !Array.isArray(models)
      || providers.some(item => typeof item !== "string")
      || models.some(item => typeof item !== "string")) return undefined;
    return { providers, models };
  } catch {
    return undefined;
  }
}
