/**
 * Exact Ollama-compatible paths served on the authenticated data-plane listener. Kept free of
 * handler imports so listener allowlists and the package-tree fence can classify a path cheaply.
 * Anything else under /api/ stays with the management API.
 */
export type OllamaNativeKind = "version" | "tags" | "show" | "chat" | "generate";

export const OLLAMA_NATIVE_ROUTES: ReadonlyMap<string, { method: "GET" | "POST"; kind: OllamaNativeKind }> = new Map([
  ["/api/version", { method: "GET", kind: "version" }],
  ["/api/tags", { method: "GET", kind: "tags" }],
  ["/api/show", { method: "POST", kind: "show" }],
  ["/api/chat", { method: "POST", kind: "chat" }],
  ["/api/generate", { method: "POST", kind: "generate" }],
]);

/** Generation routes read a JSON body under maxInboundBodyBytes and take the raised-body admission. */
export const OLLAMA_JSON_BODY_ROUTES: ReadonlySet<string> = new Set(["/api/chat", "/api/generate"]);

export function isOllamaNativePath(pathname: string): boolean {
  return OLLAMA_NATIVE_ROUTES.has(pathname);
}
