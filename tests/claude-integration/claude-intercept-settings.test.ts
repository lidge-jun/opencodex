import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
import { applyClaudeModelDefaults, ModelDefaultsRecoveryError, previewClaudeModelDefaults } from "../../src/claude/model-default-settings";

const CA = "/home/u/.opencodex/claude-intercept/ca.pem";
const env = buildClaudeInterceptEnv(8846, CA, "test-token");
const LOOPBACK = "127.0.0.1,localhost,::1,0.0.0.0";
/** What apply writes into a block that had no NO_PROXY of its own. */
const written = { ...env, NO_PROXY: LOOPBACK };

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-intercept-settings-"));
}

function seed(configDir: string, doc: unknown): void {
  writeFileSync(join(configDir, "settings.json"), JSON.stringify(doc));
}

function readSettings(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

test("model default preview is read-only and apply changes only explicitly selected tiers", () => {
  const configDir = dir();
  const backups = dir();
  const original = { model: "custom-main", env: { KEEP: "value", ANTHROPIC_DEFAULT_HAIKU_MODEL: "user-haiku" }, hooks: {} };
  const raw = JSON.stringify(original);
  writeFileSync(join(configDir, "settings.json"), raw);
  const models = { opus: "combo/opus", sonnet: "combo/sonnet" };
  const preview = previewClaudeModelDefaults(models, configDir);
  expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe(raw);
  expect(preview.changes.map(change => change.key)).toEqual(["ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"]);
  const result = applyClaudeModelDefaults(models, preview.fingerprint, configDir, backups);
  expect(result.changed).toBe(true);
  expect(readFileSync(result.backupPath!, "utf8")).toBe(raw);
  expect(readSettings(configDir)).toEqual({ ...original, env: { ...original.env, ANTHROPIC_DEFAULT_OPUS_MODEL: "combo/opus", ANTHROPIC_DEFAULT_SONNET_MODEL: "combo/sonnet" } });
  expect(applyClaudeModelDefaults(models, previewClaudeModelDefaults(models, configDir).fingerprint, configDir, backups).changed).toBe(false);
});

test("model default apply refuses stale settings or a changed saved tier", () => {
  const configDir = dir();
  const file = join(configDir, "settings.json");
  writeFileSync(file, "{}");
  const preview = previewClaudeModelDefaults({ opus: "combo/opus" }, configDir);
  expect(() => applyClaudeModelDefaults({ opus: "other/model" }, preview.fingerprint, configDir, dir())).toThrow("settings_changed");
  writeFileSync(file, '{"model":"edited"}');
  expect(() => applyClaudeModelDefaults({ opus: "combo/opus" }, preview.fingerprint, configDir, dir())).toThrow("settings_changed");
  expect(readSettings(configDir)).toEqual({ model: "edited" });
});

test("model default preview refuses malformed settings and non-object env", () => {
  const configDir = dir();
  for (const raw of ["", " ", "invalid", "[]", '{"env":[]}', '{"env":"invalid"}']) {
    writeFileSync(join(configDir, "settings.json"), raw);
    expect(() => previewClaudeModelDefaults({ opus: "combo/opus" }, configDir)).toThrow("settings_unreadable");
    expect(readFileSync(join(configDir, "settings.json"), "utf8")).toBe(raw);
  }
});

test("model default apply supports fresh installs without inventing an unselected main model", () => {
  const configDir = dir();
  const models = { opus: "combo/opus", sonnet: "combo/sonnet", haiku: "combo/haiku" };
  const preview = previewClaudeModelDefaults(models, configDir);
  expect(existsSync(join(configDir, "settings.json"))).toBe(false);
  applyClaudeModelDefaults(models, preview.fingerprint, configDir, dir());
  expect(readSettings(configDir)).toEqual({ env: {
    ANTHROPIC_DEFAULT_OPUS_MODEL: "combo/opus", ANTHROPIC_DEFAULT_SONNET_MODEL: "combo/sonnet", ANTHROPIC_DEFAULT_HAIKU_MODEL: "combo/haiku",
  } });
});

test("model default capture refuses late edits and restores the actual captured document", () => {
  const configDir = dir();
  const backups = dir();
  const file = join(configDir, "settings.json");
  writeFileSync(file, "{}");
  const models = { opus: "combo/opus" };
  const preview = previewClaudeModelDefaults(models, configDir);
  const edited = '{"model":"late-edit","env":{"KEEP":"new"}}';
  expect(() => applyClaudeModelDefaults(models, preview.fingerprint, configDir, backups, {
    beforeCapture: () => writeFileSync(file, edited),
  })).toThrow("settings_changed");
  expect(readFileSync(file, "utf8")).toBe(edited);
  expect(readFileSync(join(backups, readdirSync(backups)[0]!, "settings.json"), "utf8")).toBe(edited);
});

test("model default publication and rollback never overwrite a concurrent winner", () => {
  for (const initiallyExists of [false, true]) {
    const configDir = dir();
    const backups = dir();
    const file = join(configDir, "settings.json");
    if (initiallyExists) writeFileSync(file, "{}");
    const models = { opus: "combo/opus" };
    const preview = previewClaudeModelDefaults(models, configDir);
    const winner = '{"model":"concurrent-winner"}';
    let failure: unknown;
    try {
      applyClaudeModelDefaults(models, preview.fingerprint, configDir, backups, {
        beforePublish: () => writeFileSync(file, winner),
      });
    } catch (error) { failure = error; }
    if (initiallyExists) {
      expect(failure).toBeInstanceOf(ModelDefaultsRecoveryError);
      const recovery = failure as ModelDefaultsRecoveryError;
      expect(readFileSync(recovery.backupPath, "utf8")).toBe("{}");
    } else expect((failure as Error).message).toBe("settings_changed");
    expect(readFileSync(file, "utf8")).toBe(winner);
    if (initiallyExists) expect(readFileSync(join(backups, readdirSync(backups)[0]!, "settings.json"), "utf8")).toBe("{}");
    expect(readdirSync(configDir).some(name => name.startsWith(".model-defaults-"))).toBe(false);
  }
});

test("model default publication failure restores the captured original without a rename fallback", () => {
  const configDir = dir();
  const file = join(configDir, "settings.json");
  writeFileSync(file, '{"hooks":{}}');
  const models = { opus: "combo/opus" };
  const preview = previewClaudeModelDefaults(models, configDir);
  expect(() => applyClaudeModelDefaults(models, preview.fingerprint, configDir, dir(), {
    beforePublish: () => { throw new Error("publication_failed"); },
  })).toThrow("publication_failed");
  expect(readFileSync(file, "utf8")).toBe('{"hooks":{}}');
});

test("env block shape", () => {
  expect(env).toEqual({ HTTPS_PROXY: "http://opencodex:test-token@127.0.0.1:8846", NODE_EXTRA_CA_CERTS: CA });
});

test("apply creates settings.json when absent and is idempotent", () => {
  const configDir = dir();
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "absent" });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: written });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: false });
  expect(readSettings(configDir)).toEqual({ env: written });
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "applied", env });
});

test("apply preserves unrelated settings and env keys", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus", env: { ANTHROPIC_MODEL: "gpt-x", FOO: "1" }, permissions: { allow: [] } }));
  applyClaudeInterceptSettings(env, configDir);
  expect(readSettings(configDir)).toEqual({
    model: "opus",
    env: { ANTHROPIC_MODEL: "gpt-x", FOO: "1", ...written },
    permissions: { allow: [] },
  });
});

test("a previous port is stale and gets rewritten; a foreign proxy is left alone", () => {
  const configDir = dir();
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA } }));
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "stale", env: { HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: CA } });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(readSettings(configDir)).toEqual({ env: written });

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
  expect(readSettings(configDir)).toEqual({ theme: "dark", env: written });
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
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ model: "opus" }));
  applyClaudeInterceptSettings(env, configDir);
  expect(readSettings(configDir)).toEqual({ model: "opus", env: written });
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
  const newer = { ...written, HTTPS_PROXY: "http://127.0.0.1:12000" };
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: newer }));
  expect(rollback()).toBe(false);
  expect(readSettings(configDir)).toEqual({ env: newer });
});
