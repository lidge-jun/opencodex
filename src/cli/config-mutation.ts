import { readConfigDiagnostics } from "../config/diagnostics";
import type { OcxConfig } from "../types";
import { CliUsageError } from "./runtime-api";

/** Inside admission unless this is a passive preliminary selection read. */
export function readCliConfigForMutation(options: { passive?: boolean } = {}): OcxConfig {
  const diagnostics = readConfigDiagnostics(options);
  if (diagnostics.source === "fallback" || diagnostics.error) {
    throw new CliUsageError("config.json is invalid or unreadable; run ocx config validate and repair it before retrying. Nothing was saved.");
  }
  // Fresh installs retain the full-config commands' existing default initialization.
  return diagnostics.config;
}
