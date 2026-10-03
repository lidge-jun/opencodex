import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectUsageModelView, takeUsageSearchOption } from "../../src/cli/usage-model-search";
import { formatUsageReport } from "../../src/cli/usage-report";
import { summarizeUsage } from "../../src/usage/summary";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleObserveCommand } from "../../src/cli/observe";

const rows = [
  { model: "Alpha", provider: "one", requests: 2, totalTokens: 20 },
  { model: "Beta", provider: "ALPHA-cloud", requests: 1, totalTokens: 30 },
  { model: "Gamma", provider: "three", resolvedModel: "vendor/alpha", requests: 0, totalTokens: 30 },
  { model: "Delta", provider: "four", requests: 1, totalTokens: 40 },
];
const report = { range: "today", summary: { requests: 4, totalTokens: 120 }, models: rows, providers: [], days: [], accounts: [], usageIncomplete: true as const,
  filter: { provider: "exact", model: "attribution", apiKeyId: "key-1", matched: true, comboOverlap: false } };

// Execute only the checked-in pure useMemo callback, never mount the React page.
const source = readFileSync(repoPath("gui/src/pages/Usage.tsx"), "utf8");
const body = source.split("const filteredModels = useMemo(() => {")[1]?.split("}, [data?.models, modelQuery]);")[0];
if (!body) throw new Error("Usage model-search owner changed; inspect its new contract");
const guiView = new Function("data", "modelQuery", body) as (data: typeof report, query: string) => typeof rows;

test("search matches all three GUI fields, trims/case-folds and preserves stable ties and totals", () => {
  const result = selectUsageModelView(report, " ALphA ");
  expect(result.models.map(row => row.model)).toEqual(["Beta", "Gamma", "Alpha"]);
  expect(result.models).toEqual(guiView(report, " ALphA "));
  expect(result.modelView).toEqual({ query: "alpha", matchedModelCount: 3, returnedModelCount: 3, limit: 100, truncated: false });
  for (const key of ["summary", "providers", "days", "accounts", "filter"] as const) expect(result[key]).toBe(report[key]);
  expect(result.usageIncomplete).toBe(true);
  expect(report.models).toBe(rows);
  expect(rows.map(row => row.model)).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
});

test("blank, no match and more than 100 rows have model-only counts", () => {
  const models = Array.from({ length: 103 }, (_, i) => ({ model: `m${i}`, provider: "p", requests: 0, totalTokens: i }));
  const result = selectUsageModelView({ ...report, models }, " \t ");
  expect(result.models).toHaveLength(100);
  expect(result.models[0]?.model).toBe("m102");
  expect(result.models[99]?.model).toBe("m3");
  expect(result.modelView).toEqual({ query: "", matchedModelCount: 103, returnedModelCount: 100, limit: 100, truncated: true });
  const none = selectUsageModelView(report, "missing");
  expect(none.models).toEqual([]);
  expect(none.summary.totalTokens).toBe(120);
  expect(none.filter.matched).toBe(true);
  expect(formatUsageReport(none, { modelView: none.modelView }).join("\n")).toContain("No model rows match this search");
});

test("parser preserves missing versus explicit empty, supports equals and rejects duplicates", () => {
  const absent = ["--json"];
  expect(takeUsageSearchOption(absent)).toBeUndefined();
  expect(absent).toEqual(["--json"]);
  for (const flags of [["--search="], ["--search", ""], ["--search", "  "]]) expect(takeUsageSearchOption(flags)?.trim()).toBe("");
  const args = ["--model", "exact", "--search=Alpha", "--json"];
  expect(takeUsageSearchOption(args)).toBe("Alpha");
  expect(args).toEqual(["--model", "exact", "--json"]);
  for (const flags of [["--search"], ["--search", "--json"], ["--search=x", "--search=y"], ["--search", "x", "--search="]]) {
    expect(() => takeUsageSearchOption(flags)).toThrow();
  }
});

test("malformed models cannot masquerade as an empty search", () => {
  for (const models of [undefined, null, {}, [null], [{}], [{ ...rows[0], totalTokens: NaN }], [{ ...rows[0], requests: "2" }], [{ ...rows[0], resolvedModel: null }]]) {
    expect(() => selectUsageModelView({ models }, "no-match")).toThrow();
  }
});

test("view renderer retains zero-request rows and 100-row scope; legacy renderer retains its cap", () => {
  const models = Array.from({ length: 100 }, (_, i) => ({ model: `row-${i}`, provider: "p", requests: i === 99 ? 0 : 1, totalTokens: 100 - i }));
  const data = { ...report, models };
  const legacy = formatUsageReport(data).join("\n");
  expect(legacy).toContain("... 89 more (use --json)");
  expect(legacy).not.toContain("row-99");
  const selected = selectUsageModelView(data, "");
  const rendered = formatUsageReport(selected, { modelView: selected.modelView }).join("\n");
  expect(rendered).toContain("row-99");
  expect(rendered).toContain("100 of 100 matching model rows");
  expect(rendered).toContain("Tokens     120");
  expect(rendered).toContain("WARNING: Usage is incomplete");
  expect(formatUsageReport(data, {}).join("\n")).toBe(legacy);
});

