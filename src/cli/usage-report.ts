/**
 * Human rendering for `ocx usage`.
 *
 * Kept out of `observe.ts` and away from the shared `summaryLines()` helper on
 * purpose. `summaryLines()` is a generic depth-1 flattener shared with
 * storage/memory/debug/claude-inbound/injection; it renders any array as
 * "N item(s)", which is why every per-model and per-provider cost the server
 * computes used to vanish before reaching the terminal. Deepening it would
 * change five unrelated commands.
 *
 * Formatting follows the existing CLI house style: dynamic `padEnd` columns
 * (as in `formatAccountTable`), plain text, no ANSI colour.
 */

interface CostRow {
  provider: string;
  model?: string;
  requests: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

interface UsageReportInput {
  range?: string;
  rangeLabel?: string;
  surface?: string;
  since?: number | null;
  until?: number | null;
  summary?: {
    requests?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    estimatedCostUsd?: number;
    unpricedRequests?: number;
    unmeteredRequests?: number;
  };
  models?: CostRow[];
  providers?: CostRow[];
  days?: { date: string; requests: number; totalTokens: number; estimatedCostUsd?: number }[];
  filter?: { provider: string | null; model: string | null; matched: boolean; comboOverlap: boolean };
  /**
   * Per-account totals the API already returns and the CLI discarded (#2700).
   *
   * Withheld by the server -- sent as `[]` -- whenever a provider or model filter is active,
   * because account rows are not provider-partitioned in a way the projection could honestly
   * re-derive (summary.ts, reasoned around :865-872). An empty array therefore means two very
   * different things, and the renderer must say which.
   */
  accounts?: {
    accountLogLabel: string;
    ambiguous?: boolean;
    requests: number;
    totalTokens: number;
    estimatedCostUsd?: number;
  }[];
}

const MAX_MODEL_ROWS = 10;

function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, character => {
    const code = character.charCodeAt(0);
    return code <= 0x7f
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function count(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

/**
 * Matches the dashboard's `~$` with four fraction digits. Estimates below a
 * hundredth of a cent still read as a number rather than collapsing to $0.00,
 * which matters when a single request is being inspected.
 */
function usd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `~$${value.toFixed(4)}`;
}

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return [];
  header = header.map(terminalText);
  rows = rows.map(row => row.map(terminalText));
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
  const line = (cols: string[]): string => cols.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function describeScope(data: UsageReportInput): string {
  const parts = [`Usage — ${data.range ?? "?"}`];
  if (data.surface && data.surface !== "all") parts.push(`surface=${data.surface}`);
  if (data.filter?.provider) parts.push(`provider=${data.filter.provider}`);
  if (data.filter?.model) parts.push(`model=${data.filter.model}`);
  return terminalText(parts.join(", "));
}

export function formatUsageReport(data: UsageReportInput): string[] {
  const summary = data.summary ?? {};
  const lines: string[] = [describeScope(data), ""];

  if (data.filter && !data.filter.matched) {
    const what = [data.filter.provider && `provider "${data.filter.provider}"`, data.filter.model && `model "${data.filter.model}"`]
      .filter(Boolean).join(" and ");
    lines.push(`No usage recorded for ${terminalText(what)} in this range.`);
    lines.push("Check the spelling against `ocx usage --json`, or widen --range.");
    return lines;
  }

  const tokenSplit = [
    summary.inputTokens !== undefined ? `in ${count(summary.inputTokens)}` : null,
    summary.outputTokens !== undefined ? `out ${count(summary.outputTokens)}` : null,
    summary.cachedInputTokens ? `cached ${count(summary.cachedInputTokens)}` : null,
  ].filter(Boolean).join(" / ");

  lines.push(`Requests   ${count(summary.requests)}`);
  lines.push(`Tokens     ${count(summary.totalTokens)}${tokenSplit ? `  (${tokenSplit})` : ""}`);
  lines.push(`Est. cost  ${usd(summary.estimatedCostUsd)}    API list-price equivalent (this range)`);

  const unpriced = summary.unpricedRequests ?? 0;
  const unmetered = summary.unmeteredRequests ?? 0;
  if (unpriced > 0 || unmetered > 0) {
    // Spelled out because a $0 total is ambiguous otherwise: it can mean "no
    // spend" or "no price row matched", and those are very different answers.
    lines.push(`           ${count(unpriced)} unpriced, ${count(unmetered)} unmetered excluded from ~$`);
  }

  const providers = (data.providers ?? []).filter(row => row.requests > 0);
  if (providers.length > 0) {
    lines.push("");
    lines.push(...table(
      ["PROVIDER", "REQUESTS", "TOKENS", "EST. COST"],
      providers.map(row => [row.provider, count(row.requests), count(row.totalTokens), usd(row.estimatedCostUsd)]),
    ));
  }

  // Per-account spend (#2700). The two empty cases are distinguished deliberately: printing an
  // empty table under a filter would repeat the silently-wrong-output defect this unit removes,
  // because "what did this provider cost me per account" is the most natural way to ask and the
  // server cannot answer it honestly.
  const accountFilterActive = Boolean(data.filter?.provider || data.filter?.model);
  const accounts = (data.accounts ?? []).filter(row => row.requests > 0);
  if (accountFilterActive) {
    lines.push("");
    lines.push("ACCOUNT: not reported under a provider or model filter; run without filters for per-account totals.");
  } else if (accounts.length > 0) {
    lines.push("");
    lines.push(...table(
      ["ACCOUNT", "REQUESTS", "TOKENS", "EST. COST"],
      accounts.map(row => [
        // An ambiguous row aggregates several accounts, so reading it as one account draws the
        // wrong conclusion. Mark it rather than presenting it as a single identity.
        row.ambiguous ? `${terminalText(row.accountLogLabel)} (ambiguous)` : terminalText(row.accountLogLabel),
        count(row.requests),
        count(row.totalTokens),
        usd(row.estimatedCostUsd),
      ]),
    ));
  }

  const models = (data.models ?? []).filter(row => row.requests > 0);
  if (models.length > 0) {
    lines.push("");
    const shown = models.slice(0, MAX_MODEL_ROWS);
    lines.push(...table(
      ["MODEL", "PROVIDER", "REQUESTS", "TOKENS", "EST. COST"],
      shown.map(row => [row.model ?? "-", row.provider, count(row.requests), count(row.totalTokens), usd(row.estimatedCostUsd)]),
    ));
    if (models.length > shown.length) {
      lines.push(`... ${models.length - shown.length} more (use --json)`);
    }
  }

  if (data.filter?.comboOverlap) {
    lines.push("");
    lines.push("Some requests ran as combos, so per-model request counts can overlap. Cost does not.");
  }

  lines.push("");
  lines.push("Not a billing receipt. Subscription usage or provider credits may apply instead.");
  return lines;
}

export function formatUsageMarkdownReport(data: UsageReportInput): string[] {
  const summary = data.summary ?? {};
  const label = data.rangeLabel || data.range || "custom";
  const lines = [
    "### OpenCodex Usage Report (" + label + ")",
    "",
    "- **Requests**: " + count(summary.requests),
    "- **Total Tokens**: " + count(summary.totalTokens),
    "  - Input Tokens: " + count(summary.inputTokens) + " (Cached: " + count(summary.cachedInputTokens) + ")",
    "  - Output Tokens: " + count(summary.outputTokens),
    "- **Estimated API Cost**: " + usd(summary.estimatedCostUsd),
    ""
  ];
  const models = (data.models ?? []).filter(r => r.requests > 0);
  if (models.length > 0) {
    lines.push("| Model | Provider | Requests | Total Tokens | Est. Cost |");
    lines.push("| :--- | :--- | :--- | :--- | :--- |");
    for (const r of models) {
      lines.push("| " + (r.model || "-") + " | " + r.provider + " | " + count(r.requests) + " | " + count(r.totalTokens) + " | " + usd(r.estimatedCostUsd) + " |");
    }
  }
  return lines;
}
