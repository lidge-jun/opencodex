import { normalizeCatalogDisposition } from "../codex/catalog-refresh-status";
import { CliUsageError, RuntimeApiError, printData, terminalSafeText } from "./runtime-api";

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** A small error/exit boundary; routes and domain DTO validation belong to callers. */
export async function runCatalogAction(
  action: () => Promise<number | void>, knownErrors: Readonly<Record<string, string>> = {},
): Promise<number> {
  try {
    return (await action()) ?? 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      // New domain parsers use static messages instead of raw JSON/validator exceptions.
      console.error(`Error: ${terminalSafeText(error.message)}`);
      if (error.usage) for (const line of error.usage.split("\n")) console.error(terminalSafeText(line));
      return 2;
    }
    if (error instanceof RuntimeApiError) {
      const code = own(error.body, "code") ?? own(own(error.body, "error"), "code");
      const known = typeof code === "string" && Object.hasOwn(knownErrors, code) ? knownErrors[code] : undefined;
      const message = error.status === 404 ? "The requested record or operation was not found on the selected target."
        : error.status === 409 ? "The selected target refused a conflicting change. Read back before trying again."
          : error.status === 503 ? "Management API is unavailable. Use the intended running proxy; connected clients must make management changes on their Hub. A write outcome may be unknown."
            : "The management request failed. Inspect the selected target before retrying; the write outcome may be unknown.";
      console.error(`Error: ${terminalSafeText(known ?? message)}`);
      return error.status === 404 ? 4 : error.status === 409 ? 5 : 1;
    }
    console.error("Error: Management operation did not return a usable outcome. Inspect the selected target before retrying; no rollback is implied.");
    return 1;
  }
}

/**
 * Caller supplies a validated, rebuilt public DTO, not an arbitrary server body.
 * This helper normalizes only the shared catalog disposition and preserves its exit.
 */
export function printCatalogResult(
  data: Record<string, unknown>, refresh: unknown, wantsJson: boolean, lines: readonly string[],
): number {
  const catalogRefresh = normalizeCatalogDisposition(refresh);
  if (catalogRefresh === null) throw new Error("Invalid catalog outcome");
  const converged = catalogRefresh.status === "committed" && !catalogRefresh.degraded;
  const outcome = converged ? "Catalog committed."
    : "Change saved, but catalog convergence is incomplete. Read back before retrying.";
  printData({ ...data, catalogRefresh }, wantsJson, [...lines, outcome]);
  return converged ? 0 : 1;
}
