/**
 * Gateway model-discovery aliases (devlog/260711_claude_inbound/020, 003 G1-G6).
 *
 * Claude Code's /model picker accepts discovery ids containing `claude` or
 * `anthropic`. New routed models are exposed as `ocx-claude-<provider>--<model>`
 * with an honest display_name. The id must contain `claude` so the picker keeps
 * it, but must not START with `claude-`: Claude Code 2.1.278 treats an
 * unrecognized `claude-` id as its own model and ignores
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS unless DISABLE_COMPACT=1. Starting with
 * `ocx-claude-` keeps the real window and leaves compact enabled.
 *
 * Persisted ids stay decodable:
 *  - `ocx-claude-` — current plain ids. Decode is literal.
 *  - `claude-ocx-` (v1) — legacy plain ids. Decode stays literal, so a persisted
 *    model id that contained the two-char sequences `~s` / `~t` keeps resolving.
 *  - `claude-ocx2-` (v2) — escape encoding (`/` → `~s`, `~` → `~t`). Decode
 *    expands those escapes. New slash/tilde models still mint v2.
 *
 * Reversibility rules:
 *  - providers containing `--` or `/` are not aliased (split boundary safety);
 *  - model ids MAY contain `/` or `~` — minted under the v2 prefix with escapes
 *    (e.g. openrouter `anthropic/claude-opus-4-8` →
 *    `ocx-claude2-openrouter--anthropic~sclaude-opus-4-8`);
 *  - model ids MAY contain `--` (resolve splits on the FIRST `--` only);
 *  - native OpenAI slugs use the pseudo-provider `native` and resolve back to
 *    the bare slug; a real provider named "native" is therefore never aliased.
 */

import { desktop3pAlias } from "./desktop-3p";

/** Current plain prefix. Contains "claude" but does not start with "claude-". */
export const CLAUDE_ALIAS_PREFIX_CURRENT = "ocx-claude-";
/** Current escape-encoded prefix (`~s`/`~t` expanded on decode). */
export const CLAUDE_ALIAS_PREFIX_CURRENT_V2 = "ocx-claude2-";
/** Legacy plain prefix. Still decoded; no longer minted. */
export const CLAUDE_ALIAS_PREFIX_V1 = "claude-ocx-";
/** Legacy escape-encoded prefix. Still decoded; no longer minted. */
export const CLAUDE_ALIAS_PREFIX_V2 = "claude-ocx2-";
/**
 * Current write prefix for plain (unescaped) model ids.
 * Escape-needing models mint {@link CLAUDE_ALIAS_PREFIX_CURRENT_V2} instead.
 */
export const CLAUDE_ALIAS_PREFIX = CLAUDE_ALIAS_PREFIX_CURRENT;

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
    return `${CLAUDE_ALIAS_PREFIX_CURRENT_V2}${provider}--${encodeModelId(modelId)}`;
  }
  return `${CLAUDE_ALIAS_PREFIX_CURRENT}${provider}--${modelId}`;
}

/**
 * The spelling a release before `ocx-claude-` minted for the same route. Nothing
 * is minted with it any more; it exists so a selector already saved in Claude
 * Code's settings.json keeps its context-window lookup (context-windows.ts).
 */
function toLegacyAlias(alias: string | null): string | null {
  if (!alias) return null;
  if (alias.startsWith(CLAUDE_ALIAS_PREFIX_CURRENT_V2)) return CLAUDE_ALIAS_PREFIX_V2 + alias.slice(CLAUDE_ALIAS_PREFIX_CURRENT_V2.length);
  if (alias.startsWith(CLAUDE_ALIAS_PREFIX_CURRENT)) return CLAUDE_ALIAS_PREFIX_V1 + alias.slice(CLAUDE_ALIAS_PREFIX_CURRENT.length);
  return null;
}

/**
 * The current spelling of a selector that may still use a legacy prefix. Legacy and
 * current prefixes decode to the same route (plain stays literal, v2 expands escapes), so
 * swapping the prefix is safe. Only the prefix changes: a trailing `[1m]` marker survives.
 */
export function currentClaudeAliasSpelling(selector: string): string {
  if (selector.startsWith(CLAUDE_ALIAS_PREFIX_V2)) return CLAUDE_ALIAS_PREFIX_CURRENT_V2 + selector.slice(CLAUDE_ALIAS_PREFIX_V2.length);
  if (selector.startsWith(CLAUDE_ALIAS_PREFIX_V1)) return CLAUDE_ALIAS_PREFIX_CURRENT + selector.slice(CLAUDE_ALIAS_PREFIX_V1.length);
  return selector;
}

/** Legacy `claude-ocx-`/`claude-ocx2-` spelling of {@link aliasForRoute}. */
export function legacyAliasForRoute(provider: string, modelId: string): string | null {
  return toLegacyAlias(aliasForRoute(provider, modelId));
}

/** Legacy `claude-ocx-`/`claude-ocx2-` spelling of {@link aliasForNative}. */
export function legacyAliasForNative(slug: string): string | null {
  return toLegacyAlias(aliasForNative(slug));
}

/** Alias for a native OpenAI slug (bare model id, no provider namespace). */
export function aliasForNative(slug: string): string | null {
  // Reject "/" — native ids are bare slugs. Literal `~` is fine via v2 + ~t.
  if (!slug || slug.includes("/") || slug.includes("--")) return null;
  if (modelNeedsEscapeEncoding(slug)) {
    return `${CLAUDE_ALIAS_PREFIX_CURRENT_V2}${NATIVE_PSEUDO_PROVIDER}--${encodeModelId(slug)}`;
  }
  return `${CLAUDE_ALIAS_PREFIX_CURRENT}${NATIVE_PSEUDO_PROVIDER}--${slug}`;
}

/**
 * Reverse an alias to the inbound model string routeModel understands:
 * routed -> "<provider>/<model>", native -> bare slug. Null when not an alias.
 */
export function resolveAlias(id: string): string | null {
  // Current v2 before legacy v2, then plain prefixes. `ocx-claude2-` and
  // `claude-ocx2-` are disjoint from their plain siblings.
  if (id.startsWith(CLAUDE_ALIAS_PREFIX_CURRENT_V2)) {
    const parts = splitAlias(id, CLAUDE_ALIAS_PREFIX_CURRENT_V2);
    if (!parts) return null;
    const model = decodeEscapedModelId(parts.model);
    if (!model) return null;
    return parts.provider === NATIVE_PSEUDO_PROVIDER ? model : `${parts.provider}/${model}`;
  }
  if (id.startsWith(CLAUDE_ALIAS_PREFIX_V2)) {
    const parts = splitAlias(id, CLAUDE_ALIAS_PREFIX_V2);
    if (!parts) return null;
    const model = decodeEscapedModelId(parts.model);
    if (!model) return null;
    return parts.provider === NATIVE_PSEUDO_PROVIDER ? model : `${parts.provider}/${model}`;
  }
  for (const prefix of [CLAUDE_ALIAS_PREFIX_CURRENT, CLAUDE_ALIAS_PREFIX_V1]) {
    if (!id.startsWith(prefix)) continue;
    const parts = splitAlias(id, prefix);
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
 * The readable `ocx-claude*` form when representable; otherwise the desktop-3p
 * hash so the model still appears in discovery (collisions follow the same
 * first-wins policy as the desktop registry — audit 051 #1). Real Anthropic
 * models pass through unchanged (they must keep hitting the sk-ant passthrough).
 * Old `claude-ocx*` ids keep decoding forever in resolveInboundModel, so ids persisted
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
