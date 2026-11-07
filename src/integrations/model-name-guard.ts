import { namedExportContext } from "../clients/config-export/alias-selectors";
import { supportsAliasModelNames } from "../clients/config-export/model-names";
import type { OcxConfig } from "../types";
import { observeIntegration, type IntegrationPlanOperation, type IntegrationWriteInput } from "./mutation-plan";
import { exportContextOf } from "./state";
import type { WriteRefused } from "./writer";

/** Final synchronous admission after all coordinator awaits, before maintenance or writes. */
export function staleModelNameRefusal(
  input: IntegrationWriteInput,
  liveConfig: OcxConfig,
  operation: IntegrationPlanOperation,
): WriteRefused | null {
  if ((operation !== "apply" && operation !== "overwrite") || !supportsAliasModelNames(input.clientId)
    || (input.modelNames !== undefined && input.modelNames !== "alias")) return null;
  const context = { ...exportContextOf(input), modelNames: "alias" as const };
  const captured = namedExportContext(input.clientId, context);
  // No alias can be emitted, so routed-only operations keep their original IO path.
  if (!captured.models.some(model => model.aliasNamespaced !== undefined)) return null;
  // Policy inheritance is authoritative only after the ordinary client/path binding.
  // Observation here is read-only, and the transaction follows without another await.
  const observed = observeIntegration(input, { maintenance: false, recover: false }, operation);
  if (observed.failed || observed.modelNames !== "alias") return null;
  const current = namedExportContext(input.clientId, { ...context, config: liveConfig });
  const stale = captured.models.some((model, index) => model.aliasNamespaced !== undefined
    && model.aliasNamespaced !== current.models[index]?.aliasNamespaced);
  return stale ? {
    ok: false, clientId: input.clientId, state: "conflict", reason: "conflict",
    message: "model aliases changed while applying; retry with the current catalog",
  } : null;
}
