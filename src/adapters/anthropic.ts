import type { IncomingMeta, ProviderAdapter } from "./base";
import { debugDroppedFrame } from "../lib/debug";
import type {
  AdapterEvent,
  OcxAssistantMessage,
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxTextContent,
  OcxThinkingContent,
  OcxToolCall,
  OcxToolResultMessage,
  OcxUsage,
} from "../types";
import { isAllowedToolChoice, namespacedToolName, resolveToolChoiceWireName, toolAllowedByChoice } from "../types";
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM_INSTRUCTION, applyClaudeToolPrefix, stripClaudeToolPrefix } from "../oauth/anthropic";
import { parseDataUrl } from "./image";
import { enforceAnthropicImageLimits } from "./anthropic-image-guard";
import { normalizeAnthropicImages } from "./anthropic-image-normalize";
import { neutralizeIdentity } from "./identity";
import { CLAUDE_CODE_HEADERS, claudeCodeSessionId } from "./client-fingerprint";
import { buildNonOpenAIToolCatalogNudgeForTools } from "./tool-catalog-nudge";
import { decodeServerSentEvents } from "../lib/sse-decoder";

/** Map a user content part to an Anthropic content block (text or image source). */
function toAnthropicContentPart(p: OcxContentPart): unknown {
  if (p.type === "image") {
    const data = parseDataUrl(p.imageUrl);
    return data
      ? { type: "image", source: { type: "base64", media_type: data.mediaType, data: data.base64 } }
      : { type: "image", source: { type: "url", url: p.imageUrl } };
  }
  return { type: "text", text: p.text };
}

/** Default `max_tokens` when Codex omits `max_output_tokens`. */
const DEFAULT_MAX_TOKENS = 8192;
/** Safe ceiling for `max_tokens` (thinking + visible output) across current Claude 4.x models. */
const REASONING_MAX_TOKENS_CEILING = 32_000;
/** Adaptive-thinking ceiling: max effort budget (32k) + OUTPUT_HEADROOM (8k).
 *  Must exceed REASONING_MAX_TOKENS_CEILING so effort=max actually preserves visible-output room. */
const ADAPTIVE_THINKING_CEILING = 40_192;
/** Anthropic's documented minimum `thinking.budget_tokens`. */
const MIN_THINKING_BUDGET = 1024;
/** Visible-output room added above the thinking budget when sizing `max_tokens`. */
const OUTPUT_HEADROOM = 8192;
/** Minimum visible-output room kept below `max_tokens` (so `max_tokens > budget_tokens` always holds). */
const OUTPUT_FLOOR = 4096;
const COMPAT_TOOL_PREFIX = "cx_";
type CacheControl = { type: "ephemeral"; ttl?: "1h" | "5m" };
const MAX_CACHE_BREAKPOINTS = 4;

function resolveCacheControl(retention: "none" | "short" | "long" | undefined): CacheControl | undefined {
  const r = retention ?? "short";
  if (r === "none") return undefined;
  return r === "long" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}
// ---------------------------------------------------------------------------
// Prompt-caching breakpoint placement (ported from jawcode)
//
// Strategy: place cache_control breakpoints on up to 4 locations in order
// of stability (most stable first), so Anthropic's cumulative prefix cuts
// maximise cache hits across turns:
//   1. tools (last block)          — changes rarely
//   2. system (last block)         — changes rarely
//   3. penultimate user message    — stable across the current turn
//   4. last user message           — the new turn's content
// ---------------------------------------------------------------------------

function applyCacheControlToLast<T extends Record<string, unknown>>(blocks: T[], cc: CacheControl): void {
  if (blocks.length === 0) return;
  const i = blocks.length - 1;
  blocks[i] = { ...blocks[i], cache_control: cc };
}

function applyCacheControlToLastText(blocks: Array<Record<string, unknown>>, cc: CacheControl): void {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === "text") {
      blocks[i] = { ...blocks[i], cache_control: cc };
      return;
    }
  }
  applyCacheControlToLast(blocks, cc);
}

type PromptCachingOptions = {
  maxExplicitBreakpoints?: number;
  skipLastUser?: boolean;
};

