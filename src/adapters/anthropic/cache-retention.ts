import { credentialDomainFor } from "../../protocols/opaque-state";
import type { OcxProviderConfig } from "../../types";

export type AnthropicCacheRetention = "none" | "short" | "long";

/**
 * The retention an omitted `cacheRetention` resolves to for one destination.
 *
 * First-party Anthropic (API key or OAuth pool) defaults to the 1-hour TTL: agentic turns often
 * pause longer than five minutes, a 5-minute entry then expires and the next turn rewrites the
 * whole prefix, and the 1h write (2x base input vs 1.25x) pays for itself on a single reuse.
 * Anthropic-compatible endpoints (gateways, vendor /anthropic surfaces) keep the 5-minute
 * default: none of them documents ttl "1h", and an unknown TTL is either rejected or billed on
 * terms we cannot see. An explicit cacheRetention "long" still sends 1h anywhere.
 */
export function defaultAnthropicCacheRetention(provider: Pick<OcxProviderConfig, "baseUrl" | "authMode">): "short" | "long" {
  return credentialDomainFor(provider)?.firstPartyAnthropic ? "long" : "short";
}

/** Explicit configuration always wins; otherwise the destination default applies. */
export function resolveAnthropicCacheRetention(
  retention: AnthropicCacheRetention | undefined,
  provider: Pick<OcxProviderConfig, "baseUrl" | "authMode">,
): AnthropicCacheRetention {
  return retention ?? defaultAnthropicCacheRetention(provider);
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The 1-hour share of a reported cache write, from Anthropic's `usage.cache_creation` split
 * (`ephemeral_1h_input_tokens`). Undefined when the split is absent or malformed, which prices
 * the whole write at the 5-minute tier as before; clamped to the reported write total.
 */
export function anthropicCacheWrite1hTokens(usage: Rec, write: number): number | undefined {
  const split = usage.cache_creation;
  if (!isRec(split)) return undefined;
  const value = split.ephemeral_1h_input_tokens;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, write);
}
const MAX_DEPTH = 16;
/** Tool inputs, schemas and examples are caller data, not blocks: a cache_control key there is no breakpoint. */
const isDataKey = (key: string): boolean => key === "cache_control" || key === "input" || key === "input_schema"
  || key === "input_examples";

/**
 * Every caller cache_control breakpoint TTL in a Messages body: top-level automatic caching plus
 * blocks in system, tools and messages, including nested containers (tool_result,
 * search_result, document sources).
 */
export function collectAnthropicCacheTtls(body: unknown): unknown[] {
  if (!isRec(body)) return [];
  const ttls: unknown[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!isRec(node)) return;
    if (isRec(node.cache_control)) ttls.push(node.cache_control.ttl);
    for (const [key, value] of Object.entries(node)) {
      if (!isDataKey(key) && (Array.isArray(value) || isRec(value))) visit(value, depth + 1);
    }
  };
  if (isRec(body.cache_control)) ttls.push(body.cache_control.ttl);
  visit(body.system, 0);
  visit(body.tools, 0);
  visit(body.messages, 0);
  return ttls;
}

/**
 * Native Messages passthrough: give the caller's TTL-less breakpoints the 1-hour default.
 *
 * Applies only when the resolved retention is "long". A caller that pinned any breakpoint to a
 * TTL other than 1h ("5m") chose its own scheme and the body is returned untouched; upgrading
 * only its unset breakpoints could also put a 1h entry after a 5m one, which Anthropic rejects.
 * With no explicit non-1h TTL every breakpoint ends up 1h, so ordering stays valid. The body is
 * copied on write: the caller's object graph is never mutated.
 */
export function applyAnthropicNativeCacheTtlDefault(body: Rec, retention: AnthropicCacheRetention): Rec {
  if (retention !== "long") return body;
  const ttls = collectAnthropicCacheTtls(body);
  if (!ttls.includes(undefined)) return body;
  if (ttls.some(ttl => ttl !== undefined && ttl !== "1h")) return body;
  const upgrade = (node: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return node;
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map(item => {
        const next = upgrade(item, depth + 1);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : node;
    }
    if (!isRec(node)) return node;
    let out: Rec | undefined;
    if (isRec(node.cache_control) && node.cache_control.ttl === undefined) {
      out = { ...node, cache_control: { ...node.cache_control, ttl: "1h" } };
    }
    for (const [key, value] of Object.entries(node)) {
      if (isDataKey(key) || !(Array.isArray(value) || isRec(value))) continue;
      const next = upgrade(value, depth + 1);
      if (next !== value) (out ??= { ...node })[key] = next;
    }
    return out ?? node;
  };
  const out: Rec = { ...body };
  if (isRec(body.cache_control) && body.cache_control.ttl === undefined) {
    out.cache_control = { ...body.cache_control, ttl: "1h" };
  }
  for (const key of ["system", "tools", "messages"] as const) {
    if (body[key] !== undefined) out[key] = upgrade(body[key], 0);
  }
  return out;
}
