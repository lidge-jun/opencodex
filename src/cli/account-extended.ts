import { loadConfig } from "../config";
import { hasPassiveAccountQuota } from "../providers/quota";
import { closeSync, openSync, readSync } from "node:fs";
import {
  MAX_ACCOUNT_PRIORITY,
  MIN_ACCOUNT_PRIORITY,
  normalizeAccountPriority,
  parseAccountPriority,
} from "../codex/pool-rotation";
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
import {
  codexCatalogRefreshPending,
  warnIfCodexCatalogRefreshPending,
} from "./account-catalog-refresh";
import {
  ACCOUNT_IMPORT_DEADLINE_MS,
  ACCOUNT_IMPORT_FORMAT,
  ACCOUNT_IMPORT_MAX_BYTES,
  ACCOUNT_IMPORT_PROVIDER,
  type AccountImportCode,
  type AccountImportRecordResult,
  type AccountImportResult,
  type AccountImportStatus,
} from "../oauth/account-import";

const MAIN_ID = "__main__";
const AUTO_NOTE = "auto (no pin — lowest-usage account is selected per request)";
const EXTENDED_USAGE = `Usage:
  ocx account refresh <provider> [--json]
  ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]
  ocx account alias <provider> <id|main> <display-name|-> [--json]
  ocx account priority <provider> <id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]
  ocx account pause <provider> <id|main> [--json]
  ocx account resume <provider> <id|main> [--json]
  ocx account pause-exhausted <provider> [--json]
  ocx account strategy <provider> [<quota|round-robin|fill-first>] [--json]
  ocx account sticky <provider> [<1-100>] [--json]
  ocx account remove <provider> <id|main> --yes [--json]
  ocx account clear-cooldown <provider> <id|main> [--json]
  ocx account add-key <provider> [--label <label>] [--json]
  ocx account import <provider> --format <format> (--file <path>|--stdin) [--json]`;
const PIPE_GUIDANCE = `Pipe the API key on stdin, for example:
  ocx account add-key <provider> <<< "$MY_KEY"
  security find-generic-password -w <item> | ocx account add-key <provider>`;
const ACCOUNT_IMPORT_TIMEOUT_MS = ACCOUNT_IMPORT_DEADLINE_MS;

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

function boundedUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid_document");
  }
}