/** Place explicit cache_control breakpoints on the built Anthropic body. */
function applyPromptCaching(
  body: Record<string, unknown>,
  cc: CacheControl | undefined,
  options: PromptCachingOptions = {},
): void {
  if (!cc) return;
  const explicitLimit = options.maxExplicitBreakpoints ?? MAX_CACHE_BREAKPOINTS;
  if (explicitLimit <= 0) return;

  const messages = body.messages as Array<Record<string, unknown>> | undefined;

  // Skip if external breakpoints are already present on messages.
  if (messages) {
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        if ((msg.content as Array<Record<string, unknown>>).some(b => b.cache_control != null)) return;
      }
    }
  }

  let used = 0;

  // 1. tools
  const tools = body.tools as Array<Record<string, unknown>> | undefined;
  if (tools && tools.length > 0) {
    applyCacheControlToLast(tools, cc);
    used++;
  }
  if (used >= explicitLimit) return;

  // 2. system
  const system = body.system as Array<Record<string, unknown>> | undefined;
  if (system && system.length > 0) {
    applyCacheControlToLast(system, cc);
    used++;
  }
  if (used >= explicitLimit || !messages) return;

  // Locate user-role message indexes.
  const userIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIdxs.push(i);
  }

  // 3. penultimate user message
  if (userIdxs.length >= 2) {
    const msg = messages[userIdxs[userIdxs.length - 2]];
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: cc }];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      applyCacheControlToLastText(msg.content as Array<Record<string, unknown>>, cc);
    }
    used++;
  }
  if (used >= explicitLimit || options.skipLastUser) return;

  // 4. last user message
  if (userIdxs.length >= 1) {
    const msg = messages[userIdxs[userIdxs.length - 1]];
    if (typeof msg.content === "string") {
      msg.content = [{ type: "text", text: msg.content, cache_control: cc }];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      applyCacheControlToLastText(msg.content as Array<Record<string, unknown>>, cc);
    }
  }
}

// ---------------------------------------------------------------------------
// Breakpoint cap enforcement — strip excess beyond the 4-breakpoint limit
// ---------------------------------------------------------------------------

function countBreakpoints(body: Record<string, unknown>): number {
  let total = 0;
  const count = (blocks: Array<Record<string, unknown>> | undefined) => {
    if (!blocks) return;
    for (const b of blocks) if (b.cache_control) total++;
  };
  count(body.tools as Array<Record<string, unknown>> | undefined);
  count(body.system as Array<Record<string, unknown>> | undefined);
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (messages) {
    for (const msg of messages) {
      if (Array.isArray(msg.content)) count(msg.content as Array<Record<string, unknown>>);
    }
  }
  return total;
}

function enforceCacheControlLimit(body: Record<string, unknown>, limit = MAX_CACHE_BREAKPOINTS): void {
  const total = countBreakpoints(body);
  if (total <= limit) return;
  let excess = total - limit;
  // Strip from messages first (least stable), then system, then tools.
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (messages) {
    for (const msg of messages) {
      if (excess <= 0) break;
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as Array<Record<string, unknown>>) {
        if (excess <= 0) break;
        if (block.cache_control) { delete block.cache_control; excess--; }
      }
    }
  }
  const stripBlocks = (blocks: Array<Record<string, unknown>> | undefined) => {
    if (!blocks) return;
    for (const b of blocks) {
      if (excess <= 0) break;
      if (b.cache_control) { delete b.cache_control; excess--; }
    }
  };
  if (excess > 0) stripBlocks(body.system as Array<Record<string, unknown>> | undefined);
  if (excess > 0) stripBlocks(body.tools as Array<Record<string, unknown>> | undefined);
}

// ---------------------------------------------------------------------------
// TTL ordering — Anthropic requires 1-hour breakpoints before 5-minute ones
// ---------------------------------------------------------------------------

function normalizeTtlOrdering(body: Record<string, unknown>): void {
  const allBlocks: Array<Record<string, unknown>> = [];
  const collect = (blocks: Array<Record<string, unknown>> | undefined) => {
    if (!blocks) return;
    for (const b of blocks) if (b.cache_control) allBlocks.push(b);
  };
  collect(body.tools as Array<Record<string, unknown>> | undefined);
  collect(body.system as Array<Record<string, unknown>> | undefined);
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (messages) {
    for (const msg of messages) {
      if (Array.isArray(msg.content)) collect(msg.content as Array<Record<string, unknown>>);
    }
  }
  // Walk forward: once we see a 5-min (no ttl / ttl:"5m"), any subsequent 1h must be demoted.
  let seenShort = false;
  for (const b of allBlocks) {
    const cc = b.cache_control as CacheControl;
    if (cc.ttl !== "1h") {
      seenShort = true;
    } else if (seenShort) {
      // 1h after a short → demote to default (5m)
      delete cc.ttl;
    }
  }
}

