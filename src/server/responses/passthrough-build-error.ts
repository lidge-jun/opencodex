import { releaseCodexAuthContextProbeLease, type CodexAuthContext } from "../../codex/auth-context";
import { formatErrorResponse } from "../../bridge";
import { redactSecretString } from "../../lib/redact";
import { NamespaceToolCollisionError } from "../../responses/namespace-tool-compat";
import { RoutedCustomToolCompatError } from "../../responses/custom-tool-compat";
import { XaiToolSchemaCompatibilityError } from "../../adapters/xai-tool-schema";
import { MuseToolChoiceCompatibilityError } from "../../adapters/openai-responses/muse-tool-choice";
import { MuseToolCatalogCompatibilityError } from "../../adapters/openai-responses/muse-tool-catalog";
import { OpenGatewayInputCompatibilityError } from "../../adapters/openai-responses/opengateway-input";
import { UnsupportedInputModalityError } from "../../adapters/input-media-guard";
import { mapCodexAuthContextErrorToResponse } from "./codex-auth-error";
import { HostedAdvisorSpendRefusal } from "./policy-request-scope";
import { azureHostedImageRefusalResponse } from "./azure-hosted-image";

/** Input-lowering errors are 400; late credential/identity failures retain their own contract. */
export function passthroughBuildErrorResponse(error: unknown, accountSelector?: string): Response | undefined {
  const refusal = azureHostedImageRefusalResponse(error) ?? mapCodexAuthContextErrorToResponse(error, { now: Date.now(), accountSelector });
  if (refusal) return refusal;
  if (error instanceof NamespaceToolCollisionError
    || error instanceof XaiToolSchemaCompatibilityError
    || error instanceof RoutedCustomToolCompatError
    || error instanceof MuseToolChoiceCompatibilityError
    || error instanceof MuseToolCatalogCompatibilityError
    || error instanceof OpenGatewayInputCompatibilityError) {
    return formatErrorResponse(400, "invalid_request_error", redactSecretString(error.message));
  }
  return undefined;
}

/** Local refusals precede generic adapter-build 400s and preservation of an older rejection. */
export function adapterBuildRefusal(error: unknown, context: CodexAuthContext | undefined,
  accountSelector?: string, cleanup?: () => void): Response | undefined {
  const refusal = azureHostedImageRefusalResponse(error) ?? (error instanceof UnsupportedInputModalityError ? unsupportedInputModalityResponse(error.message)
    : error instanceof HostedAdvisorSpendRefusal ? error.response()
    : mapCodexAuthContextErrorToResponse(error, { now: Date.now(), accountSelector }));
  if (refusal) {
    cleanup?.();
    releaseCodexAuthContextProbeLease(context);
  }
  return refusal;
}

/**
 * A video the routed wire cannot carry, with the code `runTurn` adapters already emit, so a combo
 * hops to a member that can read the clip instead of ending on a generic 400. Built directly
 * because `formatErrorResponse` keeps only its allowlisted codes. The message is fixed vocabulary.
 * Deliberately NOT marked non-replayable: nothing was sent, and that marker would stop the combo
 * loop before it reads the hop code.
 */
function unsupportedInputModalityResponse(message: string): Response {
  return new Response(JSON.stringify({ error: {
    type: "invalid_request_error", code: "unsupported_input_modality", param: null, message,
  } }), { status: 400, headers: { "Content-Type": "application/json" } });
}
