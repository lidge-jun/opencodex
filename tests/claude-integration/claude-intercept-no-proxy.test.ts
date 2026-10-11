import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstPartyProxyStatus } from "../../src/claude/first-party-settings";
import {
  applyClaudeInterceptSettings,
  buildClaudeInterceptEnv,
  captureClaudeInterceptSettingsRollback,
  inspectClaudeInterceptSettings,
  migrateClaudeInterceptSettings,
  removeClaudeInterceptSettings,
  setClaudeSettingsPersistForTests,
} from "../../src/claude/intercept/settings";
import { NO_PROXY_RECEIPT_FILE, setNoProxyReceiptIoForTests } from "../../src/claude/intercept/settings-no-proxy";

// #6936: Claude Code must reach loopback MCP servers directly, not through the CONNECT-only
// intercept proxy. NO_PROXY is shared with the user, so removal restores exactly what was there.

const CA = "/home/u/.opencodex/claude-intercept/ca.pem";
const env = buildClaudeInterceptEnv(8846, CA, "test-token");
const LOOPBACK = "127.0.0.1,localhost,::1,0.0.0.0";
const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-intercept-no-proxy-"));
}
function seed(configDir: string, doc: unknown): void {
  writeFileSync(join(configDir, "settings.json"), JSON.stringify(doc));
}
function settings(configDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
}
function bytes(configDir: string): string {
  return readFileSync(join(configDir, "settings.json"), "utf8");
}
function receipt(configDir: string): string {
  return join(configDir, NO_PROXY_RECEIPT_FILE);
}
function failing(kind: "write" | "unlink"): void {
  restores.push(setNoProxyReceiptIoForTests({
    [kind]: () => { throw Object.assign(new Error("injected"), { code: "EACCES" }); },
  }));
}
/** Apply over a user env, then remove, and return what NO_PROXY ends up as. */
function roundTrip(userEnv: Record<string, unknown>): Record<string, unknown> {
  const configDir = dir();
  seed(configDir, { env: userEnv });
  expect(applyClaudeInterceptSettings(env, configDir).ok).toBe(true);
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(existsSync(receipt(configDir))).toBe(false);
  return (settings(configDir).env ?? {}) as Record<string, unknown>;
}

test("apply merges the bypass into a user value, is idempotent, and leaves a covering value alone", () => {
  const configDir = dir();
  seed(configDir, { env: { NO_PROXY: "localhost, .corp.example" } });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(settings(configDir)).toEqual({ env: { NO_PROXY: "localhost, .corp.example,127.0.0.1,::1,0.0.0.0", ...env } });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: false });
  expect(inspectClaudeInterceptSettings(env, configDir).kind).toBe("applied");

  for (const covering of ["LOCALHOST,[::1],0.0.0.0,127.0.0.1", "*", "*,::1"]) {
    const covered = dir();
    seed(covered, { env: { NO_PROXY: covering } });
    applyClaudeInterceptSettings(env, covered);
    expect(settings(covered)).toEqual({ env: { NO_PROXY: covering, ...env } });
    expect(existsSync(receipt(covered))).toBe(false);
  }
});

test("O5: removal restores exactly the value the user had", () => {
  expect(roundTrip({ NO_PROXY: "127.0.0.1" })).toEqual({ NO_PROXY: "127.0.0.1" });
  expect(roundTrip({ NO_PROXY: ".corp.example,127.0.0.1" })).toEqual({ NO_PROXY: ".corp.example,127.0.0.1" });
  expect(roundTrip({ NO_PROXY: LOOPBACK })).toEqual({ NO_PROXY: LOOPBACK });
  // A hand-written three-entry stopgap from before 0.0.0.0 was covered gets it appended, then back.
  expect(roundTrip({ NO_PROXY: "127.0.0.1,localhost,::1" })).toEqual({ NO_PROXY: "127.0.0.1,localhost,::1" });
  expect(roundTrip({ NO_PROXY: "" })).toEqual({ NO_PROXY: "" });
  expect(roundTrip({ NO_PROXY: "*,::1" })).toEqual({ NO_PROXY: "*,::1" });
  expect(roundTrip({ NO_PROXY: null })).toEqual({ NO_PROXY: null });
  expect(roundTrip({ FOO: "1" })).toEqual({ FOO: "1" });
});

test("O5: a value edited after the apply is preserved and the receipt is dropped", () => {
  const configDir = dir();
  applyClaudeInterceptSettings(env, configDir);
  seed(configDir, { env: { ...env, NO_PROXY: `${LOOPBACK},mcp.internal` } });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(settings(configDir)).toEqual({ env: { NO_PROXY: `${LOOPBACK},mcp.internal` } });
  expect(existsSync(receipt(configDir))).toBe(false);
});