function isLikelyRealAnthropicThinkingSignature(signature: string | undefined): signature is string {
  if (typeof signature !== "string" || signature.length < 16) return false;
  if (/^(fc|call|msg|rs|resp|reasoning|item|ws|tool|func|function)[-_]/i.test(signature)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(signature);
}

function usesNativeAnthropicEndpoint(provider: OcxProviderConfig): boolean {
  try {
    return new URL(provider.baseUrl).hostname === "api.anthropic.com";
  } catch {
    throw new Error(`anthropic provider has malformed baseUrl: ${provider.baseUrl}`);
  }
}

/** Map a Responses reasoning effort to an Anthropic extended-thinking budget (tokens, >= 1024). */
function reasoningBudget(effort: string): number {
  switch (effort) {
    case "minimal": return 1024;
    case "low": return 4096;
    case "high": return 16384;
    case "xhigh": return 24576;
    case "max": return 32000;
    case "medium":
    default: return 8192;
  }
}

/**
 * Claude families that moved to adaptive thinking: they 400 on `thinking.type: "enabled"`
 * ("Use \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior."),
 * while older families (Haiku 4.5, Sonnet 4.x, Opus <= 4.6) 400 on `adaptive` — so both wire
 * shapes must stay. Verified against api.anthropic.com: sonnet-5, fable-5, opus-4-7 and opus-4-8
 * require adaptive; haiku-4-5 and sonnet-4-5 reject it; opus-4-6/sonnet-4-6 accept both.
 */
const ADAPTIVE_THINKING_FAMILY_MINIMUMS: Record<string, readonly [major: number, minor: number]> = {
  sonnet: [5, 0],
  opus: [4, 7],
  fable: [0, 0],
};

function usesAdaptiveThinking(modelId: string): boolean {
  // Minor is 1-2 digits with a non-digit lookahead so date-pinned ids ("claude-opus-4-20250514")
  // parse as minor 0 instead of minor 20250514; suffixed ids ("claude-opus-4-8[1m]") still match.
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(modelId);
  if (!match) return false;
  const minimum = ADAPTIVE_THINKING_FAMILY_MINIMUMS[match[1]];
  if (!minimum) return false;
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

/** `output_config.effort` accepts low|medium|high|xhigh|max — "minimal" is rejected with a 400. */
function adaptiveEffort(effort: string): string {
  return effort === "minimal" ? "low" : effort;
}

function usageFromAnthropic(usage: Record<string, number> | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  const hasCache = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  // Anthropic reports input_tokens EXCLUSIVE of cache read/write; normalize to the
  // canonical inclusive convention (types.ts OcxUsage / devlog 070).
  return {
    inputTokens: (usage.input_tokens ?? 0) + read + write,
    outputTokens: usage.output_tokens ?? 0,
    ...(hasCache ? {
      cachedInputTokens: read,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
    } : {}),
  };
}

function mergeAnthropicUsage(
  base: Record<string, number> | undefined,
  next: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!next) return base;
  if (!base) return { ...next };
  // Anthropic `message_delta.usage` values are CUMULATIVE; adding them to the
  // message_start snapshot double-counted output tokens. Later frames win per key.
  return { ...base, ...next };
}

function buildToolNameTransforms(provider: OcxProviderConfig): { toWire: (name: string) => string; fromWire: (name: string) => string } {
  if (provider.authMode === "oauth") {
    return { toWire: applyClaudeToolPrefix, fromWire: stripClaudeToolPrefix };
  }
  if (provider.escapeBuiltinToolNames === true) {
    return {
      toWire: (name) => name.startsWith(COMPAT_TOOL_PREFIX) ? name : COMPAT_TOOL_PREFIX + name,
      fromWire: (name) => name.startsWith(COMPAT_TOOL_PREFIX) ? name.slice(COMPAT_TOOL_PREFIX.length) : name,
    };
  }
  return { toWire: (name) => name, fromWire: (name) => name };
}

function toAnthropicToolResult(msg: OcxToolResultMessage): Record<string, unknown> {
  // Anthropic tool_result accepts a string OR content blocks — render images natively
  // (e.g. Codex view_image output) instead of dropping them.
  let content: string | unknown[];
  if (typeof msg.content === "string") {
    // Anthropic rejects tool_result with empty text content blocks.
    content = msg.content || "(empty tool output)";
  } else {
    const parts = (msg.content as OcxContentPart[])
      .map(toAnthropicContentPart)
      .filter(p => !((p as { type?: string }).type === "text" && !(p as { text?: string }).text));
    content = parts.length > 0 ? parts : "(empty tool output)";
  }
  return {
    type: "tool_result",
    tool_use_id: msg.toolCallId,
    content,
    ...(msg.isError ? { is_error: true } : {}),
  };
}

function orphanToolResultText(msg: OcxToolResultMessage): string {
  const label = msg.toolName ? `${msg.toolName} (${msg.toolCallId})` : msg.toolCallId;
  const content = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content);
  return `[tool_result without adjacent tool_use: ${label}]\n${content}`;
}

