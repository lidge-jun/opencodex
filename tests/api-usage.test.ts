import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { resetUsageReadCacheForTests, usageReadCacheStatsForTests } from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

function writeFixture(now: number): void {
  const lines = [
    JSON.stringify({
      requestId: "ocx-old",
      timestamp: now - 10 * 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 12,
      usageStatus: "reported",
      usage: { inputTokens: 100, outputTokens: 50 },
      totalTokens: 150,
    }),
    JSON.stringify({
      requestId: "ocx-recent",
      timestamp: now - 1 * 86_400_000,
      provider: "openai",
      model: "gpt-5.5",
      status: 200,
      durationMs: 10,
      usageStatus: "reported",
      usage: { inputTokens: 10, outputTokens: 5 },
      totalTokens: 15,
    }),
    JSON.stringify({
      requestId: "ocx-missing",
      timestamp: now - 1 * 86_400_000,
      provider: "anthropic",
      model: "claude-x",
      surface: "claude",
      status: 200,
      durationMs: 11,
      usageStatus: "unreported",
    }),
  ];
  writeFileSync(join(testDir, "usage.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-usage-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-usage-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("GET /api/usage", () => {
  test("returns documented shape with summary, days, models, providers", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("range");
      expect(body.surface).toBe("all");
      expect(body).toHaveProperty("summary");
      expect(body).toHaveProperty("days");
      expect(body).toHaveProperty("models");
      expect(body).toHaveProperty("providers");
      expect(body).toMatchObject({ historyTruncated: false, truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0 });
      expect(Array.isArray(body.days)).toBe(true);
      expect(Array.isArray(body.models)).toBe(true);
      expect(Array.isArray(body.providers)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("usage route cache preserves truncation metadata and invalidates when configured byte limit changes", async () => {
    writeFixture(Date.now());
    saveConfig({ ...baseConfig(), managementUsageMaxReadBytes: 256 });
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/usage?range=all", server.url)).then(response => response.json());
      const second = await fetch(new URL("/api/usage?range=all", server.url)).then(response => response.json());
      expect(first.historyTruncated).toBe(true);
      expect(first.truncatedPrefixBytes).toBeGreaterThan(0);
      expect(second).toMatchObject({
        historyTruncated: first.historyTruncated,
        truncatedPrefixBytes: first.truncatedPrefixBytes,
        entriesTruncated: first.entriesTruncated,
        entriesDropped: first.entriesDropped,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("reuses only a compact summary for an unchanged revision", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      const second = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(second.summary).toEqual(first.summary);
      expect(usageReadCacheStatsForTests().fullReads).toBe(1);

      appendFileSync(join(testDir, "usage.jsonl"), `${JSON.stringify({
        requestId: "ocx-appended",
        timestamp: Date.now(),
        provider: "openai",
        model: "gpt-5.5",
        status: 200,
        durationMs: 1,
        usageStatus: "reported",
        usage: { inputTokens: 1, outputTokens: 1 },
        totalTokens: 2,
      })}\n`);
      const changed = await fetch(new URL("/api/usage?range=30d", server.url)).then(res => res.json());
      expect(changed.summary.requests).toBe(first.summary.requests + 1);
      expect(usageReadCacheStatsForTests().fullReads).toBe(2);
    } finally {
      await server.stop(true);
    }
  });

  test("range=7d drops entries older than 7 days", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?range=7d", server.url));
      const body = await res.json();
      expect(body.range).toBe("7d");
      expect(body.summary.requests).toBe(2);
      expect(body.summary.totalTokens).toBe(15);
    } finally {
      await server.stop(true);
    }
  });

  test("default range is 30d and includes the older entry", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      const body = await res.json();
      expect(body.range).toBe("30d");
      expect(body.summary.requests).toBe(3);
      expect(body.summary.measuredRequests).toBe(2);
      expect(body.summary.reportedRequests).toBe(2);
      expect(body.summary.unreportedRequests).toBe(1);
      expect(body.summary.totalTokens).toBe(165);
    } finally {
      await server.stop(true);
    }
  });

  test("unknown range falls back to 30d", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?range=quarter", server.url));
      const body = await res.json();
      expect(body.range).toBe("30d");
    } finally {
      await server.stop(true);
    }
  });

  test("filters by surface and normalizes unknown values to all", async () => {
    writeFixture(Date.now());
    const server = startServer(0);
    try {
      const codex = await fetch(new URL("/api/usage?range=all&surface=codex", server.url)).then(res => res.json());
      expect(codex.surface).toBe("codex");
      expect(codex.summary).toMatchObject({ requests: 2, totalTokens: 165 });
      expect(codex.models.map((model: { model: string }) => model.model)).toEqual(["gpt-5.5"]);
      expect(codex.providers.map((provider: { provider: string }) => provider.provider)).toEqual(["openai"]);

      const claude = await fetch(new URL("/api/usage?range=all&surface=claude", server.url)).then(res => res.json());
      expect(claude.surface).toBe("claude");
      expect(claude.summary).toMatchObject({ requests: 1, totalTokens: 0 });
      expect(claude.models.map((model: { model: string }) => model.model)).toEqual(["claude-x"]);
      expect(claude.providers.map((provider: { provider: string }) => provider.provider)).toEqual(["anthropic"]);

      const fallback = await fetch(new URL("/api/usage?range=all&surface=unknown", server.url)).then(res => res.json());
      expect(fallback.surface).toBe("all");
      expect(fallback.summary).toMatchObject({ requests: 3, totalTokens: 165 });
    } finally {
      await server.stop(true);
    }
  });

  test("read failure keeps the normalized surface in the fallback response", async () => {
    mkdirSync(join(testDir, "usage.jsonl"));
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage?surface=claude", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.surface).toBe("claude");
      expect(body.summary.requests).toBe(0);
      expect(body.error).toBe("read_failed");
    } finally {
      await server.stop(true);
    }
  });

  test("missing usage.jsonl returns zeroed summary, not 500", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/usage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.requests).toBe(0);
      expect(body.summary.measuredRequests).toBe(0);
      expect(body.summary.totalTokens).toBe(0);
      expect(body.summary.coverageRatio).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
