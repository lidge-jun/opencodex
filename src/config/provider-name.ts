export const ANTHROPIC_NATIVE_PROVIDER_ID = "anthropic-native";

const RESERVED_PROVIDER_NAMES = new Set([
  // JavaScript prototype-pollution guards.
  "__proto__",
  "prototype",
  "constructor",
  // System-reserved routing namespace (resolved before provider/account
  // namespaces in routeModelInternal). "combo" is intentionally NOT reserved:
  // a physical provider named `combo` is a supported pattern (combo aliases
  // hosted on the combo provider), and the combo selector only wins when an
  // actual combo id matches.
  "policy",
  // Guardrails uses this stable synthetic ID for the native Anthropic
  // Messages path, which must remain distinct from configured providers.
  ANTHROPIC_NATIVE_PROVIDER_ID,
]);
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export function isValidProviderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === name
    && PROVIDER_NAME_PATTERN.test(name)
    && !RESERVED_PROVIDER_NAMES.has(name.toLowerCase());
}

export function isValidGuardrailsProviderId(name: string): boolean {
  return name === ANTHROPIC_NATIVE_PROVIDER_ID || isValidProviderName(name);
}

export function hasOwnProvider(providers: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(providers, name);
}
