import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { appendDebugLogLine, getDebugLogEntries, resetDebugLogBufferForTests } from "../src/lib/debug-log-buffer";
import { clearDebugSettings, setDebugSettings } from "../src/lib/debug-settings";
import { debugProviderDiagnostic } from "../src/lib/debug";
import { getInjectionDebugLogEntries, injectionDebugLog, resetInjectionDebugLogBufferForTests } from "../src/lib/injection-debug-log";
import { startServer } from "../src/server";
import { appendUsageDebug } from "../src/usage/debug";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

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

function loopbackOrigin(server: { port: number }): string {
  return `http://127.0.0.1:${server.port}`;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-debug-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-debug-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
  resetDebugLogBufferForTests();
  resetInjectionDebugLogBufferForTests();
  clearDebugSettings();
  delete process.env.OCX_DEBUG;
  delete process.env.OPENCODEX_USAGE_DEBUG;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  resetDebugLogBufferForTests();
  resetInjectionDebugLogBufferForTests();
  clearDebugSettings();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("management API /api/debug", () => {
  test("GET returns provider + usage debug view", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/debug", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        enabled: false,
        usage: false,
        injection: false,
      });
      expect(body).toHaveProperty("runtimeOverride");
      expect(body).toHaveProperty("env");
    } finally {
      await server.stop(true);
    }
  });

  test("PUT toggles runtime flags and reset clears overrides", async () => {
    const server = startServer(0);
    const origin = loopbackOrigin(server);
    try {
      const on = await fetch(new URL("/api/debug", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ debug: true, usage: true, injection: true }),
      });
      expect(on.status).toBe(200);
      expect(await on.json()).toMatchObject({ enabled: true, usage: true, injection: true });

      const reset = await fetch(new URL("/api/debug", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ reset: true }),
      });
      expect(reset.status).toBe(200);
      expect(await reset.json()).toMatchObject({ enabled: false, usage: false, injection: false });
    } finally {
      await server.stop(true);
    }
  });

  test("injection scope: PUT toggles and scoped reset clears only it", async () => {
    const server = startServer(0);
    const origin = loopbackOrigin(server);
    try {
      const on = await fetch(new URL("/api/debug", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ injection: true }),
      });
      expect(await on.json()).toMatchObject({ injection: true, enabled: false, usage: false });

      const reset = await fetch(new URL("/api/debug", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ reset: "injection" }),
      });
      expect(await reset.json()).toMatchObject({ injection: false });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT rejects invalid bodies", async () => {
    const server = startServer(0);
    const origin = loopbackOrigin(server);
    try {
      const badType = await fetch(new URL("/api/debug", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ debug: "yes" }),
      });
      expect(badType.status).toBe(400);

      const empty = await fetch(new URL("/api/debug", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({}),
      });
      expect(empty.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects non-local Origin on debug endpoints", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/debug/logs", server.url), {
        headers: { origin: "https://attacker.test" },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "cross-origin request blocked" });
    } finally {
      await server.stop(true);
    }
  });
});

describe("management API /api/debug/logs", () => {
  test("returns buffered provider lines with seq cursor and limit", async () => {
    setDebugSettings({ debug: true });
    appendDebugLogLine("[ocx:test:one]");
    appendDebugLogLine("[ocx:test:two]");

    const server = startServer(0);
    try {
      const all = await fetch(new URL("/api/debug/logs?limit=500", server.url));
      expect(all.status).toBe(200);
      const entries = await all.json() as { seq: number; line: string }[];
      expect(entries).toHaveLength(2);
      expect(entries[0]!.seq).toBe(1);
      expect(entries[1]!.line).toContain("two");

      const tail = await fetch(new URL(`/api/debug/logs?after=${entries[0]!.seq}&limit=500`, server.url));
      const tailEntries = await tail.json() as { seq: number; line: string }[];
      expect(tailEntries).toHaveLength(1);
      expect(tailEntries[0]!.line).toContain("two");
    } finally {
      await server.stop(true);
    }
  });

  test("redacts secrets in provider diagnostics served over HTTP", async () => {
    setDebugSettings({ debug: true });
    debugProviderDiagnostic("cursor", "dial", {
      host: "api2.cursor.sh",
      // Placeholder token shape is constrained by scripts/privacy-scan.ts's tests/ allowlist.
      authorization: "Bearer access-token-value-testonly123",
    });

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/debug/logs", server.url));
      const entries = await res.json() as { line: string }[];
      expect(entries).toHaveLength(1);
      expect(entries[0]!.line).toContain("api2.cursor.sh");
      expect(entries[0]!.line).not.toContain("access-token-value-testonly123");
      expect(entries[0]!.line).toContain("[REDACTED]");
    } finally {
      await server.stop(true);
    }
  });

  test("caps limit query param at 2000", async () => {
    for (let i = 0; i < 5; i += 1) appendDebugLogLine(`[ocx:test:${i}]`);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/debug/logs?limit=99999", server.url));
      const entries = await res.json() as unknown[];
      expect(entries.length).toBeLessThanOrEqual(2000);
      expect(entries.length).toBe(getDebugLogEntries().length);
    } finally {
      await server.stop(true);
    }
  });
});

