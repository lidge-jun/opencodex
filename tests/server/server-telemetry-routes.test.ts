import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementPrincipal } from "../../src/server/management-auth";
import type { ManagementRequestIngress } from "../../src/server/management/context";
import { TELEMETRY_PREVIEW_HASH_PLACEHOLDER, readTelemetryInstallId, resetTelemetryInstallIdMemoForTests, telemetryIdPath } from "../../src/telemetry/install-id";
import { buildTelemetryStatusSnapshot } from "../../src/telemetry/routes";
import { latestCompletedUtcDay, readTelemetryState, recordPendingTelemetryDecision, runTelemetryTick } from "../../src/telemetry/scheduler";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("/api/telemetry management routes", () => {
  let home: string;
  let config: OcxConfig;
  const prevHome = process.env.OPENCODEX_HOME;
  const prevTelemetry = process.env.OCX_TELEMETRY;
  const prevDnt = process.env.DO_NOT_TRACK;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-telemetry-routes-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OCX_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    resetTelemetryInstallIdMemoForTests();
    config = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    } as OcxConfig;
    writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
  });

  afterEach(() => {
    resetTelemetryInstallIdMemoForTests();
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    if (prevTelemetry === undefined) delete process.env.OCX_TELEMETRY;
    else process.env.OCX_TELEMETRY = prevTelemetry;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
    removeTreeWithRetry(home);
  });

  async function call(
    method: string,
    pathname: string,
    options: {
      body?: unknown;
      principal?: ManagementPrincipal;
      ingress?: ManagementRequestIngress;
    } = {},
  ) {
    const url = new URL(`http://127.0.0.1:10100${pathname}`);
    const req = new Request(url, {
      method,
      headers: {
        host: "127.0.0.1:10100",
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const res = await handleManagementAPI(
      req,
      url,
      config,
      {},
      options.principal ?? "admin-token",
      undefined,
      options.ingress ?? { trustedLoopback: true },
    );
    expect(res).not.toBeNull();
    return {
      status: res!.status,
      body: (await res!.json()) as Record<string, unknown>,
    };
  }

  test("GET /api/telemetry returns status and preview with placeholder hash without creating an id", async () => {
    const res = await call("GET", "/api/telemetry");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      effective: false,
      reason: "awaiting-notice",
      decision: null,
      lastSentDay: null,
      previewEligible: false,
    });
    const preview = res.body.preview as { installDayHash: string; schemaVersion: number; day: string };
    expect(preview.schemaVersion).toBe(1);
    expect(preview.installDayHash).toBe(TELEMETRY_PREVIEW_HASH_PLACEHOLDER);
    expect(preview.day).toBe(latestCompletedUtcDay());
    expect(existsSync(telemetryIdPath(home))).toBe(false);
  });

  test("D10: GET /api/telemetry preview uses the oldest eligible unsent day and marks previewEligible=false when none is eligible", async () => {
    const now = Date.parse("2026-11-07T12:00:00.000Z");

    // 1. Consent given today (2026-11-07) or yesterday (2026-11-06) -> no completed day is strictly after consent day yet.
    const sameDaySnap = await buildTelemetryStatusSnapshot(
      {
        telemetry: {
          decision: "accepted",
          decidedAt: "2026-11-06T18:00:00.000Z",
          noticeShownAt: "2026-11-06T18:00:00.000Z",
        },
      },
      { now, env: {}, configDir: home },
    );
    expect(sameDaySnap.previewEligible).toBe(false);
    expect(sameDaySnap.preview.day).toBe("2026-11-06");

    // 2. Consent given on 2026-11-04 -> eligible unsent days are 2026-11-05 and 2026-11-06;
    // preview shows 2026-11-05 (the exact day the scheduler will send next) with previewEligible=true.
    const eligibleConfig = {
      telemetry: {
        decision: "accepted" as const,
        decidedAt: "2026-11-04T18:00:00.000Z",
        noticeShownAt: "2026-11-04T18:00:00.000Z",
      },
    };
    const firstSnap = await buildTelemetryStatusSnapshot(eligibleConfig, { now, env: {}, configDir: home });
    expect(firstSnap.previewEligible).toBe(true);
    expect(firstSnap.preview.day).toBe("2026-11-05");

    // Scheduler sends 2026-11-05; next preview moves to 2026-11-06 with previewEligible=true:
    const tick1 = await runTelemetryTick({
      configDir: home,
      config: eligibleConfig,
      env: {},
      now,
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(tick1).toMatchObject({ sent: true, day: "2026-11-05" });

    const secondSnap = await buildTelemetryStatusSnapshot(eligibleConfig, { now, env: {}, configDir: home });
    expect(secondSnap.previewEligible).toBe(true);
    expect(secondSnap.preview.day).toBe("2026-11-06");

    // Scheduler sends 2026-11-06; now no eligible day remains, so previewEligible=false on 2026-11-06:
    const tick2 = await runTelemetryTick({
      configDir: home,
      config: eligibleConfig,
      env: {},
      now,
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(tick2).toMatchObject({ sent: true, day: "2026-11-06" });

    const thirdSnap = await buildTelemetryStatusSnapshot(eligibleConfig, { now, env: {}, configDir: home });
    expect(thirdSnap.previewEligible).toBe(false);
    expect(thirdSnap.preview.day).toBe("2026-11-06");
  });

  test("PUT /api/telemetry refuses admin-token and remembered-admin sessions, and POST /api/telemetry/notice is removed (D13)", async () => {
    for (const [principal, guiSessionIssuance] of [
      ["admin-token", null],
      ["gui-session", "remembered-admin"],
    ] as const) {
      const putRes = await call("PUT", "/api/telemetry", {
        body: { decision: "accepted" },
        principal,
        ingress: { trustedLoopback: true, guiSessionIssuance },
      });
      expect(putRes.status).toBe(403);
      expect(putRes.body.code).toBe("agent_consent_required");
    }
    expect(config.telemetry).toBeUndefined();

    const noticeUrl = new URL("http://127.0.0.1:10100/api/telemetry/notice");
    const noticeReq = new Request(noticeUrl, {
      method: "POST",
      headers: { host: "127.0.0.1:10100" },
    });
    const noticeRes = await handleManagementAPI(
      noticeReq,
      noticeUrl,
      config,
      {},
      "gui-session",
      undefined,
      { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    );
    expect(noticeRes).toBeNull();
  });

  test("PUT /api/telemetry accepts a human dashboard session and deletes telemetry-id.json on decline", async () => {
    const accepted = await call("PUT", "/api/telemetry", {
      body: { decision: "accepted" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      ok: true,
      effective: true,
      reason: "accepted",
      decision: "accepted",
    });
    expect(config.telemetry?.decision).toBe("accepted");

    const tick = await runTelemetryTick({
      configDir: home,
      config,
      env: {},
      now: Date.now() + 2 * 86_400_000,
      fetch: (async () => new Response(JSON.stringify({ ok: true }), { status: 202 })) as unknown as typeof fetch,
    });
    expect(tick.sent).toBe(true);
    const rawInstallId = readTelemetryInstallId(home)!.installId;
    expect(existsSync(telemetryIdPath(home))).toBe(true);

    const declined = await call("PUT", "/api/telemetry", {
      body: { decision: "declined" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({
      ok: true,
      effective: false,
      reason: "declined",
      decision: "declined",
    });
    expect(existsSync(telemetryIdPath(home))).toBe(false);
    for (const entry of readdirSync(home)) {
      const full = join(home, entry);
      if (lstatSync(full).isFile()) {
        expect(readFileSync(full, "utf8")).not.toContain(rawInstallId);
      }
    }
  });

  test("PUT /api/telemetry on a fresh install holds the decision without creating config.json", async () => {
    // A first-run popup can be answered before any config.json exists (fresh desktop install).
    unlinkSync(join(home, "config.json"));
    config = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    const declined = await call("PUT", "/api/telemetry", {
      body: { decision: "declined" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ ok: true, effective: false, decision: "declined" });
    expect(existsSync(join(home, "config.json"))).toBe(false);
    expect(readTelemetryState(home).pendingDecision?.decision).toBe("declined");
    // A later GET from a process that only sees the defaults still reports the held decline.
    config = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;
    const status = await call("GET", "/api/telemetry");
    expect(status.body).toMatchObject({ effective: false, decision: "declined" });
  });

  test("a decline held before config.json exists survives a management request that creates config.json", async () => {
    // Fresh install: the dashboard popup accepts before any config.json exists ...
    unlinkSync(join(home, "config.json"));
    config = {
      port: 10100,
      logLevel: "info",
      defaultProvider: "fixture",
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test" } },
    } as unknown as OcxConfig;
    const accepted = await call("PUT", "/api/telemetry", {
      body: { decision: "accepted" },
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(accepted.status).toBe(200);
    // ... the held decision is not copied into the running proxy's config ...
    expect(config.telemetry).toBeUndefined();
    // ... then "ocx telemetry disable" replaces the held decision with a decline.
    recordPendingTelemetryDecision({ decision: "declined", decidedAt: "2026-11-08T12:00:00.000Z", noticeShownAt: "2026-11-08T12:00:00.000Z" }, home);
    // An admin-token request that creates config.json from the in-memory config.
    const created = await call("PUT", "/api/subagent-models", { body: { force: null } });
    expect(created.status).toBe(200);
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect((JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig).telemetry).toBeUndefined();
    const status = await call("GET", "/api/telemetry");
    expect(status.body).toMatchObject({ effective: false, decision: "declined" });
  });

  test("GET /api/telemetry reports a decision written to disk while the server's config is stale", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({
      ...config,
      telemetry: { decision: "declined", decidedAt: "2026-11-08T10:00:00.000Z", noticeShownAt: "2026-11-08T10:00:00.000Z" },
    }, null, 2) + "\n", "utf8");
    expect(config.telemetry).toBeUndefined();
    const status = await call("GET", "/api/telemetry");
    expect(status.body).toMatchObject({ effective: false, decision: "declined" });
  });
});
