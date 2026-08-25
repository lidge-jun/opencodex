import type { Database } from "bun:sqlite";
import { constantTimeEqual, hmacDigest, normalizeEmail, randomReference, randomToken, validPassword } from "./security";

const DUMMY_PASSWORD_HASH = await Bun.password.hash(randomToken("dummy_"), { algorithm: "argon2id" });
const FAILURE_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MAX_ACTIVE_SESSIONS = 10;
const REVOKED_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type HubRole = "user" | "admin";

export interface HubUser {
  id: string;
  supportReference: string;
  role: HubRole;
  status: "active" | "disabled";
  createdAt: number;
}

export interface IssuedSession {
  user: HubUser;
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: number;
}

export interface AuthenticatedSession {
  user: HubUser;
  sessionId: string;
  csrfDigest: string;
  expiresAt: number;
  authenticatedAt: number;
}

interface UserRow {
  id: string;
  support_reference: string;
  email: string;
  password_hash: string;
  role: HubRole;
  status: "active" | "disabled";
  created_at: number;
}

interface SessionRow extends UserRow {
  session_id: string;
  csrf_digest: string;
  expires_at: number;
  session_created_at: number;
}

export class HubAuth {
  constructor(
    private readonly db: Database,
    private readonly digestSecret: string,
    private readonly sessionTtlSeconds: number,
  ) {}

  private publicUser(row: UserRow): HubUser {
    return { id: row.id, supportReference: row.support_reference, role: row.role, status: row.status, createdAt: row.created_at };
  }

  private failureDigest(email: string): string {
    return hmacDigest(this.digestSecret, "login-subject", email);
  }

  private isBlocked(subjectDigest: string, now: number): boolean {
    const row = this.db.query("SELECT blocked_until FROM hub_auth_failures WHERE subject_digest = ?").get(subjectDigest) as { blocked_until: number } | null;
    return Boolean(row && row.blocked_until > now);
  }

  private recordFailure(subjectDigest: string, now: number): void {
    const row = this.db.query("SELECT failure_count, window_started_at FROM hub_auth_failures WHERE subject_digest = ?")
      .get(subjectDigest) as { failure_count: number; window_started_at: number } | null;
    const withinWindow = row && now - row.window_started_at <= FAILURE_WINDOW_MS;
    const count = withinWindow ? row.failure_count + 1 : 1;
    const windowStarted = withinWindow ? row.window_started_at : now;
    const blockedUntil = count >= MAX_FAILURES ? now + BLOCK_MS : 0;
    this.db.query(`
      INSERT INTO hub_auth_failures(subject_digest, failure_count, window_started_at, blocked_until)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subject_digest) DO UPDATE SET
        failure_count = excluded.failure_count,
        window_started_at = excluded.window_started_at,
        blocked_until = excluded.blocked_until
    `).run(subjectDigest, count, windowStarted, blockedUntil);
  }

  private clearFailures(subjectDigest: string): void {
    this.db.query("DELETE FROM hub_auth_failures WHERE subject_digest = ?").run(subjectDigest);
  }

  async register(emailValue: unknown, passwordValue: unknown, now = Date.now()): Promise<IssuedSession> {
    const email = normalizeEmail(emailValue);
    if (!email || !validPassword(passwordValue)) throw new Error("invalid_registration");
    const userId = crypto.randomUUID();
    const supportReference = randomReference("usr_");
    const passwordHash = await Bun.password.hash(passwordValue, { algorithm: "argon2id" });
    try {
      this.db.query(`INSERT INTO hub_users(id, support_reference, email, password_hash, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'user', 'active', ?, ?)`)
        .run(userId, supportReference, email, passwordHash, now, now);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new Error("registration_unavailable");
      throw error;
    }
    return this.issueSession(userId, now);
  }

  async bootstrapAdmin(emailValue: unknown, passwordValue: unknown, now = Date.now()): Promise<HubUser> {
    const email = normalizeEmail(emailValue);
    if (!email || !validPassword(passwordValue)) throw new Error("invalid_bootstrap_input");
    const passwordHash = await Bun.password.hash(passwordValue, { algorithm: "argon2id" });
    const userId = crypto.randomUUID();
    const supportReference = randomReference("usr_");
    const create = this.db.transaction(() => {
      const existing = this.db.query("SELECT 1 AS present FROM hub_users WHERE role = 'admin' LIMIT 1").get();
      if (existing) throw new Error("admin_already_bootstrapped");
      this.db.query(`INSERT INTO hub_users(id, support_reference, email, password_hash, role, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?)`)
        .run(userId, supportReference, email, passwordHash, now, now);
    });
    create();
    const row = this.db.query("SELECT * FROM hub_users WHERE id = ?").get(userId) as UserRow;
    return this.publicUser(row);
  }

