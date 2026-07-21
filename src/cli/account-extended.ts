import { loadConfig } from "../config";
import {
  apiError,
  apiJson,
  classifyAccount,
  fetchCodexRows,
  fetchProviderQuotaReport,
  fetchRows,
  proxyUnreachable,
  resolveBaseUrl,
  type AccountDeps, type AccountStdin, type FamilyRows,
  type ProviderQuotaDto, type ProviderQuotaReportDto,
} from "./account-api";

const MAIN_ID = "__main__";
const AUTO_NOTE = "auto (no pin — lowest-usage account is selected per request)";
const EXTENDED_USAGE = `Usage:
  ocx account refresh <provider> [--json]
  ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]
  ocx account remove <provider> <id|main> --yes [--json]
  ocx account add-key <provider> [--label <label>] [--json]`;
const PIPE_GUIDANCE = `Pipe the API key on stdin, for example:
  ocx account add-key <provider> <<< "$MY_KEY"
  security find-generic-password -w <item> | ocx account add-key <provider>`;

function flag(args: string[], value: string): boolean {
  const index = args.indexOf(value);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function flagValue(args: string[], value: string): { found: boolean; value?: string } {
  const index = args.indexOf(value);
  if (index < 0) return { found: false };
  if (index + 1 >= args.length) return { found: true };
  const result = args[index + 1];
  args.splice(index, 2);
  return { found: true, value: result };
}

function usage(message?: string): number {
  if (message) console.error(message);
  console.error(EXTENDED_USAGE);
  return 1;
}

function configAndType(deps: AccountDeps, name: string) {
  return classifyAccount(deps.loadConfigImpl?.() ?? loadConfig(), name);
}

function familyFailure(result: FamilyRows, fallback: string): number | null {
  if (result.networkDown) return proxyUnreachable();
  if (result.errorJson) return apiError(result.errorJson, fallback);
  return null;
}

function errorText(json: Record<string, unknown> | undefined, fallback: string): string {
  return typeof json?.error === "string" ? json.error : fallback;
}

function resetIso(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function refreshLine(row: FamilyRows["rows"][number]): string {
  const parts = [row.id === MAIN_ID ? "main" : row.id, row.email, row.plan];
  const quota = row.quota;
  if (!quota || (quota.weeklyPercent === undefined && quota.monthlyPercent === undefined)) {
    parts.push("quota: unknown");
  } else {
    if (quota.weeklyPercent !== undefined) parts.push(`weekly ${quota.weeklyPercent}%`);
    const weeklyReset = resetIso(quota.weeklyResetAt);
    if (weeklyReset) parts.push(`resets ${weeklyReset}`);
    if (quota.monthlyPercent !== undefined) parts.push(`monthly ${quota.monthlyPercent}%`);
    const monthlyReset = resetIso(quota.monthlyResetAt);
    if (monthlyReset) parts.push(`resets ${monthlyReset}`);
  }
  if (row.needsReauth) parts.push("needs-reauth");
  return parts.filter(Boolean).join(" ");
}

function quotaParts(quota: ProviderQuotaDto): string[] {
  const parts: string[] = [];
  const add = (label: string, percent: number | undefined, resetAt?: number) => {
    if (percent === undefined) return;
    parts.push(`${label} ${percent}%`);
    const reset = resetIso(resetAt);
    if (reset) parts.push(`resets ${reset}`);
  };
  add("5h", quota.fiveHourPercent, quota.fiveHourResetAt);
  add("weekly", quota.weeklyPercent, quota.weeklyResetAt);
  add("monthly", quota.monthlyPercent, quota.monthlyResetAt);
  for (const window of quota.customWindows ?? []) add(window.label, window.percent, window.resetAt);
  return parts;
}

function providerQuotaLine(name: string, report: ProviderQuotaReportDto): string {
  return [name, ...quotaParts(report.quota)].join(" ");
}

export async function readStdinLine(deps: AccountDeps): Promise<string> {
  const input: AccountStdin = deps.stdinImpl ?? process.stdin;
  const timeoutMs = deps.stdinTimeoutMs ?? 15_000;
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onData = (chunk: unknown) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const newline = buffer.search(/[\r\n]/);
      if (newline >= 0) finish(() => resolve(buffer.slice(0, newline).trim()));
    };
    const onEnd = () => finish(() => resolve(buffer.trim()));
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new Error("timed out waiting for API key on stdin"))), timeoutMs);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

