import { existsSync, readFileSync } from "node:fs";
import { validateConfigCandidate } from "../config";

export interface ConfigPreflightResult {
  ok: boolean;
  reason?: "invalid_json" | "invalid_schema" | "read_error";
  error?: string;
}

export function runConfigPreflight(configPath: string): ConfigPreflightResult {
  if (!existsSync(configPath)) {
    return { ok: true };
  }
  let text = "";
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err: unknown) {
    return {
      ok: false,
      reason: "read_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (err: unknown) {
    return {
      ok: false,
      reason: "invalid_json",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const candidate = validateConfigCandidate(parsed);
  if (!candidate.ok) {
    return {
      ok: false,
      reason: "invalid_schema",
      error: candidate.error,
    };
  }
  return { ok: true };
}