function messagesToAnthropicFormat(
  parsed: OcxParsedRequest,
  toolNames: { toWire: (name: string) => string },
): { system: string | undefined; messages: unknown[] } {
  const toolCatalogNudge = buildNonOpenAIToolCatalogNudgeForTools(
    parsed.context.tools,
    parsed.options.toolChoice,
    tool => toolNames.toWire(namespacedToolName(tool.namespace, tool.name)),
  );
  const systemParts = [...(parsed.context.systemPrompt ?? []), ...(toolCatalogNudge ? [toolCatalogNudge] : [])];
  const system = systemParts.length
    ? neutralizeIdentity(systemParts.join("\n\n")) || undefined
    : undefined;
  const messages: unknown[] = [];

  for (let i = 0; i < parsed.context.messages.length; i++) {
    const msg = parsed.context.messages[i];
    switch (msg.role) {
      case "user":
      case "developer": {
        let content: string | unknown[];
        if (typeof msg.content === "string") {
          // Anthropic rejects empty string text content blocks.
          content = msg.content || "(empty)";
        } else {
          const parts = (msg.content as OcxContentPart[])
            .map(toAnthropicContentPart)
            .filter(p => !((p as { type?: string }).type === "text" && !(p as { text?: string }).text));
          content = parts.length > 0 ? parts : "(empty)";
        }
        messages.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const aMsg = msg as OcxAssistantMessage;
        const content: unknown[] = [];
        const toolUseIds: string[] = [];
        for (const part of aMsg.content) {
          if (part.type === "text") {
            const text = (part as OcxTextContent).text;
            if (text) content.push({ type: "text", text });
          } else if (part.type === "thinking") {
            const t = part as OcxThinkingContent;
            // Redacted blocks replay verbatim FIRST (they preceded the visible thinking block
            // in the original stream order preserved by the bridge envelope).
            for (const data of t.redacted ?? []) {
              content.push({ type: "redacted_thinking", data });
            }
            if (isLikelyRealAnthropicThinkingSignature(t.signature)) {
              content.push({ type: "thinking", thinking: t.thinking, signature: t.signature });
            }
          } else if (part.type === "toolCall") {
            const tc = part as OcxToolCall;
            const flatName = namespacedToolName(tc.namespace, tc.name);
            toolUseIds.push(tc.id);
            content.push({ type: "tool_use", id: tc.id, name: toolNames.toWire(flatName), input: tc.arguments });
          }
        }
        if (content.length === 0) break;
        messages.push({ role: "assistant", content });
        if (toolUseIds.length > 0) {
          const requiredIds = new Set(toolUseIds);
          const resultBlocks: Record<string, unknown>[] = [];
          const orphanBlocks: Record<string, unknown>[] = [];
          const seen = new Set<string>();
          let j = i + 1;
          while (j < parsed.context.messages.length && parsed.context.messages[j].role === "toolResult") {
            const tr = parsed.context.messages[j] as OcxToolResultMessage;
            if (requiredIds.has(tr.toolCallId) && !seen.has(tr.toolCallId)) {
              resultBlocks.push(toAnthropicToolResult(tr));
              seen.add(tr.toolCallId);
            } else {
              orphanBlocks.push({ type: "text", text: orphanToolResultText(tr) });
            }
            j++;
          }
          for (const id of toolUseIds) {
            if (!seen.has(id)) {
              resultBlocks.push({
                type: "tool_result",
                tool_use_id: id,
                content: "[missing tool_result for this tool_use in history]",
                is_error: true,
              });
            }
          }
          messages.push({ role: "user", content: [...resultBlocks, ...orphanBlocks] });
          i = j - 1;
        }
        break;
      }
      case "toolResult": {
        // A standalone Anthropic tool_result is invalid unless it immediately follows an
        // assistant tool_use. Preserve the information as text instead of sending a 400-prone block.
        messages.push({ role: "user", content: orphanToolResultText(msg as OcxToolResultMessage) });
        break;
      }
    }
  }

  // Newer Anthropic models reject assistant-tail histories as prefill:
  // "This model does not support assistant message prefill. The conversation must end with a user message."
  // previous_response_id expansion with empty new input, interrupted-turn replay, and web-search sidecar
  // first iterations can all reach this; Kiro uses the same "(continue)" nudge precedent (src/adapters/kiro.ts:283).
  if (messages.length === 0) {
    messages.push({ role: "user", content: "(continue)" });
  } else if ((messages[messages.length - 1] as { role?: string }).role === "assistant") {
    messages.push({ role: "user", content: "(continue)" });
  }

  return { system, messages };
}

