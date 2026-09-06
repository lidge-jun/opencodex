/**
 * Claude compatibility analyzer (pure, no Lab imports).
 *
 * Detects Anthropic-specific feature usage in the sanitized source envelope
 * and decides whether a routed adapter can safely serve the request. Feature
 * codes are stable identifiers used in the bounded debug ring and (in enforce
 * mode) as a pre-network gate.
 *
 * Feature codes (Milestone 2 precise set):
 * - cache_control: any block with a cache_control field (positional prompt caching)
 * - thinking_block: thinking param or thinking/redacted_thinking blocks (genuine signed thinking)
 * - documents: document content blocks in messages
 * - unknown_content_block: content block type not in known Anthropic vocabulary
 * - web_search_tool: hosted web_search tool/block (has lossless Responses mapping)
 * - code_execution: code_execution tool/block (no lossless routed mapping)
 * - computer_use: computer tool/block (no lossless routed mapping)
 * - mcp_tool: mcp tool declarations (no lossless routed mapping)
 * - server_tool: generic fallback for other hosted/server tool types
 * - tool_search: tool_search declaration/call (lossless via tool_search)
 * - deferred_tools: tools with defer/defer_loading or deferred beta markers
 * - structured_output: output_config.format json_schema/json_object (lossless via text.format)
 * - service_tier: top-level service_tier (lossless via Responses option)
 * - context_management: top-level context_management field (no lossless routed mapping)
 * - input_examples: tool input_examples (Anthropic-only, preserved via source envelope)
 * - beta_*: each anthropic-beta token as beta_<sanitized>
 */

export type ClaudeCompatibilityMode = "shadow" | "enforce";

export const CLAUDE_COMPATIBILITY_MODES = ["shadow", "enforce"] as const;

export function isClaudeCompatibilityMode(value: unknown): value is ClaudeCompatibilityMode {
  return typeof value === "string" && (CLAUDE_COMPATIBILITY_MODES as readonly string[]).includes(value);
}

export function resolveClaudeCompatibilityMode(
  cc?: { compatibility?: unknown },
): ClaudeCompatibilityMode {
  return isClaudeCompatibilityMode(cc?.compatibility) ? cc.compatibility : "enforce";
}

export type ClaudeCompatibilityDecision = "allow" | "reject" | "shadow";

export interface ClaudeCompatibilityResult {
  featureCodes: string[];
  compatible: boolean;
  decision: ClaudeCompatibilityDecision;
  /** Human-readable reason when rejected, otherwise undefined. */
  reason?: string;
}

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function sanitizeBetaToken(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function walkForCacheControl(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(walkForCacheControl);
  const rec = value as Rec;
  if (Object.prototype.hasOwnProperty.call(rec, "cache_control")) return true;
  return Object.values(rec).some(walkForCacheControl);
}

function hasThinkingBlock(body: Rec): boolean {
  if (isRec(body.thinking)) return true;
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return false;
  for (const m of msgs) {
    if (!isRec(m)) continue;
    const content = m.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!isRec(b)) continue;
        if (b.type === "thinking" || b.type === "redacted_thinking") return true;
      }
    }
  }
  return false;
}

const KNOWN_CONTENT_TYPES = new Set([
  "text", "image", "tool_use", "tool_result", "thinking", "redacted_thinking",
  "document", "server_tool_use", "web_search_tool_result", "code_execution_tool_result",
  "tool_search_tool_result",
]);

function hasDocuments(body: Rec): boolean {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return false;
  for (const m of msgs) {
    if (!isRec(m)) continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isRec(b)) continue;
      if (b.type === "document") return true;
    }
  }
  return false;
}

function hasUnknownContentBlock(body: Rec): boolean {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return false;
  for (const m of msgs) {
    if (!isRec(m)) continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isRec(b)) continue;
      const t = typeof b.type === "string" ? b.type : "";
      if (t && !KNOWN_CONTENT_TYPES.has(t)) return true;
    }
  }
  return false;
}

function hasCodeExecution(body: Rec): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!isRec(t)) continue;
      const type = typeof t.type === "string" ? t.type : "";
      if (type.includes("code_execution")) return true;
      if (typeof t.name === "string" && t.name.includes("code_execution")) return true;
    }
  }
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!isRec(m)) continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!isRec(b)) continue;
        if (b.type === "code_execution_tool_result") return true;
        if (b.type === "server_tool_use" && typeof b.name === "string" && b.name.includes("code_execution")) return true;
      }
    }
  }
  return false;
}

function hasComputerUse(body: Rec): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!isRec(t)) continue;
      const type = typeof t.type === "string" ? t.type : "";
      if (type.includes("computer")) return true;
    }
  }
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return false;
  for (const m of msgs) {
    if (!isRec(m)) continue;
    const content = m.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!isRec(b)) continue;
      if (typeof b.type === "string" && b.type.includes("computer")) return true;
    }
  }
  return false;
}

