import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyClaudeInterceptSettings,
  captureClaudeInterceptSettingsRollback,
  buildClaudeInterceptEnv,
  inspectClaudeInterceptSettings,
  migrateClaudeInterceptSettings,
  removeClaudeInterceptSettings,
} from "../../src/claude/intercept/settings";
import { claudeInterceptEnabled, claudeInterceptProxyPort } from "../../src/claude/intercept/runtime";
import { configSchema } from "../../src/config/schema/config-schema";

const CA = "/home/u/.opencodex/claude-intercept/ca.pem";
const env = buildClaudeInterceptEnv(8846, CA, "test-token");

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-intercept-settings-"));
}

function readSettings(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

test("env block shape", () => {
  expect(env).toEqual({ HTTPS_PROXY: "http://opencodex:test-token@127.0.0.1:8846", NODE_EXTRA_CA_CERTS: CA });
});

test("apply creates settings.json when absent and is idempotent", () => {
  const configDir = dir();
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "absent" });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: false });
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "applied", env });
});

test("apply preserves unrelated settings and env keys", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus", env: { ANTHROPIC_MODEL: "gpt-x", FOO: "1" }, permissions: { allow: [] } }));
  applyClaudeInterceptSettings(env, configDir);
  expect(readSettings(configDir)).toEqual({
    model: "opus",
    env: { ANTHROPIC_MODEL: "gpt-x", FOO: "1", ...env },
    permissions: { allow: [] },
  });
});

test("a previous port is stale and gets rewritten; a foreign proxy is left alone", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA } }));
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "stale", env: { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA } });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env });

  const foreign = dir();
  writeFileSync(join(foreign, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } }));
  expect(inspectClaudeInterceptSettings(env, foreign).kind).toBe("foreign");
  expect(applyClaudeInterceptSettings(env, foreign)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(readSettings(foreign)).toEqual({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } });

  // A loopback proxy with someone else's CA is not ours either.
  const otherCa = dir();
  writeFileSync(join(otherCa, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/mitm/ca.pem" } }));
  expect(inspectClaudeInterceptSettings(env, otherCa).kind).toBe("foreign");
});

test("migrate rewrites an owned legacy env but never creates or touches foreign state", () => {
  // A pre-auth apply left a bare loopback URL; the CA anchor still marks the env as ours.
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark", env: { HTTPS_PROXY: "http://127.0.0.1:8846", NODE_EXTRA_CA_CERTS: CA } }));
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ theme: "dark", env });
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: false });

  // Absent env stays absent — migration must not enable the integration by itself.
  const missing = dir();
  expect(migrateClaudeInterceptSettings(env, missing)).toMatchObject({ ok: true, changed: false });
  expect(existsSync(join(missing, "settings.json"))).toBe(false);

  // Foreign env is never overwritten from the runtime path either.
  const foreign = dir();
  writeFileSync(join(foreign, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } }));
  expect(migrateClaudeInterceptSettings(env, foreign)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(readSettings(foreign)).toEqual({ env: { HTTPS_PROXY: "http://corp-proxy:3128" } });
});

test("remove deletes only owned values and drops an emptied env block", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus", env: { ...env } }));
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ model: "opus" });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: false });

  const foreign = dir();
  writeFileSync(join(foreign, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/mitm/ca.pem" } }));
  expect(removeClaudeInterceptSettings(CA, foreign)).toMatchObject({ ok: true, changed: false });
  expect(readSettings(foreign)).toEqual({ env: { HTTPS_PROXY: "http://127.0.0.1:8080", NODE_EXTRA_CA_CERTS: "/etc/mitm/ca.pem" } });

  const missing = dir();
  expect(removeClaudeInterceptSettings(CA, missing)).toMatchObject({ ok: true, changed: false });
});

test("corrupt settings.json is reported, never overwritten", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), "{ not json");
  expect(inspectClaudeInterceptSettings(env, configDir).kind).toBe("unreadable");
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "unreadable" });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: false, reason: "unreadable" });
  expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe("{ not json");
});

test("intercept is on by default for a hub, off for clients and when Claude Code is disabled", () => {
  expect(claudeInterceptEnabled({})).toBe(true);
  expect(claudeInterceptEnabled({ claudeCode: { intercept: { enabled: false } } })).toBe(false);
  expect(claudeInterceptEnabled({ claudeCode: { enabled: false } })).toBe(false);
  expect(claudeInterceptEnabled({ runtimeRole: "client" })).toBe(false);
  expect(claudeInterceptProxyPort({}, 8746)).toBe(8846);
  expect(claudeInterceptProxyPort({ claudeCode: { intercept: { port: 9100 } } }, 8746)).toBe(9100);
  expect(claudeInterceptProxyPort({ claudeCode: { intercept: { port: 0 } } }, 8746)).toBe(8846);
});

test("claudeCode.intercept is validated by the config schema", () => {
  const base = {
    port: 0, defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } },
  };
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: { enabled: false, port: 9100 } } }).success).toBe(true);
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: "off" } }).success).toBe(false);
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: { enabled: "no" } } }).success).toBe(false);
  expect(configSchema.safeParse({ ...base, claudeCode: { intercept: { port: 70000 } } }).success).toBe(false);
});

test("settings rollback restores managed values while preserving unrelated newer edits", () => {
  const configDir = dir();
  const previous = { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA };
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: previous }));
  const rollback = captureClaudeInterceptSettingsRollback(env, configDir);
  expect(applyClaudeInterceptSettings(env, configDir).ok).toBe(true);
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark", env: { ...env, NEW: "kept" } }));
  expect(rollback()).toBe(true);
  expect(readSettings(configDir)).toEqual({ theme: "dark", env: { ...previous, NEW: "kept" } });
});

test("settings rollback refuses a newer managed proxy choice", () => {
  const configDir = dir();
  const rollback = captureClaudeInterceptSettingsRollback(env, configDir);
  applyClaudeInterceptSettings(env, configDir);
  const newer = { ...env, HTTPS_PROXY: "http://127.0.0.1:12000" };
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: newer }));
  expect(rollback()).toBe(false);
  expect(readSettings(configDir)).toEqual({ env: newer });
});