export async function cmdRefresh(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  if (!name || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  if (classified.type !== "codex") {
    const result = await fetchProviderQuotaReport(deps, baseUrl, name);
    if (result.status === 0) return proxyUnreachable();
    if (result.status !== 200) return apiError(result.errorJson ?? {}, `failed to refresh ${name}`);
    if (wantsJson) console.log(JSON.stringify({ provider: name, report: result.report }, null, 2));
    else console.log(result.report ? providerQuotaLine(name, result.report) : `no quota report available for ${name}`);
    return 0;
  }
  const result = await fetchCodexRows(deps, baseUrl, true);
  const failed = familyFailure(result, `failed to refresh ${name}`);
  if (failed !== null) return failed;
  if (wantsJson) console.log(JSON.stringify({ accounts: result.rows }, null, 2));
  else for (const row of result.rows) console.log(refreshLine(row));
  return 0;
}

export async function cmdAutoSwitch(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  const action = args.shift();
  if (!name || !action) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified || classified.type !== "codex") {
    return usage("Error: auto-switch only applies to the openai Codex account pool");
  }
  let threshold: number | undefined;
  if (action === "on" && args.length === 0) threshold = 80;
  else if (action === "off" && args.length === 0) threshold = 0;
  else if (action === "threshold" && args.length === 1 && /^\d+$/.test(args[0]!)) threshold = Number(args[0]);
  else if (action !== "status" || args.length !== 0) return usage();
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0 || threshold > 100)) {
    return usage("Error: threshold must be an integer 0-100");
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  if (action === "status") {
    const response = await apiJson(deps, baseUrl, "GET", "/api/codex-auth/active");
    if (response.status === 0) return proxyUnreachable();
    if (response.status !== 200 || typeof response.json.autoSwitchThreshold !== "number") {
      return apiError(response.json, "failed to read auto-switch status");
    }
    threshold = response.json.autoSwitchThreshold;
  } else {
    const response = await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/auto-switch", { threshold });
    if (response.status === 0) return proxyUnreachable();
    if (response.status !== 200) return apiError(response.json, "failed to update auto-switch");
  }
  const enabled = threshold! > 0;
  if (wantsJson) console.log(JSON.stringify({ provider: name, autoSwitchThreshold: threshold, enabled }, null, 2));
  else console.log(enabled ? `auto-switch: on (threshold ${threshold}%)` : "auto-switch: off");
  return 0;
}

function deletePath(type: "codex" | "oauth" | "api-key", name: string, id: string): string {
  if (type === "codex") return `/api/codex-auth/accounts?id=${encodeURIComponent(id)}`;
  if (type === "oauth") return `/api/oauth/accounts?provider=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`;
  return `/api/providers/keys?name=${encodeURIComponent(name)}&id=${encodeURIComponent(id)}`;
}

