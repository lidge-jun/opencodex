import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { ClientPathError } from "../../src/clients/client-path";
import { t3codeConfigPath, t3codeHomeDir } from "../../src/clients/config-export/t3code";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-t3code-lifecycle-"));
  roots.push(home);
  const env = { T3CODE_HOME: "~/relocated-t3" };
  const path = join(home, "relocated-t3", "userdata", "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  const original = { theme: "dark", providerInstances: { personal: { driver: "codex" } } };
  const before = JSON.stringify(original, null, 2) + "\n";
  writeFileSync(path, before);
  const input: IntegrationWriteInput = {
    clientId: "t3code", home, env, port: 10100,
    config: {
      port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
    } as OcxConfig,
    models: [{ namespaced: "mock/a", provider: "mock", id: "a" }],
    store: createIntegrationStateStore(join(home, "store")),
  };
  return { input, path, before, original };
}

test("T3CODE_HOME binds detection, apply and Undo to the same relocated file", () => {
  const f = fixture();
  expect(t3codeConfigPath(f.input.env, f.input.home)).toBe(f.path);
  expect(INTEGRATION_CLIENTS.t3code.detectDir(f.input.env, f.input.home)).toBe(dirname(f.path));
  expect(readIntegrationState(f.input)).toMatchObject({ state: "absent", installed: true, configPath: f.path });
  expect(applyIntegration(f.input)).toMatchObject({ ok: true, changed: true });
  expect(JSON.parse(readFileSync(f.path, "utf8")).providerInstances.personal).toEqual(f.original.providerInstances.personal);
  expect(existsSync(join(f.input.home!, ".t3", "userdata", "settings.json"))).toBe(false);
  const opId = f.input.store!.listOperations("t3code")[0]!.opId;
  expect(restoreIntegration({ ...f.input, opId }).ok).toBe(true);
  expect(readFileSync(f.path, "utf8")).toBe(f.before);
});

test("a bind change refuses refresh but retains classification and owned cleanup", () => {
  const f = fixture();
  expect(applyIntegration(f.input).ok).toBe(true);
  const applied = readFileSync(f.path, "utf8");
  const remote = { ...f.input, config: { ...f.input.config, hostname: "0.0.0.0" } };
  expect(readIntegrationState(remote).state).toBe("current");
  expect(refreshIntegration(remote)).toMatchObject({ ok: false, reason: "non_loopback" });
  expect(readFileSync(f.path, "utf8")).toBe(applied);
  expect(disableIntegration(remote).ok).toBe(true);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(f.original);
});

test("a relative T3CODE_HOME throws the shared leaf error before touching a file", () => {
  const f = fixture();
  expect(() => t3codeConfigPath({ T3CODE_HOME: "relative/t3" }, f.input.home)).toThrow(ClientPathError);
  expect(readFileSync(f.path, "utf8")).toBe(f.before);
});

for (const override of ["\\shared\\t3", "/shared/t3", "C:relative", "relative/t3", "\\\\server"]) {
  test(`Windows T3CODE_HOME refuses an unqualified path: ${override}`, () => {
    expect(() => t3codeHomeDir({ T3CODE_HOME: override }, "D:\\Users\\test", "win32")).toThrow(ClientPathError);
    expect(() => t3codeHomeDir({ T3CODE_HOME: override }, "D:\\Users\\test", "win32")).toThrow("T3CODE_HOME");
  });
}

for (const override of ["C:\\abs", "C:/abs", "\\\\server\\share\\t3", "//server/share/t3"]) {
  test(`Windows T3CODE_HOME accepts a fully qualified path: ${override}`, () => {
    expect(t3codeHomeDir({ T3CODE_HOME: override }, "D:\\Users\\test", "win32")).toBe(override);
  });
}

for (const [override, expected] of [["~", "D:\\Users\\test"], ["~/t3", win32.join("D:\\Users\\test", "t3")], ["~\\t3", win32.join("D:\\Users\\test", "t3")]] as const) {
  test(`Windows T3CODE_HOME expands ${override} against the effective home`, () => {
    expect(t3codeHomeDir({ T3CODE_HOME: override }, "D:\\Users\\test", "win32")).toBe(expected);
  });
}

test("Windows T3CODE_HOME refuses a tilde expanded against a drive-less home", () => {
  expect(() => t3codeHomeDir({ T3CODE_HOME: "~" }, "\\Users\\test", "win32")).toThrow(ClientPathError);
});

test("POSIX T3CODE_HOME keeps rooted paths and tilde expansion", () => {
  expect(t3codeHomeDir({ T3CODE_HOME: "/shared/t3" }, "/home/test", "linux")).toBe("/shared/t3");
  expect(t3codeHomeDir({ T3CODE_HOME: "~/t3" }, "/home/test", "linux")).toBe("/home/test/t3");
  expect(() => t3codeHomeDir({ T3CODE_HOME: "relative/t3" }, "/home/test", "linux")).toThrow(ClientPathError);
});

test("an unqualified T3CODE_HOME surfaces as unsafe without changing client bytes", () => {
  const f = fixture();
  const overrides = process.platform === "win32" ? ["\\shared\\t3", "/shared/t3", "C:relative"] : ["relative/t3"];
  for (const override of overrides) {
    const input = { ...f.input, env: { T3CODE_HOME: override } };
    expect(readIntegrationState(input)).toMatchObject({ state: "unsafe", reason: "unresolvable-path" });
    for (const write of [applyIntegration, refreshIntegration]) {
      expect(write(input)).toMatchObject({ ok: false, reason: "unsafe", message: expect.stringContaining("T3CODE_HOME") });
    }
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
    expect(f.input.store!.listOperations("t3code")).toEqual([]);
  }
});

test("a closed Messages surface refuses apply and refresh but keeps disable", () => {
  const f = fixture();
  const explicit = { ...f.input, config: { ...f.input.config, apiSurfaces: { messages: { enabled: false } } } as OcxConfig };
  const inherited = { ...f.input, config: { ...f.input.config, claudeCode: { enabled: false } } as OcxConfig };
  for (const closed of [explicit, inherited]) {
    expect(applyIntegration(closed)).toMatchObject({ ok: false, reason: "unsafe", message: expect.stringContaining("Messages API") });
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
  }
  const reopened = { ...inherited, config: { ...inherited.config, apiSurfaces: { messages: { enabled: true } } } as OcxConfig };
  expect(applyIntegration(reopened).ok).toBe(true);
  const applied = readFileSync(f.path, "utf8");
  for (const closed of [explicit, inherited]) {
    expect(refreshIntegration(closed)).toMatchObject({ ok: false, reason: "unsafe" });
    expect(readFileSync(f.path, "utf8")).toBe(applied);
  }
  expect(disableIntegration(inherited).ok).toBe(true);
  expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(f.original);
});
