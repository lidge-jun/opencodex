const BRACED_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const BARE_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

export function resolveProviderHeaderValue(value: string): string | undefined {
  const name = BRACED_REFERENCE.exec(value)?.[1] ?? BARE_REFERENCE.exec(value)?.[1];
  return name === undefined ? value : process.env[name];
}

export function resolveProviderHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const next = resolveProviderHeaderValue(value);
    if (next !== undefined) resolved[name] = next;
  }
  return resolved;
}
