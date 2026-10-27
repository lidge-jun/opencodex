/**
 * Compare a bounded usage range with the previous equal window.
 *
 * Two sequential GET /api/usage reads with acknowledged custom bounds.
 * `--range all` is refused: there is no previous equal window for open history.
 */
import { readClientConnectionState, sameClientConnectionOwner } from "../client/state";
import { fetchHubUsage } from "../client/hub-client";
import { readServiceApiTokenState, serviceApiTokenFingerprint } from "../lib/service-secrets";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import { readRuntimePort, type RuntimePortState } from "../config/process-state";
import { isLocalAttestationSecret } from "../lib/local-management-attestation";
import { redactSecretString } from "../lib/redact";
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { fetchBoundLocalManagementRead, type LocalManagementReadDeps } from "../server/local-management-read-client";
import { rangeWindow, USAGE_SURFACES } from "../usage/summary";
import type { UsageTimeWindow } from "../usage/time-range";
import {
  CliUsageError,
  printData,
  rejectArgs,
  RuntimeApiError,
  PROXY_NOT_RUNNING_MESSAGE,
  takeFlag,
  takeOption,
  takeOptionWithSyntax,
  type RuntimeApiDeps,
} from "./runtime-api";

export const USAGE_COMPARE_USAGE = `Usage:
  ocx usage compare [--range <today|1d|7d|30d>] [--surface <all|codex|claude|grok>]
      [--provider <name>] [--model <id>] [--api-key-id <id>] [--json]`;

export type CompareRange = "today" | "7d" | "30d";
export type UsageCompareDeps = RuntimeApiDeps & Pick<LocalManagementReadDeps, "directFetch"> & {
  now?: () => number;
  readRuntime?: typeof readRuntimePort;
};

