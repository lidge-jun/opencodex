import { currentTurnWireToolCatalogBody } from "../responses-undeclared-tool-guard";

const MAX_EAGER_CODEX_MCP_TOOLS = 64;
const CODEX_CLIENT_IDENTITY = /^(?:codex|codex_cli_rs|codex_app|codex_work_desktop|codexless_agent|Codex Desktop)(?:\/|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eagerMcpToolCount(specs: unknown[], names: Set<string>, namespace?: string): void {
  for (const spec of specs) {
    if (!isRecord(spec) || spec.defer_loading === true) continue;
    if (spec.type === "namespace" && typeof spec.name === "string" && Array.isArray(spec.tools)) {
      eagerMcpToolCount(spec.tools, names, spec.name);
      continue;
    }
    const tool = isRecord(spec.function) ? spec.function : spec;
    if (tool.defer_loading === true || typeof tool.name !== "string") continue;
    const name = namespace ? `${namespace}__${tool.name}` : tool.name;
    if (name.startsWith("mcp__")) names.add(name);
    if (tool.name === "exec" && typeof tool.description === "string"
      && tool.description.includes("ALL_TOOLS") && tool.description.includes("V8")) {
      for (const match of tool.description.matchAll(/\bdeclare const tools:\s*\{\s*(mcp__[A-Za-z0-9_]+)\s*\(/g)) {
        names.add(match[1]!);
      }
    }
  }
}

export function codexToolCatalogReloadResponse(body: unknown, headers: Headers, surface: "responses" | "compact" = "responses"): Response | null {
  if (!headers.has("x-codex-turn-metadata")
    && !CODEX_CLIENT_IDENTITY.test(headers.get("originator") ?? "")
    && !CODEX_CLIENT_IDENTITY.test(headers.get("user-agent") ?? "")) return null;
  const current = currentTurnWireToolCatalogBody(body, undefined);
  if (!isRecord(current)) return null;
  const names = new Set<string>();
  if (Array.isArray(current.tools)) eagerMcpToolCount(current.tools, names);
  if (surface === "responses" && Array.isArray(current.input)) {
    for (const item of current.input) {
      if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        eagerMcpToolCount(item.tools, names);
      }
    }
  }
  if (names.size < MAX_EAGER_CODEX_MCP_TOOLS) return null;
  return Response.json({
    error: {
      type: "invalid_request_error",
      code: "codex_catalog_reload_required",
      message: "Codex sent a large eager MCP tool catalog instead of deferred tool discovery. Its model metadata may be missing or stale. Run 'ocx sync --restart-codex', then retry. OpenCodex refused this request before contacting the model provider.",
    },
  }, { status: 400 });
}
