/**
 * Global model display-name mapping: prepends a visual icon for recognized model slugs.
 * Used across all GUI surfaces (dropdowns, tables, badges) so the 5.6 trio is instantly
 * distinguishable.
 */

const MODEL_ICONS: Record<string, string> = {
  "gpt-5.6-sol": "\u2600\uFE0F",   // ☀️ sun
  "gpt-5.6-terra": "\uD83C\uDF0D", // 🌍 earth
  "gpt-5.6-luna": "\uD83C\uDF19",  // 🌙 moon
};

/** Return a display label with an icon prefix for recognized slugs, else the raw slug. */
export function modelLabel(slug: string): string {
  // Check bare slug first, then try the tail after a provider prefix (e.g. "openrouter/openai/gpt-5.6-sol").
  const icon = MODEL_ICONS[slug] ?? MODEL_ICONS[slug.slice(slug.lastIndexOf("/") + 1)];
  return icon ? `${icon} ${slug}` : slug;
}

/** Return just the icon for a slug, or empty string if none. */
export function modelIcon(slug: string): string {
  return MODEL_ICONS[slug] ?? MODEL_ICONS[slug.slice(slug.lastIndexOf("/") + 1)] ?? "";
}
