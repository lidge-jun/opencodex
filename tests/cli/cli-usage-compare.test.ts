/**
 * `ocx usage compare` reads the named range, then the previous equal window.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { handleObserveCommand } from "../../src/cli/observe";
import { compareUsageWindows } from "../../src/cli/usage-compare";

const NOW = Date.UTC(2026, 9, 15, 15, 30, 0);

function report(url: URL, requests: number): Record<string, unknown> {
  return {
    customWindow: true,
    since: Number(url.searchParams.get("since")),
    until: Number(url.searchParams.get("until")),
    summary: {
      requests,
      totalTokens: requests * 10,
      inputTokens: requests * 6,
      outputTokens: requests * 4,
      cachedInputTokens: requests,
      estimatedCostUsd: requests * 0.01,
    },
  };
}

async function run(
  argv: string[],
  status = 200,
): Promise<{ code: number; out: string; err: string; urls: URL[]; inits: RequestInit[] }> {
  const urls: URL[] = [];
  const inits: RequestInit[] = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    urls.push(url);
    inits.push(init ?? {});
    n += 1;
    return new Response(JSON.stringify(status === 200 ? report(url, n === 1 ? 20 : 10) : { error: "not found" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalErr = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    const code = await handleObserveCommand(argv, { baseUrl: "http://cli.test", fetchImpl, now: () => NOW });
    return { code, out: lines.join("\n"), err: errors.join("\n"), urls, inits };
  } finally {
    console.log = originalLog;
    console.error = originalErr;
  }
}

describe("compareUsageWindows", () => {
  test("today shifts one local day and keeps equal elapsed length", () => {
    const windows = compareUsageWindows("today", NOW);
    expect(windows.days).toBe(1);
    expect(windows.current.until).toBe(NOW);
    expect(windows.previous.until).toBeLessThan(windows.current.since);
    expect(windows.previous.until - windows.previous.since).toBe(windows.current.until - windows.current.since);
  });

  test("7d and 30d shift by that many local days", () => {
    expect(compareUsageWindows("7d", NOW).days).toBe(7);
    expect(compareUsageWindows("30d", NOW).days).toBe(30);
    const week = compareUsageWindows("7d", NOW);
    expect(week.previous.until).toBeLessThan(week.current.since);
  });
});

describe("ocx usage compare", () => {
  test("reads current then previous equal windows and prints signed deltas", async () => {
    const expected = compareUsageWindows("today", NOW);
    const result = await run(["usage", "compare", "--range", "today", "--surface", "claude", "--provider", "xai", "--model", "grok"]);
    expect(result.code).toBe(0);
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0]!.pathname).toBe("/api/usage");
    expect(result.urls[0]!.searchParams.get("range")).toBe("today");
    expect(result.urls[0]!.searchParams.get("surface")).toBe("claude");
    expect(result.urls[0]!.searchParams.get("provider")).toBe("xai");
    expect(result.urls[0]!.searchParams.get("model")).toBe("grok");
    expect(result.urls[0]!.searchParams.get("since")).toBe(String(expected.current.since));
    expect(result.urls[0]!.searchParams.get("until")).toBe(String(expected.current.until));
    expect(result.urls[1]!.searchParams.get("since")).toBe(String(expected.previous.since));
    expect(result.urls[1]!.searchParams.get("until")).toBe(String(expected.previous.until));
    expect(result.out).toContain("Usage compare — today vs previous 1 local day");
    expect(result.out).toContain("Requests");
    expect(result.out).toContain("+10");
    expect(result.out).toContain("+100.0%");
    expect(result.out).toContain("~$0.2000");
    expect(result.out).toContain("~$0.1000");
  });

  test("JSON carries delta, percent change, and 1d as today", async () => {
    const expected = compareUsageWindows("today", NOW);
    const result = await run(["usage", "compare", "--range", "1d", "--json"]);
    expect(result.code).toBe(0);
    const body = JSON.parse(result.out) as {
      schemaVersion: number;
      range: string;
      days: number;
      current: { since: number; summary: { requests: number } };
      previous: { since: number; summary: { requests: number } };
      delta: { requests: number };
      change: { requests: number };
    };
    expect(body.schemaVersion).toBe(1);
    expect(body.range).toBe("today");
    expect(body.days).toBe(1);
    expect(body.current.since).toBe(expected.current.since);
    expect(body.previous.since).toBe(expected.previous.since);
    expect(body.current.summary.requests).toBe(20);
    expect(body.previous.summary.requests).toBe(10);
    expect(body.delta.requests).toBe(10);
    expect(body.change.requests).toBe(100);
  });

  test("default range is 30d and a zero previous window reports n/a change", async () => {
    const expected = compareUsageWindows("30d", NOW);
    const urls: URL[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async input => {
      const url = new URL(String(input));
      urls.push(url);
      n += 1;
      const requests = n === 1 ? 5 : 0;
      return Response.json({
        customWindow: true,
        since: Number(url.searchParams.get("since")),
        until: Number(url.searchParams.get("until")),
        summary: { requests, totalTokens: requests, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostUsd: 0 },
      });
    };
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      expect(await handleObserveCommand(["usage", "compare"], { baseUrl: "http://cli.test", fetchImpl, now: () => NOW })).toBe(0);
    } finally {
      console.log = original;
    }
    expect(urls[0]!.searchParams.get("range")).toBe("30d");
    expect(urls[0]!.searchParams.get("since")).toBe(String(expected.current.since));
    expect(lines.join("\n")).toContain("n/a");
  });

  test("rejects all, unknown ranges, custom bounds, and inverted surfaces before transport", async () => {
    expect((await run(["usage", "compare", "--range", "all"])).code).toBe(2);
    expect((await run(["usage", "compare", "--range", "all"])).urls).toHaveLength(0);
    expect((await run(["usage", "compare", "--range", "year"])).code).toBe(2);
    expect((await run(["usage", "compare", "--since", "1", "--until", "2"])).code).toBe(2);
    expect((await run(["usage", "compare", "--surface", "web"])).code).toBe(2);
    expect((await run(["usage", "compare", "--range", "all"])).err).toContain("no previous equal window");
  });

  test("unacknowledged custom windows and key-scope mismatch fail closed", async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ summary: { requests: 1 } });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      expect(await handleObserveCommand(["usage", "compare", "--range", "today", "--json"], {
        baseUrl: "http://cli.test", fetchImpl, now: () => NOW,
      })).toBe(1);
      expect(errors.join("\n")).toContain("did not confirm the requested custom usage window");
    } finally {
      console.error = original;
    }

    const scoped: typeof fetch = async () => Response.json({
      customWindow: true, since: 1, until: 2, filter: { apiKeyId: "other" }, summary: { requests: 1 },
    });
    errors.length = 0;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
    try {
      expect(await handleObserveCommand(["usage", "compare", "--api-key-id", "Key-A", "--json"], {
        baseUrl: "http://cli.test", fetchImpl: scoped, now: () => NOW,
      })).toBe(1);
      expect(errors.join("\n")).toContain("did not confirm the requested API key scope");
    } finally {
      console.error = original;
    }
  });

  test("key scope uses redirect-error transport and echoes the id", async () => {
    const expected = compareUsageWindows("7d", NOW);
    const urls: URL[] = [];
    const inits: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      urls.push(url);
      inits.push(init ?? {});
      return Response.json({
        customWindow: true,
        since: Number(url.searchParams.get("since")),
        until: Number(url.searchParams.get("until")),
        filter: { apiKeyId: "Key-A", provider: null, model: null, matched: true, comboOverlap: false },
        summary: { requests: 3, totalTokens: 9, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, estimatedCostUsd: 0.1 },
      });
    };
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      expect(await handleObserveCommand(["usage", "compare", "--range", "7d", "--api-key-id", "Key-A", "--json"], {
        baseUrl: "http://cli.test", fetchImpl, now: () => NOW,
      })).toBe(0);
    } finally {
      console.log = original;
    }
    expect(urls).toHaveLength(2);
    expect(urls[0]!.searchParams.get("apiKeyId")).toBe("Key-A");
    expect(urls[0]!.searchParams.get("range")).toBe("7d");
    expect(urls[0]!.searchParams.get("since")).toBe(String(expected.current.since));
    expect(inits[0]!.redirect).toBe("error");
    expect(inits[0]!.credentials).toBe("omit");
    expect(JSON.parse(lines.join("\n")).filter.apiKeyId).toBe("Key-A");
  });
});


test.each(["stable-local", "stable-hub", "connect", "disconnect", "account", "credential", "admin", "transport"])(
  "usage comparison keeps one owner across both windows (%s)", scenario => {
    const home = mkdtempSync(join(tmpdir(), "ocx-compare-owner-"));
    try {
      const child = spawnSync(process.execPath, ["--eval", `
        import { spyOn } from "bun:test";
        import { writeFileSync } from "node:fs";
        import { join } from "node:path";
        import * as state from "./src/client/state";
        import { serviceApiTokenFingerprint } from "./src/lib/service-secrets";
        import { handleObserveCommand } from "./src/cli/observe";
        const scenario = ${JSON.stringify(scenario)};
        const home = process.env.OPENCODEX_HOME;
        const token = "compare-fixture-key-a", nextToken = "compare-fixture-key-b";
        const client = { serverUrl: "https://hub.example.test", managementUrl: "https://manage.example.test",
          managementTransport: "direct", selectedClients: ["claude"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
          apiKeyId: "account-a", tokenFingerprint: serviceApiTokenFingerprint(token), protocolVersion: 1,
          connectedAt: "2026-09-01T00:00:00.000Z" };
        const connected = !["stable-local", "connect", "admin"].includes(scenario);
        const write = (isClient) => writeFileSync(join(home, "config.json"), JSON.stringify({
          port: 9, providers: {}, defaultProvider: "openai", runtimeRole: isClient ? "client" : "standalone",
          ...(isClient ? { client } : {}),
        }));
        write(connected);
        writeFileSync(join(home, "service-api-token"), token);
        process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "compare-fixture-admin-a";
        const change = () => {
          if (scenario === "account") client.apiKeyId = "account-b";
          if (scenario === "credential") {
            writeFileSync(join(home, "service-api-token"), nextToken);
            client.tokenFingerprint = serviceApiTokenFingerprint(nextToken);
          }
          if (scenario === "transport") client.transport = "hub";
          if (scenario === "admin") process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "compare-fixture-admin-b";
          write(scenario !== "disconnect");
        };
        // On the old implementation these are the first read's before/after observations,
        // followed by the second read's capture. Change only after that first owner was verified.
        const read = state.readClientConnectionState;
        let observations = 0;
        spyOn(state, "readClientConnectionState").mockImplementation(() => {
          if (++observations === 3 && connected && !scenario.startsWith("stable")) change();
          return read();
        });
        const output = [], errors = [], requests = [];
        console.log = (...args) => output.push(args.join(" "));
        console.error = (...args) => errors.push(args.join(" "));
        const code = await handleObserveCommand(["usage", "compare", "--json"], {
          baseUrl: "http://local.test", now: () => ${NOW},
          fetchImpl: async (input, init) => {
            const url = new URL(String(input));
            requests.push({ origin: url.origin, path: url.pathname,
              originalCredential: new Headers(init?.headers).get("x-opencodex-api-key") === (connected ? token : "compare-fixture-admin-a") });
            if (requests.length === 1 && ["connect", "admin"].includes(scenario)) change();
            return Response.json({ schemaVersion: 1, source: "hub", scope: "client", range: "30d", surface: "all",
              generatedAt: 1, customWindow: true, since: Number(url.searchParams.get("since")), until: Number(url.searchParams.get("until")),
              summary: { requests: 1, totalTokens: 3, inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, unpricedRequests: 1, unmeteredRequests: 0 },
              providers: [], models: [], days: [], filter: { provider: null, model: null, matched: true, comboOverlap: false } });
          },
        });
        process.stdout.write(JSON.stringify({ code, output, errors, requests }));
      `], { cwd: repoRoot(), env: { ...process.env, OPENCODEX_HOME: home }, encoding: "utf8", timeout: SPAWN_BUDGET_MS - 5000 });
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(child.stdout);
      if (scenario.startsWith("stable")) {
        expect(result.code).toBe(0);
        expect(result.requests).toHaveLength(2);
        expect(result.requests.every((request: { originalCredential: boolean }) => request.originalCredential)).toBe(true);
        expect(result.requests.map((request: { path: string }) => request.path)).toEqual(Array(2).fill(scenario === "stable-hub" ? "/v1/usage" : "/api/usage"));
        expect(JSON.parse(result.output.join("\n")).delta.requests).toBe(0);
      } else {
        expect(result.code).toBe(1);
        expect(result.output).toEqual([]);
        expect(result.errors.join("\n")).toContain("Usage owner changed during comparison");
        expect(result.requests).toHaveLength(1);
      }
      expect(child.stdout).not.toContain("compare-fixture");
    } finally {
      removeTreeWithRetry(home);
    }
  }, SPAWN_BUDGET_MS,
);
