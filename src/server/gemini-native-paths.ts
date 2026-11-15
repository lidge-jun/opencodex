/**
 * Gemini-compatible paths served on the authenticated data-plane listener. Kept free of handler
 * imports so listener allowlists and the package-tree fence can classify a path cheaply.
 * `GET /v1/models` and every other /v1/ path belong to OpenCodex itself: `/v1/` counts here only
 * for `POST /v1/models/{model}:{method}` with a method this surface knows, and for the Interactions
 * API's stable `/v1/interactions` family, which OpenCodex does not otherwise serve.
 */
export type GeminiMethod = "generateContent" | "streamGenerateContent" | "countTokens" | "embedContent" | "batchEmbedContents";

export type GeminiNativeRoute =
  | { kind: "models"; httpMethod: "GET" }
  | { kind: "model"; httpMethod: "GET"; model: string }
  | { kind: "method"; httpMethod: "POST"; model: string; method: GeminiMethod }
  | { kind: "interactions"; httpMethod: "POST" }
  | { kind: "interaction"; httpMethod: "GET"; allow: readonly ["GET", "DELETE"]; id: string }
  | { kind: "interaction-cancel"; httpMethod: "POST"; id: string };

const METHODS: ReadonlySet<string> = new Set<GeminiMethod>(["generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents"]);

/** `/v1beta|v1/interactions`, `…/{id}` and `…/{id}/cancel`; an id is one plain segment. */
const INTERACTIONS_PATH = /^\/v1(?:beta)?\/interactions(?:\/([A-Za-z0-9_-]{1,128})(\/cancel)?)?$/;
const ITEM_METHODS = ["GET", "DELETE"] as const;

/** A model reference as clients write it: URL-encoded or not, with or without a leading `models/`. */
function modelName(raw: string): string | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return undefined; }
  const name = decoded.startsWith("models/") ? decoded.slice("models/".length) : decoded;
  return name.trim() ? name : undefined;
}

function interactionsRoute(pathname: string): GeminiNativeRoute | undefined {
  const match = INTERACTIONS_PATH.exec(pathname);
  if (!match) return undefined;
  const [, id, cancel] = match;
  if (id === undefined) return { kind: "interactions", httpMethod: "POST" };
  return cancel ? { kind: "interaction-cancel", httpMethod: "POST", id } : { kind: "interaction", httpMethod: "GET", allow: ITEM_METHODS, id };
}

/** The Gemini route a path names, or undefined when the path is not one this surface serves. */
export function parseGeminiNativePath(pathname: string): GeminiNativeRoute | undefined {
  const interactions = interactionsRoute(pathname);
  if (interactions) return interactions;
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

/** Whether `method` is served on the route. Stored-interaction paths answer GET and DELETE. */
export function geminiRouteAllows(route: GeminiNativeRoute, method: string): boolean {
  return "allow" in route ? (route.allow as readonly string[]).includes(method) : method === route.httpMethod;
}

/** The `Allow` header value for a route. */
export function geminiRouteAllowHeader(route: GeminiNativeRoute): string {
  return "allow" in route ? route.allow.join(", ") : route.httpMethod;
}

/**
 * Every route that reads a JSON body under maxInboundBodyBytes: generation, Interactions create and
 * countTokens. They take the shared raised or encoded body admission (#3023).
 */
export function isGeminiBodyPath(pathname: string): boolean {
  const route = parseGeminiNativePath(pathname);
  return isGeminiGenerationPath(pathname) || (route?.kind === "method" && route.method === "countTokens");
}

/** Generation routes: a body plus a model turn (turn slot, request-timeout override). */
export function isGeminiGenerationPath(pathname: string): boolean {
  const route = parseGeminiNativePath(pathname);
  return route?.kind === "interactions"
    || (route?.kind === "method" && (route.method === "generateContent" || route.method === "streamGenerateContent"));
}
