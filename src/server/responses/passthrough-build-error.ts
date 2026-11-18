import { releaseCodexAuthContextProbeLease, type CodexAuthContext } from "../../codex/auth-context";
import { formatErrorResponse } from "../../bridge";
import { redactSecretString } from "../../lib/redact";
import { NamespaceToolCollisionError } from "../../responses/namespace-tool-compat";
import { RoutedCustomToolCompatError } from "../../responses/custom-tool-compat";
import { XaiToolSchemaCompatibilityError } from "../../adapters/xai-tool-schema";
import { MuseToolChoiceCompatibilityError } from "../../adapters/openai-responses/muse-tool-choice";
import { MuseToolCatalogCompatibilityError } from "../../adapters/openai-responses/muse-tool-catalog";
import { OpenGatewayInputCompatibilityError } from "../../adapters/openai-responses/opengateway-input";
import { mapCodexAuthContextErrorToResponse } from "./codex-auth-error";
import { HostedAdvisorSpendRefusal } from "./policy-request-scope";

/** Input-lowering errors are 400; late credential/identity failures retain their own contract. */
export function passthroughBuildErrorResponse(error: unknown, accountSelector?: string): Response | undefined {
  const refusal = mapCodexAuthContextErrorToResponse(error, { now: Date.now(), accountSelector });
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
  const refusal = error instanceof HostedAdvisorSpendRefusal ? error.response()
    : mapCodexAuthContextErrorToResponse(error, { now: Date.now(), accountSelector });
  if (refusal) {
    cleanup?.();
    releaseCodexAuthContextProbeLease(context);
  }
  return refusal;
}