test("O3: a missing or malformed receipt is no provenance, so removal preserves NO_PROXY", () => {
  for (const content of [null, "{", JSON.stringify({ version: 2, hadKey: false, previous: null, written: LOOPBACK }),
    JSON.stringify({ version: 1, written: LOOPBACK })]) {
    const configDir = dir();
    applyClaudeInterceptSettings(env, configDir);
    if (content === null) rmSync(receipt(configDir));
    else writeFileSync(receipt(configDir), content);
    removeClaudeInterceptSettings(CA, configDir);
    expect(settings(configDir)).toEqual({ env: { NO_PROXY: LOOPBACK } });
  }
});

test("O1: a failed receipt write after invalidation leaves no receipt, so a stale one cannot match", () => {
  const configDir = dir();
  writeFileSync(receipt(configDir), JSON.stringify({ version: 1, hadKey: false, previous: null, written: LOOPBACK }));
  seed(configDir, { env: { ...env, NO_PROXY: "" } });
  failing("write");
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(settings(configDir)).toEqual({ env: { ...env, NO_PROXY: LOOPBACK } });
  expect(existsSync(receipt(configDir))).toBe(false);
  removeClaudeInterceptSettings(CA, configDir);
  expect(settings(configDir)).toEqual({ env: { NO_PROXY: LOOPBACK } });
});

test("O2: apply writes nothing when an old receipt cannot be invalidated", () => {
  const configDir = dir();
  seed(configDir, { env: { ...env, NO_PROXY: "10.0.0.5" } });
  const before = bytes(configDir);
  failing("unlink");
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "unreadable", path: receipt(configDir) });
  expect(bytes(configDir)).toBe(before);
});

test("O4/O10: removal is fail-closed on receipt invalidation, then a later episode keeps the user's value", () => {
  const configDir = dir();
  seed(configDir, { env: { NO_PROXY: "" } });
  applyClaudeInterceptSettings(env, configDir);
  const applied = bytes(configDir);
  const proof = readFileSync(receipt(configDir), "utf8");
  failing("unlink");
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: false, reason: "unreadable" });
  expect(bytes(configDir)).toBe(applied);
  expect(readFileSync(receipt(configDir), "utf8")).toBe(proof);
  restores.pop()!();
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(settings(configDir)).toEqual({ env: { NO_PROXY: "" } });
  expect(existsSync(receipt(configDir))).toBe(false);
  // The user now writes the bypass themselves; a new episode must not claim it.
  seed(configDir, { env: { NO_PROXY: LOOPBACK } });
  applyClaudeInterceptSettings(env, configDir);
  removeClaudeInterceptSettings(CA, configDir);
  expect(settings(configDir)).toEqual({ env: { NO_PROXY: LOOPBACK } });
});

test("O11: an apply that starts a new episode drops a receipt left by an earlier one", () => {
  const configDir = dir();
  applyClaudeInterceptSettings(env, configDir);
  // The block is cleared by hand, leaving the receipt; the user then writes the bypass themselves.
  seed(configDir, { env: { NO_PROXY: LOOPBACK } });
  expect(existsSync(receipt(configDir))).toBe(true);
  applyClaudeInterceptSettings(env, configDir);
  expect(existsSync(receipt(configDir))).toBe(false);
  removeClaudeInterceptSettings(CA, configDir);
  expect(settings(configDir)).toEqual({ env: { NO_PROXY: LOOPBACK } });
});

function failingPersist(): void {
  restores.push(setClaudeSettingsPersistForTests(() => { throw new Error("settings write failed"); }));
}

test("O14: an uncommitted removal keeps the episode, so a retry restores the user's value", () => {
  const configDir = dir();
  seed(configDir, { env: { NO_PROXY: "" } });
  applyClaudeInterceptSettings(env, configDir);
  const applied = bytes(configDir);
  const proof = readFileSync(receipt(configDir), "utf8");
  failingPersist();
  expect(() => removeClaudeInterceptSettings(CA, configDir)).toThrow("settings write failed");
  expect(bytes(configDir)).toBe(applied);
  expect(readFileSync(receipt(configDir), "utf8")).toBe(proof);
  restores.pop()!();
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: true });
  expect(settings(configDir)).toEqual({ env: { NO_PROXY: "" } });
  expect(existsSync(receipt(configDir))).toBe(false);
});

