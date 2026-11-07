import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementPrincipal } from "../../src/server/management-auth";
import type { ManagementRequestIngress } from "../../src/server/management/context";
import { TELEMETRY_PREVIEW_HASH_PLACEHOLDER, ensureTelemetryInstallId, resetTelemetryInstallIdMemoForTests, telemetryIdPath } from "../../src/telemetry/install-id";
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
    });
    const preview = res.body.preview as { installDayHash: string; schemaVersion: number };
    expect(preview.schemaVersion).toBe(1);
    expect(preview.installDayHash).toBe(TELEMETRY_PREVIEW_HASH_PLACEHOLDER);
    expect(existsSync(telemetryIdPath(home))).toBe(false);
  });

  test("PUT /api/telemetry and POST /api/telemetry/notice refuse admin-token and remembered-admin sessions", async () => {
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

      const noticeRes = await call("POST", "/api/telemetry/notice", {
        principal,
        ingress: { trustedLoopback: true, guiSessionIssuance },
      });
      expect(noticeRes.status).toBe(403);
      expect(noticeRes.body.code).toBe("agent_consent_required");
    }
    expect(config.telemetry).toBeUndefined();
  });

  test("POST /api/telemetry/notice accepts a human dashboard session and is idempotent", async () => {
    const first = await call("POST", "/api/telemetry/notice", {
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      ok: true,
      effective: true,
      reason: "default-on",
      decision: null,
    });
    const firstNoticeAt = first.body.noticeShownAt as string;
    expect(typeof firstNoticeAt).toBe("string");

    const second = await call("POST", "/api/telemetry/notice", {
      principal: "gui-session",
      ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
    });
    expect(second.status).toBe(200);
    expect(second.body.noticeShownAt).toBe(firstNoticeAt);
  });

  test("PUT /api/telemetry accepts a human dashboard session and deletes telemetry-id.json on decline", async () => {
    ensureTelemetryInstallId(home);
    expect(existsSync(telemetryIdPath(home))).toBe(true);

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
  });
});