function hasMcpTool(body: Rec): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!isRec(t)) continue;
      const type = typeof t.type === "string" ? t.type : "";
      // A client-executed function may legitimately be named `mcp_*`; only the
      // protocol-declared server toolset is an MCP admission feature.
      if (type === "mcp_toolset") return true;
    }
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRec(message) || !Array.isArray(message.content)) continue;
      if (message.content.some(block => isRec(block) && (block.type === "mcp_tool_use" || block.type === "mcp_tool_result"))) return true;
    }
  }
  return false;
}

function hasWebSearchTool(body: Rec): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!isRec(t)) continue;
      const type = typeof t.type === "string" ? t.type : "";
      if (type.includes("web_search")) return true;
    }
  }
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!isRec(m)) continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!isRec(b)) continue;
        if (b.type === "web_search_tool_result") return true;
        if (b.type === "server_tool_use" && typeof b.name === "string" && b.name.includes("web_search")) return true;
      }
    }
  }
  return false;
}

function hasGenericServerTool(body: Rec): boolean {
  const tools = body.tools;
  if (!Array.isArray(tools)) {
    const msgs = body.messages;
    if (Array.isArray(msgs)) {
      for (const m of msgs) {
        if (!isRec(m)) continue;
        const content = m.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (!isRec(b)) continue;
          if (b.type !== "server_tool_use") continue;
          const name = typeof b.name === "string" ? b.name : "";
          if (name.includes("web_search") || name.includes("code_execution") || name.includes("computer") || name.startsWith("tool_search_tool_")) continue;
          return true;
        }
      }
    }
    return false;
  }
  for (const t of tools) {
    if (!isRec(t)) continue;
    // Exclude known function tools, tool_search, and already-classified server tools
    const type = typeof t.type === "string" ? t.type : "";
    const name = typeof t.name === "string" ? t.name : "";
    if (name === "tool_search" || name.startsWith("tool_search_tool_")) continue;
    if (type === "tool_search" || type.startsWith("tool_search_tool_")) continue;
    if (type.includes("web_search") || type.includes("code_execution") || type.includes("computer") || type.startsWith("mcp")) continue;
    if (type && type !== "function") return true;
    if (type && typeof t.name !== "string") return true;
  }
  const msgs2 = body.messages;
  if (Array.isArray(msgs2)) {
    for (const m of msgs2) {
      if (!isRec(m)) continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!isRec(b)) continue;
        if (b.type === "server_tool_use") {
          const n = typeof b.name === "string" ? b.name : "";
          if (n.includes("web_search") || n.includes("code_execution") || n.includes("computer") || n.startsWith("tool_search_tool_")) continue;
          return true;
        }
      }
    }
  }
  return false;
}

function hasToolSearch(body: Rec): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!isRec(t)) continue;
      if (typeof t.type === "string" && (t.type === "tool_search" || t.type.startsWith("tool_search_tool_"))) return true;
      if (typeof t.name === "string" && (t.name === "tool_search" || t.name.startsWith("tool_search_tool_"))) return true;
    }
  }
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!isRec(m)) continue;
      const content = m.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!isRec(b)) continue;
        if (b.type === "tool_search_tool_result") return true;
        if ((b.type === "tool_use" || b.type === "server_tool_use")
          && typeof b.name === "string"
          && (b.name === "tool_search" || b.name.startsWith("tool_search_tool_"))) return true;
      }
    }
  }
  return false;
}

function hasDeferredTools(body: Rec): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!isRec(t)) continue;
      if (t.defer === true) return true;
      if ((t as Rec).defer_loading === true) return true;
      if (Object.hasOwn(t, "defer") || Object.hasOwn(t, "defer_loading")) {
        // presence with truthy already handled; presence with explicit true is deferred
      }
    }
  }
  if (Object.hasOwn(body, "defer_tools") || Object.hasOwn(body, "deferred_tools")) return true;
  return false;
}

function hasInputExamples(body: Rec): boolean {
  const tools = body.tools;
  if (!Array.isArray(tools)) return false;
  for (const t of tools) {
    if (!isRec(t)) continue;
    if (Object.hasOwn(t, "input_examples")) return true;
  }
  return false;
}

function hasStructuredOutput(body: Rec): boolean {
  const oc = body.output_config;
  if (!isRec(oc)) return false;
  const fmt = (oc as Rec).format ?? (oc as Rec).output_format;
  if (!isRec(fmt as unknown)) return false;
  const f = fmt as Rec;
  if (f.type === "json_schema" || f.type === "json_object") return true;
  if (isRec(f.schema)) return true;
  return false;
}

function hasServiceTier(body: Rec): boolean {
  return typeof body.service_tier === "string" && (body.service_tier as string).length > 0;
}

