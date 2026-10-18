import { expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsageSurface, summarizeUsage } from "../../src/usage/summary";
import { appendUsageEntry, isKnownUsageSurface, normalizePersistedUsageRow, readUsageEntries } from "../../src/usage/log";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * D3: the usage surface taxonomy. Before this fix the codex bucket was
 * `surface !== "claude"`, which swallowed claude-desktop AND every unlabelled request;
 * and the serializers whitelisted only claude/claude-desktop, dropping any new surface
 * at write time.
 */

function entry(surface: PersistedUsageEntry["surface"], model: string): PersistedUsageEntry {
  return {
    requestId: `req-${model}`,
    timestamp: Date.now(),
    provider: "prov",
    model,
    ...(surface ? { surface } : {}),
    status: 200,
    durationMs: 42,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const ENTRIES: PersistedUsageEntry[] = [
  entry("claude", "via-claude-code"),
  entry("claude-desktop", "via-desktop"),
  entry("grok", "via-grok"),
  entry("omp", "via-omp"),
  entry("hermes", "via-hermes"),
  entry(undefined, "via-codex-cli"),
];

function modelsFor(surface: Parameters<typeof summarizeUsage>[3]): string[] {
  return summarizeUsage(ENTRIES, "all", Date.now(), surface).models.map(m => m.model).sort();
}

test("product buckets are disjoint", () => {
  expect(modelsFor("claude")).toEqual(["via-claude-code", "via-desktop"]);
  expect(modelsFor("grok")).toEqual(["via-grok"]);
  expect(modelsFor("omp")).toEqual(["via-omp"]);
  expect(modelsFor("hermes")).toEqual(["via-hermes"]);
  // codex = the historical unlabelled bucket. Crucially it must NOT contain
  // claude-desktop anymore — that was the bug.
  expect(modelsFor("codex")).toEqual(["via-codex-cli"]);
  expect(modelsFor("all")).toEqual(["via-claude-code", "via-codex-cli", "via-desktop", "via-grok", "via-hermes", "via-omp"]);
});

test.each(["claude", "omp", "hermes"] as const)("%s filters totals, days, models and providers", surface => {
  const now = Date.now();
  const entries: PersistedUsageEntry[] = [
    { ...entry(undefined, "untagged"), timestamp: now - 1000, provider: "codex-provider" },
    { ...entry(surface, "product-model"), timestamp: now - 2000, provider: "product-provider" },
  ];
  const all = summarizeUsage(entries, "30d", now);
  expect(all.summary).toMatchObject({ requests: 2, totalTokens: 30 });
  expect(all.days.reduce((requests, day) => requests + day.requests, 0)).toBe(2);
  const codex = summarizeUsage(entries, "30d", now, "codex");
  expect(codex.summary).toMatchObject({ requests: 1, totalTokens: 15 });
  expect(codex.models.map(row => row.model)).toEqual(["untagged"]);
  expect(codex.providers.map(row => row.provider)).toEqual(["codex-provider"]);
  const filtered = summarizeUsage(entries, "30d", now, surface);
  expect(filtered.surface).toBe(surface);
  expect(filtered.summary).toMatchObject({ requests: 1, totalTokens: 15 });
  expect(filtered.days.reduce((requests, day) => requests + day.requests, 0)).toBe(1);
  expect(filtered.models.map(row => row.model)).toEqual(["product-model"]);
  expect(filtered.providers.map(row => row.provider)).toEqual(["product-provider"]);
});

test("surface parsers keep the persisted and summary vocabularies closed", () => {
  expect(parseUsageSurface("grok")).toBe("grok");
  expect(parseUsageSurface("omp")).toBe("omp");
  expect(parseUsageSurface("hermes")).toBe("hermes");
  expect(parseUsageSurface("codex")).toBe("codex");
  expect(parseUsageSurface("claude")).toBe("claude");
  for (const { surface } of ENTRIES) {
    if (surface === undefined) continue;
    expect(isKnownUsageSurface(surface)).toBe(true);
    expect(normalizePersistedUsageRow({ ...entry(undefined, "known"), surface })?.surface).toBe(surface);
  }
  for (const surface of ["chatgpt", "constructor", "__proto__", "toString", "Hermes", " hermes "]) {
    expect(parseUsageSurface(surface)).toBe("all");
    expect(isKnownUsageSurface(surface)).toBe(false);
    expect(normalizePersistedUsageRow({ ...entry(undefined, "unknown"), surface })?.surface).toBeUndefined();
  }
  expect(parseUsageSurface(null)).toBe("all");
  expect(parseUsageSurface(undefined)).toBe("all");
});

// The serializer regression: a whitelist that drops unknown surfaces at write time
// would make supported tags invisible after a restart. This is the write->read proof.
test("grok, omp and hermes surfaces survive the usage-log round trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-usage-surfaces-"));
  const prev = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    appendUsageEntry(entry("grok", "ocx-kimi-k3"));
    appendUsageEntry(entry("omp", "ocx-omp-sonnet"));
    appendUsageEntry(entry("hermes", "ocx-hermes-sonnet"));
    appendUsageEntry(entry(undefined, "plain-codex"));
    const entries = await readUsageEntries();
    const grok = entries.find(e => e.model === "ocx-kimi-k3");
    const omp = entries.find(e => e.model === "ocx-omp-sonnet");
    const hermes = entries.find(e => e.model === "ocx-hermes-sonnet");
    const plain = entries.find(e => e.model === "plain-codex");
    expect(grok?.surface).toBe("grok");
    expect(omp?.surface).toBe("omp");
    expect(hermes?.surface).toBe("hermes");
    expect(summarizeUsage(entries, "all", Date.now(), "omp").models.map(row => row.model)).toEqual(["ocx-omp-sonnet"]);
    expect(summarizeUsage(entries, "all", Date.now(), "hermes").models.map(row => row.model)).toEqual(["ocx-hermes-sonnet"]);
    expect(plain?.surface).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prev;
    removeTreeWithRetry(home);
  }
});