export async function cmdRemove(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const fail = (message: string): number => {
    if (wantsJson) console.error(JSON.stringify({ error: message }));
    else console.error(`Error: ${message}`);
    return 1;
  };
  const confirmed = flag(args, "--yes");
  const name = args.shift();
  const requestedId = args.shift();
  if (!name || !requestedId || args.length) return wantsJson ? fail("provider and account id are required") : usage();
  if (!confirmed) {
    const message = `Confirmation required. Re-run: ocx account remove ${name} ${requestedId} --yes`;
    return wantsJson ? fail(message) : usage(message);
  }
  const classified = configAndType(deps, name);
  if ("error" in classified) return wantsJson ? fail(classified.error) : usage(`Error: ${classified.error}`);
  const id = classified.type === "codex" && requestedId === "main" ? MAIN_ID : requestedId;
  if (classified.type === "codex" && id === MAIN_ID) return wantsJson
    ? fail("the main Codex App login cannot be removed")
    : usage("Error: the main Codex App login cannot be removed");
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return fail("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.");
  const before = await fetchRows(deps, baseUrl, name, classified.type);
  if (before.networkDown) return fail("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.");
  if (before.errorJson) return fail(errorText(before.errorJson, `failed to verify ${name} before removal`));
  if (!before.rows.some(row => row.id === id)) return wantsJson
    ? fail(`account or key "${requestedId}" was not found`)
    : usage(`Error: account or key "${requestedId}" was not found`);
  const response = await apiJson(deps, baseUrl, "DELETE", deletePath(classified.type, name, id));
  if (response.status === 0) return fail("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.");
  if (response.status !== 200) return fail(errorText(response.json, `failed to remove ${requestedId}`));
  const after = await fetchRows(deps, baseUrl, name, classified.type);
  if (after.networkDown || after.errorJson) {
    const detail = after.networkDown ? "proxy not reachable" : typeof after.errorJson?.error === "string" ? after.errorJson.error : "unknown error";
    return fail(`post-delete verification failed; delete may have succeeded: ${detail}`);
  }
  const removedActive = before.activeId === id;
  const result = { ok: true, provider: name, id, removedActive, promotedActiveId: after.activeId };
  if (wantsJson) console.log(JSON.stringify(result, null, 2));
  else if (classified.type === "codex" && removedActive && after.activeId === null) console.log(`openai: ${AUTO_NOTE}`);
  else if (classified.type === "oauth") console.log(after.rows.length ? `${name}: active account is now ${after.activeId}` : `${name}: no accounts remaining`);
  else if (classified.type === "api-key") console.log(after.rows.length ? `${name}: active key is now ${after.activeId}` : `${name}: no keys remaining`);
  else console.log(`${name}: removed account ${requestedId}`);
  return 0;
}

export async function cmdAddKey(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const labelArg = flagValue(args, "--label");
  const name = args.shift();
  if (!name || args.length || (labelArg.found && labelArg.value === undefined)) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified || classified.type !== "api-key") return usage("Error: add-key only applies to API-key providers");
  const input: AccountStdin = deps.stdinImpl ?? process.stdin;
  if (input.isTTY) return usage(PIPE_GUIDANCE);
  let key: string;
  try {
    key = await readStdinLine(deps);
  } catch (error) {
    return usage(`Error: ${error instanceof Error ? error.message : String(error)}\n${PIPE_GUIDANCE}`);
  }
  if (!key) return usage(`Error: API key input was empty\n${PIPE_GUIDANCE}`);
  const label = labelArg.value?.trim();
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const response = await apiJson(deps, baseUrl, "POST", "/api/providers/keys", { name, key, ...(label ? { label } : {}) });
  if (response.status === 0) return proxyUnreachable();
  if (response.status !== 201) return apiError(response.json, `failed to add a key for ${name}`);
  const id = typeof response.json.id === "string" ? response.json.id : null;
  // Redact the key inside the label BEFORE serialization — a key containing
  // JSON-escaped characters (" or \) would otherwise survive the whole-output
  // pass in escaped form (audit finding, Carver WP3-C).
  const safeLabel = label ? label.replaceAll(key, "[redacted]") : undefined;
  const result = { ok: true, id, ...(safeLabel ? { label: safeLabel } : {}) };
  const output = wantsJson ? JSON.stringify(result, null, 2)
    : `${name}: added API key ${id ?? ""}${safeLabel ? ` (${safeLabel})` : ""}`.trim();
  console.log(output.replaceAll(key, "[redacted]"));
  return 0;
}
