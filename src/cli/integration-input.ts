/** Input shared by integration preview and journal commands; no writer imports. */
import { CliUsageError, takeOptionWithSyntax } from "./runtime-api";

export function validateAsideProfile(profile: string | undefined, client: string | undefined, usage: string): void {
  if (profile === undefined) return;
  if (client !== "aside") throw new CliUsageError("--profile requires --client aside", usage);
  if (!/^(0|[1-9][0-9]*)$/.test(profile) || !Number.isSafeInteger(Number(profile))) {
    throw new CliUsageError("--profile must be a nonnegative integer account ID", usage);
  }
}

export function clientIntegrationPath(client: string, profile?: string): string {
  const base = `/api/client-integrations/${encodeURIComponent(client)}`;
  return client === "aside" ? `${base}/profiles${profile === undefined ? "" : `/${encodeURIComponent(profile)}`}` : base;
}

export function integrationOption(args: string[], flag: string): string | undefined {
  return takeOptionWithSyntax(args, flag)?.value;
}

export function integrationFlag(args: string[], flag: string): boolean {
  const occurrences = args.filter(arg => arg === flag || arg.startsWith(`${flag}=`));
  if (occurrences.length > 1) throw new CliUsageError(`${flag} was given more than once`);
  if (occurrences.length === 0) return false;
  if (occurrences[0] !== flag) throw new CliUsageError(`${flag} does not take a value`);
  args.splice(args.indexOf(flag), 1);
  return true;
}

export function integrationFingerprint(args: string[]): string | undefined {
  const value = integrationOption(args, "--plan-fingerprint");
  if (value !== undefined && !/^p[0-9]+:[0-9a-f]{32}$/.test(value)) {
    throw new CliUsageError("--plan-fingerprint requires a bound preview token");
  }
  return value;
}

/** Entries replace the map; omission preserves it; explicit clear sends {}. */
export function integrationDroidDefaults(args: string[]): Record<string, string> | undefined {
  const clear = integrationFlag(args, "--clear-reasoning-defaults");
  const entries: Array<[string, string]> = [];
  while (true) {
    const index = args.findIndex(arg => arg === "--reasoning-default" || arg.startsWith("--reasoning-default="));
    if (index < 0) break;
    const token = args[index]!;
    const inline = token.startsWith("--reasoning-default=");
    const raw = inline ? token.slice("--reasoning-default=".length) : args[index + 1];
    if (!raw || (!inline && raw.startsWith("--"))) throw new CliUsageError("--reasoning-default requires MODEL=EFFORT");
    args.splice(index, inline ? 1 : 2);
    const separator = raw.lastIndexOf("=");
    if (separator < 1 || separator === raw.length - 1 || !raw.slice(0, separator).trim() || !raw.slice(separator + 1).trim()) {
      throw new CliUsageError("--reasoning-default requires nonempty MODEL=EFFORT");
    }
    const model = raw.slice(0, separator);
    if (entries.some(([key]) => key === model)) throw new CliUsageError("--reasoning-default contains a duplicate model");
    entries.push([model, raw.slice(separator + 1)]);
  }
  if (clear && entries.length) throw new CliUsageError("--clear-reasoning-defaults cannot be combined with --reasoning-default");
  return clear || entries.length ? Object.fromEntries(entries) : undefined;
}