function readBoundedImportFile(path: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(ACCOUNT_IMPORT_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > ACCOUNT_IMPORT_MAX_BYTES) throw new Error("invalid_document");
    return boundedUtf8(buffer.subarray(0, offset));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_document") throw error;
    throw new Error("source_read_failed");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function readBoundedImportStdin(deps: AccountDeps): Promise<string> {
  const input: AccountStdin = deps.stdinImpl ?? process.stdin;
  if (input.isTTY) throw new Error("stdin_required");
  const timeoutMs = deps.stdinTimeoutMs ?? 15_000;
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
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
      const encoded = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += encoded.byteLength;
      if (bytes > ACCOUNT_IMPORT_MAX_BYTES) {
        finish(() => reject(new Error("invalid_document")));
        return;
      }
      chunks.push(encoded);
    };
    const onEnd = () => finish(() => {
      try { resolve(boundedUtf8(Buffer.concat(chunks, bytes))); }
      catch (error) { reject(error); }
    });
    const onError = () => finish(() => reject(new Error("source_read_failed")));
    const timer = setTimeout(() => finish(() => reject(new Error("stdin_timeout"))), timeoutMs);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

const IMPORT_STATUSES = new Set<AccountImportStatus>(["imported", "updated", "failed", "unsupported"]);
const IMPORT_CODES = new Set<AccountImportCode>([
  "imported", "updated", "import_cancelled", "unsupported_provider", "unsupported_format", "invalid_document",
  "invalid_record", "credential_rejected", "identity_mismatch", "missing_project", "persist_failed",
]);
const IMPORT_RESULT_FIELDS = new Set([
  "totalCount", "importedCount", "updatedCount", "failedCount", "unsupportedCount", "results",
]);
const IMPORT_RECORD_FIELDS = new Set(["index", "status", "code"]);
const IMPORT_STATUS_CODES: Record<AccountImportStatus, ReadonlySet<AccountImportCode>> = {
  imported: new Set(["imported"]),
  updated: new Set(["updated"]),
  failed: new Set(["invalid_record", "credential_rejected", "identity_mismatch", "missing_project", "persist_failed"]),
  unsupported: new Set(["unsupported_provider", "unsupported_format"]),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const fields = Object.keys(value);
  return fields.length === allowed.size && fields.every(field => allowed.has(field));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0;
}

function safeImportResult(json: unknown): AccountImportResult | null {
  if (!isPlainObject(json) || !hasExactFields(json, IMPORT_RESULT_FIELDS)) return null;
  if (
    !isNonNegativeSafeInteger(json.totalCount)
    || !isNonNegativeSafeInteger(json.importedCount)
    || !isNonNegativeSafeInteger(json.updatedCount)
    || !isNonNegativeSafeInteger(json.failedCount)
    || !isNonNegativeSafeInteger(json.unsupportedCount)
  ) return null;
  if (!Array.isArray(json.results)) return null;
  if (json.results.length !== json.totalCount) return null;

  const results: AccountImportRecordResult[] = [];
  const indices = new Set<number>();
  const aggregate: Record<AccountImportStatus, number> = {
    imported: 0,
    updated: 0,
    failed: 0,
    unsupported: 0,
  };
  for (const raw of json.results) {
    if (!isPlainObject(raw) || !hasExactFields(raw, IMPORT_RECORD_FIELDS)) return null;
    const item = raw;
    if (!isNonNegativeSafeInteger(item.index) || item.index >= json.totalCount || indices.has(item.index)) return null;
    if (!IMPORT_STATUSES.has(item.status as AccountImportStatus)) return null;
    if (!IMPORT_CODES.has(item.code as AccountImportCode)) return null;
    const status = item.status as AccountImportStatus;
    const code = item.code as AccountImportCode;
    if (!IMPORT_STATUS_CODES[status].has(code)) return null;
    indices.add(item.index);
    aggregate[status] += 1;
    results.push({
      index: item.index,
      status,
      code,
    });
  }
  if (
    indices.size !== json.totalCount
    || aggregate.imported !== json.importedCount
    || aggregate.updated !== json.updatedCount
    || aggregate.failed !== json.failedCount
    || aggregate.unsupported !== json.unsupportedCount
  ) return null;

  return {
    totalCount: json.totalCount,
    importedCount: json.importedCount,
    updatedCount: json.updatedCount,
    failedCount: json.failedCount,
    unsupportedCount: json.unsupportedCount,
    results,
  };
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
  if (result.networkDown) return proxyUnreachable(result.transportError);
  if (result.errorJson) return apiError(result.errorJson, fallback, result.status);
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
  if (row.paused) parts.push("paused");
  // Was a second quota dialect: it gated the whole block on weekly/monthly, so an account
  // reporting only a 5h window printed `quota: unknown` while `quotaParts` five lines below
  // rendered the same data correctly for the provider path (#2703). Two halves of one file
  // disagreeing about how to read one DTO is the defect; delegating removes it rather than
  // teaching the second dialect a third window.
  const quotaText = row.quota ? quotaParts(row.quota).join(" ") : "";
  parts.push(quotaText.length > 0 ? quotaText : "quota: unknown");
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

export function providerQuotaLine(name: string, report: ProviderQuotaReportDto): string {
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
    if (result.status === 0) return proxyUnreachable(result.transportError);
    if (result.status !== 200) return apiError(result.errorJson ?? {}, `failed to refresh ${name}`, result.status);
    if (wantsJson) console.log(JSON.stringify({ provider: name, report: result.report }, null, 2));
    else if (result.report) console.log(providerQuotaLine(name, result.report));
    // A passive provider has no probe to run, so "no report available" reads as a
    // failure of something that was never attempted. Say what is actually true.
    else if (hasPassiveAccountQuota(name)) {
      console.log(`${name} reports usage only during a streaming response; there is nothing to refresh. Run a request through this provider to update it, then see \`ocx account list ${name}\`.`);
    } else console.log(`no quota report available for ${name}`);
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
  // Anthropic keeps its threshold on its own pool contract; generic OAuth providers (#695)
  // and the Codex pool are accepted here.
  if ("error" in classified || classified.type === "api-key" || name === "anthropic") {
    return usage("Error: auto-switch only applies to the openai Codex account pool or a generic OAuth provider pool");
  }
  const genericPool = classified.type === "oauth";
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
    const response = await apiJson(
      deps, baseUrl, "GET",
      genericPool ? `/api/oauth/accounts/pool?provider=${encodeURIComponent(name)}` : "/api/codex-auth/active",
    );
    if (response.status === 0) return proxyUnreachable(response.transportError);
    if (response.status !== 200 || (!genericPool && typeof response.json.autoSwitchThreshold !== "number")) {
      return apiError(response.json, "failed to read auto-switch status", response.status);
    }
    threshold = typeof response.json.autoSwitchThreshold === "number" ? response.json.autoSwitchThreshold : 0;
  } else {
    const response = genericPool
      ? await apiJson(deps, baseUrl, "PUT", "/api/oauth/accounts/pool", { provider: name, autoSwitchThreshold: threshold })
      : await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/auto-switch", { threshold });
    if (response.status === 0) return proxyUnreachable(response.transportError);
    if (response.status !== 200) return apiError(response.json, "failed to update auto-switch", response.status);
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
  const catalogRefreshPending = classified.type === "codex"
    && codexCatalogRefreshPending(response.json);
  const after = await fetchRows(deps, baseUrl, name, classified.type);
  if (after.networkDown || after.errorJson) {
    const detail = after.networkDown ? "proxy not reachable" : typeof after.errorJson?.error === "string" ? after.errorJson.error : "unknown error";
    return fail(`post-delete verification failed; delete may have succeeded: ${detail}`);
  }
  const removedActive = before.activeId === id;
  const result = {
    ok: true,
    provider: name,
    id,
    removedActive,
    promotedActiveId: after.activeId,
    ...(classified.type === "codex" ? { catalogRefreshPending } : {}),
  };
  if (wantsJson) console.log(JSON.stringify(result, null, 2));
  else if (classified.type === "codex" && removedActive && after.activeId === null) console.log(`openai: ${AUTO_NOTE}`);
  else if (classified.type === "oauth") console.log(after.rows.length ? `${name}: active account is now ${after.activeId}` : `${name}: no accounts remaining`);
  else if (classified.type === "api-key") console.log(after.rows.length ? `${name}: active key is now ${after.activeId}` : `${name}: no keys remaining`);
  else console.log(`${name}: removed account ${requestedId}`);
  if (!wantsJson && catalogRefreshPending) warnIfCodexCatalogRefreshPending(response.json);
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
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 201) return apiError(response.json, `failed to add a key for ${name}`, response.status);
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

export async function cmdImport(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const formatArg = flagValue(args, "--format");
  const fileArg = flagValue(args, "--file");
  const fromStdin = flag(args, "--stdin");
  const provider = args.shift();

  // Admission happens before source I/O. In particular, an inline JSON positional argument is
  // rejected without inspecting or echoing it, keeping secrets out of any subsequent surface.
  if (
    provider !== ACCOUNT_IMPORT_PROVIDER
    || formatArg.value !== ACCOUNT_IMPORT_FORMAT
    || formatArg.found !== true
  ) {
    const code = provider === ACCOUNT_IMPORT_PROVIDER ? "unsupported_format" : "unsupported_provider";
    console.error(`Error: ${code}`);
    return 1;
  }
  const hasFile = fileArg.found && typeof fileArg.value === "string" && fileArg.value.length > 0;
  if (args.length > 0 || hasFile === fromStdin || (fileArg.found && !hasFile)) {
    return usage("Error: choose exactly one bounded source: --file <path> or --stdin");
  }

  let source: string;
  try {
    source = hasFile ? readBoundedImportFile(fileArg.value!) : await readBoundedImportStdin(deps);
  } catch (error) {
    const code = error instanceof Error ? error.message : "source_read_failed";
    console.error(`Error: ${["invalid_document", "source_read_failed", "stdin_required", "stdin_timeout"].includes(code) ? code : "source_read_failed"}`);
    return 1;
  }

  let document: unknown;
  try {
    document = JSON.parse(source) as unknown;
  } catch {
    console.error("Error: invalid_document");
    return 1;
  }

  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const configuredImportTimeout = deps.importTimeoutMs;
  const importTimeoutMs = typeof configuredImportTimeout === "number" && Number.isFinite(configuredImportTimeout)
    ? Math.min(ACCOUNT_IMPORT_TIMEOUT_MS, Math.max(1, Math.floor(configuredImportTimeout)))
    : ACCOUNT_IMPORT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, importTimeoutMs);
  let response;
  try {
    response = await apiJson(deps, baseUrl, "POST", "/api/oauth/accounts/import", {
      provider,
      format: formatArg.value,
      document,
    }, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 0) {
    if (!timedOut) return proxyUnreachable(response.transportError);
    console.error(`Error: import_timeout after ${importTimeoutMs}ms`);
    return 1;
  }
  if (response.status !== 200) {
    if (IMPORT_CODES.has(response.json.code as AccountImportCode)) {
      console.error(`Error: ${response.json.code as AccountImportCode}`);
    } else {
      console.error(`Error: import_request_failed (status ${response.status})`);
    }
    return 1;
  }
  const result = safeImportResult(response.json);
  if (!result) {
    console.error("Error: invalid_response");
    return 1;
  }

  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `${provider}: ${result.importedCount} imported, ${result.updatedCount} updated, ${result.failedCount} failed, ${result.unsupportedCount} unsupported`,
    );
    for (const item of result.results) console.log(`  #${item.index + 1} ${item.status} (${item.code})`);
  }
  return result.failedCount > 0 || result.unsupportedCount > 0 ? 1 : 0;
}