test("O13: when the receipt cannot be put back either, the settings error still surfaces", () => {
  const configDir = dir();
  seed(configDir, { env: { NO_PROXY: "" } });
  applyClaudeInterceptSettings(env, configDir);
  const applied = bytes(configDir);
  failingPersist();
  failing("write");
  expect(() => removeClaudeInterceptSettings(CA, configDir)).toThrow("settings write failed");
  expect(bytes(configDir)).toBe(applied);
  expect(existsSync(receipt(configDir))).toBe(false);
});

test("O6: a non-string NO_PROXY keeps the block stale and is never rewritten", () => {
  const configDir = dir();
  seed(configDir, { env: { ...env, NO_PROXY: false } });
  const before = bytes(configDir);
  expect(inspectClaudeInterceptSettings(env, configDir)).toEqual({ kind: "stale", env });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(bytes(configDir)).toBe(before);
  expect(existsSync(receipt(configDir))).toBe(false);
});

test("O7: an owned block without the bypass reports broken until the startup migrate repairs it", () => {
  const configDir = dir();
  seed(configDir, { env: { ...env, NO_PROXY: "10.0.0.5" } });
  const status = () => firstPartyProxyStatus({ settings: inspectClaudeInterceptSettings(env, configDir), boundProxyPort: 8846, eligible: true });
  expect(status()).toBe("broken");
  expect(migrateClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: true, changed: true });
  expect(settings(configDir)).toEqual({ env: { ...env, NO_PROXY: `10.0.0.5,${LOOPBACK}` } });
  expect(status()).toBe("live");
});

test("a foreign proxy block never gains a NO_PROXY or a receipt", () => {
  const configDir = dir();
  const foreign = { HTTPS_PROXY: "http://corp-proxy:3128", NODE_EXTRA_CA_CERTS: "/etc/corp/ca.pem" };
  seed(configDir, { env: foreign });
  expect(applyClaudeInterceptSettings(env, configDir)).toMatchObject({ ok: false, reason: "foreign_env" });
  expect(removeClaudeInterceptSettings(CA, configDir)).toMatchObject({ ok: true, changed: false });
  expect(settings(configDir)).toEqual({ env: foreign });
  expect(existsSync(receipt(configDir))).toBe(false);
});

test("O8/O12: rollback restores NO_PROXY and the receipt as they were captured", () => {
  const created = dir();
  const rollbackCreated = captureClaudeInterceptSettingsRollback(env, created);
  applyClaudeInterceptSettings(env, created);
  expect(existsSync(receipt(created))).toBe(true);
  expect(rollbackCreated()).toBe(true);
  expect(settings(created)).toEqual({});
  expect(existsSync(receipt(created))).toBe(false);

  const merged = dir();
  seed(merged, { env: { NO_PROXY: ".corp.example" } });
  const rollbackMerged = captureClaudeInterceptSettingsRollback(env, merged);
  applyClaudeInterceptSettings(env, merged);
  expect(rollbackMerged()).toBe(true);
  expect(settings(merged)).toEqual({ env: { NO_PROXY: ".corp.example" } });

  // O12: rollback to an absent block restores an older receipt; the next episode start drops it.
  const absent = dir();
  const older = JSON.stringify({ version: 1, hadKey: false, previous: null, written: LOOPBACK });
  writeFileSync(receipt(absent), older);
  seed(absent, { env: { NO_PROXY: LOOPBACK } });
  const rollbackAbsent = captureClaudeInterceptSettingsRollback(env, absent);
  applyClaudeInterceptSettings(env, absent);
  expect(existsSync(receipt(absent))).toBe(false);
  expect(rollbackAbsent()).toBe(true);
  expect(readFileSync(receipt(absent), "utf8")).toBe(older);
  applyClaudeInterceptSettings(env, absent);
  expect(existsSync(receipt(absent))).toBe(false);
  removeClaudeInterceptSettings(CA, absent);
  expect(settings(absent)).toEqual({ env: { NO_PROXY: LOOPBACK } });

  // A value edited after the apply survives rollback, and so does the current receipt.
  const edited = dir();
  const rollbackEdited = captureClaudeInterceptSettingsRollback(env, edited);
  applyClaudeInterceptSettings(env, edited);
  seed(edited, { env: { ...env, NO_PROXY: `${LOOPBACK},mcp.internal` } });
  expect(rollbackEdited()).toBe(true);
  expect(settings(edited)).toEqual({ env: { NO_PROXY: `${LOOPBACK},mcp.internal` } });
});
