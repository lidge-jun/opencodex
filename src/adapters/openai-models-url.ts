const TRAILING_SLASHES = /\/+$/;
const TRAILING_MODELS = /\/models\/?$/;

/** Build the default key-auth model-discovery URL from a configured baseUrl.
 *  Accepts /v1, /v1/, /v1/models, and /v1/models/.
 *  The configured base path is preserved: only a trailing slash or an
 *  already-pasted /models segment is stripped before the endpoint is appended.
 */
export function openaiModelsUrl(baseUrl: string | undefined): string {
  // A provider can reach discovery without a baseUrl through the capture/bootstrap
  // paths. The previous interpolation produced "undefined/models" for it and no
  // consumer parses that string in the spec-less branch, so keep the tolerant shape
  // instead of throwing on the normalization.
  const trimmed = String(baseUrl).trim().replace(TRAILING_SLASHES, "");
  const withoutEndpoint = trimmed.replace(TRAILING_MODELS, "");
  return `${withoutEndpoint}/models`;
}

