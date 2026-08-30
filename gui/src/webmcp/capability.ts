// Phase 15 (WebMCP) — compatibility adapter.
//
// The WebMCP API is experimental. This module is the ONLY place that touches
// document.modelContext (or its legacy navigator alias). The rest of the app
// sees a typed adapter that degrades to "unavailable" without crashing.

export interface WebMcpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface WebMcpModelContext {
  registerTool: (tool: WebMcpToolDefinition, options?: { signal?: AbortSignal }) => Promise<void> | void;
}

type DocumentWithModelContext = Document & { modelContext?: WebMcpModelContext };
type NavigatorWithModelContext = Navigator & { modelContext?: WebMcpModelContext };

export function getModelContext(): WebMcpModelContext | null {
  if (typeof document === "undefined") return null;
  const docContext = (document as DocumentWithModelContext).modelContext;
  if (docContext) return docContext;
  const legacy = typeof navigator !== "undefined"
    ? (navigator as NavigatorWithModelContext).modelContext
    : undefined;
  return legacy ?? null;
}

export type WebMcpAvailability = "ready" | "unavailable";

export function webMcpAvailability(): WebMcpAvailability {
  return getModelContext() ? "ready" : "unavailable";
}