/**
 * Lift a quota cooldown on a Codex account.
 *
 * This is the user-facing escape from the lockout described in
 * `devlog/_plan/260726_cooldown_lockout_hardening`: injected routing makes the proxy the
 * only model path for Codex Desktop, so a stuck cooldown reads as "the whole app is dead".
 *
 * Codex accounts only. API-key pools already reset their own 429 cooldowns through key
 * management (`clearKeyCooldowns`), and OAuth providers have no equivalent state here.
 */
export async function cmdClearCooldown(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  const requestedId = args.shift();
  if (!name || !requestedId || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  if (classified.type !== "codex") {
    return usage(`Error: ${name} is not a Codex account pool; cooldown clearing applies to Codex accounts only`);
  }
  const id = requestedId === "main" ? MAIN_ID : requestedId;
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const response = await apiJson(deps, baseUrl, "POST", "/api/codex-auth/accounts/clear-cooldown", { id });
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, `failed to clear cooldown for ${requestedId}`, response.status);
  const cleared = response.json?.cleared === true;
  if (wantsJson) console.log(JSON.stringify({ ok: true, provider: name, id, cleared }, null, 2));
  else if (cleared) console.log(`${name}: cooldown lifted for ${requestedId}`);
  else console.log(`${name}: no active cooldown for ${requestedId}`);
  return 0;
}

