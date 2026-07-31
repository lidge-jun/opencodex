/**
 * Gateway model-discovery aliases (devlog/260711_claude_inbound/020, 003 G1-G6).
 *
 * Claude Code's /model picker only lists discovery entries whose id literally
 * begins with `claude` or `anthropic`, so routed models are exposed as
 * `claude-ocx-<provider>--<model>` with an honest display_name. Aliases must be
 * deterministic, reversible, and STABLE across releases (picker selections
 * persist to Claude Code's settings.json `model` field).
 *
 * Versioned prefixes:
 *  - `claude-ocx-` (v1) — legacy / plain model ids with no `/` or `~`. Decode
 *    is literal (no escape expansion), so a persisted model id that literally
 *    contained the two-char sequences `~s` / `~t` keeps resolving.
 *  - `claude-ocx2-` (v2) — used whenever the model id needs escape encoding
 *    (`/` → `~s`, `~` → `~t`). Decode expands those escapes. New slash/tilde
 *    models always mint v2 so they cannot collide with v1 literals.
 *
 * Reversibility rules:
 *  - providers containing `--` or `/` are not aliased (split boundary safety);
 *  - model ids MAY contain `/` or `~` — minted under the v2 prefix with escapes
 *    (e.g. openrouter `anthropic/claude-opus-4-8` →
 *    `claude-ocx2-openrouter--anthropic~sclaude-opus-4-8`);
 *  - model ids MAY contain `--` (resolve splits on the FIRST `--` only);
 *  - native OpenAI slugs use the pseudo-provider `native` and resolve back to
 *    the bare slug; a real provider named "native" is therefore never aliased.
 */

import { desktop3pAlias } from "./desktop-3p";

/** Legacy / plain readable prefix (literal model portion on decode). */
export const CLAUDE_ALIAS_PREFIX_V1 = "claude-ocx-";
/** Escape-encoded readable prefix (`~s`/`~t` expanded on decode). */
export const CLAUDE_ALIAS_PREFIX_V2 = "claude-ocx2-";
/**
 * Current write prefix for plain (unescaped) model ids.
 * Escape-needing models mint {@link CLAUDE_ALIAS_PREFIX_V2} instead.
 */
export const CLAUDE_ALIAS_PREFIX = CLAUDE_ALIAS_PREFIX_V1;

/** Encoded `/` inside the model portion of a v2 Claude Code alias. */
const CLAUDE_ALIAS_SLASH_ENC = "~s";
/** Encoded literal `~` inside the model portion of a v2 Claude Code alias. */
const CLAUDE_ALIAS_TILDE_ENC = "~t";
const NATIVE_PSEUDO_PROVIDER = "native";

function modelNeedsEscapeEncoding(modelId: string): boolean {
  return modelId.includes("/") || modelId.includes("~");
}

function encodeModelId(modelId: string): string {
  // Escape literal tildes first so slash encoding cannot create ambiguity.
  return modelId
    .replaceAll("~", CLAUDE_ALIAS_TILDE_ENC)
    .replaceAll("/", CLAUDE_ALIAS_SLASH_ENC);
}

function decodeEscapedModelId(encoded: string): string {
  let out = "";
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "~" && i + 1 < encoded.length) {
      const next = encoded[i + 1];
      if (next === "s") {
        out += "/";
        i += 1;
        continue;
      }
      if (next === "t") {
        out += "~";
        i += 1;
        continue;
      }
    }
    out += encoded[i];
  }
  return out;
}

function splitAlias(id: string, prefix: string): { provider: string; model: string } | null {
  const rest = id.slice(prefix.length);
  const sep = rest.indexOf("--");
  if (sep <= 0) return null;
  const provider = rest.slice(0, sep);
  const model = rest.slice(sep + 2);
  if (!provider || !model) return null;
  return { provider, model };
}

/** Alias for a routed "<provider>/<model>" pair; null when not representable. */
export function aliasForRoute(provider: string, modelId: string): string | null {
  if (!provider || provider.includes("--") || provider.includes("/") || provider === NATIVE_PSEUDO_PROVIDER) return null;
  if (!modelId) return null;
  if (modelNeedsEscapeEncoding(modelId)) {
    return `${CLAUDE_ALIAS_PREFIX_V2}${provider}--${encodeModelId(modelId)}`;
  }
  return `${CLAUDE_ALIAS_PREFIX_V1}${provider}--${modelId}`;
}

/** Alias for a native OpenAI slug (bare model id, no provider namespace). */
export function aliasForNative(slug: string): string | null {
  // Reject "/" — native ids are bare slugs. Literal `~` is fine via v2 + ~t.
  if (!slug || slug.includes("/") || slug.includes("--")) return null;
  if (modelNeedsEscapeEncoding(slug)) {
    return `${CLAUDE_ALIAS_PREFIX_V2}${NATIVE_PSEUDO_PROVIDER}--${encodeModelId(slug)}`;
  }
  return `${CLAUDE_ALIAS_PREFIX_V1}${NATIVE_PSEUDO_PROVIDER}--${slug}`;
}

/**
 * Reverse an alias to the inbound model string routeModel understands:
 * routed -> "<provider>/<model>", native -> bare slug. Null when not an alias.
 */
export function resolveAlias(id: string): string | null {
  // Check v2 before v1 for clarity (prefixes are disjoint: ocx2 vs ocx-).
  if (id.startsWith(CLAUDE_ALIAS_PREFIX_V2)) {
    const parts = splitAlias(id, CLAUDE_ALIAS_PREFIX_V2);
    if (!parts) return null;
    const model = decodeEscapedModelId(parts.model);
    if (!model) return null;
    return parts.provider === NATIVE_PSEUDO_PROVIDER ? model : `${parts.provider}/${model}`;
  }
  if (id.startsWith(CLAUDE_ALIAS_PREFIX_V1)) {
    const parts = splitAlias(id, CLAUDE_ALIAS_PREFIX_V1);
    if (!parts) return null;
    // Literal decode — preserves pre-escape aliases whose model id contained
    // the two-char sequences ~s / ~t.
    return parts.provider === NATIVE_PSEUDO_PROVIDER ? parts.model : `${parts.provider}/${parts.model}`;
  }
  return null;
}

/**
 * Claude Code (CLI) surface alias — devlog 050 + audit 051 #2.
 *
 * The readable `claude-ocx*` form when representable; otherwise the desktop-3p
 * hash so the model still appears in discovery (collisions follow the same
 * first-wins policy as the desktop registry — audit 051 #1). Real Anthropic
 * models pass through unchanged (they must keep hitting the sk-ant passthrough).
 * Both families keep decoding forever in resolveInboundModel, so ids persisted
 * in Claude Code's settings.json never break when the surface style changes.
 */
export function claudeCodeAlias(provider: string, modelId: string): string {
  if (provider === "anthropic" && modelId.startsWith("claude-")) return modelId;
  return aliasForRoute(provider, modelId) ?? desktop3pAlias(provider, modelId);
}

/** Claude Code (CLI) surface alias for a native OpenAI slug. */
export function claudeCodeNativeAlias(slug: string): string {
  return aliasForNative(slug) ?? desktop3pAlias("native", slug);
}
