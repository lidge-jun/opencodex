export const MIRASIM_LONG_CONTEXT_BETA = "context-1m-2025-08-07";
export const MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const MIRASIM_CLAUDE_CACHE_BREAKPOINT_LIMIT = 4;

type AnthropicSystemBlock = {
  type: "text";
  text: string;
  [key: string]: unknown;
};

type CacheControl = {
  type: "ephemeral";
  ttl?: "1h" | "5m";
};

function isSystemTextBlock(value: unknown): value is AnthropicSystemBlock {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "text"
    && typeof (value as Record<string, unknown>).text === "string";
}

function normalizedCacheControl(value: unknown): CacheControl | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type !== "ephemeral") return undefined;
  const ttl = record.ttl;
  if (ttl === "1h" || ttl === "5m") return { type: "ephemeral", ttl };
  return { type: "ephemeral" };
}

function preferredMirasimCacheControl(body: Record<string, unknown>): CacheControl {
  const candidates: unknown[] = [];
  const system = body.system;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        candidates.push((block as Record<string, unknown>).cache_control);
      }
    }
  }
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && typeof tool === "object" && !Array.isArray(tool)) {
        candidates.push((tool as Record<string, unknown>).cache_control);
      }
    }
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          candidates.push((block as Record<string, unknown>).cache_control);
        }
      }
    }
  }
  for (const candidate of candidates) {
    const normalized = normalizedCacheControl(candidate);
    if (normalized) return normalized;
  }
  return { type: "ephemeral" };
}

function messageCacheCarriers(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const carriers: Array<Record<string, unknown>> = [];
  const messages = body.messages;
  if (!Array.isArray(messages)) return carriers;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const record = block as Record<string, unknown>;
      if (record.cache_control) carriers.push(record);
      if (record.type !== "tool_result" || !Array.isArray(record.content)) continue;
      for (const nested of record.content) {
        if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
        const nestedRecord = nested as Record<string, unknown>;
        if (nestedRecord.cache_control) carriers.push(nestedRecord);
      }
    }
  }
  return carriers;
}

function systemCacheCarriers(
  body: Record<string, unknown>,
  marker: AnthropicSystemBlock,
): Array<Record<string, unknown>> {
  const system = body.system;
  if (!Array.isArray(system)) return [];
  return system
    .filter((block): block is Record<string, unknown> =>
      !!block && typeof block === "object" && !Array.isArray(block) && block !== marker
      && !!(block as Record<string, unknown>).cache_control)
    .map(block => block as Record<string, unknown>);
}

function toolCacheCarriers(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is Record<string, unknown> =>
      !!tool && typeof tool === "object" && !Array.isArray(tool)
      && !!(tool as Record<string, unknown>).cache_control)
    .map(tool => tool as Record<string, unknown>);
}

function countMirasimCacheBreakpoints(
  body: Record<string, unknown>,
  marker: AnthropicSystemBlock,
): number {
  return 1
    + messageCacheCarriers(body).length
    + systemCacheCarriers(body, marker).length
    + toolCacheCarriers(body).length;
}

function enforceMirasimClaudeCacheBreakpointLimit(
  body: Record<string, unknown>,
  marker: AnthropicSystemBlock,
): void {
  let excess = countMirasimCacheBreakpoints(body, marker) - MIRASIM_CLAUDE_CACHE_BREAKPOINT_LIMIT;
  if (excess <= 0) return;

  // The relay normalizes the Claude Agent marker itself. Keep that marker cacheable and shed
  // the oldest message breakpoints first, preserving the newest conversation prefix. Only if a
  // caller already supplied more than four stable breakpoints do we fall back to non-marker
  // system blocks and finally tools.
  for (const carrier of messageCacheCarriers(body)) {
    if (excess <= 0) return;
    delete carrier.cache_control;
    excess--;
  }
  for (const carrier of systemCacheCarriers(body, marker)) {
    if (excess <= 0) return;
    delete carrier.cache_control;
    excess--;
  }
  for (const carrier of toolCacheCarriers(body)) {
    if (excess <= 0) return;
    delete carrier.cache_control;
    excess--;
  }
}

/**
 * Mirasim's Claude relay rejects otherwise-valid generic Messages requests unless the system
 * prompt identifies the request as a Claude Agent SDK turn. Keep that provider-specific contract
 * at the Mirasim boundary instead of contaminating the shared Anthropic serializer.
 *
 * Preserve the caller's system prompt byte-for-byte as its own block and prepend only the minimum
 * marker accepted by the relay. Do not spoof Claude Code billing/version headers.
 */
export function ensureMirasimClaudeAgentSystemMarker(body: Record<string, unknown>): void {
  const cacheControl = preferredMirasimCacheControl(body);
  const current = body.system;
  if (typeof current === "string") {
    const marker: AnthropicSystemBlock = {
      type: "text",
      text: MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
      cache_control: cacheControl,
    };
    body.system = current === MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER
      ? [marker]
      : [marker, { type: "text", text: current }];
    enforceMirasimClaudeCacheBreakpointLimit(body, marker);
    return;
  }

  if (Array.isArray(current)) {
    const existing = current.find(
      block => isSystemTextBlock(block) && block.text === MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
    );
    let marker: AnthropicSystemBlock;
    if (isSystemTextBlock(existing)) {
      marker = existing;
      marker.cache_control = normalizedCacheControl(marker.cache_control) ?? cacheControl;
    } else {
      marker = {
        type: "text",
        text: MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
        cache_control: cacheControl,
      };
      body.system = [
        marker,
        ...current,
      ];
    }
    enforceMirasimClaudeCacheBreakpointLimit(body, marker);
    return;
  }

  const marker: AnthropicSystemBlock = {
    type: "text",
    text: MIRASIM_CLAUDE_AGENT_SYSTEM_MARKER,
    cache_control: cacheControl,
  };
  body.system = [marker];
}

function safeBetaValue(value: string | null | undefined): string | undefined {
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value)) return undefined;
  return value;
}

export function mirasimAnthropicBetaValue(
  values: readonly (string | null | undefined)[],
  longContext: boolean,
): string | undefined {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const sources = [
    ...values.map(safeBetaValue).filter((value): value is string => value !== undefined),
    ...(longContext ? [MIRASIM_LONG_CONTEXT_BETA] : []),
  ];
  for (const value of sources) {
    for (const token of value.split(",")) {
      const clean = token.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      tokens.push(clean);
    }
  }
  return tokens.length > 0 ? tokens.join(",") : undefined;
}

export function mergeMirasimAnthropicBetaHeaders(
  requestHeaders: Record<string, string>,
  incoming: Headers | undefined,
  longContext: boolean,
): void {
  const values: string[] = [];
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (name.toLowerCase() !== "anthropic-beta") continue;
    values.push(value);
    delete requestHeaders[name];
  }
  values.push(incoming?.get("anthropic-beta") ?? "");
  const merged = mirasimAnthropicBetaValue(values, longContext);
  if (merged) requestHeaders["anthropic-beta"] = merged;
}
