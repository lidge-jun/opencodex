/**
 * Gemini-compatible paths served on the authenticated data-plane listener. Kept free of handler
 * imports so listener allowlists and the package-tree fence can classify a path cheaply.
 * `GET /v1/models` and every other /v1/ path belong to OpenCodex itself: `/v1/` counts here only
 * for `POST /v1/models/{model}:{method}` with a method this surface knows.
 */
export type GeminiMethod = "generateContent" | "streamGenerateContent" | "countTokens" | "embedContent" | "batchEmbedContents";

export type GeminiNativeRoute =
  | { kind: "models"; httpMethod: "GET" }
  | { kind: "model"; httpMethod: "GET"; model: string }
  | { kind: "method"; httpMethod: "POST"; model: string; method: GeminiMethod };

const METHODS: ReadonlySet<string> = new Set<GeminiMethod>(["generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents"]);

/** A model reference as clients write it: URL-encoded or not, with or without a leading `models/`. */
function modelName(raw: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  const name = decoded.startsWith("models/") ? decoded.slice("models/".length) : decoded;
  return name.trim() ? name : undefined;
}

/** The Gemini route a path names, or undefined when the path is not one this surface serves. */
export function parseGeminiNativePath(pathname: string): GeminiNativeRoute | undefined {
  const beta = pathname.startsWith("/v1beta/models");
  if (!beta && !pathname.startsWith("/v1/models/")) return undefined;
  const rest = pathname.slice(beta ? "/v1beta/models".length : "/v1/models".length);
  if (beta && (rest === "" || rest === "/")) return { kind: "models", httpMethod: "GET" };
  if (!rest.startsWith("/")) return undefined;
  const target = rest.slice(1);
  const colon = target.lastIndexOf(":");
  if (colon >= 0 && METHODS.has(target.slice(colon + 1))) {
    const model = modelName(target.slice(0, colon));
    return model ? { kind: "method", httpMethod: "POST", model, method: target.slice(colon + 1) as GeminiMethod } : undefined;
  }
  if (!beta) return undefined;
  const model = modelName(target);
  return model ? { kind: "model", httpMethod: "GET", model } : undefined;
}

export function isGeminiNativePath(pathname: string): boolean {
  return parseGeminiNativePath(pathname) !== undefined;
}

/** Generation routes read a JSON body under maxInboundBodyBytes and take the raised-body admission. */
export function isGeminiGenerationPath(pathname: string): boolean {
  const route = parseGeminiNativePath(pathname);
  return route?.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent");
}
