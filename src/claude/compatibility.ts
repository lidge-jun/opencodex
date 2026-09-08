/** Opt-in admission for the translated Messages path; no adapter or credential state. */
export type ClaudeCompatibilityMode = "shadow" | "enforce";

// False means deliberately tolerated degradation, not lossless representation.
const FEATURES = {
  cache_control: false,
  input_examples: false,
  thinking_settings: false,
  unknown_beta: false,
  thinking_replay: true,
  documents: true,
  web_search_tool: true,
  tool_search: true,
  tool_reference: true,
  deferred_tools: true,
  strict_tools: true,
  caller_mode: true,
  structured_output: true,
  service_tier: true,
  mcp_tool: true,
  code_execution: true,
  computer_use: true,
  server_tool: true,
  context_management: true,
  container: true,
  inference_geo: true,
  user_profile: true,
  unknown_body_field: true,
  unknown_content_block: true,
} as const;

export type ClaudeFeatureCode = keyof typeof FEATURES;
const FEATURE_CODES = Object.keys(FEATURES) as ClaudeFeatureCode[];
const MAX_FEATURE_CODES = 32;
const MAX_REASON_LENGTH = 512;
type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function isClaudeCompatibilityMode(value: unknown): value is ClaudeCompatibilityMode {
  return value === "shadow" || value === "enforce";
}

/** Project only closed codes, including when reading an untrusted persisted row. */
export function normalizeClaudeFeatureCodes(value: unknown): ClaudeFeatureCode[] {
  if (!Array.isArray(value)) return [];
  const codes = new Set<ClaudeFeatureCode>();
  for (const code of value) {
    if (typeof code === "string" && Object.hasOwn(FEATURES, code)) codes.add(code as ClaudeFeatureCode);
  }
  return FEATURE_CODES.filter(code => codes.has(code)).sort().slice(0, MAX_FEATURE_CODES);
}

/** Never accept a caller-supplied reason, header value, model name or tool name. */
export function claudeCompatibilityReason(codes: readonly ClaudeFeatureCode[], shadow: boolean): string | undefined {
  const unsupported = codes.filter(code => FEATURES[code]);
  if (unsupported.length === 0) return undefined;
  return `${shadow ? "shadow: would reject" : "unsupported translated Claude features"}: ${unsupported.join(", ")}`
    .slice(0, MAX_REASON_LENGTH);
}

const BODY_FIELDS = new Set([
  "model", "max_tokens", "messages", "system", "tools", "tool_choice", "thinking",
  "output_config", "metadata", "service_tier", "stop_sequences", "stream",
  "temperature", "top_p", "top_k", "cache_control", "context_management",
  "container", "inference_geo", "user_profile_id", "mcp_servers", "defer_tools", "deferred_tools",
]);

function activeDeferred(value: unknown): boolean {
  return value === true || (Array.isArray(value) ? value.length > 0 : isRec(value) && Object.keys(value).length > 0);
}

function nonDirectCaller(value: unknown): boolean {
  return value !== undefined && !(Array.isArray(value) && value.length === 1 && value[0] === "direct");
}

