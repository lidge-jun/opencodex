/**
 * Management API surface for the memory watchdog (dashboard beta panel):
 *   GET  /api/memory           → read-only Monitor + Recommend report (Runs behind requireApiAuth).
 *   PUT  /api/memory/settings  → validate + persist (saveConfig) + apply live without a restart.
 * The route handlers are exercised directly; auth/CORS gating is asserted elsewhere. saveConfig is
 * pointed at an isolated OPENCODEX_HOME so persistence is checked without touching the real config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath } from "../src/config";
import { handleManagementAPI } from "../src/server/management-api";
import { stopMemoryWatchdog } from "../src/server/memory-watchdog";
import type { OcxConfig } from "../src/types";

const savedHome = process.env.OPENCODEX_HOME;
let tempHome: string | null = null;

afterEach(() => {
  stopMemoryWatchdog(); // never leak a running watchdog singleton across tests
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    tempHome = null;
  }
});

function isolatedHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "ocx-memory-"));
  process.env.OPENCODEX_HOME = tempHome;
}

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

async function get(config: OcxConfig): Promise<Response> {
  const req = new Request("http://localhost/api/memory");
  const res = await handleManagementAPI(req, new URL(req.url), config);
  expect(res).not.toBeNull();
  return res!;
}

async function put(config: OcxConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/memory/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config);
  expect(res).not.toBeNull();
  return res!;
}

interface Report {
  enabled: boolean;
  resolvedConfig?: { warnFraction: number; criticalFraction: number; requireSupervisor: boolean; autoRestart: boolean };
  supervisor?: { supervised: boolean; hint: string };
  recommendation?: unknown;
}

describe("GET /api/memory", () => {
  test("degrades to { enabled: false } when the watchdog is not running", async () => {
    isolatedHome();
    const config = makeConfig();
    const res = await get(config);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });

  test("after enabling, the report exposes the Monitor + Recommend shape", async () => {
    isolatedHome();
    const config = makeConfig();
    await put(config, { enabled: true, warnFraction: 0.55, criticalFraction: 0.8 });
    const data = (await (await get(config)).json()) as Report;
    expect(data.enabled).toBe(true);
    expect(data.resolvedConfig?.warnFraction).toBe(0.55);
    expect(data.resolvedConfig?.criticalFraction).toBe(0.8);
    expect(data.supervisor).toBeDefined();
    expect(data.recommendation).toBeDefined();
  });
});

describe("PUT /api/memory/settings", () => {
  test("valid patch persists to disk and applies live", async () => {
    isolatedHome();
    const config = makeConfig();
    const res = await put(config, { enabled: true, warnFraction: 0.5, criticalFraction: 0.85, requireSupervisor: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; report: Report };
    expect(body.ok).toBe(true);
    // in-memory config mutated
    expect(config.memoryWatchdog).toMatchObject({ warnFraction: 0.5, criticalFraction: 0.85, requireSupervisor: false });
    // persisted to the isolated config file
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.memoryWatchdog).toMatchObject({ warnFraction: 0.5, criticalFraction: 0.85, requireSupervisor: false });
    // applied live: the running report reflects the new thresholds
    expect(body.report.resolvedConfig?.warnFraction).toBe(0.5);
    expect(body.report.resolvedConfig?.requireSupervisor).toBe(false);
  });

  test("a live threshold change updates the already-running watchdog", async () => {
    isolatedHome();
    const config = makeConfig();
    await put(config, { enabled: true, warnFraction: 0.6, criticalFraction: 0.75 });
    const res = await put(config, { warnFraction: 0.4 });
    const body = (await res.json()) as { report: Report };
    expect(res.status).toBe(200);
    expect(body.report.resolvedConfig?.warnFraction).toBe(0.4);
  });

  test("enabled:false stops the watchdog and the report degrades", async () => {
    isolatedHome();
    const config = makeConfig();
    await put(config, { enabled: true });
    expect(((await (await get(config)).json()) as Report).enabled).toBe(true);
    await put(config, { enabled: false });
    expect(await (await get(config)).json()).toEqual({ enabled: false });
  });

  test.each([
    ["out-of-range warnFraction", { warnFraction: 2 }],
    ["non-numeric criticalFraction", { criticalFraction: "high" }],
    ["non-boolean autoRestart", { autoRestart: "yes" }],
    ["non-boolean requireSupervisor", { requireSupervisor: 1 }],
    ["non-positive intervalMs", { intervalMs: 0 }],
    ["below-minimum restartGraceMs", { restartGraceMs: 500 }],
    ["above-maximum restartGraceMs", { restartGraceMs: 900_000 }],
    ["non-numeric restartGraceMs", { restartGraceMs: "30s" }],
    ["non-finite restartGraceMs", { restartGraceMs: Number.NaN }],
  ] as const)("rejects %s with 400 and does not persist", async (_label, body) => {
    isolatedHome();
    const config = makeConfig();
    const res = await put(config, body);
    expect(res.status).toBe(400);
    expect(config.memoryWatchdog).toBeUndefined();
    expect(existsSync(getConfigPath())).toBe(false);
  });

  test("a valid restartGraceMs persists, applies live, and raises a shorter cooldown", async () => {
    isolatedHome();
    // A config-file cooldown SHORTER than the requested grace: the runtime must raise it.
    const config = makeConfig({ memoryWatchdog: { minRestartIntervalMs: 60_000 } } as Partial<OcxConfig>);
    await put(config, { enabled: true });
    const res = await put(config, { restartGraceMs: 300_000 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; report: { resolvedConfig?: { restartGraceMs?: number; minRestartIntervalMs?: number } } };
    expect(body.ok).toBe(true);
    expect(body.report.resolvedConfig?.restartGraceMs).toBe(300_000);
    expect(body.report.resolvedConfig?.minRestartIntervalMs).toBe(300_000); // cooldown >= grace
    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.memoryWatchdog?.restartGraceMs).toBe(300_000);
  });

  test("rejects a non-object body with 400", async () => {
    isolatedHome();
    const config = makeConfig();
    const res = await put(config, ["not", "an", "object"]);
    expect(res.status).toBe(400);
  });
});
