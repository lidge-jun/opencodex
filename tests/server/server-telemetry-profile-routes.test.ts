import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementPrincipal } from "../../src/server/management-auth";
import type { ManagementRequestIngress } from "../../src/server/management/context";
import { setProfileClientOverridesForTests } from "../../src/telemetry/profile/client";
import { telemetryProfilePath } from "../../src/telemetry/profile/paths";
import { resetProfileServiceCachesForTests } from "../../src/telemetry/profile/service";
import { stopProfileScheduler } from "../../src/telemetry/profile/sync";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const SECRET = "ocxp_" + "b".repeat(43);
const HUMAN: { principal: ManagementPrincipal; ingress: ManagementRequestIngress } = {
  principal: "gui-session",
  ingress: { trustedLoopback: true, guiSessionIssuance: "loopback-bootstrap" },
};

describe("/api/telemetry/profile management routes", () => {
  let home: string;
  let config: OcxConfig;
  let collectorCalls: Array<{ method: string; url: string }>;
  let collectorDown = false;
  const prevHome = process.env.OPENCODEX_HOME;
  const prevTelemetry = process.env.OCX_TELEMETRY;
  const prevDnt = process.env.DO_NOT_TRACK;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-profile-routes-"));
    process.env.OPENCODEX_HOME = home;
    delete process.env.OCX_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    resetProfileServiceCachesForTests();
    collectorCalls = [];
    collectorDown = false;
    config = {
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      telemetry: { decision: "accepted", decidedAt: "2026-10-01T00:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" },
    } as OcxConfig;
    writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
    setProfileClientOverridesForTests({
      baseUrl: "https://collector.test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        collectorCalls.push({ method: init?.method ?? "GET", url: String(input) });
        if (collectorDown) throw new Error("connect ECONNREFUSED");
        if (init?.method === "POST") {
          return Response.json({ ok: true, profile: { handle: "jun", displayName: "Jun", avatar: "teal" }, secret: SECRET }, { status: 201 });
        }
        return Response.json({ ok: true, deleted: true });
      }) as typeof fetch,
    });
  });

  afterEach(() => {
    stopProfileScheduler();
    setProfileClientOverridesForTests(null);
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    if (prevTelemetry === undefined) delete process.env.OCX_TELEMETRY;
    else process.env.OCX_TELEMETRY = prevTelemetry;
    if (prevDnt === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDnt;
    removeTreeWithRetry(home);
  });

  async function call(method: string, pathname: string, options: { body?: unknown; principal?: ManagementPrincipal; ingress?: ManagementRequestIngress } = {}) {
    const url = new URL(`http://127.0.0.1:10100${pathname}`);
    const req = new Request(url, {
      method,
      headers: { host: "127.0.0.1:10100", ...(options.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const res = await handleManagementAPI(req, url, config, {}, options.principal ?? "admin-token", undefined, options.ingress ?? { trustedLoopback: true });
    expect(res).not.toBeNull();
    const text = await res!.text();
    return { status: res!.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  const connectBody = { handle: "jun", displayName: "Jun", avatar: "teal", acknowledgePublic: true };

  test("GET reports a disconnected profile without contacting the collector", async () => {
    const res = await call("GET", "/api/telemetry/profile");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, connected: false, telemetryEffective: true, profile: null });
    expect(collectorCalls).toHaveLength(0);
  });

  test("connecting refuses the admin token and remembered sessions, and needs the public acknowledgement", async () => {
    for (const [principal, guiSessionIssuance] of [["admin-token", undefined], ["gui-session", "remembered-admin"]] as const) {
      const res = await call("POST", "/api/telemetry/profile", {
        body: connectBody,
        principal,
        ingress: { trustedLoopback: true, ...(guiSessionIssuance ? { guiSessionIssuance } : {}) },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("agent_consent_required");
    }
    const unacknowledged = await call("POST", "/api/telemetry/profile", { ...HUMAN, body: { ...connectBody, acknowledgePublic: false } });
    expect(unacknowledged.status).toBe(400);
    expect(collectorCalls).toHaveLength(0);
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
  });

  test("a human session connects; no response ever contains the secret; the telemetry decision is unchanged", async () => {
    const configBefore = readFileSync(join(home, "config.json"), "utf8");
    const connected = await call("POST", "/api/telemetry/profile", { ...HUMAN, body: connectBody });
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ ok: true, connected: true, profile: { handle: "jun", displayName: "Jun", avatar: "teal" } });
    const read = await call("GET", "/api/telemetry/profile");
    for (const res of [connected, read]) expect(res.text).not.toContain(SECRET);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(configBefore);
    const again = await call("POST", "/api/telemetry/profile", { ...HUMAN, body: connectBody });
    expect(again.body.code).toBe("already_connected");
  });

  test("connecting while anonymous telemetry is off is refused", async () => {
    process.env.OCX_TELEMETRY = "0";
    const res = await call("POST", "/api/telemetry/profile", { ...HUMAN, body: connectBody });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("telemetry_off");
    expect(collectorCalls).toHaveLength(0);
  });

  test("disconnecting is allowed with the admin token and reports a pending deletion when the collector is down", async () => {
    await call("POST", "/api/telemetry/profile", { ...HUMAN, body: connectBody });
    collectorDown = true;
    const pending = await call("DELETE", "/api/telemetry/profile");
    expect(pending.body).toMatchObject({ ok: true, status: "deletion_pending", deleted: false });
    expect(existsSync(telemetryProfilePath(home))).toBe(true);
    collectorDown = false;
    const done = await call("DELETE", "/api/telemetry/profile");
    expect(done.body).toMatchObject({ ok: true, status: "deleted", deleted: true });
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
    const none = await call("DELETE", "/api/telemetry/profile");
    expect(none.body).toMatchObject({ ok: true, status: "not_connected" });
  });
});

