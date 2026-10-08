import { runCatalogAction } from "./catalog-command-result";
import { serializeManagementJson } from "./json-input";
import { printSettingsResult, projectSettingsApply } from "./settings-result";
import { CliUsageError, runtimeBaseUrl, runtimeRequest, takeFlag, takeOptionWithSyntax, type RuntimeApiDeps } from "./runtime-api";

export const SYSTEM_PARITY_OPTIONS = ["--show-codex-credits", "--account-picker", "--main-account-hard-lock", "--ultra-fast-tier", "--fast-rows"] as const;
const BOOLEAN_FIELDS: Readonly<Record<string, string>> = {
  "--show-codex-credits": "showCodexCredits", "--account-picker": "codexAccountPickerEnabled",
  "--main-account-hard-lock": "codexMainAccountHardLock", "--ultra-fast-tier": "ultraFastTier", "--fast-rows": "fastRows",
  "--auto-start": "codexAutoStart", "--desktop-authless": "codexDesktopAuthless", "--client-compaction": "codexClientCompaction",
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function boolean(raw: string, option: string): boolean {
  if (["on", "true", "yes", "1", "enabled"].includes(raw.toLowerCase())) return true;
  if (["off", "false", "no", "0", "disabled"].includes(raw.toLowerCase())) return false;
  throw new CliUsageError(`${option} must be on or off`);
}
function desktopState(value: unknown): Record<string, unknown> | null {
  if (!record(value) || typeof value.stored !== "boolean" || (value.effective !== null && typeof value.effective !== "boolean")
    || (value.inertReason !== undefined && value.inertReason !== "client_role" && value.inertReason !== "non_loopback_bind_requires_admission_token")) return null;
  return { stored: value.stored, effective: value.effective, ...(value.inertReason ? { inertReason: value.inertReason } : {}) };
}

/** New-option writes; the original no-new-option settings output remains compatible. */
export async function handleSystemSettingsParity(argsInput: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argsInput], wantsJson = takeFlag(args, "--json");
    const body: Record<string, unknown> = {};
    for (const [option, field] of Object.entries(BOOLEAN_FIELDS)) {
      const value = takeOptionWithSyntax(args, option)?.value;
      if (value !== undefined) body[field] = boolean(value, option);
    }
    const mode = takeOptionWithSyntax(args, "--stream-mode")?.value;
    if (mode !== undefined) {
      if (!["auto", "legacy-tee", "eager-relay"].includes(mode)) throw new CliUsageError("Invalid --stream-mode");
      body.streamMode = mode;
    }
    if (args.length || !Object.keys(body).length) throw new CliUsageError("Provide supported system setting options and optional --json");
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    const response = await runtimeRequest("/api/settings", { method: "PUT", redirect: "error", body: serializeManagementJson(body) }, pinned);
    if (!record(response) || response.ok !== true) throw new Error("Invalid settings receipt");
    const observed: Record<string, unknown> = {};
    const unverified: string[] = [];
    for (const [key, requested] of Object.entries(body)) {
      if (key === "ultraFastTier") continue;
      const actual = response[key];
      if (typeof actual === typeof requested && (key !== "streamMode" || ["auto", "legacy-tee", "eager-relay"].includes(actual as string))) observed[key] = actual;
      if (actual !== requested) unverified.push(key);
    }
    if (Object.hasOwn(body, "ultraFastTier")) {
      try {
        const readBack = await runtimeRequest("/api/settings", { redirect: "error" }, pinned);
        if (record(readBack) && typeof readBack.ultraFastTier === "boolean") observed.ultraFastTier = readBack.ultraFastTier;
      } catch { /* Acceptance already happened; retain safe unknown verification, not raw error. */ }
      if (observed.ultraFastTier !== body.ultraFastTier) unverified.push("ultraFastTier");
    }
    const data: Record<string, unknown> = { ok: true, settings: observed };
    let nativePending = false;
    if (Object.hasOwn(body, "codexDesktopAuthless") || Object.hasOwn(body, "codexClientCompaction")) {
      const switches = record(response.codexDesktopSwitches) ? response.codexDesktopSwitches : {};
      const report: Record<string, unknown> = {};
      for (const key of ["codexDesktopAuthless", "codexClientCompaction"]) {
        if (!Object.hasOwn(body, key)) continue;
        const state = desktopState(switches[key]);
        if (state) report[key] = state; else unverified.push(`${key}.effective`);
      }
      const apply = projectSettingsApply(switches.apply);
      if (apply) {
        report.apply = apply;
        nativePending = !apply.applied && apply.reason !== "not_requested";
      } else unverified.push("desktopApply");
      data.desktop = report;
    }
    if (unverified.length) { data.verification = "unverified"; data.unverifiedFields = unverified; }
    const lines = ["System settings accepted.", ...Object.entries(observed).map(([key, value]) => `${key}: ${value}`)];
    if (unverified.length) lines.push(`Read-back is unverified for: ${unverified.join(", ")}.`);
    if (nativePending) lines.push("Native client application is deferred or refused; the settings remain saved.");
    const pendingCode = printSettingsResult(data, response.catalogRefreshPending, wantsJson, lines);
    return unverified.length || nativePending ? 1 : pendingCode;
  });
}
