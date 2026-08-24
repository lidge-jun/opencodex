import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HubAuth } from "../hub/src/auth";
import { type HubConfig, loadHubConfig, validateHubConfig } from "../hub/src/config";
import { HubDatabase } from "../hub/src/database";
import { HubRateLimiter } from "../hub/src/rate-limit";
import { validPassword } from "../hub/src/security";
import { HubService } from "../hub/src/server";

const temporaryDirectories: string[] = [];

function tempDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "hubapi-auth-test-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "hub.sqlite") };
}

function config(databasePath: string): HubConfig {
  return {
    databasePath,
    digestSecret: "test-only-digest-secret-with-at-least-32-bytes",
    publicOrigin: "http://127.0.0.1:10400",
    hostname: "127.0.0.1",
    port: 0,
    allowRegistration: true,
    sessionTtlSeconds: 3600,
    development: true,
    trustLoopbackProxy: false,
    opencodexOrigin: "http://127.0.0.1:10100",
    internalAdmissionToken: "test-only-internal-admission-token-at-least-32-bytes",
    requestCostUnits: 100,
    pricingVersion: "test-v1",
    upstreamTimeoutMs: 5_000,
  };
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
}

function cookieHeader(response: Response): string {
  return setCookies(response).map(value => value.split(";", 1)[0]).join("; ");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("hub hosted config boundary", () => {
  test("requires HTTPS outside explicit loopback development", () => {
    expect(() => validateHubConfig({ ...config("/tmp/hub.sqlite"), development: false, hostname: "0.0.0.0" }))
      .toThrow("https public origin");
    expect(() => validateHubConfig({ ...config("/tmp/hub.sqlite"), digestSecret: "short" }))
      .toThrow("at least 32 bytes");
  });

  test("fails closed on unsafe secrets, origins, session lifetime, and registration defaults", () => {
    const base = config("/tmp/hub.sqlite");
    expect(() => validateHubConfig({ ...base, digestSecret: "change-me-change-me-change-me-change-me" })).toThrow("placeholder");
    expect(() => validateHubConfig({ ...base, internalAdmissionToken: base.digestSecret })).toThrow("must be different");
    expect(() => validateHubConfig({ ...base, publicOrigin: "http://user:pass@127.0.0.1:10400" })).toThrow("without credentials");
    expect(() => validateHubConfig({ ...base, development: false, hostname: "0.0.0.0", publicOrigin: "https://127.0.0.1:10400" })).toThrow("must not be loopback");
    expect(() => validateHubConfig({ ...base, sessionTtlSeconds: 299 })).toThrow("between 300 and 2592000");
    const loaded = loadHubConfig({
      HUB_DEVELOPMENT: "1",
      HUB_DATABASE_PATH: base.databasePath,
      HUB_DIGEST_SECRET: base.digestSecret,
      HUB_PUBLIC_ORIGIN: base.publicOrigin,
      HUB_OPENCODEX_ORIGIN: base.opencodexOrigin,
      HUB_INTERNAL_ADMISSION_TOKEN: base.internalAdmissionToken,
      HUB_REQUEST_COST_UNITS: String(base.requestCostUnits),
      HUB_PRICING_VERSION: base.pricingVersion,
    });
    expect(loaded.allowRegistration).toBe(false);
    expect(loaded.upstreamTimeoutMs).toBe(120_000);
  });

  test("ordinary OpenCodex entrypoints do not import or start hub", () => {
    for (const path of ["src/router.ts", "src/server/lifecycle.ts", "src/server/responses/core.ts", "src/server/index.ts"]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/(?:from|import\()\s*["'][^"']*hub\//);
    }
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe("bun run src/cli/index.ts start");
  });
});

describe("hub authentication store", () => {
  test("creates a private database file and refuses a symbolic-link target", () => {
    const { directory, path } = tempDatabase();
    const database = new HubDatabase(path);
    expect(statSync(path).mode & 0o777).toBe(process.platform === "win32" ? statSync(path).mode & 0o777 : 0o600);
    database.close();

    if (process.platform !== "win32") {
      const target = join(directory, "existing.sqlite");
      const linked = join(directory, "linked.sqlite");
      writeFileSync(target, "not a database", { mode: 0o600 });
      symlinkSync(target, linked);
      expect(() => new HubDatabase(linked)).toThrow("unsafe hub database path");
    }
  });

  test("rejects common, repeated, and whitespace-only passwords", async () => {
    expect(validPassword("password1234")).toBe(false);
    expect(validPassword("aaaaaaaaaaaa")).toBe(false);
    expect(validPassword("            ")).toBe(false);
    expect(validPassword("correct horse battery staple")).toBe(true);

    const { path } = tempDatabase();
    const database = new HubDatabase(path);
    const auth = new HubAuth(database.db, config(path).digestSecret, 3600);
    await expect(auth.register("weak@example.com", "password1234")).rejects.toThrow("invalid_registration");
    await expect(auth.bootstrapAdmin("admin@example.com", "aaaaaaaaaaaa")).rejects.toThrow("invalid_bootstrap_input");
    expect(database.db.query("SELECT count(*) AS count FROM hub_users").get()).toEqual({ count: 0 });
    database.close();
  });

  test("bootstraps exactly one administrator with Argon2id and no default account", async () => {
    const { path } = tempDatabase();
    const database = new HubDatabase(path);
    const auth = new HubAuth(database.db, config(path).digestSecret, 3600);
    expect(database.db.query("SELECT count(*) AS count FROM hub_users").get()).toEqual({ count: 0 });

    const admin = await auth.bootstrapAdmin("Admin@Example.com", "a sufficiently long admin password");
    expect(admin.role).toBe("admin");
    const stored = database.db.query("SELECT email, password_hash FROM hub_users WHERE id = ?").get(admin.id) as { email: string; password_hash: string };
    expect(stored.email).toBe("admin@example.com");
    expect(stored.password_hash).toStartWith("$argon2id$");
    expect(stored.password_hash).not.toContain("sufficiently long");
    await expect(auth.bootstrapAdmin("other@example.com", "another sufficiently long password"))
      .rejects.toThrow("admin_already_bootstrapped");
    database.close();
  });

  test("stores only session and CSRF digests and revokes all sessions after password change", async () => {
    const { path } = tempDatabase();
    const database = new HubDatabase(path);
    const auth = new HubAuth(database.db, config(path).digestSecret, 3600);
    const issued = await auth.register("user@example.com", "correct horse battery staple");
    const row = database.db.query("SELECT token_digest, csrf_digest FROM hub_sessions WHERE id = ?").get(issued.sessionId) as { token_digest: string; csrf_digest: string };
    expect(row.token_digest).not.toContain(issued.token);
    expect(row.csrf_digest).not.toContain(issued.csrfToken);
    expect(auth.authenticate(issued.token)?.user.id).toBe(issued.user.id);

    await auth.changePassword(issued.user.id, "correct horse battery staple", "a new correct horse battery staple");
    expect(auth.authenticate(issued.token)).toBeNull();
    await expect(auth.login("user@example.com", "correct horse battery staple")).rejects.toThrow("invalid_credentials");
    expect((await auth.login("user@example.com", "a new correct horse battery staple")).user.id).toBe(issued.user.id);
    database.close();
  });

  test("caps active sessions and revokes the oldest session", async () => {
    const { path } = tempDatabase();
    const database = new HubDatabase(path);
    const auth = new HubAuth(database.db, config(path).digestSecret, 3600);
    const first = await auth.register("sessions@example.com", "correct horse battery staple", 1_000);
    for (let index = 0; index < 10; index += 1) {
      await auth.login("sessions@example.com", "correct horse battery staple", 2_000 + index);
    }
    expect(auth.listSessions(first.user.id, 3_000)).toHaveLength(10);
    expect(auth.authenticate(first.token, 3_000)).toBeNull();
    const stored = database.db.query(`SELECT count(*) AS count FROM hub_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`).get(first.user.id, 3_000) as { count: number };
    expect(stored.count).toBe(10);
    database.close();
  });

  test("rate limits repeated invalid login attempts without storing the email", async () => {
    const { path } = tempDatabase();
    const database = new HubDatabase(path);
    const auth = new HubAuth(database.db, config(path).digestSecret, 3600);
    await auth.register("rate@example.com", "correct horse battery staple");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(auth.login("rate@example.com", "wrong password value", 1_000 + attempt)).rejects.toThrow("invalid_credentials");
    }
    await expect(auth.login("rate@example.com", "correct horse battery staple", 2_000)).rejects.toThrow("login_rate_limited");
    const failure = database.db.query("SELECT subject_digest FROM hub_auth_failures").get() as { subject_digest: string };
    expect(failure.subject_digest).not.toContain("rate@example.com");
    database.close();
  });

  test("persists network limits using only a keyed subject digest", () => {
    const { path } = tempDatabase();
    const database = new HubDatabase(path);
    const limiter = new HubRateLimiter(database.db, config(path).digestSecret);
    expect(limiter.consume("auth.register", "203.0.113.42", 2, 10_000, 1_000).allowed).toBe(true);
    expect(limiter.consume("auth.register", "203.0.113.42", 2, 10_000, 1_001).allowed).toBe(true);
    const denied = limiter.consume("auth.register", "203.0.113.42", 2, 10_000, 1_002);
    expect(denied).toEqual({ allowed: false, retryAfterSeconds: 10 });
    const stored = database.db.query("SELECT subject_digest FROM hub_rate_limits").get() as { subject_digest: string };
    expect(stored.subject_digest).not.toContain("203.0.113.42");
    expect(limiter.consume("auth.register", "203.0.113.42", 2, 10_000, 11_001).allowed).toBe(true);
    database.close();
  });
});

describe("hub browser session boundary", () => {
  test("uses one generic registration failure for invalid and existing accounts", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    const register = (email: string, password: string) => service.fetch(new Request("http://127.0.0.1:10400/hub/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: service.config.publicOrigin },
      body: JSON.stringify({ email, password }),
    }), "203.0.113.18");

    expect((await register("registered@example.com", "correct horse battery staple")).status).toBe(201);
    const duplicate = await register("registered@example.com", "correct horse battery staple");
    const invalid = await register("not-an-email", "password1234");
    expect(duplicate.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "registration_unavailable" });
    expect(await invalid.json()).toEqual({ error: "registration_unavailable" });
    service.stop();
  });

  test("rate limits recharge-code guessing per authenticated user", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    const issued = await service.auth.register("redeem@example.com", "correct horse battery staple");
    const headers = {
      "content-type": "application/json",
      Cookie: `hubapi_session=${issued.token}; hubapi_csrf=${issued.csrfToken}`,
      Origin: service.config.publicOrigin,
      "x-hubapi-csrf-token": issued.csrfToken,
    };
    const redeem = (attempt: number) => service.fetch(new Request("http://127.0.0.1:10400/hub/account/redeem", {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": `redeem-guess-${String(attempt).padStart(4, "0")}` },
      body: JSON.stringify({ code: `hub_rc_missing-${String(attempt).padStart(12, "0")}` }),
    }), "203.0.113.19");

    for (let attempt = 0; attempt < 10; attempt += 1) expect((await redeem(attempt)).status).toBe(409);
    const limited = await redeem(10);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    service.stop();
  });

  test("requires configured Origin, HttpOnly session cookie, and session-bound CSRF", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    const rejected = await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
    }));
    expect(rejected.status).toBe(403);

    const registered = await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: service.config.publicOrigin },
      body: JSON.stringify({ email: "user@example.com", password: "correct horse battery staple" }),
    }));
    expect(registered.status).toBe(201);
    const body = await registered.json() as { csrfToken: string };
    const cookies = setCookies(registered);
    expect(cookies.find(value => value.startsWith("hubapi_session="))).toContain("HttpOnly");
    expect(cookies.find(value => value.startsWith("hubapi_csrf="))).not.toContain("HttpOnly");
    expect(registered.headers.get("cache-control")).toBe("no-store");

    const cookie = cookieHeader(registered);
    const missingCsrf = await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: service.config.publicOrigin },
    }));
    expect(missingCsrf.status).toBe(403);

    const logout = await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: service.config.publicOrigin, "x-hubapi-csrf-token": body.csrfToken },
    }));
    expect(logout.status).toBe(200);
    const afterLogout = await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/me", { headers: { Cookie: cookie } }));
    expect(afterLogout.status).toBe(401);
    service.stop();
  });

  test("revokes user API keys without placing the key identifier in the URL", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    const issued = await service.auth.register("key-owner@example.com", "correct horse battery staple");
    const key = service.billing.createApiKey(issued.user.id, "Private URL key");
    const headers = {
      "content-type": "application/json",
      Cookie: `hubapi_session=${issued.token}; hubapi_csrf=${issued.csrfToken}`,
      Origin: service.config.publicOrigin,
      "x-hubapi-csrf-token": issued.csrfToken,
    };

    expect((await service.fetch(new Request(`http://127.0.0.1:10400/hub/account/keys/${key.id}`, {
      method: "DELETE",
      headers,
    }))).status).toBe(404);
    const revoked = await service.fetch(new Request("http://127.0.0.1:10400/hub/account/key", {
      method: "DELETE",
      headers,
      body: JSON.stringify({ keyId: key.id }),
    }));
    expect(revoked.status).toBe(200);
    expect(service.billing.authenticateApiKey(key.key)).toBeNull();
    service.stop();
  });

  test("never dispatches an OpenCodex management or unknown route", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    expect((await service.fetch(new Request("http://127.0.0.1:10400/api/config"))).status).toBe(404);
    expect((await service.fetch(new Request("http://127.0.0.1:10400/v1/responses"))).status).toBe(405);
    expect((await service.fetch(new Request("http://127.0.0.1:10400/hub/unknown"))).status).toBe(404);
    service.stop();
  });

  test("reports anonymous browser status without a noisy authentication error", async () => {
    const { path } = tempDatabase();
    const hub = new HubService(config(path));
    const status = await hub.fetch(new Request("http://127.0.0.1:10400/hub/auth/status"));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ authenticated: false });
    const favicon = await hub.fetch(new Request("http://127.0.0.1:10400/favicon.ico"));
    expect(favicon.status).toBe(204);
    hub.stop();
  });

  test("rotates an existing browser session after login", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    const registered = await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: service.config.publicOrigin },
      body: JSON.stringify({ email: "rotate@example.com", password: "correct horse battery staple" }),
    }));
    const oldCookie = cookieHeader(registered);
    const loggedIn = await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: oldCookie, Origin: service.config.publicOrigin },
      body: JSON.stringify({ email: "rotate@example.com", password: "correct horse battery staple" }),
    }));
    expect(loggedIn.status).toBe(200);
    expect(cookieHeader(loggedIn)).not.toBe(oldCookie);
    expect((await service.fetch(new Request("http://127.0.0.1:10400/hub/auth/me", { headers: { Cookie: oldCookie } }))).status).toBe(401);
    service.stop();
  });

  test("records a failed audit event for a rejected administrator mutation", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    await service.auth.bootstrapAdmin("admin@example.com", "a sufficiently long admin password");
    const admin = await service.auth.login("admin@example.com", "a sufficiently long admin password");
    const response = await service.fetch(new Request("http://127.0.0.1:10400/hub/admin/recharge-batches", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Cookie: `hubapi_session=${admin.token}; hubapi_csrf=${admin.csrfToken}`,
        Origin: service.config.publicOrigin,
        "x-hubapi-csrf-token": admin.csrfToken,
      },
      body: JSON.stringify({ label: "invalid batch" }),
    }), "203.0.113.9");
    expect(response.status).toBe(400);
    expect(service.billing.listAudit(admin.user)).toContainEqual(expect.objectContaining({
      action: "recharge_batch.create",
      targetType: "recharge_batch",
      targetId: null,
      outcome: "failed",
    }));
    service.stop();
  });

  test("does not disclose unexpected database errors from administrator mutations", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path));
    await service.auth.bootstrapAdmin("admin@example.com", "a sufficiently long admin password");
    const admin = await service.auth.login("admin@example.com", "a sufficiently long admin password");
    const mutationHeaders = {
      "content-type": "application/json",
      Cookie: `hubapi_session=${admin.token}; hubapi_csrf=${admin.csrfToken}`,
      Origin: service.config.publicOrigin,
      "x-hubapi-csrf-token": admin.csrfToken,
    };
    service.billing.createRechargeBatch = (() => {
      throw new Error("SQLITE_IOERR /private/hub.sqlite internal-detail");
    }) as typeof service.billing.createRechargeBatch;
    const batchResponse = await service.fetch(new Request("http://127.0.0.1:10400/hub/admin/recharge-batches", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ label: "valid batch", unitAmount: 100, quantity: 1 }),
    }), "203.0.113.10");
    expect(batchResponse.status).toBe(500);
    expect(await batchResponse.json()).toEqual({ error: "admin_action_failed" });

    service.billing.adminUserDetails = (() => {
      throw new Error("SQLITE_IOERR /private/hub.sqlite internal-detail");
    }) as typeof service.billing.adminUserDetails;
    const detailsResponse = await service.fetch(new Request("http://127.0.0.1:10400/hub/admin/user-details", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ userId: admin.user.id }),
    }), "203.0.113.10");
    expect(detailsResponse.status).toBe(500);
    expect(await detailsResponse.json()).toEqual({ error: "admin_action_failed" });

    service.billing.adjustBalance = (() => {
      throw new Error("SQLITE_IOERR /private/hub.sqlite internal-detail");
    }) as typeof service.billing.adjustBalance;

    const response = await service.fetch(new Request("http://127.0.0.1:10400/hub/admin/ledger-adjustments", {
      method: "POST",
      headers: { ...mutationHeaders, "Idempotency-Key": "admin-error-test-0001" },
      body: JSON.stringify({ userId: admin.user.id, amountUnits: 1, reason: "test failure mapping" }),
    }), "203.0.113.10");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "admin_action_failed" });
    service.stop();
  });

  test("keeps model discovery account-scoped and administrator support views masked", async () => {
    const { path } = tempDatabase();
    const service = new HubService(config(path), {
      fetchImpl: async () => Response.json({ object: "list", data: [{ id: "coding" }, { id: "vision" }] }),
    });
    const adminUser = await service.auth.bootstrapAdmin("admin@example.com", "a sufficiently long admin password");
    const userSession = await service.auth.register("user@example.com", "correct horse battery staple");
    const adminSession = await service.auth.login("admin@example.com", "a sufficiently long admin password");
    const key = service.billing.createApiKey(userSession.user.id, "User key");

    expect((await service.fetch(new Request("http://127.0.0.1:10400/hub/account/models"))).status).toBe(401);
    const userCookie = `hubapi_session=${userSession.token}; hubapi_csrf=${userSession.csrfToken}`;
    const catalog = await service.fetch(new Request("http://127.0.0.1:10400/hub/account/models", { headers: { Cookie: userCookie } }));
    expect(await catalog.json()).toMatchObject({ status: "available", models: ["coding", "vision"], upstreamStatus: 200 });
    expect((await service.fetch(new Request("http://127.0.0.1:10400/hub/admin/user-details", {
      method: "POST",
      headers: { Cookie: userCookie, Origin: service.config.publicOrigin, "content-type": "application/json", "x-hubapi-csrf-token": userSession.csrfToken },
      body: JSON.stringify({ userId: userSession.user.id }),
    }))).status).toBe(403);

    const adminCookie = `hubapi_session=${adminSession.token}; hubapi_csrf=${adminSession.csrfToken}`;
    const details = await service.fetch(new Request("http://127.0.0.1:10400/hub/admin/user-details", {
      method: "POST",
      headers: { Cookie: adminCookie, Origin: service.config.publicOrigin, "content-type": "application/json", "x-hubapi-csrf-token": adminSession.csrfToken },
      body: JSON.stringify({ userId: userSession.user.id }),
    }));
    const detailsBody = await details.json() as Record<string, unknown>;
    expect(details.status).toBe(200);
    expect(JSON.stringify(detailsBody)).toContain(userSession.user.supportReference);
    expect(JSON.stringify(detailsBody)).not.toContain("user@example.com");
    expect(JSON.stringify(detailsBody)).not.toContain(key.key);

    const revoked = await service.fetch(new Request("http://127.0.0.1:10400/hub/admin/api-key", {
      method: "DELETE",
      headers: { Cookie: adminCookie, Origin: service.config.publicOrigin, "content-type": "application/json", "x-hubapi-csrf-token": adminSession.csrfToken },
      body: JSON.stringify({ keyId: key.id }),
    }));
    expect(revoked.status).toBe(200);
    expect(service.billing.authenticateApiKey(key.key)).toBeNull();
    expect(adminUser.role).toBe("admin");
    service.stop();
  });
});
