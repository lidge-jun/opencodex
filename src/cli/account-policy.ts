import { isAnthropicInstanceId } from "../providers/anthropic-instance-id";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import { isValidProviderName } from "../config/provider-name";
import { resolveCodexAccountTargetFromRows } from "./account-target";
import { runCatalogAction } from "./catalog-command-result";
import { serializeManagementJson } from "./json-input";
import { creditAllReceipt, creditReceipt, grantsSchema, parseDto, poolSchema, record,
  rosterSchema, threshold, thresholdReceipt } from "./account-policy-dto";
import { CliUsageError, RuntimeApiError, printData, runtimeBaseUrl, runtimeRequest, summaryLines,
  takeFlag, takeOptionWithSyntax, type RuntimeApiDeps } from "./runtime-api";

type Subcommand = "pool" | "auto-switch" | "credits" | "quota-activation" | "anthropic-reset-grants";
const USAGE = "Usage: ocx account pool <provider> [--enabled on|off] [--threshold 0-100] [--strategy NAME] [--sticky 1-100] [--quota-window NAME] [--json]\n"
  + "       ocx account auto-switch openai <status|on|off|inherit|threshold N> --account ID [--json]\n"
  + "       ocx account credits openai <ID on|off|--all on|off> [--json]\n"
  + "       ocx account quota-activation openai ID --window <fiveHour|weekly> <on|off> [--json]\n"
  + "       ocx account anthropic-reset-grants [ID] [--provider anthropic|anthropic2] [--json]";
const READ_ERRORS = { no_account: "No matching Anthropic OAuth account.", auth_failed: "Sign in to this Anthropic account again.",
  upstream_unavailable: "Anthropic did not return the reset-grant status.", ledger_unavailable: "The reset journal is unavailable.",
  ledger_busy: "The reset journal is busy. No grant was consumed." };
function usage(): never { throw new CliUsageError("Invalid account policy arguments.", USAGE); }
function onOff(value: string | undefined): boolean { if (value !== "on" && value !== "off") usage(); return value === "on"; }
function integer(value: string, min: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > 100) usage();
  return Number(value);
}
function selector(value: string | undefined): string {
  if (!value || value.trim() !== value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || value.startsWith("-")) usage();
  return value;
}
function option(args: string[], name: string): string | undefined { return takeOptionWithSyntax(args, name)?.value; }
function done(args: string[]): void { if (args.length) usage(); }
async function request(path: string, deps: RuntimeApiDeps, body?: Record<string, unknown>): Promise<unknown> {
  return runtimeRequest(path, { redirect: "error", ...(body === undefined ? {} : {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: serializeManagementJson(body),
  }) }, deps);
}
async function roster(deps: RuntimeApiDeps) {
  return parseDto(rosterSchema, await request("/api/codex-auth/accounts", deps)).accounts;
}
async function target(deps: RuntimeApiDeps, requested: string) {
  const rows = await roster(deps);
  const selected = resolveCodexAccountTargetFromRows(rows, requested);
  if (!("id" in selected)) {
    if ("error" in selected && selected.kind === "not_found") throw new RuntimeApiError("Account not found", 404, null);
    throw new CliUsageError("Account selector is reserved, ambiguous or unavailable. Use a unique account ID.");
  }
  return { id: selected.id, rows };
}
function output(data: Record<string, unknown>, json: boolean, note?: string): number {
  printData(data, json, [...(note ? [note] : []), ...summaryLines(data)]);
  return 0;
}
function requireEqual(actual: unknown, expected: unknown): void { if (actual !== expected) throw new Error("Unverified account policy result"); }

async function pool(args: string[], json: boolean, deps: RuntimeApiDeps): Promise<number> {
  const provider = selector(args.shift()).toLowerCase();
  if (!isValidProviderName(provider)) usage();
  const patch: Record<string, unknown> = {};
  const enabled = option(args, "--enabled"), limit = option(args, "--threshold"), sticky = option(args, "--sticky");
  const strategy = option(args, "--strategy"), window = option(args, "--quota-window");
  if (enabled !== undefined) patch.enabled = onOff(enabled);
  if (limit !== undefined) patch.autoSwitchThreshold = integer(limit, 0);
  if (sticky !== undefined) patch.stickyLimit = integer(sticky, 1);
  if (strategy !== undefined) {
    if (!["quota", "round-robin", "fill-first", ...(provider === "openai" ? ["reset-first"] : []),
      ...(provider === "kiro" ? ["least-loaded"] : [])].includes(strategy)) usage();
    patch.strategy = strategy;
  }
  if (window !== undefined) {
    if (!isAnthropicInstanceId(provider) || !["five-hour", "weekly", "max-utilization"].includes(window)) usage();
    patch.quotaWindow = window;
  }
  done(args);
  const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
  const before = parseDto(poolSchema, await request(`/api/pool/settings?provider=${encodeURIComponent(provider)}`, pinned));
  requireEqual(before.provider, provider);
  requireEqual(before.kind, provider === "openai" ? "codex" : isAnthropicInstanceId(provider) ? "anthropic" : "generic");
  if (Object.keys(patch).some(key => !(before.supported as string[]).includes(key))
    || (before.kind === "codex" && enabled !== undefined)) throw new CliUsageError("The selected pool does not support a requested field.");
  if (!Object.keys(patch).length) return output(before, json);
  const after = parseDto(poolSchema, await request("/api/pool/settings", pinned, { provider, ...patch }));
  requireEqual(after.provider, provider); requireEqual(after.kind, before.kind);
  for (const [key, value] of Object.entries(patch)) requireEqual(record(after)[key], value);
  return output(after, json, after.warning === "config_bookkeeping_failed"
    ? "Pool policy saved, but configuration bookkeeping failed. Re-read the pool policy to confirm the current state."
    : "Pool policy saved.");
}

