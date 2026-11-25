import type { OcxProviderConfig } from "../../types";
import type { ClientFacingModelLabel } from "../../lib/error-destination";
import { markProxyError } from "../../lib/client-error-body";
import { markResponseNonReplayable } from "../../lib/upstream-retry";
import { collectResponsesToolGroups } from "../../responses/tool-groups";
import { isPlainObject } from "../../adapters/openai-responses/internal";
import { AdmissionModelDeniedError, admissionModelDeniedResponse, assertRouteAllowedByScope,
  projectAdmissionModelDeniedLog, type AdmissionModelScope } from "../admission-model-scope";
import { projectLocalModelRefusalLog } from "../request-log-failure-detail";
import type { RequestLogContext } from "../request-log";

export const AZURE_IMAGE_DEPLOYMENT_HEADER = "x-ms-oai-image-generation-deployment";

/** Fixed vocabulary: neither the configured deployment nor a hidden route is public. */
export class AzureHostedImageError extends Error {
  constructor() {
    super("Azure hosted image generation requires a fixed operator deployment, a matching tool model, and an unchanged destination");
    this.name = "AzureHostedImageError";
  }
}

export function azureHostedImageRefusalResponse(error: unknown): Response | undefined {
  if (error instanceof AdmissionModelDeniedError) return admissionModelDeniedResponse(error);
  if (!(error instanceof AzureHostedImageError)) return undefined;
  const response = Response.json({ error: { type: "invalid_request_error",
    code: "azure_image_deployment_required", param: "tools", message: error.message } }, { status: 400 });
  markResponseNonReplayable(response);
  return markProxyError(response, "scope");
}

export type AzureHostedImageGuard = (body: unknown, headers: Headers, target: string) =>
  ((finalTarget: string, finalHeaders: Headers) => void) | undefined;

/** Capture operator authority once; a credential rebuild must create a new binding. */
export function createAzureHostedImageGuard(
  providerName: string, provider: OcxProviderConfig, url: string,
  scope: AdmissionModelScope | undefined, selector: ClientFacingModelLabel, logCtx: RequestLogContext,
): AzureHostedImageGuard {
  const entries = Object.entries(provider.headers ?? {}).filter(([name]) => name.toLowerCase() === AZURE_IMAGE_DEPLOYMENT_HEADER);
  const deployment = entries.length === 1 && typeof entries[0]![1] === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entries[0]![1]) ? entries[0]![1] : undefined;
  const capturedScope = scope && structuredClone(scope);
  const project = (error: unknown): never => {
    if (error instanceof AdmissionModelDeniedError) projectAdmissionModelDeniedLog(error, logCtx);
    else projectLocalModelRefusalLog(logCtx, selector);
    throw error;
  };
  return (serialized, headers, target) => {
    try {
      if (typeof serialized !== "string") throw new AzureHostedImageError();
      let body: unknown;
      try { body = JSON.parse(serialized); } catch { throw new AzureHostedImageError(); }
      if (!isPlainObject(body)) throw new AzureHostedImageError();
      const tools = collectResponsesToolGroups(body).flat().filter(tool => isPlainObject(tool) && tool.type === "image_generation");
      if (tools.length === 0) return undefined;
      if (!deployment || typeof body.model !== "string") throw new AzureHostedImageError();
      assertRouteAllowedByScope(capturedScope, selector, { providerName, modelId: body.model });
      assertRouteAllowedByScope(capturedScope, selector, { providerName, modelId: deployment });
      if (tools.some(tool => isPlainObject(tool) && tool.model !== undefined && tool.model !== deployment)) {
        throw new AzureHostedImageError();
      }
      const checkDestination = (finalTarget: string, finalHeaders: Headers): void => {
        if (finalTarget !== url || finalHeaders.get(AZURE_IMAGE_DEPLOYMENT_HEADER) !== deployment) {
          project(new AzureHostedImageError());
        }
      };
      checkDestination(target, headers);
      return checkDestination;
    } catch (error) { return project(error); }
  };
}