test("actual summary DTO is accepted and a failed attribution match is not rescued by local search", () => {
  const dto = summarizeUsage([], "today", 1_700_000_000_000);
  expect(selectUsageModelView(dto, "").models).toEqual([]);
  const selected = selectUsageModelView({ ...report, filter: { ...report.filter, matched: false } }, "Alpha");
  expect(selected.filter.matched).toBe(false);
  expect(formatUsageReport(selected, { modelView: selected.modelView }).join("\n")).toContain("No matching readable usage records");
  expect(formatUsageReport(selected, { modelView: selected.modelView }).join("\n")).toContain('Model search "alpha": 3 of 3');
});

async function isolated(run: (home: string, out: ReturnType<typeof spyOn<typeof console, "log">>, err: ReturnType<typeof spyOn<typeof console, "error">>) => Promise<void>) {
  const prior = process.env.OPENCODEX_HOME, home = mkdtempSync(join(tmpdir(), "ocx-usage-search-"));
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "admin-api-token"), "synthetic-admin");
  const out = spyOn(console, "log").mockImplementation(() => {}), err = spyOn(console, "error").mockImplementation(() => {});
  try { await run(home, out, err); } finally {
    out.mockRestore(); err.mockRestore();
    if (prior === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = prior;
    removeTreeWithRetry(home);
  }
}

test("wired search stays local after exact key/model/provider/window acknowledgment", () => isolated(async (_home, out, err) => {
  const args = ["usage", "--search", "alpha", "--api-key-id", "key-1", "--provider", "exact", "--model", "attribution", "--since", "10", "--until", "20", "--json"];
  const dto = { ...report, customWindow: true, since: 10, until: 20 };
  expect(await handleObserveCommand(args, { baseUrl: "http://fixture.test", fetchImpl: (async input => {
    expect(Object.fromEntries(new URL(String(input)).searchParams)).toEqual({ range: "30d", surface: "all", provider: "exact", model: "attribution", apiKeyId: "key-1", since: "10", until: "20" });
    return Response.json(dto);
  }) as typeof fetch })).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]?.[0])).models.map((row: { model: string }) => row.model)).toEqual(["Beta", "Gamma", "Alpha"]);
  for (const invalid of [{ ...dto, filter: { ...dto.filter, apiKeyId: "other" } }, { ...dto, until: 21 }]) {
    out.mockClear();
    expect(await handleObserveCommand(args, { baseUrl: "http://fixture.test", fetchImpl: (async () => Response.json(invalid)) as typeof fetch })).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.flat().join(" ")).toContain("did not confirm");
  }
}));

test("connected self usage preserves enrolled authority and refuses other-key scope before I/O", () => isolated(async (home, out) => {
  const token = "synthetic-client-token";
  const connection = { serverUrl: "https://hub.example.test", managementUrl: "https://manage.example.test", managementTransport: "direct", selectedClients: ["claude"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "own", tokenFingerprint: createHash("sha256").update(token).digest("hex"), protocolVersion: 1, connectedAt: "2026-09-01T00:00:00.000Z" };
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", runtimeRole: "client", client: connection }));
  writeFileSync(join(home, "service-api-token"), token);
  let calls = 0;
  const deps = { fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(String(input)).toBe("https://hub.example.test/v1/usage?range=30d&surface=all");
    expect(new Headers(init?.headers).get("x-opencodex-api-key")).toBe(token);
    return Response.json({ ...report, schemaVersion: 1, source: "hub", scope: "client", generatedAt: 1, since: null, surface: "all",
      summary: { ...report.summary, inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, unpricedRequests: 4, unmeteredRequests: 0 } });
  }) as typeof fetch };
  expect(await handleObserveCommand(["usage", "--search", "alpha", "--json"], deps)).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]?.[0])).scope).toBe("client");
  expect(calls).toBe(1);
  out.mockClear();
  expect(await handleObserveCommand(["usage", "--search", "alpha", "--api-key-id", "other", "--json"], deps)).toBe(2);
  expect(calls).toBe(1); expect(out).not.toHaveBeenCalled();
}));

test("invalid search stops before discovery; absent search preserves the original JSON", () => isolated(async (_home, out) => {
  let calls = 0;
  const deps = { baseUrl: "http://fixture.test", fetchImpl: (async () => { calls++; return Response.json(report); }) as typeof fetch };
  for (const flags of [["--search"], ["--search", "--json"], ["--search=x", "--search=y"]]) {
    expect(await handleObserveCommand(["usage", ...flags], deps)).toBe(2);
  }
  expect(calls).toBe(0);
  expect(await handleObserveCommand(["usage", "--json"], deps)).toBe(0);
  expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toEqual(report);
}));
