import type { Server } from "bun";
import { HubAuth, type AuthenticatedSession, type IssuedSession } from "./auth";
import { readBoundedBody } from "./body";
import { HubBilling } from "./billing";
import { HUB_PUBLIC_PROXY_PATHS, HubAdmission } from "./admission";
import { type HubConfig, validateHubConfig } from "./config";
import { HubDatabase } from "./database";
import { HubRateLimiter } from "./rate-limit";
import { resolveNetworkSubject } from "./network";
import {
  clearCsrfCookie,
  clearSessionCookie,
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfCookie,
  parseCookies,
  securityHeaders,
  SESSION_COOKIE,
  sessionCookie,
} from "./security";

const JSON_BODY_MAX_BYTES = 64 * 1024;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOGIN_NETWORK_LIMIT = 30;
const REGISTRATION_NETWORK_LIMIT = 5;
const AUTH_RATE_WINDOW_MS = 15 * 60_000;
const REGISTRATION_RATE_WINDOW_MS = 60 * 60_000;
const RECHARGE_USER_LIMIT = 10;
const RECHARGE_NETWORK_LIMIT = 30;
const RECHARGE_RATE_WINDOW_MS = 15 * 60_000;
const ADMIN_ACTION_LIMIT = 20;
const ADMIN_ACTION_WINDOW_MS = 60_000;
const PASSWORD_CHANGE_USER_LIMIT = 5;
const PASSWORD_CHANGE_NETWORK_LIMIT = 15;
const PASSWORD_CHANGE_WINDOW_MS = 15 * 60_000;
type HubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", ...securityHeaders() });
  if (extraHeaders) for (const [key, value] of new Headers(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

const PORTAL_FILES = new Map([
  ["/hub/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/hub", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/hub/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/hub/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

async function portalResponse(pathname: string): Promise<Response | null> {
  const asset = PORTAL_FILES.get(pathname);
  if (!asset) return null;
  const file = Bun.file(new URL(`../portal/${asset.file}`, import.meta.url));
  if (!(await file.exists())) return json({ error: "portal_asset_missing" }, 503);
  const headers = new Headers({
    ...securityHeaders(),
    "Content-Type": asset.type,
    "Cache-Control": asset.file === "index.html" ? "no-store" : "no-cache",
  });
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  return new Response(file, { headers });
}

function withSessionCookies(response: Response, session: IssuedSession, secure: boolean, ttl: number): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", sessionCookie(session.token, secure, ttl));
  headers.append("Set-Cookie", csrfCookie(session.csrfToken, secure, ttl));
  return new Response(response.body, { status: response.status, headers });
}

function withClearedCookies(response: Response, secure: boolean): Response {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", clearSessionCookie(secure));
  headers.append("Set-Cookie", clearCsrfCookie(secure));
  return new Response(response.body, { status: response.status, headers });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const encoding = req.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") throw new Error("unsupported_content_encoding");
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("unsupported_media_type");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > JSON_BODY_MAX_BYTES) throw new Error("invalid_body");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readBoundedBody(req.body, JSON_BODY_MAX_BYTES));
  } catch {
    throw new Error("invalid_body");
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("invalid_body");
  }
}

function requestOriginAllowed(req: Request, configuredOrigin: string): boolean {
  return req.headers.get("Origin") === configuredOrigin;
}

export class HubService {
  readonly config: HubConfig;
  readonly database: HubDatabase;
  readonly auth: HubAuth;
  readonly billing: HubBilling;
  readonly admission: HubAdmission;
  readonly rateLimiter: HubRateLimiter;
  private server: Server<undefined> | null = null;

  constructor(config: HubConfig, dependencies: { fetchImpl?: HubFetch } = {}) {
    this.config = validateHubConfig(config);
    this.database = new HubDatabase(this.config.databasePath);
    this.auth = new HubAuth(this.database.db, this.config.digestSecret, this.config.sessionTtlSeconds);
    this.billing = new HubBilling(this.database.db, this.config.digestSecret);
    this.admission = new HubAdmission(this.config, this.billing, dependencies.fetchImpl);
    this.rateLimiter = new HubRateLimiter(this.database.db, this.config.digestSecret);
  }

  private session(req: Request): AuthenticatedSession | null {
    const token = parseCookies(req.headers.get("Cookie")).get(SESSION_COOKIE);
    return this.auth.authenticate(token);
  }

  private requireSession(req: Request): AuthenticatedSession | Response {
    const session = this.session(req);
    return session ?? json({ error: "authentication_required" }, 401);
  }

  private requireMutationEvidence(req: Request, session?: AuthenticatedSession): Response | null {
    if (!requestOriginAllowed(req, this.config.publicOrigin)) return json({ error: "origin_rejected" }, 403);
    if (!session) return null;
    const cookies = parseCookies(req.headers.get("Cookie"));
    const headerToken = req.headers.get(CSRF_HEADER);
    if (!headerToken || cookies.get(CSRF_COOKIE) !== headerToken || !this.auth.verifyCsrf(session, headerToken)) {
      return json({ error: "csrf_rejected" }, 403);
    }
    return null;
  }

  private requireAdmin(session: AuthenticatedSession, recent = false): Response | null {
    if (session.user.role !== "admin") return json({ error: "admin_required" }, 403);
    if (recent && Date.now() - session.authenticatedAt > 15 * 60_000) return json({ error: "recent_authentication_required" }, 403);
    return null;
  }

  private consumeRateLimit(scope: string, subject: string, limit: number, windowMs: number): Response | null {
    const decision = this.rateLimiter.consume(scope, subject, limit, windowMs);
    return decision.allowed ? null : json({ error: "rate_limited" }, 429, { "Retry-After": String(decision.retryAfterSeconds) });
  }

  private requireAdminMutation(req: Request, session: AuthenticatedSession, action: string): Response | null {
    const rejection = this.requireMutationEvidence(req, session) ?? this.requireAdmin(session, true);
    if (rejection) return rejection;
    const limited = this.consumeRateLimit(`admin.${action}`, session.user.id, ADMIN_ACTION_LIMIT, ADMIN_ACTION_WINDOW_MS);
    if (limited) this.billing.recordAdminAudit(session.user, `rate_limit.${action}`, "admin_action", null, "denied");
    return limited;
  }

  async fetch(req: Request, clientAddress = "unknown"): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers: securityHeaders() });
    if (this.admission.handles(url.pathname)) return this.admission.handle(req);
    if (req.method === "GET") {
      const portal = await portalResponse(url.pathname);
      if (portal) return portal;
    }
    if (!url.pathname.startsWith("/hub/")) return json({ error: "not_found" }, 404);
    if (MUTATING_METHODS.has(req.method) && !requestOriginAllowed(req, this.config.publicOrigin)) {
      return json({ error: "origin_rejected" }, 403);
    }

    try {
      if (req.method === "GET" && url.pathname === "/hub/health") {
        return json({
          status: "ok",
          mode: "hosted",
          version: 1,
          pricingVersion: this.config.pricingVersion,
          requestCostUnits: this.config.requestCostUnits,
          billingPolicy: "fixed_on_upstream_acceptance",
          registrationEnabled: this.config.allowRegistration,
          proxy: {
            status: "edge_ready",
            upstreamStatus: "not_probed",
            endpoints: [...HUB_PUBLIC_PROXY_PATHS],
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/hub/auth/register") {
        if (!this.config.allowRegistration) return json({ error: "registration_disabled" }, 403);
        const limited = this.consumeRateLimit("auth.register", clientAddress, REGISTRATION_NETWORK_LIMIT, REGISTRATION_RATE_WINDOW_MS);
        if (limited) return limited;
        const body = await readJson(req);
        const session = await this.auth.register(body.email, body.password);
        const priorSession = this.session(req);
        if (priorSession) this.auth.revokeSession(priorSession.sessionId);
        return withSessionCookies(json({ user: session.user, csrfToken: session.csrfToken }, 201), session, !this.config.development, this.config.sessionTtlSeconds);
      }

      if (req.method === "POST" && url.pathname === "/hub/auth/login") {
        const limited = this.consumeRateLimit("auth.login", clientAddress, LOGIN_NETWORK_LIMIT, AUTH_RATE_WINDOW_MS);
        if (limited) return limited;
        const body = await readJson(req);
        try {
          const priorSession = this.session(req);
          const session = await this.auth.login(body.email, body.password);
          if (priorSession) this.auth.revokeSession(priorSession.sessionId);
          return withSessionCookies(json({ user: session.user, csrfToken: session.csrfToken }), session, !this.config.development, this.config.sessionTtlSeconds);
        } catch (error) {
          if ((error as Error).message === "login_rate_limited") return json({ error: "login_rate_limited" }, 429, { "Retry-After": "900" });
          return json({ error: "invalid_credentials" }, 401);
        }
      }

      if (req.method === "GET" && url.pathname === "/hub/auth/me") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        return json({ user: session.user, sessionId: session.sessionId, expiresAt: session.expiresAt });
      }

      if (req.method === "GET" && url.pathname === "/hub/auth/status") {
        const session = this.session(req);
        return session
          ? json({ authenticated: true, user: session.user, sessionId: session.sessionId, expiresAt: session.expiresAt })
          : json({ authenticated: false });
      }

      if (req.method === "GET" && url.pathname === "/hub/auth/sessions") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        return json({ sessions: this.auth.listSessions(session.user.id), currentSessionId: session.sessionId });
      }

      if (req.method === "POST" && url.pathname === "/hub/auth/logout") {
        const session = this.requireSession(req);
        if (session instanceof Response) return withClearedCookies(session, !this.config.development);
        const rejection = this.requireMutationEvidence(req, session);
        if (rejection) return rejection;
        this.auth.revokeSession(session.sessionId);
        return withClearedCookies(json({ ok: true }), !this.config.development);
      }

      if (req.method === "POST" && url.pathname === "/hub/auth/logout-all") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireMutationEvidence(req, session);
        if (rejection) return rejection;
        this.auth.revokeAllSessions(session.user.id);
        return withClearedCookies(json({ ok: true }), !this.config.development);
      }

      if (req.method === "POST" && url.pathname === "/hub/auth/password") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireMutationEvidence(req, session);
        if (rejection) return rejection;
        const userLimited = this.consumeRateLimit("auth.password.user", session.user.id, PASSWORD_CHANGE_USER_LIMIT, PASSWORD_CHANGE_WINDOW_MS);
        const networkLimited = this.consumeRateLimit("auth.password.network", clientAddress, PASSWORD_CHANGE_NETWORK_LIMIT, PASSWORD_CHANGE_WINDOW_MS);
        if (userLimited || networkLimited) return userLimited ?? networkLimited!;
        const body = await readJson(req);
        try {
          await this.auth.changePassword(session.user.id, body.currentPassword, body.newPassword);
        } catch {
          return json({ error: "password_change_rejected" }, 400);
        }
        return withClearedCookies(json({ ok: true, reauthenticationRequired: true }), !this.config.development);
      }

      if (req.method === "GET" && url.pathname === "/hub/account/keys") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        return json({ keys: this.billing.listApiKeys(session.user.id) });
      }

      if (req.method === "POST" && url.pathname === "/hub/account/keys") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireMutationEvidence(req, session);
        if (rejection) return rejection;
        const body = await readJson(req);
        try {
          const created = this.billing.createApiKey(session.user.id, body.name);
          return json({ key: created }, 201);
        } catch {
          return json({ error: "invalid_key_name" }, 400);
        }
      }

      if (req.method === "DELETE" && url.pathname === "/hub/account/key") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireMutationEvidence(req, session);
        if (rejection) return rejection;
        const body = await readJson(req);
        const keyId = typeof body.keyId === "string" ? body.keyId : "";
        if (!/^[0-9a-f-]{36}$/i.test(keyId) || !this.billing.revokeApiKey(session.user.id, keyId)) return json({ error: "key_not_found" }, 404);
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/hub/account/balance") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        return json(this.billing.balance(session.user.id));
      }

      if (req.method === "GET" && url.pathname === "/hub/account/ledger") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        return json({ entries: this.billing.listLedger(session.user.id, Number(url.searchParams.get("limit") ?? "100")) });
      }

      if (req.method === "GET" && url.pathname === "/hub/account/requests") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        return json({ requests: this.billing.listRequests(session.user.id, Number(url.searchParams.get("limit") ?? "100")) });
      }

      if (req.method === "GET" && url.pathname === "/hub/account/models") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        return json(await this.admission.modelCatalog(req.signal));
      }

      if (req.method === "POST" && url.pathname === "/hub/account/redeem") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireMutationEvidence(req, session);
        if (rejection) return rejection;
        const userLimited = this.consumeRateLimit("recharge.redeem.user", session.user.id, RECHARGE_USER_LIMIT, RECHARGE_RATE_WINDOW_MS);
        if (userLimited) return userLimited;
        const networkLimited = this.consumeRateLimit("recharge.redeem.network", clientAddress, RECHARGE_NETWORK_LIMIT, RECHARGE_RATE_WINDOW_MS);
        if (networkLimited) return networkLimited;
        const body = await readJson(req);
        try {
          return json(this.billing.redeem(session.user.id, body.code, req.headers.get("Idempotency-Key")));
        } catch (error) {
          const code = (error as Error).message;
          if (code === "idempotency_conflict") return json({ error: code }, 409);
          if (code === "invalid_idempotency_key" || code === "invalid_recharge_code") return json({ error: code }, 400);
          return json({ error: "recharge_unavailable" }, 409);
        }
      }

      if (req.method === "POST" && url.pathname === "/hub/admin/recharge-batches") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "recharge_batch_create");
        if (rejection) return rejection;
        try {
          const body = await readJson(req);
          const batch = this.billing.createRechargeBatch(session.user, {
            label: body.label,
            unitAmount: body.unitAmount,
            quantity: body.quantity,
            expiresAt: body.expiresAt,
          });
          return json({ batch, revealOnce: true }, 201);
        } catch (error) {
          try { this.billing.recordAdminAudit(session.user, "recharge_batch.create", "recharge_batch", null, "failed"); } catch { /* preserve the redacted response on storage failure */ }
          const code = (error as Error).message;
          if (code === "invalid_recharge_batch" || code === "invalid_body") return json({ error: "invalid_recharge_batch" }, 400);
          return json({ error: "admin_action_failed" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/hub/admin/recharge-batches/import") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "recharge_batch_import");
        if (rejection) return rejection;
        try {
          const body = await readJson(req);
          return json({ batch: this.billing.importRechargeBatch(session.user, {
            label: body.label,
            unitAmount: body.unitAmount,
            codes: body.codes,
            expiresAt: body.expiresAt,
          }) }, 201);
        } catch (error) {
          try { this.billing.recordAdminAudit(session.user, "recharge_batch.import", "recharge_batch", null, "failed"); } catch { /* preserve the redacted response on storage failure */ }
          const code = (error as Error).message;
          if (code === "recharge_code_conflict") return json({ error: code }, 409);
          if (code === "invalid_recharge_batch" || code === "invalid_body") return json({ error: "invalid_recharge_batch" }, 400);
          return json({ error: "admin_action_failed" }, 500);
        }
      }

      if (req.method === "GET" && url.pathname === "/hub/admin/recharge-batches") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdmin(session);
        if (rejection) return rejection;
        return json({ batches: this.billing.listRechargeBatches(session.user) });
      }

      if (req.method === "POST" && url.pathname === "/hub/admin/recharge-code-inventory") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "recharge_code_inventory");
        if (rejection) return rejection;
        const body = await readJson(req);
        const batchId = typeof body.batchId === "string" ? body.batchId : "";
        if (!/^[0-9a-f-]{36}$/i.test(batchId)) return json({ error: "invalid_batch_reference" }, 400);
        return json({ codes: this.billing.listRechargeCodes(session.user, batchId) });
      }

      if (req.method === "DELETE" && url.pathname === "/hub/admin/recharge-batch") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "recharge_batch_revoke");
        if (rejection) return rejection;
        const body = await readJson(req);
        const batchId = typeof body.batchId === "string" ? body.batchId : "";
        if (!/^[0-9a-f-]{36}$/i.test(batchId) || !this.billing.revokeRechargeBatch(session.user, batchId)) {
          this.billing.recordAdminAudit(session.user, "recharge_batch.revoke", "recharge_batch", /^[0-9a-f-]{36}$/i.test(batchId) ? batchId : null, "failed");
          return json({ error: "batch_not_found" }, 404);
        }
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/hub/admin/users") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdmin(session);
        if (rejection) return rejection;
        return json({ users: this.billing.listUsers(session.user) });
      }

      if (req.method === "POST" && url.pathname === "/hub/admin/user-details") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "user_details");
        if (rejection) return rejection;
        try {
          const body = await readJson(req);
          const userId = typeof body.userId === "string" ? body.userId : "";
          if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: "user_not_found" }, 404);
          return json(this.billing.adminUserDetails(session.user, userId, Number(body.ledgerLimit ?? 50)));
        } catch (error) {
          const code = (error as Error).message;
          if (code === "user_not_found") return json({ error: code }, 404);
          if (code === "invalid_body") return json({ error: code }, 400);
          return json({ error: "admin_action_failed" }, 500);
        }
      }

      if (req.method === "DELETE" && url.pathname === "/hub/admin/api-key") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "api_key_revoke");
        if (rejection) return rejection;
        const body = await readJson(req);
        const keyId = typeof body.keyId === "string" ? body.keyId : "";
        if (!/^[0-9a-f-]{36}$/i.test(keyId) || !this.billing.revokeApiKeyAsAdmin(session.user, keyId)) {
          this.billing.recordAdminAudit(session.user, "api_key.revoke", "api_key", /^[0-9a-f-]{36}$/i.test(keyId) ? keyId : null, "failed");
          return json({ error: "key_not_found" }, 404);
        }
        return json({ ok: true });
      }

      if (req.method === "GET" && url.pathname === "/hub/admin/metrics") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdmin(session);
        if (rejection) return rejection;
        return json(this.billing.adminMetrics(session.user));
      }

      if (req.method === "GET" && url.pathname === "/hub/admin/requests") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdmin(session);
        if (rejection) return rejection;
        return json({ requests: this.billing.listAdminRequests(session.user, Number(url.searchParams.get("limit") ?? "100")) });
      }

      if (req.method === "PATCH" && url.pathname === "/hub/admin/user-status") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "user_status");
        if (rejection) return rejection;
        try {
          const body = await readJson(req);
          const userId = typeof body.userId === "string" ? body.userId : "";
          if (!/^[0-9a-f-]{36}$/i.test(userId)) {
            this.billing.recordAdminAudit(session.user, "user.status", "user", null, "failed");
            return json({ error: "invalid_user_reference" }, 400);
          }
          if (!this.billing.setUserStatus(session.user, userId, body.status)) {
            this.billing.recordAdminAudit(session.user, "user.status", "user", userId, "failed");
            return json({ error: "user_not_found" }, 404);
          }
          return json({ ok: true });
        } catch (error) {
          try { this.billing.recordAdminAudit(session.user, "user.status", "user", null, "failed"); } catch { /* preserve the redacted response on storage failure */ }
          const code = (error as Error).message;
          if (code === "invalid_user_status" || code === "cannot_disable_self") return json({ error: code }, 400);
          return json({ error: "admin_action_failed" }, 500);
        }
      }

      if (req.method === "POST" && url.pathname === "/hub/admin/ledger-adjustments") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdminMutation(req, session, "ledger_adjustment");
        if (rejection) return rejection;
        try {
          const body = await readJson(req);
          return json(this.billing.adjustBalance(session.user, {
            userId: body.userId,
            amountUnits: body.amountUnits,
            reason: body.reason,
            idempotencyKey: req.headers.get("Idempotency-Key"),
          }));
        } catch (error) {
          try { this.billing.recordAdminAudit(session.user, "ledger.adjust", "user", null, "failed"); } catch { /* preserve the redacted response on storage failure */ }
          const code = (error as Error).message;
          if (code === "idempotency_conflict") return json({ error: code }, 409);
          if (code === "invalid_adjustment") return json({ error: code }, 400);
          if (code === "insufficient_adjustable_balance") return json({ error: code }, 409);
          if (code === "credit_limit_exceeded") return json({ error: code }, 409);
          if (code === "account_not_found") return json({ error: "user_not_found" }, 404);
          return json({ error: "admin_action_failed" }, 500);
        }
      }

      if (req.method === "GET" && url.pathname === "/hub/admin/audit") {
        const session = this.requireSession(req);
        if (session instanceof Response) return session;
        const rejection = this.requireAdmin(session);
        if (rejection) return rejection;
        return json({ events: this.billing.listAudit(session.user) });
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      const code = (error as Error).message;
      if (code === "invalid_body") return json({ error: code }, 400);
      if (code === "invalid_registration" || code === "registration_unavailable") {
        return json({ error: "registration_unavailable" }, 400);
      }
      if (code === "unsupported_content_encoding" || code === "unsupported_media_type") return json({ error: code }, 415);
      return json({ error: "internal_error" }, 500);
    }
  }

  start(): Server<undefined> {
    if (this.server) return this.server;
    this.database.acquireSingleNodeLock();
    try {
      this.billing.recoverPendingReservations();
      this.server = Bun.serve({
        hostname: this.config.hostname,
        port: this.config.port,
        fetch: (req, server) => {
          const networkSubject = resolveNetworkSubject(this.config, req, server.requestIP(req)?.address ?? "unknown");
          if (networkSubject === null) return json({ error: "untrusted_proxy" }, 403);
          return this.fetch(req, networkSubject);
        },
      });
    } catch (error) {
      this.database.releaseSingleNodeLock();
      throw error;
    }
    return this.server;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
    this.database.close();
  }
}
