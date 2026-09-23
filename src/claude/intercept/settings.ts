import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeConfigDir } from "../auth-detect";

/**
 * Claude Code `settings.json` env block for intercept mode.
 *
 * Both the Claude Desktop Code tab and the standalone `claude` CLI read the user
 * `~/.claude/settings.json` and export its `env` map into the process before any network
 * call. Two keys make every Claude Code process route through the local CONNECT proxy while
 * the app itself stays a first-party install:
 *
 *   env.HTTPS_PROXY         = http://127.0.0.1:<proxy port>
 *   env.NODE_EXTRA_CA_CERTS = <configDir>/claude-intercept/ca.pem
 *
 * Ownership is tracked by value, never by a marker key. The CA path is the anchor: it lives
 * under opencodex's own config directory, so only a block whose `NODE_EXTRA_CA_CERTS` names
 * that file is treated as ours. A user's own proxy or CA setting is left alone.
 */

export const CLAUDE_INTERCEPT_MANAGED_ENV = ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"] as const;
export type ClaudeInterceptManagedEnv = typeof CLAUDE_INTERCEPT_MANAGED_ENV[number];

export interface ClaudeInterceptEnv {
  HTTPS_PROXY: string;
  NODE_EXTRA_CA_CERTS: string;
}

export function claudeInterceptProxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function buildClaudeInterceptEnv(proxyPort: number, caCertPath: string): ClaudeInterceptEnv {
  return { HTTPS_PROXY: claudeInterceptProxyUrl(proxyPort), NODE_EXTRA_CA_CERTS: caCertPath };
}

export type ClaudeInterceptSettingsState =
  | { kind: "absent" }
  | { kind: "applied"; env: ClaudeInterceptEnv }
  | { kind: "stale"; env: Partial<ClaudeInterceptEnv> }
  | { kind: "foreign"; env: Partial<Record<ClaudeInterceptManagedEnv, string>> }
  | { kind: "unreadable"; path: string };

type SettingsDoc = Record<string, unknown> & { env?: Record<string, unknown> };

function settingsPath(configDir: string): string {
  return join(configDir, "settings.json");
}

function readSettings(path: string): { doc: SettingsDoc } | { error: "missing" | "unreadable" } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) { // no-excuse-ok: catch -- an absent settings file is the fresh-install state.
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "unreadable" };
    return { doc: parsed as SettingsDoc };
  } catch { // no-excuse-ok: catch -- a corrupt settings file must be reported, not overwritten.
    return { error: "unreadable" };
  }
}

function envRecord(doc: SettingsDoc): Record<string, unknown> {
  return doc.env && typeof doc.env === "object" && !Array.isArray(doc.env) ? doc.env : {};
}

/** Loopback proxy URLs are the only shape opencodex ever writes. */
export function isClaudeInterceptProxyUrl(value: unknown): value is string {
  return typeof value === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/.test(value.trim());
}

function isOwnedCaPath(value: unknown, ownedCaPath: string): value is string {
  return typeof value === "string" && value.trim() === ownedCaPath;
}

/** Classify the current settings env against the values this router would write. */
export function inspectClaudeInterceptSettings(
  expected: ClaudeInterceptEnv,
  configDir = claudeConfigDir(),
): ClaudeInterceptSettingsState {
  const path = settingsPath(configDir);
  const read = readSettings(path);
  if ("error" in read) return read.error === "missing" ? { kind: "absent" } : { kind: "unreadable", path };
  const env = envRecord(read.doc);
  const proxy = env.HTTPS_PROXY;
  const ca = env.NODE_EXTRA_CA_CERTS;
  if (proxy === undefined && ca === undefined) return { kind: "absent" };
  if (proxy === expected.HTTPS_PROXY && ca === expected.NODE_EXTRA_CA_CERTS) return { kind: "applied", env: expected };
  const caOurs = isOwnedCaPath(ca, expected.NODE_EXTRA_CA_CERTS);
  const proxyOurs = proxy === undefined || isClaudeInterceptProxyUrl(proxy);
  if (caOurs && proxyOurs) {
    return {
      kind: "stale",
      env: {
        ...(typeof proxy === "string" ? { HTTPS_PROXY: proxy } : {}),
        ...(typeof ca === "string" ? { NODE_EXTRA_CA_CERTS: ca } : {}),
      },
    };
  }
  return {
    kind: "foreign",
    env: {
      ...(typeof proxy === "string" ? { HTTPS_PROXY: proxy } : {}),
      ...(typeof ca === "string" ? { NODE_EXTRA_CA_CERTS: ca } : {}),
    },
  };
}

