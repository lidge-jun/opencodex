import { readJsonOrThrow } from "../../fetch-json";
import type {
  GuardrailsActivity,
  GuardrailsActivityFilters,
  GuardrailsCustomRule,
  GuardrailsDataType,
  GuardrailsOverview,
  GuardrailsImportPreview,
  GuardrailsRules,
  GuardrailsSettingsPatch,
  GuardrailsSettings,
  GuardrailsTesterResult,
} from "./types";

function guardrailsSettingsMutationPayload(
  patch: GuardrailsSettingsPatch,
): GuardrailsSettingsPatch {
  return {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.failurePolicy !== undefined ? { failurePolicy: patch.failurePolicy } : {}),
    ...(patch.providerScope !== undefined
      ? { providerScope: patch.providerScope }
      : {}),
    ...(patch.enabledDataTypes !== undefined
      ? { enabledDataTypes: patch.enabledDataTypes }
      : {}),
    ...(patch.disabledBuiltinRuleIds !== undefined
      ? { disabledBuiltinRuleIds: patch.disabledBuiltinRuleIds }
      : {}),
    ...(patch.keywordPrefilterEnabled !== undefined
      ? { keywordPrefilterEnabled: patch.keywordPrefilterEnabled }
      : {}),
  };
}

export class GuardrailsApiError extends Error {
  readonly code?: string;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(message);
    this.name = "GuardrailsApiError";
    this.code = code;
    this.status = status;
  }
}

async function guardrailsMutationError(response: Response, fallback: string): Promise<GuardrailsApiError> {
  let message = fallback;
  let code: string | undefined;
  try {
    const body = await response.json() as { code?: unknown; error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error) message = body.error;
    else if (typeof body.message === "string" && body.message) message = body.message;
    if (typeof body.code === "string" && body.code) code = body.code;
  } catch {
    // Non-JSON errors keep the localized fallback.
  }
  return new GuardrailsApiError(message, response.status, code);
}

async function getJson<T>(url: string, signal: AbortSignal, error: string): Promise<T> {
  const response = await fetch(url, { signal });
  const parsed = await readJsonOrThrow<T>(response, error);
  if (!parsed) throw new Error(error);
  return parsed;
}

export function fetchGuardrailsOverview(apiBase: string, signal: AbortSignal, error: string) {
  return getJson<GuardrailsOverview>(`${apiBase}/api/guardrails`, signal, error);
}

export function fetchGuardrailsRules(apiBase: string, signal: AbortSignal, error: string) {
  return getJson<GuardrailsRules>(`${apiBase}/api/guardrails/rules`, signal, error);
}

export async function fetchGuardrailsExport(apiBase: string, error: string): Promise<Blob> {
  const response = await fetch(`${apiBase}/api/guardrails/export`);
  if (!response.ok) throw await guardrailsMutationError(response, error);
  return response.blob();
}

export function fetchGuardrailsActivity(
  apiBase: string,
  signal: AbortSignal,
  error: string,
  filters: GuardrailsActivityFilters,
) {
  const query = new URLSearchParams({ limit: "100" });
  if (filters.category !== "") query.set("category", String(filters.category));
  if (filters.mode) query.set("mode", filters.mode);
  if (filters.result) query.set("result", filters.result);
  if (filters.surface) query.set("surface", filters.surface);
  return getJson<GuardrailsActivity>(`${apiBase}/api/guardrails/activity?${query}`, signal, error);
}

async function mutate<T>(
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
  revision: string | undefined,
  error: string,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(revision ? { "If-Match": `"${revision}"` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await guardrailsMutationError(response, error);
  const parsed = await readJsonOrThrow<T>(response, error);
  if (!parsed) throw new Error(error);
  return parsed;
}

export function updateGuardrailsSettings(
  apiBase: string,
  patch: GuardrailsSettingsPatch,
  revision: string,
  error: string,
) {
  return mutate<GuardrailsSettings>(
    `${apiBase}/api/guardrails/settings`,
    "PUT",
    guardrailsSettingsMutationPayload(patch),
    revision,
    error,
  );
}

export function toggleGuardrailsRule(
  apiBase: string,
  ruleId: string,
  enabled: boolean,
  revision: string,
  error: string,
) {
  return mutate<GuardrailsRules>(
    `${apiBase}/api/guardrails/rules/${encodeURIComponent(ruleId)}/enabled`,
    "PUT",
    { enabled },
    revision,
    error,
  );
}

export function saveGuardrailsCustomRule(
  apiBase: string,
  rule: GuardrailsCustomRule,
  editingRuleId: string | null,
  revision: string,
  error: string,
) {
  return mutate<GuardrailsRules>(
    editingRuleId
      ? `${apiBase}/api/guardrails/rules/${encodeURIComponent(editingRuleId)}`
      : `${apiBase}/api/guardrails/rules`,
    editingRuleId ? "PUT" : "POST",
    rule,
    revision,
    error,
  );
}

export function deleteGuardrailsCustomRule(
  apiBase: string,
  ruleId: string,
  revision: string,
  error: string,
) {
  return mutate<GuardrailsRules>(
    `${apiBase}/api/guardrails/rules/${encodeURIComponent(ruleId)}`,
    "DELETE",
    undefined,
    revision,
    error,
  );
}

export function testGuardrailsText(
  apiBase: string,
  text: string,
  signal: AbortSignal,
  error: string,
  settings?: {
    enabled: true;
    enabledDataTypes: GuardrailsDataType[];
    keywordPrefilterEnabled: boolean;
  },
) {
  return fetch(`${apiBase}/api/guardrails/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...(settings ? { settings } : {}) }),
    signal,
  }).then(async response => {
    const parsed = await readJsonOrThrow<GuardrailsTesterResult>(response, error);
    if (!parsed) throw new Error(error);
    return parsed;
  });
}

export async function importGuardrailsBundle(
  apiBase: string,
  bundle: unknown,
  mode: "merge" | "replace",
  dryRun: boolean,
  revision: string,
  error: string,
): Promise<Record<string, unknown>> {
  return mutate<Record<string, unknown>>(
    `${apiBase}/api/guardrails/import`,
    "POST",
    { mode, dryRun, bundle },
    revision,
    error,
  );
}

export async function previewGuardrailsBundle(
  apiBase: string,
  bundle: unknown,
  mode: "merge" | "replace",
  revision: string,
  error: string,
): Promise<GuardrailsImportPreview> {
  return mutate<GuardrailsImportPreview>(
    `${apiBase}/api/guardrails/import`,
    "POST",
    { mode, dryRun: true, bundle },
    revision,
    error,
  );
}
