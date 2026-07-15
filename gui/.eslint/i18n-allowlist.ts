/**
 * Literals that may stay hardcoded in UI/data code.
 * - Brand/product names (proper nouns)
 * - Model identifiers (technical ids from providers/APIs)
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
  "OAuth",
  "API",
]);

const BRAND_LITERALS_LOWER = new Set(
  [...BRAND_LITERALS].map((name) => name.toLowerCase()),
);

/** Non-UI technical strings (API paths, CSS fragments, dotted key fragments). */
export function isTechnicalLiteral(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/") && /^\/[\w./?=&%-]+$/.test(trimmed)) return true;
  if (/^(var\(--|calc\(|repeat\(|hsl\(|url\(|linear-gradient\()/i.test(trimmed)) return true;
  if (/^[\w-]+(\.[\w-]+)+$/i.test(trimmed)) return true;
  return false;
}

/** Model/catalog ids: gpt-4o, claude-3-5-sonnet, deepseek-v4-flash-free, provider/model */
export function isModelIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (!/^[a-z0-9][a-z0-9._\-/+:]*$/i.test(trimmed)) return false;
  return /[a-z]/i.test(trimmed) && (/\d/.test(trimmed) || /[-_/]/.test(trimmed) || /^gpt/i.test(trimmed) || /^claude/i.test(trimmed));
}

export function isBrandOrModelLiteral(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (BRAND_LITERALS.has(trimmed) || BRAND_LITERALS_LOWER.has(trimmed.toLowerCase())) return true;
  if (isModelIdentifier(trimmed)) return true;
  return false;
}
