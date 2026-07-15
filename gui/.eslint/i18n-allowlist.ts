/**
 * Literals that may stay hardcoded in UI/data code.
 * - Brand/product names (proper nouns)
 * - Model identifiers (technical ids from providers/APIs)
 * - Shell/code/CLI/header/unit fragments (not user-facing copy)
 */

const BRAND_LITERALS = new Set([
  "OpenAI",
  "Anthropic",
  "GitHub",
  "Codex",
  "OpenRouter",
  "Ollama",
  "xAI",
  "Grok",
  "Google",
  "Azure",
  "DeepSeek",
  "Kimi",
  "Moonshot",
  "Cursor",
  "OpenCode",
  "Xiaomi",
  "Mimo",
  "Claude",
  "ChatGPT",
  "OpenCodex",
  "opencodex",
  "OAuth",
  "API",
]);

const BRAND_LITERALS_LOWER = new Set(
  [...BRAND_LITERALS].map((name) => name.toLowerCase()),
);

/** Single-token technical units / abbreviations shown next to numbers. */
const TECHNICAL_UNITS = new Set([
  "ms",
  "k",
  "1M",
  "c",
  "w",
  "v",
  "Mo",
  "Mi",
  "Fr",
]);

/** Non-UI technical strings (API paths, CSS, shell, headers, debug fields). */
export function isTechnicalLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;

  // Version prefix / unit tokens
  if (TECHNICAL_UNITS.has(trimmed)) return true;

  // Absolute/relative URLs and localhost endpoints
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^https?:\/\/[^\s]+$/i.test(trimmed)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/i.test(trimmed)) return true;

  // Paths / query fragments
  if (trimmed.startsWith("/") && /^\/[\w./?=&%-]+$/.test(trimmed)) return true;
  if (/^[?&][a-zA-Z_][\w-]*=$/.test(trimmed)) return true;

  // CSS / style functions
  if (
    /^(var\(--|calc\(|repeat\(|hsl\(|url\(|linear-gradient\()/i.test(trimmed)
  ) {
    return true;
  }

  // Dotted identifiers (package.paths, header-ish ids)
  if (/^[\w-]+(\.[\w-]+)+$/i.test(trimmed)) return true;

  // Shell: export VAR=… / export VAR fragments
  if (/^export\b/i.test(trimmed)) return true;
  if (/^[A-Z][A-Z0-9_]+=/.test(trimmed)) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(trimmed) && trimmed.includes("_")) return true;

  // Shell comments
  if (trimmed.startsWith("#")) return true;

  // curl / CLI samples and fragments
  if (/^curl\b/i.test(trimmed)) return true;
  if (/^-H\b/.test(trimmed)) return true;
  if (/^-d\b/.test(trimmed)) return true;
  if (/^ocx\b/i.test(trimmed)) return true;
  if (/^codex\b/i.test(trimmed)) return true;

  // HTTP headers / auth schemes
  if (/^Authorization\b/i.test(trimmed)) return true;
  if (/^Bearer\b/i.test(trimmed)) return true;
  if (/^Content-Type\b/i.test(trimmed)) return true;
  if (/^x-[\w-]+$/i.test(trimmed)) return true;

  // Debug/tooling field dumps: model=…, resolved=, supportsTier=true
  if (/^[a-zA-Z_][\w]*=/.test(trimmed)) return true;

  // JSON-ish snippets in examples
  if (/^[{[]/.test(trimmed) || /[}\]]$/.test(trimmed)) return true;
  if (/^"(model|input|type|name)":/.test(trimmed)) return true;

  // Adapter / auth-mode technical badges
  if (
    /^(oauth|passthrough|forward|local|key|openai-chat|openai-responses|anthropic|google|azure-openai|cursor)$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  // Channel / npm channel ids
  if (/^(latest|preview)$/i.test(trimmed)) return true;

  // API field column labels (debug tables) — protocol keys, not prose
  if (
    /^(thinking|effort|beta|metadata|system|model|resolved|requestedTier|configuredTier|responseTier|supportsTier)$/i.test(
      trimmed,
    )
  ) {
    return true;
  }

  return false;
}

/** Model/catalog ids: gpt-4o, claude-3-5-sonnet, deepseek-v4-flash-free, provider/model */
export function isModelIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (!/^[a-z0-9][a-z0-9._\-/+:]*$/i.test(trimmed)) return false;
  return (
    /[a-z]/i.test(trimmed) &&
    (/\d/.test(trimmed) ||
      /[-_/]/.test(trimmed) ||
      /^gpt/i.test(trimmed) ||
      /^claude/i.test(trimmed))
  );
}

export function isBrandOrModelLiteral(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (
    BRAND_LITERALS.has(trimmed) ||
    BRAND_LITERALS_LOWER.has(trimmed.toLowerCase())
  ) {
    return true;
  }
  if (isModelIdentifier(trimmed)) return true;
  return false;
}