function hasContextManagement(body: Rec): boolean {
  return Object.prototype.hasOwnProperty.call(body, "context_management");
}

const KNOWN_BODY_FIELDS = new Set([
  "model", "max_tokens", "messages", "system", "tools", "tool_choice", "thinking",
  "output_config", "metadata", "service_tier", "stop_sequences", "stream",
  "temperature", "top_p", "top_k", "cache_control", "context_management",
  "container", "inference_geo", "user_profile_id", "defer_tools", "deferred_tools",
]);

function hasUnknownBodyField(body: Rec): boolean {
  return Object.keys(body).some(field => !KNOWN_BODY_FIELDS.has(field));
}

/**
 * Collect feature codes from a sanitized Anthropic body and anthropic-beta header.
 * Pure — no config or Lab state.
 */
export function collectClaudeFeatureCodes(
  body: unknown,
  anthropicBeta?: string,
): string[] {
  const codes: string[] = [];
  const rec = isRec(body) ? (body as Rec) : null;
  if (rec) {
    if (walkForCacheControl(body)) codes.push("cache_control");
    if (hasContextManagement(rec)) codes.push("context_management");
    if (Object.hasOwn(rec, "container")) codes.push("container");
    if (Object.hasOwn(rec, "inference_geo")) codes.push("inference_geo");
    if (Object.hasOwn(rec, "user_profile_id")) codes.push("user_profile");
    if (hasUnknownBodyField(rec)) codes.push("unknown_body_field");
    if (hasThinkingBlock(rec)) codes.push("thinking_block");
    if (hasDocuments(rec)) codes.push("documents");
    if (hasUnknownContentBlock(rec)) codes.push("unknown_content_block");
    if (hasWebSearchTool(rec)) codes.push("web_search_tool");
    if (hasCodeExecution(rec)) codes.push("code_execution");
    if (hasComputerUse(rec)) codes.push("computer_use");
    if (hasMcpTool(rec)) codes.push("mcp_tool");
    if (hasGenericServerTool(rec)) codes.push("server_tool");
    if (hasToolSearch(rec)) codes.push("tool_search");
    if (hasDeferredTools(rec)) codes.push("deferred_tools");
    if (hasInputExamples(rec)) codes.push("input_examples");
    if (hasStructuredOutput(rec)) codes.push("structured_output");
    if (hasServiceTier(rec)) codes.push("service_tier");
  }
  if (typeof anthropicBeta === "string" && anthropicBeta.trim().length > 0) {
    for (const raw of anthropicBeta.split(",")) {
      const sanitized = sanitizeBetaToken(raw);
      if (!sanitized) continue;
      codes.push(`beta_${sanitized}`);
    }
  }
  return [...new Set(codes)].sort();
}

/**
 * Analyze compatibility for a given body/header/adapter/mode.
 * Enforce rejects when incompatible features require native Anthropic.
 * Shadow never rejects — it only records.
 */
export function analyzeClaudeCompatibility(
  body: unknown,
  opts: { mode: ClaudeCompatibilityMode; adapter?: string; anthropicBeta?: string },
): ClaudeCompatibilityResult {
  const featureCodes = collectClaudeFeatureCodes(body, opts.anthropicBeta);
  if (opts.adapter === "anthropic") {
    return { featureCodes, compatible: true, decision: "allow" };
  }
  // Incompatible set for routed adapters (non-anthropic native).
  // Compatible (translated or lossless): cache_control, thinking_block, web_search_tool,
  // tool_search, structured_output, service_tier, input_examples (deferred? no), beta_*.
  // Incompatible: features without lossless Responses mapping — they require Anthropic
  // source preservation and must be rejected on routed targets.
  const INCOMPATIBLE = new Set([
    "cache_control",
    "context_management",
    "container",
    "inference_geo",
    "user_profile",
    "unknown_body_field",
    "documents",
    "unknown_content_block",
    "code_execution",
    "computer_use",
    "mcp_tool",
    "server_tool",
    "input_examples",
  ]);
  if (opts.adapter !== "openai-responses") INCOMPATIBLE.add("deferred_tools");
  const incompatible = featureCodes.filter(c => INCOMPATIBLE.has(c)).slice(0, 32);
  if (opts.mode === "shadow") {
    return {
      featureCodes,
      compatible: true,
      decision: incompatible.length > 0 ? "shadow" : "allow",
      ...(incompatible.length > 0 ? { reason: `shadow: would reject for ${incompatible.join(", ")}` } : {}),
    };
  }
  if (incompatible.length > 0) {
    return {
      featureCodes,
      compatible: false,
      decision: "reject",
      reason: `unsupported features for routed adapter ${opts.adapter ?? "unknown"}: ${incompatible.join(", ")}. Select an Anthropic route, remove the feature, or begin a fresh reasoning turn`.slice(0, 512),
    };
  }
  return { featureCodes, compatible: true, decision: "allow" };
}
