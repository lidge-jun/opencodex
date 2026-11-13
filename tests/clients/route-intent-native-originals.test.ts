import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { mutatePersistedConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config/persisted-mutation";
import { persistNativeRouteIntent } from "../../src/client/route-intent-apply";
import {
  nativeIntentFields, nativeIntentOriginalsPath, prepareNativeIntentWrite, readNativeIntentOriginals, restoreNativeIntentOriginals,
} from "../../src/client/route-intent-native-originals";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-native-originals-"));
  process.env.OPENCODEX_HOME = root;
  const config = getDefaultConfig();
  delete config.clientIntegrations;
  delete config.claudeCode;
  delete config.apiSurfaces;
  saveConfig(config);
});
afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  removeTreeWithRetry(root);
});

const raw = () => JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const codex = () => Object.hasOwn(raw().clientIntegrations ?? {}, "codex") ? raw().clientIntegrations.codex : "absent";
const linkWrite = (client: "codex" | "claude" | "grok" | "claude-desktop", enabled: boolean) =>
  persistNativeRouteIntent(client, enabled, () => {}, loadConfig(), true);
const restore = () => restoreNativeIntentOriginals(() => {});
const setCodex = (value: boolean | "absent") => {
  const config = loadConfig();
  if (value === "absent") delete config.clientIntegrations?.codex;
  else config.clientIntegrations = { ...config.clientIntegrations, codex: value };
  saveConfig(config);
};

test("the original is captured once and restored with its presence after repeated link writes", () => {
  linkWrite("codex", false);
  linkWrite("codex", true);
  linkWrite("codex", false);
  expect(readNativeIntentOriginals()?.fields.codex).toEqual({ original: null, published: false });
  expect(restore()).toBe(true);
  expect(codex()).toBe("absent");
  expect(existsSync(nativeIntentOriginalsPath())).toBe(false);
});

test("a no-op link write claims no ownership", () => {
  setCodex(true);
  linkWrite("codex", true);
  expect(existsSync(nativeIntentOriginalsPath())).toBe(false);
  expect(prepareNativeIntentWrite(nativeIntentFields(loadConfig()), nativeIntentFields(loadConfig()))).toBe(false);
  expect(restore()).toBe(false);
  expect(codex()).toBe(true);
});

test("Home writes are not recorded", () => {
  persistNativeRouteIntent("codex", false, () => {}, loadConfig(), false);
  expect(existsSync(nativeIntentOriginalsPath())).toBe(false);
  expect(codex()).toBe(false);
});

test("restore keeps a value the writer did not publish and still removes the record", () => {
  setCodex(false);
  linkWrite("codex", true);
  setCodex("absent");
  expect(restore()).toBe(true);
  expect(codex()).toBe("absent");
  expect(existsSync(nativeIntentOriginalsPath())).toBe(false);
});

test("Claude restore returns enabled, the migration stamp and the Messages surface to absent", () => {
  linkWrite("claude", false);
  expect(raw().claudeCode.enabled).toBe(false);
  expect(typeof raw().claudeCode.authModeMigratedAt).toBe("string");
  expect(raw().apiSurfaces.messages).toEqual({ enabled: true });
  restore();
  expect(raw().claudeCode).toBeUndefined();
  expect(raw().apiSurfaces).toBeUndefined();
});

test("crash after the write-ahead record but before the config write restores nothing and clears the record", () => {
  setCodex(true);
  setPersistedConfigMutationBeforeCommitForTests(() => { throw new Error("fixture crash before config commit"); });
  expect(() => linkWrite("codex", false)).toThrow("fixture crash before config commit");
  expect(codex()).toBe(true);
  expect(readNativeIntentOriginals()?.fields.codex).toEqual({ original: true, pending: false });
  expect(restore()).toBe(true);
  expect(codex()).toBe(true);
  expect(existsSync(nativeIntentOriginalsPath())).toBe(false);
});

test("crash after the config write but before publish still restores the pending value", () => {
  const before = nativeIntentFields(loadConfig());
  expect(prepareNativeIntentWrite(before, { ...before, codex: false })).toBe(true);
  mutatePersistedConfig(config => { config.clientIntegrations = { ...config.clientIntegrations, codex: false }; return { changed: true, value: config }; });
  expect(readNativeIntentOriginals()?.fields.codex).toEqual({ original: null, pending: false });
  restore();
  expect(codex()).toBe("absent");
});

test("an interrupted restore is retried safely", () => {
  setCodex(true);
  linkWrite("codex", false);
  setPersistedConfigMutationBeforeCommitForTests(() => { throw new Error("fixture crash during restore"); });
  expect(() => restore()).toThrow("fixture crash during restore");
  expect(codex()).toBe(false);
  expect(existsSync(nativeIntentOriginalsPath())).toBe(true);
  const recorded = readFileSync(nativeIntentOriginalsPath(), "utf8");
  expect(restore()).toBe(true);
  expect(codex()).toBe(true);
  // Crash after the restored config committed but before the record was removed.
  writeFileSync(nativeIntentOriginalsPath(), recorded, { mode: 0o600 });
  expect(restore()).toBe(true);
  expect(codex()).toBe(true);
  expect(existsSync(nativeIntentOriginalsPath())).toBe(false);
});

test("a different link after a crashed enrollment keeps the first original", () => {
  // Crashed attempt: the config shows its value, the record still calls it pending.
  const before = nativeIntentFields(loadConfig());
  prepareNativeIntentWrite(before, { ...before, codex: false });
  mutatePersistedConfig(config => { config.clientIntegrations = { codex: false }; return { changed: true, value: config }; });
  // The next link turns Codex on, then off again.
  linkWrite("codex", true);
  expect(readNativeIntentOriginals()?.fields.codex).toEqual({ original: null, published: true });
  linkWrite("codex", false);
  restore();
  expect(codex()).toBe("absent");
});

test("an unreadable record refuses both capture and restore without touching config", () => {
  setCodex(true);
  linkWrite("codex", false);
  writeFileSync(nativeIntentOriginalsPath(), "{not json", { mode: 0o600 });
  expect(() => restore()).toThrow("Native intent originals record is unreadable");
  expect(() => linkWrite("codex", true)).toThrow("Native intent originals record is unreadable");
  expect(codex()).toBe(false);
});
