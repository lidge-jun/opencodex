const TRAILING_SLASHES = /\/+$/;
const TRAILING_RESPONSES = /\/responses\/?$/;
const TRAILING_V1 = /\/v1\/?$/;

/** Build the default key-auth openai-responses send URL.
 *  Accepts /v1, /v1/, /v1/responses, and /v1/responses/.
 *  Custom `responsesPath` stays on the adapter; this helper is only the legacy /v1/responses branch.
 */
export function openaiResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(TRAILING_SLASHES, "");
  const withoutEndpoint = trimmedPath.replace(TRAILING_RESPONSES, "");
  const withoutV1 = withoutEndpoint.replace(TRAILING_V1, "");
  url.pathname = `${withoutV1}/v1/responses`;
  return url.toString();
}
