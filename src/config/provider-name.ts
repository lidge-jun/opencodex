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
]);
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

export function isValidProviderName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === name
    && PROVIDER_NAME_PATTERN.test(name)
    && !RESERVED_PROVIDER_NAMES.has(name.toLowerCase());
}

export function hasOwnProvider(providers: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(providers, name);
}
