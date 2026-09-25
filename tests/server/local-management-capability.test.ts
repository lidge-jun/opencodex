import { describe, expect, test } from "bun:test";
import {
  LOCAL_MANAGEMENT_CAPABILITY_TTL_MS,
  LOCAL_MANAGEMENT_READ_PATHS,
  createLocalManagementReadCapability,
  verifyLocalManagementReadCapability,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER as expiryHeader,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER as proofHeader,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER as pidHeader,
  LOCAL_MANAGEMENT_NONCE_HEADER as nonceHeader,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
} from "../../src/lib/local-management-capability";
import {
  SYSTEM_RESTART_METHOD,
  SYSTEM_RESTART_PATH,
  createSystemRestartCapability,
  verifySystemRestartCapability,
} from "../../src/lib/system-restart-contract";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createLocalDesktopSnapshotCapability as mint,
  desktopSnapshotBodyDigest,
  LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER,
  LOCAL_DESKTOP_SNAPSHOT_PATH as path,
  verifyLocalDesktopSnapshotCapability as verify,
  createLocalDesktopSnapshotCapability,
  LOCAL_DESKTOP_SNAPSHOT_PATH,
} from "../../src/lib/local-desktop-snapshot-capability";
import {
  hasLocalDesktopSnapshotCapability as admit,
  verifyLocalDesktopSnapshotBody as verifyBody,
} from "../../src/server/local-desktop-snapshot-auth";
import {
  managementPrincipal,
  requireManagementAuth,
  type ManagementAuthState,
} from "../../src/server/management-auth";
import { handleSidebarRoutes } from "../../src/server/management/sidebar-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";


describe("local management read capability", () => {
  const secret = "A".repeat(43);
  const nonce = "B".repeat(43);
  const pid = 4242;
  const port = 10100;
  const now = 1_800_000_000_000;
  const expiresAt = now + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS;

  test("binds one allowlisted GET to its nonce, path, PID, and port", () => {
    const capability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
    );
    expect(capability).toHaveLength(43);
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
      capability,
      now,
    )).toBe(true);

    const invalid: Array<[string, string, number, number, string | null]> = [
      ["POST", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid, port, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.codexAccounts, pid, port, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid + 1, port, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid, port + 1, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid, port, "C".repeat(43)],
    ];
    for (const [method, path, candidatePid, candidatePort, candidate] of invalid) {
      expect(verifyLocalManagementReadCapability(
        secret,
        nonce,
        method,
        path,
        candidatePid,
        candidatePort,
        expiresAt,
        candidate,
        now,
      )).toBe(false);
    }
    expect(verifyLocalManagementReadCapability(
      secret,
      "D".repeat(43),
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
      capability,
      now,
    )).toBe(false);
    const expiredCapability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      now,
    );
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      now,
      expiredCapability,
      now,
    )).toBe(false);
    const farFutureExpiry = now + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS + 1;
    const farFutureCapability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      farFutureExpiry,
    );
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      farFutureExpiry,
      farFutureCapability,
      now,
    )).toBe(false);
  });

  test("the desktop tray reads stay inside the allowlist", () => {
    // native_tray_data requests /api/config and /api/codex-auth/active through
    // the same 401-retry path as the other reads; if either falls off the
    // allowlist the capability retry 401s and the tray loses its data.
    for (const path of [
      LOCAL_MANAGEMENT_READ_PATHS.config,
      LOCAL_MANAGEMENT_READ_PATHS.codexAuthActive,
    ]) {
      const capability = createLocalManagementReadCapability(
        secret,
        nonce,
        "GET",
        path,
        pid,
        port,
        expiresAt,
      );
      expect(capability).not.toBeNull();
      expect(verifyLocalManagementReadCapability(
        secret,
        nonce,
        "GET",
        path,
        pid,
        port,
        expiresAt,
        capability,
        now,
      )).toBe(true);
    }
  });

  test("the query is bound into the grant", () => {
    const usage = `${LOCAL_MANAGEMENT_READ_PATHS.usage}?range=7d`;
    const capability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      usage,
      pid,
      port,
      expiresAt,
    );
    expect(capability).toHaveLength(43);
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      usage,
      pid,
      port,
      expiresAt,
      capability,
      now,
    )).toBe(true);
    // A grant for one range does not satisfy another, and a capability minted over the bare
    // pathname does not satisfy a query-bearing request.
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      `${LOCAL_MANAGEMENT_READ_PATHS.usage}?range=today`,
      pid,
      port,
      expiresAt,
      capability,
      now,
    )).toBe(false);
    const bare = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.usage,
      pid,
      port,
      expiresAt,
    );
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      usage,
      pid,
      port,
      expiresAt,
      bare,
      now,
    )).toBe(false);
  });

  test("cannot cross the restart or other local-read capability domains", () => {
    const memoryCapability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
    );
    const restartCapability = createSystemRestartCapability(
      secret,
      nonce,
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      pid,
      port,
    );
    expect(verifySystemRestartCapability(
      secret,
      nonce,
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      pid,
      port,
      memoryCapability,
    )).toBe(false);
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
      restartCapability,
      now,
    )).toBe(false);
  });
});

