import { Database } from "bun:sqlite";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

export type AdvisorBudgetReservation = { ok: true; used: number } | { ok: false; reason: "exhausted" | "unavailable" };
export interface AdvisorTaskBudget {
  reserve(task: string, limit: number, now: number): AdvisorBudgetReservation;
}

/**
 * Reserve BEFORE dispatch. Failed/disconnected calls may still cost money, so reservations
 * are never refunded. Only SHA-256 task digests, counts and expiry times reach disk. Opening
 * lazily and closing before returning also keeps disabled installs and shutdown timer-free.
 */
export function createAdvisorTaskBudget(path?: string): AdvisorTaskBudget {
  return {
    reserve(task, limit, now) {
      let db: Database | undefined;
      try {
        const key = new Bun.CryptoHasher("sha256").update(`advisor-budget\0${task}`).digest("hex");
        const file = path ?? join(getConfigDir(), "advisor-budget.sqlite");
        const dir = dirname(file);
        assertNotRealHomeUnderTest(dir);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("invalid directory");
        hardenSecretDir(dir, { required: true });
        if (!path) {
          recordOwnedConfigPath(dir, file);
          recordOwnedConfigPath(dir, `${file}-journal`);
        }
        try { closeSync(openSync(file, "wx", 0o600)); }
        catch (error) { if ((error as { code?: string }).code !== "EEXIST") throw error; }
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid file");
        if (process.platform !== "win32") chmodSync(file, 0o600);
        hardenSecretPath(file, { required: true });
        db = new Database(file);
        db.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS tasks (task TEXT PRIMARY KEY, used INTEGER NOT NULL, expires INTEGER NOT NULL)");
        const connection = db;
        return connection.transaction((): AdvisorBudgetReservation => {
          connection.query("DELETE FROM tasks WHERE expires <= ?").run(now);
          const current = connection.query<{ used: number }, [string]>("SELECT used FROM tasks WHERE task = ?").get(key);
          if (current && current.used >= limit) return { ok: false, reason: "exhausted" };
          // Never evict a live task to make room: that would reset its spending limit.
          if (!current && connection.query<{ n: number }, []>("SELECT count(*) AS n FROM tasks").get()!.n >= 512) {
            return { ok: false, reason: "unavailable" };
          }
          connection.query("INSERT INTO tasks VALUES (?, 1, ?) ON CONFLICT(task) DO UPDATE SET used = used + 1")
            .run(key, now + 86_400_000);
          return { ok: true, used: (current?.used ?? 0) + 1 };
        }).immediate();
      } catch {
        // An unavailable/corrupt/locked budget blocks the expert call, never the worker.
        return { ok: false, reason: "unavailable" };
      } finally { try { db?.close(); } catch { /* reservation outcome is authoritative */ } }
    },
  };
}