/**
 * Named selection orders. The words convey sequence rather than rank because the
 * pool moves down the list only when everything above it is drained — "high
 * priority" would suggest the account gets more traffic, which is not what
 * ordering does.
 */
const PRIORITY_PRESETS: Record<string, number> = {
  first: 2,
  earlier: 1,
  normal: 0,
  later: -1,
  last: -2,
};

function priorityPresetName(priority: number): string | null {
  return Object.entries(PRIORITY_PRESETS).find(([, value]) => value === priority)?.[0] ?? null;
}

function formatPriority(priority: number): string {
  const preset = priorityPresetName(priority);
  const signed = priority > 0 ? `+${priority}` : String(priority);
  return preset ? `${signed} (${preset})` : signed;
}

/** `null` = reset to the default; `undefined` = unparseable. */
function parsePriorityArgument(raw: string): number | null | undefined {
  const word = raw.trim().toLowerCase();
  if (word === "reset") return null;
  // Own keys only: `in` also matches "constructor", "__proto__", and friends.
  if (Object.hasOwn(PRIORITY_PRESETS, word)) return PRIORITY_PRESETS[word];
  // The regex only rules out shapes Number() would coerce ("1e2", " 1 ", ""); the range
  // itself comes from the core parser so the CLI cannot drift from what the API accepts.
  if (!/^[+-]?\d+$/.test(word)) return undefined;
  return parseAccountPriority(Number(word)) ?? undefined;
}