function toolsToAnthropicFormat(parsed: OcxParsedRequest, toolNames: { toWire: (name: string) => string }): unknown[] | undefined {
  if (!parsed.context.tools || parsed.context.tools.length === 0) return undefined;
  const allowed = isAllowedToolChoice(parsed.options.toolChoice)
    ? new Set(parsed.options.toolChoice.allowedTools)
    : undefined;
  const tools = allowed
    ? parsed.context.tools.filter(t => toolAllowedByChoice(t, allowed))
    : parsed.context.tools;
  if (tools.length === 0) return undefined;
  const converted = tools.map(t => ({
    name: toolNames.toWire(namespacedToolName(t.namespace, t.name)),
    description: t.description,
    input_schema: normalizeAnthropicInputSchema(t.parameters),
  }));
  return converted;
}

// Codex multi-agent v2 stamps a Responses-only `encrypted: true` marker on
// collaboration tool schemas (openai/codex 5f4d06ef; issue #85). It is an
// annotation for the ChatGPT backend only. Anthropic input_schema is strict
// JSON Schema; strip the marker defensively everywhere it can appear as a
// schema keyword, while preserving properties literally named "encrypted".
const ENCRYPTED_MARKER_NAME_BAG_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const ENCRYPTED_MARKER_LITERAL_VALUE_KEYS = new Set(["const", "default", "enum", "examples"]);

function stripEncryptedMarker(node: unknown, inNameBag = false): unknown {
  if (Array.isArray(node)) return node.map(item => stripEncryptedMarker(item));
  if (!node || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (inNameBag) {
      out[key] = stripEncryptedMarker(value);
    } else if (key !== "encrypted") {
      out[key] = ENCRYPTED_MARKER_LITERAL_VALUE_KEYS.has(key)
        ? value
        : stripEncryptedMarker(value, ENCRYPTED_MARKER_NAME_BAG_KEYS.has(key));
    }
  }

  return out;
}

function normalizeAnthropicInputSchema(schema: unknown): Record<string, unknown> {
  const stripped = stripEncryptedMarker(schema);
  const obj = stripped && typeof stripped === "object" && !Array.isArray(stripped)
    ? stripped as Record<string, unknown>
    : {};
  // Anthropic rejects root-level missing type and oneOf/anyOf/allOf in input_schema.
  // Normalize the root only: ensure type:"object" + properties, flatten root composition
  // while preserving nested schemas. Mirrors kiro-tools.ts ensureRootObjectType.
  // Known limitation: Object.assign on branch properties means later branches overwrite
  // earlier ones when the same property name appears with different schemas.
  const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
  const hasRootComposition = compositionKeys.some(key => Array.isArray(obj[key]));
  const type = obj.type;
  const rootObjectType = type === "object" || (Array.isArray(type) && type.includes("object"));

  if (!hasRootComposition) {
    const normalized: Record<string, unknown> = rootObjectType && type === "object"
      ? { ...obj }
      : { ...obj, type: "object" };
    if (normalized.properties === undefined || normalized.properties === null) {
      normalized.properties = {};
    }
    return normalized;
  }

  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    Object.assign(properties, obj.properties as Record<string, unknown>);
  }
  if (Array.isArray(obj.required)) {
    for (const item of obj.required) if (typeof item === "string") required.add(item);
  }

  for (const key of compositionKeys) {
    const variants = obj[key];
    if (!Array.isArray(variants)) continue;
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const v = variant as Record<string, unknown>;
      if (v.properties && typeof v.properties === "object" && !Array.isArray(v.properties)) {
        Object.assign(properties, v.properties as Record<string, unknown>);
      }
      if (mergeRequired && Array.isArray(v.required)) {
        for (const item of v.required) if (typeof item === "string") required.add(item);
      }
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") continue;
    if (key === "type" || key === "properties" || key === "required") continue;
    normalized[key] = value;
  }
  normalized.type = "object";
  normalized.properties = properties;
  if (required.size > 0) normalized.required = [...required];
  return normalized;
}

