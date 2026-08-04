import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUsageSurface, summarizeUsage } from "../src/usage/summary";
import { appendUsageEntry, readUsageEntries } from "../src/usage/log";
import type { PersistedUsageEntry } from "../src/usage/log";

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
  entry(undefined, "via-codex-cli"),
];

function modelsFor(surface: Parameters<typeof summarizeUsage>[3]): string[] {
  return summarizeUsage(ENTRIES, "all", Date.now(), surface).models.map(m => m.model).sort();
}

test("the four buckets are disjoint", () => {
  expect(modelsFor("claude")).toEqual(["via-claude-code", "via-desktop"]);
  expect(modelsFor("grok")).toEqual(["via-grok"]);
  // codex = the historical unlabelled bucket. Crucially it must NOT contain
  // claude-desktop anymore — that was the bug.
  expect(modelsFor("codex")).toEqual(["via-codex-cli"]);
  expect(modelsFor("all")).toEqual(["via-claude-code", "via-codex-cli", "via-desktop", "via-grok"]);
});

test("parseUsageSurface accepts grok and still rejects unknown values", () => {
  expect(parseUsageSurface("grok")).toBe("grok");
  expect(parseUsageSurface("codex")).toBe("codex");
  expect(parseUsageSurface("claude")).toBe("claude");
  expect(parseUsageSurface("chatgpt")).toBe("all");
  expect(parseUsageSurface(null)).toBe("all");
  expect(parseUsageSurface(undefined)).toBe("all");
});

// The serializer regression: a whitelist that drops unknown surfaces at write time
// would make the grok tag invisible after a restart. This is the write->read proof.
test("a grok surface survives the usage-log round trip", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-usage-grok-"));
  const prev = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    appendUsageEntry(entry("grok", "ocx-kimi-k3"));
    appendUsageEntry(entry(undefined, "plain-codex"));
    const entries = await readUsageEntries();
    const grok = entries.find(e => e.model === "ocx-kimi-k3");
    const plain = entries.find(e => e.model === "plain-codex");
    expect(grok?.surface).toBe("grok");
    expect(plain?.surface).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