/** Complete finite detection. Only protocol content positions are visited, never schemas/arguments. */
function detectFeatures(body: unknown, anthropicBeta?: string): Set<ClaudeFeatureCode> {
  const codes = new Set<ClaudeFeatureCode>();
  // Header-only beta semantics are outside this policy. No header bytes become codes.
  if (anthropicBeta?.trim()) codes.add("unknown_beta");
  if (!isRec(body)) return codes; // The existing Messages parser owns malformed top-level input.
  if (Object.keys(body).some(key => !BODY_FIELDS.has(key))) codes.add("unknown_body_field");
  for (const [field, code] of [
    ["cache_control", "cache_control"], ["context_management", "context_management"],
    ["container", "container"], ["inference_geo", "inference_geo"],
    ["user_profile_id", "user_profile"], ["mcp_servers", "mcp_tool"],
  ] as const) {
    if (Object.hasOwn(body, field)) codes.add(code);
  }
  if (body.service_tier !== undefined && body.service_tier !== null) codes.add("service_tier");
  if (isRec(body.thinking)) codes.add("thinking_settings");
  if (isRec(body.output_config)
    && (body.output_config.format != null || body.output_config.output_format != null)) codes.add("structured_output");
  if (activeDeferred(body.defer_tools) || activeDeferred(body.deferred_tools)) codes.add("deferred_tools");

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!isRec(tool)) continue;
      if (Object.hasOwn(tool, "cache_control")) codes.add("cache_control");
      if (Object.hasOwn(tool, "input_examples")) codes.add("input_examples");
      if (tool.strict === true) codes.add("strict_tools");
      if (tool.defer === true || tool.defer_loading === true) codes.add("deferred_tools");
      if (nonDirectCaller(tool.allowed_callers)) codes.add("caller_mode");
      const type = tool.type;
      // Ordinary client function names do not convey hosted execution semantics.
      if (type === undefined || type === "function" || type === "custom") continue;
      if (type === "mcp_toolset") codes.add("mcp_tool");
      else if (typeof type === "string" && /^web_search_\d{8}$/.test(type)) codes.add("web_search_tool");
      else if (typeof type === "string" && /^tool_search(?:_tool_(?:regex|bm25))?(?:_\d{8})?$/.test(type)) codes.add("tool_search");
      else if (typeof type === "string" && /^code_execution_\d{8}$/.test(type)) codes.add("code_execution");
      else if (typeof type === "string" && /^computer(?:_toolset)?_\d{8}$/.test(type)) codes.add("computer_use");
      else codes.add("server_tool");
    }
  }

  const scanBlock = (block: unknown, position: "message" | "system" | "result") => {
    if (!isRec(block)) return;
    if (Object.hasOwn(block, "cache_control")) codes.add("cache_control");
    if (position === "system" && block.type !== "text") codes.add("unknown_content_block");
    if (position === "result" && (typeof block.type !== "string" || !["text", "image", "document", "tool_reference"].includes(block.type))) {
      codes.add("unknown_content_block");
    }
    switch (block.type) {
      case "text":
      case "image": break;
      case "document": codes.add("documents"); break;
      case "thinking":
      case "redacted_thinking": codes.add("thinking_replay"); break;
      case "tool_reference": codes.add("tool_reference"); break;
      case "tool_search_tool_result": codes.add("tool_search"); break;
      case "web_search_tool_result": codes.add("web_search_tool"); break;
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result": codes.add("code_execution"); break;
      case "mcp_tool_use":
      case "mcp_tool_result": codes.add("mcp_tool"); break;
      case "tool_use":
        if (block.caller !== undefined && (!isRec(block.caller) || block.caller.type !== "direct")) codes.add("caller_mode");
        break;
      case "server_tool_use":
        switch (block.name) {
          case "tool_search":
          case "tool_search_tool_regex":
          case "tool_search_tool_bm25": codes.add("tool_search"); break;
          case "web_search": codes.add("web_search_tool"); break;
          case "code_execution": codes.add("code_execution"); break;
          case "computer": codes.add("computer_use"); break;
          default: codes.add("server_tool");
        }
        break;
      case "tool_result": break; // Children are visited below at the one supported nesting level.
      default: codes.add("unknown_content_block");
    }
  };
  if (Array.isArray(body.system)) for (const block of body.system) scanBlock(block, "system");
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRec(message) || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        scanBlock(block, "message");
        if (isRec(block) && block.type === "tool_result" && Array.isArray(block.content)) {
          for (const child of block.content) scanBlock(child, "result");
        }
      }
    }
  }
  return codes;
}

export interface ClaudeCompatibilityResult {
  featureCodes: ClaudeFeatureCode[];
  compatible: boolean;
  decision: "allow" | "shadow" | "reject";
  reason?: string;
}

/** All translated targets share this policy; native passthrough never calls it. */
export function analyzeClaudeCompatibility(
  body: unknown,
  opts: { mode: ClaudeCompatibilityMode; anthropicBeta?: string },
): ClaudeCompatibilityResult {
  const detected = detectFeatures(body, opts.anthropicBeta);
  const compatible = !FEATURE_CODES.some(code => detected.has(code) && FEATURES[code]);
  const featureCodes = normalizeClaudeFeatureCodes([...detected]);
  return {
    featureCodes,
    compatible,
    decision: compatible ? "allow" : opts.mode === "shadow" ? "shadow" : "reject",
    ...(!compatible ? { reason: claudeCompatibilityReason(featureCodes, opts.mode === "shadow") } : {}),
  };
}