function writeSettings(path: string, doc: SettingsDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export type ClaudeInterceptSettingsWrite =
  | { ok: true; changed: boolean; path: string }
  | { ok: false; reason: "unreadable" | "foreign_env"; path: string };

/** Capture only the managed keys. Rollback preserves unrelated edits and refuses
 * to overwrite a newer proxy/CA choice made after this apply. */
export function captureClaudeInterceptSettingsRollback(
  expected: ClaudeInterceptEnv,
  configDir = claudeConfigDir(),
): () => boolean {
  const path = settingsPath(configDir);
  const before = readSettings(path);
  if ("error" in before && before.error !== "missing") return () => false;
  const previous = "doc" in before ? { ...envRecord(before.doc) } : {};
  return () => {
    try {
      const current = readSettings(path);
      if (!("doc" in current)) return false;
      const env = envRecord(current.doc);
      if (CLAUDE_INTERCEPT_MANAGED_ENV.some(key => env[key] !== expected[key])) return false;
      for (const key of CLAUDE_INTERCEPT_MANAGED_ENV) {
        if (previous[key] === undefined) delete env[key];
        else env[key] = previous[key];
      }
      if (Object.keys(env).length === 0) delete current.doc.env;
      else current.doc.env = env;
      writeSettings(path, current.doc);
      return true;
    } catch { return false; }
  };
}

/**
 * Write the intercept env into `settings.json`. Refuses when a managed key already holds a
 * value opencodex did not write (a user-configured corporate proxy, for instance).
 */
export function applyClaudeInterceptSettings(
  env: ClaudeInterceptEnv,
  configDir = claudeConfigDir(),
): ClaudeInterceptSettingsWrite {
  const path = settingsPath(configDir);
  const state = inspectClaudeInterceptSettings(env, configDir);
  if (state.kind === "unreadable") return { ok: false, reason: "unreadable", path };
  if (state.kind === "foreign") return { ok: false, reason: "foreign_env", path };
  if (state.kind === "applied") return { ok: true, changed: false, path };
  const read = readSettings(path);
  const doc: SettingsDoc = "doc" in read ? read.doc : {};
  doc.env = { ...envRecord(doc), ...env };
  writeSettings(path, doc);
  return { ok: true, changed: true, path };
}

/** Remove the managed keys, but only the values opencodex owns. */
export function removeClaudeInterceptSettings(
  ownedCaPath: string,
  configDir = claudeConfigDir(),
): ClaudeInterceptSettingsWrite {
  const path = settingsPath(configDir);
  const read = readSettings(path);
  if ("error" in read) {
    return read.error === "missing" ? { ok: true, changed: false, path } : { ok: false, reason: "unreadable", path };
  }
  const env = envRecord(read.doc);
  if (!isOwnedCaPath(env.NODE_EXTRA_CA_CERTS, ownedCaPath)) return { ok: true, changed: false, path };
  delete env.NODE_EXTRA_CA_CERTS;
  if (isClaudeInterceptProxyUrl(env.HTTPS_PROXY)) delete env.HTTPS_PROXY;
  if (Object.keys(env).length === 0) delete read.doc.env;
  else read.doc.env = env;
  writeSettings(path, read.doc);
  return { ok: true, changed: true, path };
}