describe("desktop snapshot proof contract", () => {
  const secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
  const nonce = "A".repeat(43);
  const now = 1_700_000_000_000;
  const expiry = now + 10_000;
  const body = new TextEncoder().encode('{"sessionId":"test"}');
  const digest = desktopSnapshotBodyDigest(body);
  const local = { attestationSecret: secret, pid: 4242, port: 10100 };
  const proof = mint(secret, nonce, "POST", path, local.pid, local.port, expiry, digest)!;

  function request(at = now): Request {
    const fresh = randomBytes(32).toString("base64url");
    return new Request(`http://127.0.0.1:10100${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [pidHeader]: String(local.pid), [nonceHeader]: fresh, [expiryHeader]: String(at + 10_000),
        [LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER]: digest,
        [proofHeader]: mint(secret, fresh, "POST", path, local.pid, local.port, at + 10_000, digest)!,
      },
      body,
    });
  }

  describe("body-bound desktop snapshot contract", () => {
    test("matches the Rust fixed vector", () => {
      expect(digest).toBe("5pREWDDMbj42QHj3DvVNrC54yVF7Vpd8cNj5c-z3rQ4");
      expect(proof).toBe("yEkTQtyXzQsi_kJGmzmUO1wyJIjc_G4-iiNNoyB4Zcw");
      expect(verify(secret, nonce, "POST", path, 4242, 10100, expiry, digest, proof, now)).toBe(true);
    });

    test("rejects expired, future and invalid lifetimes", () => {
      for (const time of [expiry, expiry + 1, now - 1, NaN, Infinity]) {
        expect(verify(secret, nonce, "POST", path, 4242, 10100, expiry, digest, proof, time)).toBe(false);
      }
      for (const end of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(mint(secret, nonce, "POST", path, 4242, 10100, end, digest)).toBeNull();
      }
    });

    test("binds the key, nonce, pid, port and raw-body digest", () => {
      expect(verify("C".repeat(43), nonce, "POST", path, 4242, 10100, expiry, digest, proof, now)).toBe(false);
      expect(verify(secret, "B".repeat(43), "POST", path, 4242, 10100, expiry, digest, proof, now)).toBe(false);
      expect(verify(secret, nonce, "POST", path, 4243, 10100, expiry, digest, proof, now)).toBe(false);
      expect(verify(secret, nonce, "POST", path, 4242, 10101, expiry, digest, proof, now)).toBe(false);
      expect(verify(secret, nonce, "POST", path, 4242, 10100, expiry, "B".repeat(43), proof, now)).toBe(false);
      expect(verify(secret, nonce, "POST", path, 4242, 10100, expiry - 1, digest, proof, now)).toBe(false);
      expect(desktopSnapshotBodyDigest(new TextEncoder().encode('{ "sessionId":"test"}'))).not.toBe(digest);
    });

    test("cannot authorize reads, other writes, queries or path suffixes", () => {
      for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
        expect(mint(secret, nonce, method, path, 4242, 10100, expiry, digest)).toBeNull();
        expect(verify(secret, nonce, method, path, 4242, 10100, expiry, digest, proof, now)).toBe(false);
      }
      for (const other of ["/api/config", "/api/system/restart", `${path}?x=1`, `${path}/`, `${path}\n`]) {
        expect(mint(secret, nonce, "POST", other, 4242, 10100, expiry, digest)).toBeNull();
      }
    });

    test("rejects malformed credentials and instance fields without throwing", () => {
      for (const value of ["", "A".repeat(42), "A".repeat(44), "!".repeat(43)]) {
        expect(mint(value, nonce, "POST", path, 4242, 10100, expiry, digest)).toBeNull();
        expect(mint(secret, value, "POST", path, 4242, 10100, expiry, digest)).toBeNull();
        expect(mint(secret, nonce, "POST", path, 4242, 10100, expiry, value)).toBeNull();
        expect(verify(secret, nonce, "POST", path, 4242, 10100, expiry, digest, value, now)).toBe(false);
      }
      for (const pid of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(mint(secret, nonce, "POST", path, pid, 10100, expiry, digest)).toBeNull();
      }
      for (const port of [0, -1, 1.5, 65536, NaN]) {
        expect(mint(secret, nonce, "POST", path, 4242, port, expiry, digest)).toBeNull();
      }
    });

    test("preserves read-v1 and separates read grants from snapshot grants", () => {
      const read = createLocalManagementReadCapability(secret, nonce, "GET", "/api/usage?range=7d", 4242, 10100, expiry)!;
      expect(read).toBe("oGyWOCGZsICYctxQv-mPK0gCiDocvOVHQG5plyjYCUg");
      expect(verify(secret, nonce, "POST", path, 4242, 10100, expiry, digest, read, now)).toBe(false);
      expect(verifyLocalManagementReadCapability(secret, nonce, "GET", "/api/usage?range=7d", 4242, 10100, expiry, proof, now)).toBe(false);
    });
  });

  describe("single-use snapshot admission", () => {
    test("is idempotent for one Request but rejects a replayed Request", () => {
      const req = request();
      const replay = req.clone();
      expect(admit(req, local, now)).toBe(true);
      expect(admit(req, local, now)).toBe(true);
      expect(verifyBody(req, body)).toBe(true);
      expect(admit(replay, local, now)).toBe(false);
      expect(verifyBody(replay, body)).toBe(false);
    });

    test("checks the admitted digest rather than trusting a replaced header", () => {
      const req = request();
      expect(admit(req, local, now)).toBe(true);
      const changed = new TextEncoder().encode('{"sessionId":"other"}');
      req.headers.set(LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER, desktopSnapshotBodyDigest(changed));
      expect(verifyBody(req, changed)).toBe(false);
      expect(verifyBody(req, body)).toBe(true);
      expect(verifyBody(req, new Uint8Array(1025))).toBe(false);
    });

    test("refuses absent context, wrong instance and browser-origin requests", () => {
      expect(admit(request(), undefined, now)).toBe(false);
      expect(admit(request(), { ...local, pid: 4243 }, now)).toBe(false);
      expect(admit(request(), { ...local, port: 10101 }, now)).toBe(false);
      expect(admit(request(), { ...local, attestationSecret: "C".repeat(43) }, now)).toBe(false);
      for (const origin of ["", "http://127.0.0.1:10100", "https://operator.example"]) {
        const req = request(); req.headers.set("origin", origin);
        expect(admit(req, local, now)).toBe(false);
      }
    });

    test("rejects missing or malformed signed headers", () => {
      for (const header of [pidHeader, nonceHeader, expiryHeader, proofHeader, LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER]) {
        const req = request(); req.headers.delete(header);
        expect(admit(req, local, now)).toBe(false);
      }
      for (const value of ["0", "04242", "-1", "4242x", "1.5"]) {
        const req = request(); req.headers.set(pidHeader, value);
        expect(admit(req, local, now)).toBe(false);
      }
      for (const value of ["0", "01700000010000", "-1", "1.5", "Infinity", "99999999999999999999"]) {
        const req = request(); req.headers.set(expiryHeader, value);
        expect(admit(req, local, now)).toBe(false);
      }
    });

    test("denies a captured proof on another route, query or method", () => {
      for (const target of ["/api/config", "/api/system/restart", `${path}?x=1`, `${path}/`]) {
        const req = new Request(`http://127.0.0.1:10100${target}`, { method: "POST", headers: request().headers, body });
        expect(admit(req, local, now)).toBe(false);
      }
      const get = new Request(`http://127.0.0.1:10100${path}`, { headers: request().headers });
      expect(admit(get, local, now)).toBe(false);
    });

    test("fails closed at replay-cache capacity and recovers after expiry", () => {
      const later = now + 30_000;
      const first = request(later);
      const replay = first.clone();
      expect(admit(first, local, later)).toBe(true);
      for (let i = 1; i < 256; i++) expect(admit(request(later), local, later)).toBe(true);
      expect(admit(request(later), local, later)).toBe(false);
      expect(admit(replay, local, later)).toBe(false);
      expect(admit(request(later + 10_000), local, later + 10_000)).toBe(true);
      expect(admit(replay, local, later + 10_000)).toBe(false);
    });
  });
});