describe("management API /api/debug/injection-logs", () => {
  test("returns buffered injection lines with seq cursor and limit", async () => {
    setDebugSettings({ injection: true });
    injectionDebugLog("[opencodex] gpt-5.4: multi-agent guidance injected (surface=collab, 128 chars)");
    injectionDebugLog("[opencodex] gpt-5.4: effort cap applied (ultra -> high, main turn)");

    const server = startServer(0);
    try {
      const all = await fetch(new URL("/api/debug/injection-logs?limit=500", server.url));
      expect(all.status).toBe(200);
      const entries = await all.json() as { seq: number; line: string }[];
      expect(entries).toHaveLength(2);
      expect(entries[0]!.seq).toBe(1);
      expect(entries[1]!.line).toContain("effort cap applied");

      const tail = await fetch(new URL(`/api/debug/injection-logs?after=${entries[0]!.seq}&limit=500`, server.url));
      const tailEntries = await tail.json() as { seq: number; line: string }[];
      expect(tailEntries).toHaveLength(1);
      expect(tailEntries[0]!.line).toContain("effort cap applied");
    } finally {
      await server.stop(true);
    }
  });

  test("caps limit query param at 2000", async () => {
    for (let i = 0; i < 5; i += 1) injectionDebugLog(`[opencodex] inj:${i}`);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/debug/injection-logs?limit=99999", server.url));
      const entries = await res.json() as unknown[];
      expect(entries.length).toBeLessThanOrEqual(2000);
      expect(entries.length).toBe(getInjectionDebugLogEntries().length);
    } finally {
      await server.stop(true);
    }
  });
});

describe("management API /api/debug/usage-logs", () => {
  test("tails usage-debug.jsonl from the running proxy home", async () => {
    appendUsageDebug({
      ts: Date.now(),
      requestId: "ocx-usage-wire",
      provider: "cursor",
      model: "gpt-5.4",
      upstreamContentType: "text/event-stream",
      upstreamStatus: 200,
      bodyKind: "sse",
      bodySample: "data: ok",
      extractedUsage: null,
    });

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/debug/usage-logs", server.url));
      expect(res.status).toBe(200);
      const entries = await res.json() as { seq: number; line: string }[];
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0]!.seq).toBe(1);
      expect(entries[0]!.line).toContain("ocx-usage-wire");

      const tail = await fetch(new URL(`/api/debug/usage-logs?after=${entries[0]!.seq}`, server.url));
      expect(await tail.json()).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });

  test("serves redacted usage samples without leaking bearer tokens", async () => {
    appendUsageDebug({
      ts: Date.now(),
      requestId: "ocx-usage-secret",
      provider: "cursor",
      model: "gpt-5.4",
      upstreamContentType: "application/json",
      upstreamStatus: 200,
      bodyKind: "json",
      // Placeholder token shape is constrained by scripts/privacy-scan.ts's tests/ allowlist.
      bodySample: "Bearer usage-debug-token-value-testonly123",
      extractedUsage: null,
    });

    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/debug/usage-logs", server.url));
      const entries = await res.json() as { line: string }[];
      expect(entries[0]!.line).not.toContain("usage-debug-token-value-testonly123");
      expect(entries[0]!.line).toContain("[REDACTED]");
    } finally {
      await server.stop(true);
    }
  });
});