  async login(emailValue: unknown, passwordValue: unknown, now = Date.now()): Promise<IssuedSession> {
    const email = normalizeEmail(emailValue);
    const candidate = typeof passwordValue === "string" ? passwordValue : "";
    const subjectDigest = this.failureDigest(email ?? "invalid");
    if (this.isBlocked(subjectDigest, now)) {
      await Bun.password.verify(candidate, DUMMY_PASSWORD_HASH);
      throw new Error("login_rate_limited");
    }
    const row = email
      ? this.db.query("SELECT * FROM hub_users WHERE email = ?").get(email) as UserRow | null
      : null;
    const valid = await Bun.password.verify(candidate, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !valid || row.status !== "active") {
      this.recordFailure(subjectDigest, now);
      throw new Error("invalid_credentials");
    }
    this.clearFailures(subjectDigest);
    return this.issueSession(row.id, now);
  }

  private issueSession(userId: string, now: number): IssuedSession {
    const token = randomToken("hub_session_");
    const csrfToken = randomToken("hub_csrf_");
    const sessionId = crypto.randomUUID();
    const expiresAt = now + this.sessionTtlSeconds * 1000;
    const issue = this.db.transaction(() => {
      this.db.query(`DELETE FROM hub_sessions
        WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)`)
        .run(now, now - REVOKED_SESSION_RETENTION_MS);
      const active = this.db.query(`SELECT id FROM hub_sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at ASC, id ASC`).all(userId, now) as Array<{ id: string }>;
      const excess = Math.max(0, active.length - MAX_ACTIVE_SESSIONS + 1);
      const revoke = this.db.query("UPDATE hub_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
      for (const session of active.slice(0, excess)) revoke.run(now, session.id);
      this.db.query(`INSERT INTO hub_sessions
        (id, user_id, token_digest, csrf_digest, created_at, expires_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          sessionId,
          userId,
          hmacDigest(this.digestSecret, "session", token),
          hmacDigest(this.digestSecret, "csrf", csrfToken),
          now,
          expiresAt,
          now,
        );
    });
    issue();
    const row = this.db.query("SELECT * FROM hub_users WHERE id = ?").get(userId) as UserRow;
    return { user: this.publicUser(row), sessionId, token, csrfToken, expiresAt };
  }

  authenticate(token: string | undefined, now = Date.now()): AuthenticatedSession | null {
    if (!token?.startsWith("hub_session_")) return null;
    const digest = hmacDigest(this.digestSecret, "session", token);
    const row = this.db.query(`
      SELECT u.*, s.id AS session_id, s.csrf_digest, s.expires_at, s.created_at AS session_created_at
      FROM hub_sessions s JOIN hub_users u ON u.id = s.user_id
      WHERE s.token_digest = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'
    `).get(digest, now) as SessionRow | null;
    if (!row) return null;
    this.db.query("UPDATE hub_sessions SET last_seen_at = ? WHERE id = ?").run(now, row.session_id);
    return { user: this.publicUser(row), sessionId: row.session_id, csrfDigest: row.csrf_digest, expiresAt: row.expires_at, authenticatedAt: row.session_created_at };
  }

  verifyCsrf(session: AuthenticatedSession, csrfToken: string | null): boolean {
    if (!csrfToken?.startsWith("hub_csrf_")) return false;
    return constantTimeEqual(hmacDigest(this.digestSecret, "csrf", csrfToken), session.csrfDigest);
  }

  revokeSession(sessionId: string, now = Date.now()): void {
    this.db.query("UPDATE hub_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, sessionId);
  }

  revokeAllSessions(userId: string, now = Date.now()): void {
    this.db.query("UPDATE hub_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now, userId);
  }

  listSessions(userId: string, now = Date.now()): Array<{ id: string; createdAt: number; lastSeenAt: number; expiresAt: number }> {
    return this.db.query(`SELECT id, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt
      FROM hub_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`)
      .all(userId, now) as Array<{ id: string; createdAt: number; lastSeenAt: number; expiresAt: number }>;
  }

  async changePassword(userId: string, currentValue: unknown, nextValue: unknown, now = Date.now()): Promise<void> {
    if (typeof currentValue !== "string" || !validPassword(nextValue)) throw new Error("invalid_password_change");
    const row = this.db.query("SELECT password_hash FROM hub_users WHERE id = ? AND status = 'active'").get(userId) as { password_hash: string } | null;
    if (!row || !(await Bun.password.verify(currentValue, row.password_hash))) throw new Error("invalid_password_change");
    const nextHash = await Bun.password.hash(nextValue, { algorithm: "argon2id" });
    const change = this.db.transaction(() => {
      this.db.query("UPDATE hub_users SET password_hash = ?, updated_at = ? WHERE id = ?").run(nextHash, now, userId);
      this.revokeAllSessions(userId, now);
    });
    change();
  }
}
