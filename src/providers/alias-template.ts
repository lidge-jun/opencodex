/**
 * Opt-in per-provider alias templates (#7705). Pure: no config reads or writes, no expression
 * evaluation. A template is literal text plus the two placeholders `{providerAlias}` and
 * `{modelBasename}`; anything else in braces makes the template invalid. The basename is required,
 * because a template without it would give every model of the provider the same name.
 */
/** Defined here so default-aliases can import this module without a cycle; it re-exports it. */
export const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const KNOWN = new Set(["providerAlias", "modelBasename"]);
/** The same reserved prefixes the config loader refuses for manual model aliases. */
export const RESERVED_ALIAS_PREFIX = /^(?:gpt-|o1-|o3-|o4-|codex-)/i;
export const MAX_ALIAS_TEMPLATE_LENGTH = 128;

export type AliasTemplateSkip = "no_provider_alias" | "invalid_alias" | "reserved_prefix";

/** Null for a usable template, otherwise a short reason fit for an API error. */
export function aliasTemplateError(template: string): string | null {
  if (typeof template !== "string" || !template.trim()) return "template must be a non-empty string";
  if (template.length > MAX_ALIAS_TEMPLATE_LENGTH) return `template must be at most ${MAX_ALIAS_TEMPLATE_LENGTH} characters`;
  const stripped = template.replace(PLACEHOLDER, "");
  if (/[{}]/.test(stripped)) return "template has an unbalanced or nested brace";
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (!KNOWN.has(match[1]!)) return `unknown placeholder {${match[1]}}; use {providerAlias} and {modelBasename}`;
  }
  if (!template.includes("{modelBasename}")) return "template must include {modelBasename}";
  return null;
}

/** Final `/` segment of a model id, with `:` written as `-` (`a/b/beam:free` -> `beam-free`). */
export function modelBasename(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).replaceAll(":", "-");
}

/** One model's candidate, or why it has none. Assumes a template `aliasTemplateError` accepted. */
export function expandAliasTemplate(
  template: string,
  providerAlias: string | undefined,
  id: string,
): { alias: string } | { skip: AliasTemplateSkip } {
  if (template.includes("{providerAlias}") && !providerAlias) return { skip: "no_provider_alias" };
  const alias = template.replace(PLACEHOLDER, (_whole, name: string) =>
    name === "providerAlias" ? providerAlias ?? "" : modelBasename(id));
  if (!MODEL_ALIAS_PATTERN.test(alias)) return { skip: "invalid_alias" };
  if (RESERVED_ALIAS_PREFIX.test(alias)) return { skip: "reserved_prefix" };
  return { alias };
}
