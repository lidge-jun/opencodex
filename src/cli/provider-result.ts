import { normalizeCatalogDisposition } from "../codex/catalog-refresh-status";
import { CliUsageError, RuntimeApiError, printData, terminalSafeText } from "./runtime-api";

const ERRORS: Readonly<Record<string, string>> = {
  stale_provider_editor_baseline: "Provider baseline is stale. Read a fresh snapshot and review the changes before applying again.",
  provider_config_conflict: "Provider configuration changed before the write. Inspect the target before retrying.",
  provider_config_unavailable: "Provider configuration is unavailable on the target.",
  invalid_provider_editor_body: "Expected a provider editor document containing only defaultProvider and providers.",
  invalid_provider_editor_field: "The provider editor document contains a non-editable field.",
  invalid_provider_editor_config: "The proposed provider configuration is invalid.",
  invalid_provider_destination: "The target refused a provider destination.",
  invalid_provider: "The target refused the provider configuration.",
  invalid_provider_name: "The provider name is invalid.",
  invalid_default_provider: "The default must name a configured provider.",
  default_provider_disabled: "A disabled provider cannot be the default.",
  provider_namespace_conflict: "The provider conflicts with an account namespace.",
  provider_has_dependent_combos: "A routing combo still depends on this provider. Inspect its dependencies before removal.",
  last_provider: "The last provider cannot be removed.",
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Read only own data values; never invoke response getters or stringify a body. */
function own(value: unknown, key: string): unknown {
  if (!record(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Provider commands return numeric partial outcomes rather than losing them in runCliAction. */
export async function runProviderAction(action: () => Promise<number | void>): Promise<number> {
  try {
    return (await action()) ?? 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      // Domain/input parsers supply static diagnostics; no raw parser/OS error reaches here.
      console.error(`Error: ${terminalSafeText(error.message)}`);
      if (error.usage) for (const line of error.usage.split("\n")) console.error(terminalSafeText(line));
      return 2;
    }
    if (error instanceof RuntimeApiError) {
      const code = own(error.body, "code") ?? own(own(error.body, "error"), "code");
      const known = typeof code === "string" && Object.hasOwn(ERRORS, code) ? ERRORS[code] : undefined;
      const fallback = error.status === 404 ? "Provider or management operation was not found on the selected target."
        : error.status === 409 ? "The target refused a conflicting provider change. Read back before trying again."
          : error.status === 503 ? "Management API is unavailable. Start the intended proxy; connected clients must make provider changes on their Hub. The write outcome may be unknown."
            : "The provider request failed. Inspect the selected target before retrying; the write outcome may be unknown.";
      console.error(`Error: ${known ?? fallback}`);
      return error.status === 404 ? 4 : error.status === 409 ? 5 : 1;
    }
    console.error("Error: Provider operation did not return a usable outcome. Inspect the selected target before retrying; no rollback is implied.");
    return 1;
  }
}

const RECEIPT_FIELDS = new Set([
  "success", "name", "defaultProvider", "droppedCustomModels", "disabled", "hasApiKey",
  "xaiResponsesOptInState", "dependentShadowIntercept", "catalogRefresh",
]);

function invalidReceipt(): never { throw new Error("Invalid provider receipt"); }
function safeLabel(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096; }

/** Copy the public receipt vocabulary. Unexpected bodies never become raw CLI output. */
export function printProviderReceipt(value: unknown, wantsJson: boolean, action: string): number {
  if (!record(value) || own(value, "success") !== true
    || Object.keys(value).some(key => !RECEIPT_FIELDS.has(key))) invalidReceipt();
  const result: Record<string, unknown> = { success: true };
  for (const key of ["name", "defaultProvider"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const label = own(value, key);
    if (!safeLabel(label)) invalidReceipt();
    result[key] = label;
  }
  for (const key of ["disabled", "hasApiKey"] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const flag = own(value, key);
    if (typeof flag !== "boolean") invalidReceipt();
    result[key] = flag;
  }
  if (Object.hasOwn(value, "xaiResponsesOptInState")) {
    const state = own(value, "xaiResponsesOptInState");
    if (typeof state !== "boolean" && state !== "mixed") invalidReceipt();
    result.xaiResponsesOptInState = state;
  }
  if (Object.hasOwn(value, "droppedCustomModels")) {
    const count = own(value, "droppedCustomModels");
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) invalidReceipt();
    result.droppedCustomModels = count;
  }
  if (Object.hasOwn(value, "dependentShadowIntercept")) {
    const shadow = own(value, "dependentShadowIntercept");
    const model = own(shadow, "model"), enabled = own(shadow, "enabled");
    if (!record(shadow) || !safeLabel(model) || typeof enabled !== "boolean"
      || Object.keys(shadow).some(key => key !== "model" && key !== "enabled")) invalidReceipt();
    result.dependentShadowIntercept = { model, enabled };
  }
  let pending = false;
  let outcome = "No client catalog refresh was requested by this operation.";
  if (Object.hasOwn(value, "catalogRefresh")) {
    const raw = own(value, "catalogRefresh");
    const refresh = raw === null ? null : normalizeCatalogDisposition(raw);
    if (raw !== null && refresh === null) invalidReceipt();
    result.catalogRefresh = refresh;
    if (refresh?.status === "committed") {
      outcome = refresh.degraded ? "Catalog committed with degraded provider observations." : "Catalog committed.";
    } else if (refresh && refresh.reason !== "not-requested") {
      pending = true;
      outcome = `Configuration saved, but catalog did not converge (${refresh.reason}). Read back before retrying.`;
    }
  }
  const lines = [`${action}: provider configuration saved.`, outcome];
  if (result.defaultProvider) lines.push(`Default provider: ${result.defaultProvider}`);
  if (result.droppedCustomModels !== undefined) lines.push(`Removed custom models: ${result.droppedCustomModels}`);
  if (result.dependentShadowIntercept) {
    const shadow = result.dependentShadowIntercept as { model: string; enabled: boolean };
    lines.push(`Shadow-call dependency: ${shadow.model} (enabled: ${shadow.enabled}). Inspect its target.`);
  }
  printData(result, wantsJson, lines);
  return pending ? 1 : 0;
}