export async function cmdPriority(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  const requestedId = args.shift();
  const requestedPriority = args.shift();
  if (!name || !requestedId || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  if (classified.type !== "codex") {
    return usage("Error: selection order only applies to the openai Codex account pool");
  }
  const id = requestedId === "main" ? MAIN_ID : requestedId;

  // Validate before touching the network so a typo never reaches the proxy.
  let priority: number | null | undefined;
  if (requestedPriority !== undefined) {
    priority = parsePriorityArgument(requestedPriority);
    if (priority === undefined) {
      return usage(`Error: selection order must be an integer ${MIN_ACCOUNT_PRIORITY}..${MAX_ACCOUNT_PRIORITY}, one of ${Object.keys(PRIORITY_PRESETS).join("/")}, or reset`);
    }
  }

  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  // No value means "show" — a read must not rewrite what it is reporting.
  if (priority === undefined) {
    const result = await fetchCodexRows(deps, baseUrl);
    const failed = familyFailure(result, `failed to read ${name} accounts`);
    if (failed !== null) return failed;
    const row = result.rows.find(candidate => candidate.id === id);
    if (!row) return usage(`Error: no ${name} account ${requestedId}`);
    const current = normalizeAccountPriority(row.priority);
    if (wantsJson) {
      console.log(JSON.stringify(
        { ok: true, provider: name, id, priority: current, preset: priorityPresetName(current) },
        null,
        2,
      ));
    } else {
      console.log(`${name}: ${requestedId} selection order is ${formatPriority(current)}`);
    }
    return 0;
  }

  const response = await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/accounts/priority", { id, priority });
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, `failed to set selection order for ${requestedId}`, response.status);
  const applied = typeof response.json.priority === "number" ? response.json.priority : (priority ?? 0);
  if (wantsJson) {
    console.log(JSON.stringify(
      { ok: true, provider: name, id, priority: applied, preset: priorityPresetName(applied) },
      null,
      2,
    ));
  } else {
    console.log(`${name}: ${requestedId} selection order is now ${formatPriority(applied)}`);
  }
  // Not cmdUse's note: re-ordering takes effect on the next unbound request rather than
  // only on new sessions, because preemption moves those requests up immediately.
  console.error("Takes effect from the next unbound request; running threads keep their current account until drained.");
  // The release is not optional and not conditional on the value changing, so it has to be
  // stated: this route is the only way to clear a pin without immediately setting another,
  // which means a write storing the order an account already had still releases it. Without
  // this line that is a silent side effect of a command that looks purely declarative.
  console.error('Also releases any manual "use this account now" pin, on any account.');
  return 0;
}

/**
 * `ocx account pause|resume <provider> <id>` (#2702).
 *
 * The server routes have always existed; only the CLI caller was missing, so pausing an
 * account was dashboard-only. The issue reports these as POST; the code is PUT
 * (`auth-api.ts:1494`), and the route is shared by both directions with a `paused` boolean
 * rather than being two endpoints.
 */
export async function cmdPause(args: string[], deps: AccountDeps, paused: boolean): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  const requestedId = args.shift();
  const verb = paused ? "pause" : "resume";
  if (!name || !requestedId || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  if (classified.type !== "codex") {
    return usage(`Error: ${verb} applies to the openai Codex account pool`);
  }
  const id = requestedId === "main" ? MAIN_ID : requestedId;

  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  const response = await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/accounts/pause", { id, paused });
  // Transport sentinel first: status 0 means the proxy never answered, and comparing it to
  // 200 would report an unreachable proxy as a management error.
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, `failed to ${verb} ${requestedId}`, response.status);

  if (wantsJson) {
    console.log(JSON.stringify({ ok: true, provider: name, id, paused }, null, 2));
  } else {
    console.log(`${name}: ${requestedId} ${paused ? "paused" : "resumed"}`);
  }
  if (paused) {
    // Both are server-side effects of this route (auth-api.ts:1508-1510), not consequences
    // the operator would infer from the word "pause".
    console.error("Threads bound to this account are unbound, and a fallback account is selected if this one was active.");
  }
  return 0;
}

/**
 * `ocx account pause-exhausted [--off]` (#2702).
 *
 * Pauses every account whose quota is spent. The route refreshes quota for each account, so
 * it can partially fail; the response distinguishes "checked none and some failed" from
 * "checked some", and that distinction is reported rather than flattened into ok/not-ok.
 */