const METRICS = ["requests", "totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "estimatedCostUsd"] as const;
type Metric = typeof METRICS[number];
type Totals = Partial<Record<Metric, number>>;
type ScopedUsage = {
  customWindow?: boolean;
  since?: number | null;
  until?: number;
  summary?: Totals;
  usageIncomplete?: boolean;
  filter?: Record<string, unknown>;
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

function parseCompareRange(raw: string): CompareRange {
  if (raw === "all") throw new CliUsageError("--range all has no previous equal window; use today, 1d, 7d or 30d", USAGE_COMPARE_USAGE);
  if (raw === "today" || raw === "1d") return "today";
  if (raw === "7d" || raw === "30d") return raw;
  throw new CliUsageError("--range must be one of today, 1d, 7d, 30d", USAGE_COMPARE_USAGE);
}

/** Named range at `now`, then the same range evaluated one equal window earlier. */
export function compareUsageWindows(range: CompareRange, now: number): {
  current: UsageTimeWindow;
  previous: UsageTimeWindow;
  days: number;
} {
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  const { since } = rangeWindow(range, now);
  if (since === null) throw new Error("compare requires a bounded usage range");
  const prior = new Date(now);
  prior.setDate(prior.getDate() - days);
  const priorNow = prior.getTime();
  const { since: previousSince } = rangeWindow(range, priorNow);
  if (previousSince === null) throw new Error("compare requires a bounded usage range");
  return {
    current: Object.freeze({ since, until: now }),
    previous: Object.freeze({ since: previousSince, until: priorNow }),
    days,
  };
}

function metric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function totalsOf(report: ScopedUsage): Totals {
  const row = report.summary ?? {};
  const totals: Totals = {};
  for (const key of METRICS) {
    const value = metric((row as Totals)[key]);
    if (value !== undefined) totals[key] = value;
  }
  return totals;
}

function delta(current?: number, previous?: number): number | undefined {
  if (current === undefined || previous === undefined) return undefined;
  return current - previous;
}

function changePct(current?: number, previous?: number): number | null | undefined {
  if (current === undefined || previous === undefined) return undefined;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous * 100;
}

function count(value: number | undefined): string {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function usd(value: number | undefined): string {
  return value === undefined ? "—" : `~$${value.toFixed(4)}`;
}

function signed(value: number | undefined, money: boolean): string {
  if (value === undefined) return "—";
  const abs = money ? usd(Math.abs(value)) : count(Math.abs(value));
  if (value === 0) return money ? usd(0) : "0";
  return `${value > 0 ? "+" : "-"}${abs}`;
}

function pct(value: number | null | undefined): string {
  if (value === undefined) return "—";
  if (value === null) return "n/a";
  const abs = Math.abs(value).toFixed(1);
  if (value === 0) return "0.0%";
  return `${value > 0 ? "+" : "-"}${abs}%`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function formatCompare(input: {
  range: CompareRange;
  days: number;
  currentWindow: UsageTimeWindow;
  previousWindow: UsageTimeWindow;
  current: Totals;
  previous: Totals;
  incomplete: boolean;
}): string[] {
  const lines = [
    `Usage compare — ${input.range} vs previous ${input.days} local day${input.days === 1 ? "" : "s"} (equal window)`,
    `Current   ${iso(input.currentWindow.since)} to ${iso(input.currentWindow.until)}`,
    `Previous  ${iso(input.previousWindow.since)} to ${iso(input.previousWindow.until)}`,
    "",
  ];
  if (input.incomplete) {
    lines.push("WARNING: Usage is incomplete; some records could not be included. Totals reflect readable records only.", "");
  }
  const labels: Record<Metric, string> = {
    requests: "Requests",
    totalTokens: "Tokens",
    inputTokens: "Input",
    outputTokens: "Output",
    cachedInputTokens: "Cached",
    estimatedCostUsd: "Est. cost",
  };
  const rows = METRICS.map(key => {
    const money = key === "estimatedCostUsd";
    const show = money ? usd : count;
    return [
      labels[key],
      show(input.current[key]),
      show(input.previous[key]),
      signed(delta(input.current[key], input.previous[key]), money),
      pct(changePct(input.current[key], input.previous[key])),
    ];
  });
  const header = ["METRIC", "CURRENT", "PREVIOUS", "DELTA", "CHANGE"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  lines.push(line(header), ...rows.map(line), "", "Not a billing receipt. Subscription usage or provider credits may apply instead.");
  return lines;
}

// Private command-local authority; neither credentials nor fingerprints enter output.
function captureUsageOwner() {
  const connection = readClientConnectionState();
  if (connection.kind === "invalid" || connection.kind === "mismatched") {
    throw new Error(`Client usage unavailable: ${connection.reason}`);
  }
  const token = readServiceApiTokenState();
  if (connection.kind === "connected" && (token.kind !== "present" || token.fingerprint !== connection.value.tokenFingerprint)) {
    throw new Error("Client usage unavailable: the enrolled data key is missing or changed; repair the client connection");
  }
  const headers = runningProxyUpdateHeaders();
  const fingerprint = connection.kind === "connected" ? connection.value.tokenFingerprint
    : serviceApiTokenFingerprint(headers.get("X-OpenCodex-API-Key") ?? "");
  return { connection, token, fingerprint };
}
type UsageOwner = ReturnType<typeof captureUsageOwner>;

function pinUsageRuntime(deps: UsageCompareDeps, owner: UsageOwner): (suffix: string) => Promise<ScopedUsage> {
  const readRuntime = deps.readRuntime ?? readRuntimePort;
  const initial = readRuntimePortForComparison();
  const pinned = { ...initial };
  let liveIdentity: string | undefined;
  function readRuntimePortForComparison(): RuntimePortState {
    const runtime = readRuntime();
    if (!runtime || !isLocalAttestationSecret(runtime.attestationSecret)) {
      throw new Error("Usage runtime unavailable: restart the proxy with an attested runtime record.");
    }
    return runtime;
  }
  function assertRuntime(): RuntimePortState {
    const current = readRuntimePortForComparison();
    if (current.pid !== pinned.pid || current.port !== pinned.port || current.hostname !== pinned.hostname
      || current.attestationSecret !== pinned.attestationSecret) {
      throw new Error("Usage runtime changed during comparison; no comparison was produced. Retry for the current runtime.");
    }
    return current;
  }
  return async suffix => {
    assertRuntime();
    const live = await (deps.findLiveProxy ?? findLiveProxy)();
    assertRuntime();
    assertUsageOwner(owner);
    if (!live) throw new RuntimeApiError(PROXY_NOT_RUNNING_MESSAGE, 503, null, "proxy_not_running");
    const identity = JSON.stringify([live.pid, live.port, live.hostname, live.source, live.role]);
    if (live.source !== "runtime" || live.pid !== pinned.pid || live.port !== pinned.port
      || probeHostname(live.hostname) !== probeHostname(pinned.hostname) || live.role === "client"
      || (liveIdentity !== undefined && liveIdentity !== identity)) {
      throw new Error("Usage runtime changed during comparison; no comparison was produced. Retry for the current runtime.");
    }
    liveIdentity = identity;
    const read = await fetchBoundLocalManagementRead(live, `/api/usage?${suffix.replace(/^\?/, "")}`, {
      fetchImpl: deps.fetchImpl, directFetch: deps.directFetch, readRuntime: assertRuntime,
      timeoutMs: 60_000, requireResponseProof: true,
    });
    assertRuntime();
    if (read.kind === "unavailable") {
      throw new RuntimeApiError(`Local usage read unavailable (${read.reason}). No comparison was produced.`, 503, null);
    }
    if (!read.response.ok) {
      throw new RuntimeApiError(`Usage request failed (HTTP ${read.response.status}). No comparison was produced.`, read.response.status, null);
    }
    const result = await read.response.json() as ScopedUsage;
    assertRuntime();
    return result;
  };
}

function assertUsageOwner(owner: UsageOwner): void {
  const current = readClientConnectionState();
  const expected = owner.connection;
  let same = current.kind === expected.kind;
  if (expected.kind === "connected") {
    const token = readServiceApiTokenState();
    same = current.kind === "connected" && sameClientConnectionOwner(current.value, expected.value)
      && current.value.transport === expected.value.transport
      && JSON.stringify(current.value.link) === JSON.stringify(expected.value.link)
      && current.value.tokenFingerprint === owner.fingerprint
      && token.kind === "present" && token.fingerprint === owner.fingerprint;
  } else {
    same &&= serviceApiTokenFingerprint(runningProxyUpdateHeaders().get("X-OpenCodex-API-Key") ?? "") === owner.fingerprint;
  }
  if (!same) throw new Error("Usage owner changed during comparison; no comparison was produced. Retry for the current connection and credential.");
}

async function readUsage(
  suffix: string,
  window: UsageTimeWindow,
  apiKeyId: string | undefined,
  deps: RuntimeApiDeps,
  owner: UsageOwner,
  localRead?: (suffix: string) => Promise<ScopedUsage>,
): Promise<ScopedUsage> {
  assertUsageOwner(owner);
  const { connection, token } = owner;
  let result: ScopedUsage;
  if (connection.kind === "connected") {
    if (apiKeyId !== undefined) {
      throw new CliUsageError("--api-key-id is unavailable on connected clients; run on the hub for a selected key, or omit it for this client's usage", USAGE_COMPARE_USAGE);
    }
    if (token.kind !== "present" || token.fingerprint !== connection.value.tokenFingerprint) {
      throw new Error("Client usage unavailable: the enrolled data key is missing or changed; repair the client connection");
    }
    const link = connection.value.transport === "link" && connection.value.link;
    const peerFetch = deps.fetchImpl
      ?? (link ? (await import("../client/link-home")).linkBoundFetch(connection.value, token.token) : undefined);
    result = await fetchHubUsage(connection.value.serverUrl, token.token, new URLSearchParams(suffix.replace(/^\?/, "")), {
      fetchImpl: peerFetch, timeoutMs: 60_000, ...(link ? { peer: "Home" as const } : {}),
    });
  } else {
    try {
      result = await localRead!(suffix);
    } catch (error) {
      if (apiKeyId === undefined) throw error;
      if (error instanceof RuntimeApiError) throw error;
      throw new Error("Key-scoped usage could not be read. Check runtime access and retry.");
    }
    if (apiKeyId !== undefined && result.filter?.apiKeyId !== apiKeyId) {
      throw new Error("The server did not confirm the requested API key scope. Upgrade and restart the proxy, then retry.");
    }
  }
  if (result?.customWindow !== true || result.since !== window.since || result.until !== window.until) {
    throw new Error("The server did not confirm the requested custom usage window. Upgrade and restart the proxy, then retry.");
  }
  assertUsageOwner(owner);
  return result;
}

/** Compare the current named range with the previous equal window through two /api/usage reads. */
export async function handleUsageCompareCommand(argv: string[], deps: UsageCompareDeps = {}): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const range = parseCompareRange(takeOption(args, "--range") ?? "30d");
  const surface = takeOption(args, "--surface") ?? "all";
  const provider = takeOption(args, "--provider");
  const model = takeOption(args, "--model");
  const rawKeyId = takeOptionWithSyntax(args, "--api-key-id")?.value;
  const apiKeyId = rawKeyId?.trim();
  if (apiKeyId !== undefined && !apiKeyId) throw new CliUsageError("--api-key-id must not be blank", USAGE_COMPARE_USAGE);
  if (takeOption(args, "--since") !== undefined || takeOption(args, "--until") !== undefined) {
    throw new CliUsageError("compare derives both windows; do not pass --since or --until", USAGE_COMPARE_USAGE);
  }
  if (!USAGE_SURFACES.includes(surface as (typeof USAGE_SURFACES)[number])) {
    throw new CliUsageError(`--surface must be one of ${USAGE_SURFACES.join(", ")}`, USAGE_COMPARE_USAGE);
  }
  rejectArgs(args.map(redactSecretString), USAGE_COMPARE_USAGE);
  const now = deps.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) throw new CliUsageError("compare clock is invalid", USAGE_COMPARE_USAGE);
  const windows = compareUsageWindows(range, now);
  const filters = { range, surface, provider, model, apiKeyId };
  const owner = captureUsageOwner();
  const localRead = owner.connection.kind === "disconnected" ? pinUsageRuntime(deps, owner) : undefined;
  const currentReport = await readUsage(query({ ...filters, since: windows.current.since, until: windows.current.until }), windows.current, apiKeyId, deps, owner, localRead);
  const previousReport = await readUsage(query({ ...filters, since: windows.previous.since, until: windows.previous.until }), windows.previous, apiKeyId, deps, owner, localRead);
  const current = totalsOf(currentReport);
  const previous = totalsOf(previousReport);
  const deltaTotals: Totals = {};
  const change: Partial<Record<Metric, number | null>> = {};
  for (const key of METRICS) {
    const d = delta(current[key], previous[key]);
    if (d !== undefined) deltaTotals[key] = d;
    const pctValue = changePct(current[key], previous[key]);
    if (pctValue !== undefined) change[key] = pctValue;
  }
  const incomplete = currentReport.usageIncomplete === true || previousReport.usageIncomplete === true;
  const result = {
    schemaVersion: 1,
    range,
    surface,
    days: windows.days,
    filter: { provider: provider ?? null, model: model ?? null, apiKeyId: apiKeyId ?? null },
    current: { since: windows.current.since, until: windows.current.until, summary: current, usageIncomplete: currentReport.usageIncomplete === true },
    previous: { since: windows.previous.since, until: windows.previous.until, summary: previous, usageIncomplete: previousReport.usageIncomplete === true },
    delta: deltaTotals,
    change,
    incomplete,
  };
  printData(result, wantsJson, wantsJson ? undefined : formatCompare({
    range, days: windows.days, currentWindow: windows.current, previousWindow: windows.previous,
    current, previous, incomplete,
  }));
}