export function createAnthropicAdapter(provider: OcxProviderConfig, cacheRetention?: "none" | "short" | "long"): ProviderAdapter {
  const isOAuth = provider.authMode === "oauth";
  const toolNames = buildToolNameTransforms(provider);
  return {
    name: "anthropic",

    async buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta) {
      if (typeof provider.apiKey !== "string" || provider.apiKey.trim() === "") {
        if (isOAuth) {
          throw new Error("anthropic oauth token missing — run ocx login anthropic");
        }
        throw new Error("anthropic provider requires a non-empty apiKey (authMode: key)");
      }

      const { system, messages } = messagesToAnthropicFormat(parsed, toolNames);
      // Primary image layer: resize/re-encode to fit Anthropic limits without dropping
      // (anthropic-image-normalize.ts); the guard below remains the deterministic backstop.
      // imageTierBias > 0 = upstream-413 tightened retry (030): start every image one tier lower.
      await normalizeAnthropicImages(messages, { tierBias: incoming?.imageTierBias ?? 0 });
      // Anthropic rejects many-image requests (>20 images) carrying any image over
      // 2000px per side; see anthropic-image-guard.ts for the full limit policy.
      enforceAnthropicImageLimits(messages);
      const tools = toolsToAnthropicFormat(parsed, toolNames);

      const body: Record<string, unknown> = {
        model: parsed.modelId,
        messages,
        stream: parsed.stream,
        max_tokens: parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (isOAuth) {
        // Claude OAuth (Pro/Max) requires the first system block to be the Claude Code identity.
        body.system = [
          { type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION },
          ...(system ? [{ type: "text", text: system }] : []),
        ];
      } else if (system) {
        body.system = [{ type: "text", text: system }];
      }
      if (tools) body.tools = tools;
      if (parsed.options.temperature !== undefined) body.temperature = parsed.options.temperature;
      if (parsed.options.topP !== undefined) body.top_p = parsed.options.topP;
      if (parsed.options.stopSequences) body.stop_sequences = parsed.options.stopSequences;

      // `reasoning` is a Codex effort string; "none" is the disable sentinel (see parser.ts
      // REASONING_EFFORTS). A bare truthy check would treat "none" as truthy and wrongly enable
      // extended thinking (and strip temperature/top_p), so gate on a real, non-disable effort.
      if (typeof parsed.options.reasoning === "string" && parsed.options.reasoning !== "none") {
        if (usesAdaptiveThinking(parsed.modelId)) {
          // Adaptive-thinking models replace the token budget with an effort knob and reject
          // `thinking.type: "enabled"` outright. `max_tokens` still caps thinking plus visible
          // output, so high effort needs the same total-token headroom as budget thinking or a
          // default 8192-token request can spend everything on thought and return empty text.
          body.thinking = { type: "adaptive" };
          body.output_config = { effort: adaptiveEffort(parsed.options.reasoning) };
          const explicitMaxOut = parsed.options.maxOutputTokens;
          const wantBudget = reasoningBudget(parsed.options.reasoning);
          const floor = wantBudget + OUTPUT_HEADROOM;
          // Preserve explicit caller limits as-is; for omitted limits use the adaptive ceiling
          // so effort=max (budget=32k) still leaves OUTPUT_HEADROOM tokens for visible output.
          body.max_tokens = explicitMaxOut !== undefined
            ? explicitMaxOut
            : Math.min(ADAPTIVE_THINKING_CEILING, Math.max(DEFAULT_MAX_TOKENS, floor));
        } else {
          // Anthropic requires max_tokens > thinking.budget_tokens (max_tokens caps thinking +
          // visible output) and budget_tokens >= 1024. Codex sends the SAME value for both, which
          // 400s ("max_tokens must be greater than thinking.budget_tokens"). Size them so max_tokens
          // always exceeds the budget within a model-safe ceiling, reserving room for visible output.
          const maxOut = parsed.options.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
          const wantBudget = reasoningBudget(parsed.options.reasoning);
          const maxTokens = Math.min(REASONING_MAX_TOKENS_CEILING, Math.max(maxOut, wantBudget + OUTPUT_HEADROOM));
          const budget = Math.max(MIN_THINKING_BUDGET, Math.min(wantBudget, maxTokens - OUTPUT_FLOOR));
          body.max_tokens = maxTokens;
          body.thinking = { type: "enabled", budget_tokens: budget };
        }
        // Extended thinking disallows temperature != 1 and top_p — drop both or the API 400s.
        delete body.temperature;
        delete body.top_p;
      }

      if (parsed.options.toolChoice && (tools || parsed.options.toolChoice === "none")) {
        const tc = parsed.options.toolChoice;
        if (tc === "auto") body.tool_choice = { type: "auto" };
        else if (tc === "none") body.tool_choice = { type: "none" };
        else if (tc === "required") body.tool_choice = { type: "any" };
        else if (isAllowedToolChoice(tc)) body.tool_choice = { type: tc.mode === "required" ? "any" : "auto" };
        else if (typeof tc === "object" && "name" in tc) body.tool_choice = { type: "tool", name: toolNames.toWire(resolveToolChoiceWireName(parsed.context.tools, tc.name)) };
      }

      const base = provider.baseUrl.replace(/\/v1\/?$/, "");
      const url = `${base}/v1/messages`;
      const unresolvedPlaceholder = url.match(/\{[^}]*\}/)?.[0];
      if (unresolvedPlaceholder) {
        throw new Error(`anthropic baseUrl contains unresolved ${unresolvedPlaceholder}`);
      }
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "Accept": parsed.stream ? "text/event-stream" : "application/json",
        "User-Agent": "@anthropic-ai/sdk/0.74.0",
      };
      if (isOAuth) {
        headers["Authorization"] = `Bearer ${provider.apiKey}`;
        headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA;
        // Match the real Claude Code CLI request fingerprint: a valid OAuth token with an empty
        // header set is a non-first-party signature. (cch billing-header signing is intentionally
        // out of scope — brittle and version-coupled.)
        Object.assign(headers, CLAUDE_CODE_HEADERS);
        headers["X-Claude-Code-Session-Id"] = claudeCodeSessionId(provider.apiKey);
        headers["x-client-request-id"] = crypto.randomUUID();
      } else {
        headers["x-api-key"] = provider.apiKey;
      }
      if (provider.headers) Object.assign(headers, provider.headers);

      // Prompt caching: native Anthropic supports top-level automatic caching, which
      // follows the moving final block across turns. Keep one breakpoint slot free for it.
      const cc = resolveCacheControl(cacheRetention);
      const automaticPromptCaching = cc && usesNativeAnthropicEndpoint(provider);
      if (automaticPromptCaching) body.cache_control = cc;
      const explicitLimit = automaticPromptCaching ? MAX_CACHE_BREAKPOINTS - 1 : MAX_CACHE_BREAKPOINTS;
      applyPromptCaching(body, cc, {
        maxExplicitBreakpoints: explicitLimit,
        skipLastUser: !!automaticPromptCaching,
      });
      enforceCacheControlLimit(body, explicitLimit);
      normalizeTtlOrdering(body);

      return { url, method: "POST", headers, body: JSON.stringify(body) };
    },

    async *parseStream(response: Response): AsyncGenerator<AdapterEvent> {
      if (!response.body) {
        yield { type: "error", message: "No response body" };
        return;
      }

      let currentBlockType = "";
      let currentToolCallId = "";
      let currentToolCallName = "";
      let pendingUsage: Record<string, number> | undefined;
      let pendingStopReason: string | undefined;
      let emittedDone = false;

      const emitDone = function* (): Generator<AdapterEvent> {
        if (emittedDone) return;
        emittedDone = true;
        yield {
          type: "done",
          usage: usageFromAnthropic(pendingUsage),
          ...(pendingStopReason ? { stopReason: pendingStopReason } : {}),
        };
      };

      for await (const record of decodeServerSentEvents(response.body, { includeComments: true })) {
        if (record.kind === "comment") {
          yield { type: "heartbeat" };
          continue;
        }
        const payload = record.data.trim();
        if (!payload) continue;

        let data: Record<string, unknown>;
        try {
          data = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          debugDroppedFrame("anthropic", payload);
          continue;
        }

        switch (record.event || data.type) {
              case "message_start": {
                const message = data.message as { usage?: Record<string, number> } | undefined;
                pendingUsage = mergeAnthropicUsage(pendingUsage, message?.usage);
                break;
              }
              case "content_block_start": {
                const block = data.content_block as { type: string; id?: string; name?: string; data?: string } | undefined;
                if (!block) break;
                currentBlockType = block.type;
                if (block.type === "tool_use") {
                  currentToolCallId = block.id ?? "";
                  currentToolCallName = toolNames.fromWire(block.name ?? "");
                  yield { type: "tool_call_start", id: currentToolCallId, name: currentToolCallName };
                }
                if (block.type === "redacted_thinking" && typeof block.data === "string") {
                  // Opaque redacted block: replay verbatim later or tool-use turns 400.
                  yield { type: "redacted_thinking", data: block.data };
                }
                break;
              }
              case "content_block_delta": {
                const delta = data.delta as Record<string, unknown> | undefined;
                if (!delta) break;
                if (delta.type === "text_delta" && typeof delta.text === "string") {
                  yield { type: "text_delta", text: delta.text };
                } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
                  yield { type: "thinking_delta", thinking: delta.thinking };
                } else if (delta.type === "reasoning_delta" && typeof delta.reasoning === "string") {
                  // Some Anthropic-compatible reasoning models use `reasoning` names for the
                  // otherwise equivalent thinking block. Preserve it as raw reasoning and keep
                  // later text blocks independent.
                  yield { type: "thinking_delta", thinking: delta.reasoning };
                } else if (delta.type === "signature_delta" && typeof delta.signature === "string" && (currentBlockType === "thinking" || currentBlockType === "reasoning")) {
                  // Arrives once, just before the thinking block's content_block_stop; block-scoped
                  // so a stray signature on a non-thinking block can never be captured.
                  yield { type: "thinking_signature", signature: delta.signature };
                } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                  yield { type: "tool_call_delta", arguments: delta.partial_json };
                }
                break;
              }
              case "content_block_stop": {
                if (currentBlockType === "tool_use") {
                  yield { type: "tool_call_end" };
                  currentToolCallId = "";
                }
                currentBlockType = "";
                break;
              }
              case "message_delta": {
                const usage = data.usage as Record<string, number> | undefined;
                pendingUsage = mergeAnthropicUsage(pendingUsage, usage);
                const delta = data.delta as { stop_reason?: unknown } | undefined;
                if (typeof delta?.stop_reason === "string") pendingStopReason = delta.stop_reason;
                break;
              }
              case "message_stop": {
                yield* emitDone();
                break;
              }
              case "error": {
                const err = data.error as { message?: string } | undefined;
                yield { type: "error", message: err?.message ?? "Anthropic error" };
                return;
              }
        }
      }
      if (!emittedDone) {
        if (pendingStopReason !== undefined) {
          const stopReason = pendingStopReason === "max_tokens"
            ? "max_tokens"
            : pendingStopReason === "refusal" || pendingStopReason === "content_filter"
              ? "content_filter"
              : undefined;
          emittedDone = true;
          yield {
            type: "done",
            usage: usageFromAnthropic(pendingUsage),
            ...(stopReason ? { stopReason } : {}),
          };
        } else {
          yield { type: "error", message: "upstream stream ended before message_stop — possible truncation" };
        }
      }
    },

    async parseResponse(response: Response): Promise<AdapterEvent[]> {
      const json = await response.json() as Record<string, unknown>;
      const events: AdapterEvent[] = [];
      const content = json.content as { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string; reasoning?: string; signature?: string; data?: string }[] | undefined;
      if (content) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            events.push({ type: "text_delta", text: block.text });
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            events.push({ type: "thinking_delta", thinking: block.thinking });
            if (typeof block.signature === "string" && block.signature) {
              events.push({ type: "thinking_signature", signature: block.signature });
            }
          } else if (block.type === "reasoning" && typeof block.reasoning === "string") {
            events.push({ type: "thinking_delta", thinking: block.reasoning });
          } else if (block.type === "redacted_thinking" && typeof block.data === "string") {
            events.push({ type: "redacted_thinking", data: block.data });
          } else if (block.type === "tool_use") {
            events.push({ type: "tool_call_start", id: block.id ?? "", name: toolNames.fromWire(block.name ?? "") });
            events.push({ type: "tool_call_delta", arguments: JSON.stringify(block.input ?? {}) });
            events.push({ type: "tool_call_end" });
          }
        }
      }
      const usage = json.usage as Record<string, number> | undefined;
      const stopReason = typeof json.stop_reason === "string" ? json.stop_reason : undefined;
      events.push({
        type: "done",
        usage: usageFromAnthropic(usage),
        ...(stopReason ? { stopReason } : {}),
      });
      return events;
    },

  };
}