export async function cmdPauseExhausted(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  if (!name || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  if (classified.type !== "codex") {
    return usage("Error: pause-exhausted applies to the openai Codex account pool");
  }

  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  const response = await apiJson(deps, baseUrl, "PUT", "/api/codex-auth/accounts/pause-exhausted", {});
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, "failed to pause exhausted accounts", response.status);

  const pausedIds = Array.isArray(response.json.pausedAccountIds)
    ? (response.json.pausedAccountIds as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const checked = typeof response.json.checkedAccountCount === "number" ? response.json.checkedAccountCount : null;
  const failed = typeof response.json.failedAccountCount === "number" ? response.json.failedAccountCount : null;

  const complete = failed === null || failed === 0;
  const ok = complete;
  if (failed !== null && failed > 0) {
    console.error(`Quota refresh failed for ${failed} account(s); those were not evaluated.`);
  }
  if (wantsJson) {
    console.log(JSON.stringify({
      ok,
      complete,
      provider: name,
      pausedAccountIds: pausedIds,
      checkedAccountCount: checked,
      failedAccountCount: failed,
    }, null, 2));
    return ok ? 0 : 1;
  }
  console.log(pausedIds.length > 0
    ? `${name}: paused ${pausedIds.length} exhausted account(s): ${pausedIds.join(", ")}`
    : `${name}: no exhausted accounts to pause`);
  return ok ? 0 : 1;
}

/**
 * Two pools expose strategy and sticky, and they are NOT reached the same way:
 *
 * |  | Codex pool | Anthropic pool |
 * |---|---|---|
 * | read | `GET /api/codex-auth/active` | `GET /api/oauth/accounts/pool?provider=` |
 * | write | `PUT /api/codex-auth/pool-strategy` | `PUT /api/oauth/accounts/pool` |
 * | keys | `accountPoolStrategy`/`accountPoolStickyLimit` | `strategy`/`stickyLimit` |
 * | body | bare field | field **plus** a mandatory `provider` |
 *
 * Omitting `provider` from the Anthropic write body earns a 400
 * (`oauth-account-routes.ts:344`), so the asymmetry has to be encoded somewhere. Encoding it
 * here keeps ONE verb pair working on both pools. The alternative the plan left open -- a second
 * `provider-strategy`/`provider-sticky` pair -- would double the surface an operator must learn
 * to express one idea, and a CLI that can steer one pool and not the other is exactly the trap
 * this unit exists to remove.
 */
interface PoolTransport {
  readPath: string;
  writePath: string;
  /** Response key carrying the applied strategy. */
  strategyKey: string;
  /** Response key carrying the applied sticky limit. */
  stickyKey: string;
  writeBody: (field: "strategy" | "stickyLimit", value: unknown) => Record<string, unknown>;
}

const CODEX_POOL_TRANSPORT: PoolTransport = {
  readPath: "/api/codex-auth/active",
  writePath: "/api/codex-auth/pool-strategy",
  strategyKey: "accountPoolStrategy",
  stickyKey: "accountPoolStickyLimit",
  writeBody: (field, value) => ({ [field]: value }),
};

function anthropicPoolTransport(provider: string): PoolTransport {
  return {
    readPath: `/api/oauth/accounts/pool?provider=${encodeURIComponent(provider)}`,
    writePath: "/api/oauth/accounts/pool",
    strategyKey: "strategy",
    stickyKey: "stickyLimit",
    writeBody: (field, value) => ({ provider, [field]: value }),
  };
}

/**
 * Codex and Anthropic keep their own pool transports; every other OAuth provider speaks the
 * generic pool-settings contract on the same `/api/oauth/accounts/pool` route (#695).
 * API-key providers have no pool and are refused here without a round-trip.
 */
function poolTransportFor(
  classified: { type: "codex" | "oauth" | "api-key" },
  name: string,
): PoolTransport | string {
  if (classified.type === "codex") return CODEX_POOL_TRANSPORT;
  if (classified.type === "oauth") return anthropicPoolTransport(name);
  return `pool settings apply to OAuth account pools, not the API-key provider "${name}"`;
}

/**
 * `ocx account strategy <provider> [<name>]` and `ocx account sticky <provider> [<n>]` (#2702).
 *
 * One implementation rather than two near-duplicates, because strategy and sticky are two
 * fields of one setting on every pool that has them.
 *
* Values are NOT re-validated here. The server owns both contracts -- three strategy names,
* a 1-100 sticky bound -- and a duplicated bound is a second thing to keep in sync. Its 400
* is actionable now that the CLI prints `reason`.
*/
async function poolSetting(
  args: string[],
  deps: AccountDeps,
  field: "strategy" | "stickyLimit",
): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  const requested = args.shift();
  const label = field === "strategy" ? "pool strategy" : "sticky limit";
  if (!name || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  const transport = poolTransportFor(classified, name);
  if (typeof transport === "string") return usage(`Error: ${transport}`);

  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();

  // No value means show. A read must not rewrite what it is reporting.
  if (requested === undefined) {
    const response = await apiJson(deps, baseUrl, "GET", transport.readPath);
    if (response.status === 0) return proxyUnreachable(response.transportError);
    if (response.status !== 200) return apiError(response.json, `failed to read ${label}`, response.status);
    const strategy = response.json[transport.strategyKey];
    const sticky = response.json[transport.stickyKey];
    if (wantsJson) {
      // Pool-neutral key names: the two routes spell the same two settings differently, and a
      // `--json` consumer should not have to branch on which pool answered.
      console.log(JSON.stringify({ ok: true, provider: name, strategy, stickyLimit: sticky }, null, 2));
    } else {
      console.log(`${name}: ${label} is ${String(field === "strategy" ? strategy : sticky)}`);
    }
    return 0;
  }

  // Sent as a number when it parses as one so the server sees the type it validates;
  // a non-numeric string still goes through and earns the server's own 400.
  const value = field === "strategy"
    ? requested
    : (Number.isNaN(Number(requested)) ? requested : Number(requested));
  const response = await apiJson(deps, baseUrl, "PUT", transport.writePath, transport.writeBody(field, value));
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, `failed to set ${label}`, response.status);

  if (wantsJson) {
    console.log(JSON.stringify({
      ok: true,
      provider: name,
      strategy: response.json[transport.strategyKey],
      stickyLimit: response.json[transport.stickyKey],
    }, null, 2));
  } else {
    // Echo the APPLIED value from the response, not the requested one: the server normalizes,
    // and printing the request would hide a normalization the operator should see.
    const applied = field === "strategy" ? response.json[transport.strategyKey] : response.json[transport.stickyKey];
    console.log(`${name}: ${label} is now ${String(applied)}`);
  }
  return 0;
}

