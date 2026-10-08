import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopStartupSettings } from "../../src/codex/desktop-compatibility/startup-settings";
import { handleDesktopCompatibilitySettingsRoutes } from "../../src/server/management/desktop-compatibility-settings-routes";
import { handleManagementAPI } from "../../src/server/management-api";
import { armClaudeCodeBaseline, loadConfig, saveConfigPreservingClaudeCode } from "../../src/config";
import { mutatePersistedConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { setIcaclsRunnerForTests, setAsyncIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { flushConfigDirHardeningAndReaps } from "../../src/config/paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
let root = "", previous: string | undefined;
const initial = { port: 10100, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } } };
const success = () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" });
const read = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const write = (value: unknown) => writeFileSync(join(root, "config.json"), JSON.stringify(value));
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME; root = mkdtempSync(join(tmpdir(), "ocx-desktop-setting-")); process.env.OPENCODEX_HOME = root;
  setIcaclsRunnerForTests(success); setAsyncIcaclsRunnerForTests(async () => success()); write(initial);
});
afterEach(async () => {
  setPersistedConfigMutationBeforeCommitForTests(null); await flushConfigDirHardeningAndReaps(root);
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  setIcaclsRunnerForTests(null); setAsyncIcaclsRunnerForTests(null); removeTreeWithRetry(root);
});
test("field-scoped write preserves unrelated concurrent settings and rejects a stale preference", () => {
  const service = createDesktopStartupSettings(), first = service.status();
  expect(first.startOnProxyStart).toBe(false);
  setPersistedConfigMutationBeforeCommitForTests(() => write({ ...read(), logLevel: "debug" }));
  const enabled = service.set(true, first.revision);
  expect(enabled.startOnProxyStart).toBe(true); expect(read().logLevel).toBe("debug"); expect(read().providers).toEqual(initial.providers);
  expect(() => service.set(false, first.revision)).toThrow("settings_changed"); expect(read().desktopCompatibility.startOnProxyStart).toBe(true);
  expect(service.set(true, enabled.revision)).toEqual(enabled);
});
test("an unrelated later live save does not revert the persisted next-start preference", () => {
  const live = loadConfig(); armClaudeCodeBaseline(live);
  const service = createDesktopStartupSettings({ liveConfig: live }); service.set(true, service.status().revision);
  live.logLevel = "debug"; saveConfigPreservingClaudeCode(live);
  expect(read().desktopCompatibility).toEqual({ startOnProxyStart: true }); expect(read().logLevel).toBe("debug");
  write({ ...read(), desktopCompatibility: { startOnProxyStart: false } });
  live.logLevel = "info"; saveConfigPreservingClaudeCode(live);
  expect(read().desktopCompatibility).toEqual({ startOnProxyStart: false });
});
test("a publication-side error stays an error but cannot let a later save undo committed intent", () => {
  const live = loadConfig(); armClaudeCodeBaseline(live);
  const service = createDesktopStartupSettings({ liveConfig: live, mutate: callback => {
    mutatePersistedConfig(callback); throw new Error("fixture post-publication failure");
  } });
  expect(() => service.set(true, service.status().revision)).toThrow("fixture post-publication failure");
  expect(service.status().startOnProxyStart).toBe(true);
  live.logLevel = "debug"; saveConfigPreservingClaudeCode(live); expect(read().desktopCompatibility.startOnProxyStart).toBe(true);
});
test("invalid settings are preserved and a competing preference blocks replay", () => {
  const service = createDesktopStartupSettings(), first = service.status();
  setPersistedConfigMutationBeforeCommitForTests(() => write({ ...read(), desktopCompatibility: { startOnProxyStart: true } }));
  expect(() => service.set(true, first.revision)).toThrow("settings_changed");
  const malformed = { ...initial, desktopCompatibility: { startOnProxyStart: true, apply: true } }; write(malformed);
  expect(() => service.status()).toThrow("settings_invalid"); expect(read()).toEqual(malformed);
});
function request(method: string, body?: unknown): ManagementContext {
  const url = new URL("http://127.0.0.1:10100/api/codex/desktop-compatibility/settings");
  return { url, req: new Request(url, { method, headers: { host: url.host, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    config: initial, principal: "gui-session", trustedLoopbackIngress: true, deps: { desktopStartupSettings: createDesktopStartupSettings() } } as unknown as ManagementContext;
}
test("management dispatcher enforces local confirmation and reads back the saved preference", async () => {
  const service = createDesktopStartupSettings(), before = service.status();
  for (const change of [{ principal: "admin-token" }, { trustedLoopbackIngress: false }]) {
    const ctx = request("POST", { confirmed: true, startOnProxyStart: true, revision: before.revision }); Object.assign(ctx, change);
    expect((await handleDesktopCompatibilitySettingsRoutes(ctx))?.status).toBe(403);
  }
  const invalid = request("POST", { confirmed: true, startOnProxyStart: "true", revision: before.revision });
  expect((await handleDesktopCompatibilitySettingsRoutes(invalid))?.status).toBe(400);
  expect(service.status()).toEqual(before);
  const ctx = request("POST", { confirmed: true, startOnProxyStart: true, revision: before.revision });
  const response = await handleManagementAPI(ctx.req, ctx.url, ctx.config as OcxConfig, ctx.deps, "gui-session", undefined, { trustedLoopback: true });
  expect(response?.status).toBe(200); expect((await response!.json()).settings).toEqual(service.status()); expect(service.status().startOnProxyStart).toBe(true);
});