describe("desktop snapshot admission and route", () => {
  const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;
  const local = { attestationSecret: "B".repeat(43), pid: 4242, port: 10100 };
  const state: Extract<ManagementAuthState, { available: true }> = {
    available: true, token: "snapshot-route-test-admin", source: "environment",
    sessions: new Map(), pairingGrants: new Map(),
  };

  function payload(sessionId = randomUUID()): string {
    return JSON.stringify({
      sessionId, currentVersion: "2.61.0", latestVersion: "2.62.0", available: true,
      checkedAtMs: Date.now(), phase: "available",
    });
  }

  function signedRequest(signedBody: string, sentBody = signedBody): Request {
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 10_000;
    const digest = desktopSnapshotBodyDigest(new TextEncoder().encode(signedBody));
    return new Request(`http://127.0.0.1:10100${LOCAL_DESKTOP_SNAPSHOT_PATH}`, {
      method: "POST", body: sentBody,
      headers: {
        host: "127.0.0.1:10100", "content-type": "application/json",
        [LOCAL_MANAGEMENT_EXPECTED_PID_HEADER]: String(local.pid),
        [LOCAL_MANAGEMENT_NONCE_HEADER]: nonce,
        [LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER]: String(expiresAt),
        [LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER]: digest,
        [LOCAL_MANAGEMENT_CAPABILITY_HEADER]: createLocalDesktopSnapshotCapability(
          local.attestationSecret, nonce, "POST", LOCAL_DESKTOP_SNAPSHOT_PATH,
          local.pid, local.port, expiresAt, digest,
        )!,
      },
    });
  }

  async function dispatch(req: Request, auth: ManagementAuthState = state): Promise<Response> {
    const denied = requireManagementAuth(req, auth, undefined, local);
    if (denied) return denied;
    const principal = managementPrincipal(req, auth, undefined, local) ?? undefined;
    const response = await handleSidebarRoutes({ req, url: new URL(req.url), config, principal } as ManagementContext);
    expect(response).not.toBeNull();
    return response!;
  }

  describe("snapshot capability through management admission and the bounded route", () => {
    test("publishes and reads display state without an admin credential", async () => {
      const session = randomUUID();
      const req = signedRequest(payload(session));
      expect(req.headers.has("x-opencodex-api-key")).toBe(false);
      expect((await dispatch(req)).status).toBe(200);
      expect(managementPrincipal(req, state, undefined, local)).toBe("local-desktop-snapshot-capability");
      const read = new Request(`http://127.0.0.1:10100/api/update/badge?surface=desktop&session=${session}`);
      const response = await handleSidebarRoutes({ req: read, url: new URL(read.url), config } as ManagementContext);
      expect((await response!.json() as { unknown: boolean }).unknown).toBe(false);
    });

    test("works when file-backed management auth is unavailable", async () => {
      expect((await dispatch(signedRequest(payload()), { available: false, reason: "test ACL failure" })).status).toBe(200);
    });

    test("refuses a second request with the captured headers", async () => {
      const req = signedRequest(payload());
      const replay = req.clone();
      expect((await dispatch(req)).status).toBe(200);
      expect((await dispatch(replay)).status).toBe(401);
    });

    test("checks raw bytes before JSON parsing or state mutation", async () => {
      const session = randomUUID();
      const original = payload(session);
      expect((await dispatch(signedRequest(original, ` ${original}`))).status).toBe(403);
      expect((await dispatch(signedRequest(original, "{"))).status).toBe(403);
      const read = new Request(`http://127.0.0.1:10100/api/update/badge?surface=desktop&session=${session}`);
      const response = await handleSidebarRoutes({ req: read, url: new URL(read.url), config } as ManagementContext);
      expect((await response!.json() as { unknown: boolean }).unknown).toBe(true);
    });

    test("cannot substitute a new body digest after the gate admitted the request", async () => {
      const original = payload();
      const changed = payload();
      const req = signedRequest(original, changed);
      expect(requireManagementAuth(req, state, undefined, local)).toBeNull();
      req.headers.set(LOCAL_DESKTOP_SNAPSHOT_BODY_HEADER, desktopSnapshotBodyDigest(new TextEncoder().encode(changed)));
      expect((await dispatch(req)).status).toBe(403);
    });

    test("retains the 1 KiB streaming limit and JSON validation", async () => {
      expect((await dispatch(signedRequest("x".repeat(1025)))).status).toBe(413);
      expect((await dispatch(signedRequest("{"))).status).toBe(400);
      const text = signedRequest(payload()); text.headers.set("content-type", "text/plain");
      expect((await dispatch(text)).status).toBe(400);
    });

    test("does not trust a capability principal supplied without actual admission", async () => {
      const req = signedRequest(payload());
      const response = await handleSidebarRoutes({
        req, url: new URL(req.url), config, principal: "local-desktop-snapshot-capability",
      } as ManagementContext);
      expect(response!.status).toBe(403);
    });

    test("still rejects browser sessions and browser-origin publishers", async () => {
      const req = signedRequest(payload()); req.headers.set("origin", "http://127.0.0.1:10100");
      expect((await dispatch(req)).status).toBe(401);
      const gui = signedRequest(payload());
      const response = await handleSidebarRoutes({ req: gui, url: new URL(gui.url), config, principal: "gui-session" } as ManagementContext);
      expect(response!.status).toBe(403);
    });

    test("retains existing admin-token compatibility but not browser-origin writes", async () => {
      const request = () => new Request(`http://127.0.0.1:10100${LOCAL_DESKTOP_SNAPSHOT_PATH}`, {
        method: "POST", body: payload(),
        headers: { "content-type": "application/json", "x-opencodex-api-key": state.token },
      });
      expect((await dispatch(request())).status).toBe(200);
      const browser = request(); browser.headers.set("origin", "");
      expect((await dispatch(browser)).status).toBe(403);
    });
  });
});