export function cmdStrategy(args: string[], deps: AccountDeps): Promise<number> {
  return poolSetting(args, deps, "strategy");
}

export function cmdSticky(args: string[], deps: AccountDeps): Promise<number> {
  return poolSetting(args, deps, "stickyLimit");
}

export async function cmdAlias(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = flag(args, "--json");
  const name = args.shift();
  const requestedId = args.shift();
  const requestedAlias = args.shift();
  if (!name || !requestedId || requestedAlias === undefined || args.length) return usage();
  const classified = configAndType(deps, name);
  if ("error" in classified) return usage(`Error: ${classified.error}`);
  const id = classified.type === "codex" && requestedId === "main" ? MAIN_ID : requestedId;
  if (id === MAIN_ID) return usage("Error: the main Codex App login cannot be renamed");
  const alias = requestedAlias === "-" ? "" : requestedAlias.trim();
  if (alias.length > 80 || /[\x00-\x1f\x7f]/.test(alias)) return usage("Error: alias must be at most 80 printable characters");
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const path = classified.type === "codex"
    ? "/api/codex-auth/accounts/alias"
    : classified.type === "oauth"
      ? "/api/oauth/accounts/alias"
      : "/api/providers/keys/alias";
  const body = classified.type === "codex"
    ? { id, alias }
    : classified.type === "oauth"
      ? { provider: name, accountId: id, alias }
      : { name, id, alias };
  const response = await apiJson(deps, baseUrl, "PUT", path, body);
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, `failed to rename ${requestedId}`, response.status);
  const result = { ok: true, provider: name, id, alias: alias || null };
  if (wantsJson) console.log(JSON.stringify(result, null, 2));
  else console.log(alias ? `${name}: ${requestedId} is now “${alias}”` : `${name}: cleared alias for ${requestedId}`);
  return 0;
}
