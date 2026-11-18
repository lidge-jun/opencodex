import { namedExportContext } from "../clients/config-export/alias-selectors";
import { attachNestedSelectors } from "../clients/config-export/nested-selectors";
import { supportsAliasModelNames } from "../clients/config-export/model-names";
import type { OcxConfig } from "../types";
import { observeIntegration, type IntegrationPlanOperation, type IntegrationWriteInput } from "./mutation-plan";
import { exportContextOf } from "./state";
import type { WriteRefused } from "./writer";

/**
 * Pi's raw nested selectors were proven against the serving configuration when the roster loaded
 * (#8172). A configuration or inventory change during the coordinator awaits retires that proof, so
 * a selector that no longer reaches the same model refuses the write instead of being installed.
 */
function staleNestedSelectorRefusal(
  input: IntegrationWriteInput,
  liveConfig: OcxConfig,
  operation: IntegrationPlanOperation,
): WriteRefused | null {
  if ((operation !== "apply" && operation !== "overwrite") || input.clientId !== "pi") return null;
  const captured = exportContextOf(input).models;
  if (!captured.some(model => model.nestedNamespaced !== undefined)) return null;
  const current = attachNestedSelectors(liveConfig, captured);
  const stale = captured.some((model, index) => model.nestedNamespaced !== undefined
    && model.nestedNamespaced !== current[index]?.nestedNamespaced);
  return stale ? {
    ok: false, clientId: input.clientId, state: "conflict", reason: "conflict",
    message: "model selectors changed while applying; retry with the current catalog",
  } : null;
}

/** Final synchronous admission after all coordinator awaits, before maintenance or writes. */
export function staleModelNameRefusal(
  input: IntegrationWriteInput,
  liveConfig: OcxConfig,
  operation: IntegrationPlanOperation,
): WriteRefused | null {
  const nested = staleNestedSelectorRefusal(input, liveConfig, operation);
  if (nested) return nested;
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