describe("desktop snapshot transport source", () => {
  /** Regression for the snapshot write left outside the initial read-capability fix. */
  test("all ProxyClient management transports keep the reusable admin token off the wire", () => {
    const source = readFileSync(repoPath("desktop/src-tauri/src/proxy.rs"), "utf8")
      .split("#[cfg(test)]")[0]!
      .replace(/\/\/[^\n]*/g, "");
    expect(source).not.toContain("authorised_token");
    expect(source).not.toContain("self.auth.token()");
    expect(source.toLowerCase()).not.toContain("x-opencodex-api-key");
    const snapshot = source.slice(source.indexOf("pub async fn post_desktop_snapshot"), source.indexOf("async fn request("));
    expect(snapshot).toContain("self.authorised_runtime()?");
    expect(snapshot).toContain("CapabilityHeaders::mint_snapshot(&recorded, &body)");
    expect(snapshot).toContain("serde_json::to_vec(body)");
    expect(snapshot).toContain(".body(body)");
    expect(snapshot).not.toContain(".json(body)");
    expect(snapshot).not.toContain("identify()");
  });
});

describe("native tray provider account read grants", () => {
  const local = { attestationSecret: "D".repeat(43), pid: 5759, port: 10100 };
  const state: ManagementAuthState = {
    available: true, token: "tray-read-test-admin", source: "environment",
    sessions: new Map(), pairingGrants: new Map(),
  };
  const cases = [
    [LOCAL_MANAGEMENT_READ_PATHS.oauthAccounts,
      "/api/oauth/accounts?provider=anthropic&quota=1",
      "/api/oauth/accounts?provider=xai&quota=1"],
    [LOCAL_MANAGEMENT_READ_PATHS.providerKeys,
      "/api/providers/keys?name=example&quota=1",
      "/api/providers/keys?name=other&quota=1"],
  ] as const;

  /** Mint precisely the request target emitted by native_tray_accounts::query. */
  function signed(target: string): Request {
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS;
    const proof = createLocalManagementReadCapability(
      local.attestationSecret, nonce, "GET", target, local.pid, local.port, expiresAt,
    );
    expect(proof).not.toBeNull();
    return new Request(`http://127.0.0.1:${local.port}${target}`, {
      headers: {
        [pidHeader]: String(local.pid), [nonceHeader]: nonce,
        [expiryHeader]: String(expiresAt), [proofHeader]: proof!,
      },
    });
  }

  for (const [pathname, target, other] of cases) {
    test(`${pathname}: admits its real query once without an admin token`, () => {
      const req = signed(target);
      const replay = req.clone();
      expect(req.headers.has("x-opencodex-api-key")).toBe(false);
      expect(requireManagementAuth(req, state, undefined, local)).toBeNull();
      expect(managementPrincipal(req, state, undefined, local)).toBe("local-read-capability");
      expect(requireManagementAuth(replay, state, undefined, local)?.status).toBe(401);
    });

    test(`${pathname}: unused proof cannot change selector, route or method`, () => {
      // Never admit the original first: rejection must prove binding, not merely replay.
      for (const altered of [other, `${pathname}/extra`, "/api/config"]) {
        const original = signed(target);
        const req = new Request(`http://127.0.0.1:${local.port}${altered}`, {
          headers: original.headers,
        });
        expect(requireManagementAuth(req, state, undefined, local)?.status).toBe(401);
      }
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const original = signed(target);
        const req = new Request(original.url, { method, headers: original.headers });
        expect(requireManagementAuth(req, state, undefined, local)?.status).toBe(401);
        expect(createLocalManagementReadCapability(
          local.attestationSecret, "A".repeat(43), method, target,
          local.pid, local.port, Date.now() + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS,
        )).toBeNull();
      }
    });
  }

  test("every native account source is covered by the explicit read allowlist", () => {
    const source = readFileSync(repoPath("desktop/src-tauri/src/native_tray_accounts.rs"), "utf8")
      .split("#[cfg(test)]")[0]!;
    const paths = new Set([...source.matchAll(/"(\/api\/[^"?]+)"/g)].map(match => match[1]!));
    expect(paths.size).toBeGreaterThan(0);
    for (const target of paths) {
      expect(Object.values(LOCAL_MANAGEMENT_READ_PATHS) as string[]).toContain(target);
    }
  });

  test("the desktop Auth no longer loads reusable admin credentials", () => {
    const source = readFileSync(repoPath("desktop/src-tauri/src/auth.rs"), "utf8");
    expect(source).not.toContain("OPENCODEX_ADMIN_AUTH_TOKEN");
    expect(source).not.toContain("admin-api-token");
    expect(source).not.toContain("pub fn token(");
    expect(source).toContain("runtime-port.json");
  });
});