async function codex(sub: "auto-switch" | "credits" | "quota-activation", args: string[], json: boolean, deps: RuntimeApiDeps): Promise<number> {
  if (args.shift() !== "openai") usage();
  let requested: string | undefined, action: string | undefined, all = false, window: string | undefined;
  let value: number | null | undefined, enabled: boolean | undefined;
  if (sub === "auto-switch") {
    requested = selector(option(args, "--account")); action = args.shift();
    if (action === "threshold") value = integer(args.shift() ?? "", 0);
    else if (action === "on") value = 80;
    else if (action === "off") value = 0;
    else if (action === "inherit") value = null;
    else if (action !== "status") usage();
  } else if (sub === "credits") {
    all = takeFlag(args, "--all");
    if (!all) requested = selector(args.shift());
    enabled = onOff(args.shift());
  } else {
    window = option(args, "--window");
    if (window !== "fiveHour" && window !== "weekly") usage();
    requested = selector(args.shift()); enabled = onOff(args.shift());
  }
  done(args);
  const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
  if (all) {
    const result = parseDto(creditAllReceipt, await request("/api/codex-auth/accounts/credits", pinned, { all: enabled }));
    requireEqual(result.all, enabled);
    if ((!enabled && result.ids.length !== 0) || (enabled && !result.ids.includes(MAIN_CODEX_ACCOUNT_ID))) throw new Error("Invalid credit scope");
    return output(result, json, enabled ? "Paid-credit use enabled for the returned current accounts." : "Paid-credit use disabled for all accounts.");
  }
  const { id, rows } = await target(pinned, requested!);
  if (sub === "auto-switch") {
    if (action === "status") {
      const selected = rows.find(row => row.id === id);
      const override = selected?.autoSwitchThresholdOverride;
      if (override === undefined) throw new Error("Missing account threshold evidence");
      const active = record(await request("/api/codex-auth/active", pinned));
      const effective = override ?? parseDto(threshold, active.autoSwitchThreshold);
      return output({ ok: true, id, autoSwitchThresholdOverride: override, autoSwitchThreshold: effective }, json);
    }
    const result = parseDto(thresholdReceipt, await request("/api/codex-auth/auto-switch", pinned, { id, threshold: value }));
    requireEqual(result.id, id); requireEqual(result.autoSwitchThresholdOverride, value);
    if (value !== null) requireEqual(result.autoSwitchThreshold, value);
    return output(result, json, "Account threshold saved.");
  }
  if (sub === "credits") {
    const result = parseDto(creditReceipt, await request("/api/codex-auth/accounts/credits", pinned, { id, creditsAfterLimit: enabled }));
    requireEqual(result.id, id); requireEqual(result.creditsAfterLimit, enabled);
    return output(result, json, enabled ? "Paid-credit use enabled for this account." : "Paid-credit use disabled for this account.");
  }
  const reply = record(await request("/api/settings", pinned, { codexQuotaAutoRefresh: { id, window, enabled } }));
  requireEqual(reply.ok, true);
  const settings = record(reply.codexQuotaAutoRefresh);
  // Disabling the last window removes the settings entry, by the existing server contract.
  const setting = Object.hasOwn(settings, id) ? record(settings[id]) : { fiveHour: false, weekly: false };
  if (typeof setting.fiveHour !== "boolean" || typeof setting.weekly !== "boolean") throw new Error("Invalid window settings");
  requireEqual(setting[window!], enabled);
  const selected = (await roster(pinned)).find(row => row.id === id);
  if (!selected || selected.quota === undefined) throw new Error("Missing quota evidence after save");
  const available = selected.quotaAutoRefresh
    ? selected.quotaAutoRefresh[window === "fiveHour" ? "fiveHourAvailable" : "weeklyAvailable"]
    : window === "fiveHour" ? selected.quota?.shortWindowSeconds === 18000 && typeof selected.quota.shortResetAt === "number"
      : typeof selected.quota?.weeklyResetAt === "number";
  return output({ ok: true, id, window, enabled: setting[window!], available }, json, "Quota activation setting saved; scheduled refresh is separate.");
}

/** New policy verbs use strict runtime identity; legacy pool-scope auto-switch stays in its existing owner. */
export async function handleAccountPolicyCommand(sub: Subcommand, args: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const rest = [...args], json = takeFlag(rest, "--json");
    if (rest.includes("--json")) usage();
    if (sub === "pool") return pool(rest, json, deps);
    if (sub !== "anthropic-reset-grants") return codex(sub, rest, json, deps);
    const selectedProvider = option(rest, "--provider");
    const provider = selectedProvider ?? "anthropic";
    if (!isAnthropicInstanceId(provider)) usage();
    const id = rest.length ? selector(rest.shift()) : undefined;
    done(rest);
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    // Omission preserves legacy A request syntax; explicit calls verify the echoed instance.
    const query = new URLSearchParams();
    if (id) query.set("accountId", id);
    if (selectedProvider !== undefined) query.set("provider", provider);
    const result = parseDto(grantsSchema, await request(`/api/anthropic/reset-grants${query.size ? `?${query}` : ""}`, pinned));
    if (selectedProvider !== undefined || result.provider !== undefined) requireEqual(result.provider, provider);
    if (id) requireEqual(result.accountId, id);
    return output(result, json, "Reset-grant status read; no grant was consumed.");
  }, READ_ERRORS);
}
