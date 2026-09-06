import { saveConfig, readConfigDiagnostics } from "../../src/config";
import { writeServiceApiTokenFile } from "../../src/lib/service-secrets";
import { withClientLifecycleSync } from "../../src/client/lifecycle-lock";
import { applyRemoteDesktopStore } from "../../src/claude/desktop-remote-store";
import type { OcxConfig } from "../../src/types";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  atomicReplaceDesktopConfig,
  buildDesktop3pRegistry,
  deriveDesktop3pCode,
  desktop3pAlias,
  generateDesktop3pConfig,
  generateDesktop3pModels,
  legacyDesktop3pAlias,
  isUnresolvedDesktop3pAlias,
  isKnownDesktop3pModelId,
  parseDesktop3pModeArgs,
  resolveDesktop3pConfigLibraryPath,
  resolveDesktop3pAlias,
  writeDesktop3pConfig,
  writeRemoteDesktop3pConfig,
  type Desktop3pModelEntry,
} from "../../src/claude/desktop-3p";
import { moveDesktopRoute, reconcileDesktopProfile, setDesktopFamilyDefault } from "../../src/claude/desktop-profile";
import { resolveInboundModel } from "../../src/claude/inbound";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("Claude Desktop 3P models", () => {
  test("replaces native exemptions together with the registry on either install path", () => {
    const dated = "claude-opus-4-8-20260304";
    try {
      buildDesktop3pRegistry([], [{ provider: "anthropic", id: dated }]);
      expect(resolveDesktop3pAlias(dated)).toBeNull();
      expect(isUnresolvedDesktop3pAlias(dated)).toBe(false);
      generateDesktop3pModels(["gpt-5.6-sol"], []);
      expect(isUnresolvedDesktop3pAlias(dated)).toBe(true);
      expect(isUnresolvedDesktop3pAlias("claude-opus-4-8-ncb")).toBe(false);
      expect(isUnresolvedDesktop3pAlias("claude-opus-4-ncb")).toBe(false);
      generateDesktop3pModels([], [{ provider: "anthropic", id: dated }]);
      expect(isUnresolvedDesktop3pAlias(dated)).toBe(false);
      buildDesktop3pRegistry([], []);
      expect(isUnresolvedDesktop3pAlias(dated)).toBe(true);
      expect(isUnresolvedDesktop3pAlias("claude-opus-4-8-ncb")).toBe(true);
      expect(isUnresolvedDesktop3pAlias("claude-opus-4-ncb")).toBe(true);
      for (const id of ["claude-opus-4-8", "claude-haiku-4-5", "claude-opus-4-8-20250201", "claude-ocx-native--claude-fable-5-1"]) {
        expect(isUnresolvedDesktop3pAlias(id)).toBe(false);
      }
    } finally { buildDesktop3pRegistry([], []); }
  });

  test("remote apply preserves exact hub entries and foreign keys without installing aliases", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ocx-desktop-remote-")));
    const previous = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(dir, "ocx");
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = dir;
    const models: Desktop3pModelEntry[] = [{
      name: "claude-opus-4-8-20260304", labelOverride: "Hub model",
      anthropicFamilyTier: "fable", isFamilyDefault: true, supports1m: true, prefer1m: true,
    }];
    try {
      saveConfig({ providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"] } }, defaultProvider: "test", port: 4096 } as OcxConfig);
      expect(readConfigDiagnostics().source).toBe("file");
      const local = writeDesktop3pConfig(4096, ["gpt-5.6-sol"], [], "old-key", "static", undefined, undefined, { lockPath: join(dir, "locks", "desktop.sqlite") });
      expect(local.written).toBe(true);
      const prior = JSON.parse(readFileSync(local.path, "utf8"));
      writeFileSync(local.path, JSON.stringify({ ...prior, foreignSetting: { retained: true } }));
      const token = writeServiceApiTokenFile("remote-fixture-key");
      const owner = { serverUrl: "https://hub.example.test", apiKeyId: "desktop-fixture", connectedAt: "2026-09-06T00:00:00.000Z" };
      saveConfig({ providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"] } }, defaultProvider: "test", port: 4096, runtimeRole: "client", client: {
        ...owner, managementUrl: owner.serverUrl, managementTransport: "direct", selectedClients: ["claude"],
        tokenEnv: "OPENCODEX_API_AUTH_TOKEN", tokenFingerprint: token.fingerprint, protocolVersion: 1,
      } } as OcxConfig);
      expect(readConfigDiagnostics().source).toBe("file");
      for (const mode of ["static", "hybrid", "discovery"] as const) {
        const result = withClientLifecycleSync(held => applyRemoteDesktopStore(held, {
          owner, expectedTokenFingerprint: token.fingerprint,
          baseUrl: owner.serverUrl, apiKey: "remote-fixture-key", mode, models,
        }), { lockPath: join(dir, "locks", "desktop.sqlite") });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        expect(result.path).toBe(local.path);
        const written = JSON.parse(readFileSync(result.path!, "utf8"));
        expect(written.inferenceGatewayBaseUrl).toBe("https://hub.example.test");
        expect(written.inferenceGatewayApiKey).toBe("remote-fixture-key");
        expect(written.modelDiscoveryEnabled).toBe(mode !== "static");
        expect(written.inferenceModels).toEqual(mode === "discovery" ? undefined : models);
        expect(written.foreignSetting).toEqual({ retained: true });
        expect(resolveDesktop3pAlias(models[0]!.name)).toBeNull();
        expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
      }
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previous;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      buildDesktop3pRegistry([], []);
      removeTreeWithRetry(dir);
    }
  });

  test("local generation and unbound remote failures retain result semantics and existing file bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-generation-"));
    const previous = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(dir, "ocx");
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = dir;
    try {
      saveConfig({ providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"] } }, defaultProvider: "test", port: 4096 } as OcxConfig);
      expect(readConfigDiagnostics().source).toBe("file");
      const initial = writeDesktop3pConfig(4096, [], [{ provider: "test", id: "valid" }], undefined, "static", undefined, undefined, { lockPath: join(dir, "locks", "desktop.sqlite") });
      expect(initial.written).toBe(true);
      const before = readFileSync(initial.path, "utf8");
      const beforeMeta = readFileSync(join(dir, "_meta.json"), "utf8");
      const local = writeDesktop3pConfig(4096, [], [{ provider: "test", id: "x".repeat(90) }], undefined, "static", undefined, undefined, { lockPath: join(dir, "locks", "desktop.sqlite") });
      const remote = writeRemoteDesktop3pConfig({
        baseUrl: "https://hub.example.test", apiKey: "fixture-key", mode: "static",
        lifecycleLockDeps: { lockPath: join(dir, "locks", "desktop.sqlite") },
        models: [{ name: "invalid", labelOverride: "Hub", anthropicFamilyTier: "opus" }],
      });
      expect(local.written).toBe(false);
      expect(local.path).toBe(initial.path);
      expect(local.reason).toContain("exceeds 80 chars");
      // An unbound caller is refused before selecting or touching a Desktop file.
      expect(remote).toMatchObject({ written: false, path: "", reason: "desktop_remote_connection_required" });
      expect(readFileSync(initial.path, "utf8")).toBe(before);
      expect(readFileSync(join(dir, "_meta.json"), "utf8")).toBe(beforeMeta);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previous;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      buildDesktop3pRegistry([], []);
      removeTreeWithRetry(dir);
    }
  });

  test("resolves the actual cross-platform Claude Desktop config library (#539)", () => {
    // Claude Desktop appends "-3p" to its userData root (app.asar `GE()`), so the
    // suffix-less path is one Desktop never reads. Branch-by-branch coverage lives in
    // tests/claude-integration/claude-desktop-config-path.test.ts; this pins the public entry point.
    expect(resolveDesktop3pConfigLibraryPath({
      env: { OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR: " /custom/library " },
      platform: "darwin",
      homeDir: "/Users/test",
    })).toBe("/custom/library");
    // CLAUDE_USER_DATA_DIR is the one branch where Desktop drops the suffix entirely.
    expect(resolveDesktop3pConfigLibraryPath({
      env: { CLAUDE_USER_DATA_DIR: "/profiles/claude" },
      platform: "darwin",
      homeDir: "/Users/test",
    })).toBe(posix.join("/profiles/claude", "configLibrary"));
    expect(resolveDesktop3pConfigLibraryPath({
      env: {},
      platform: "darwin",
      homeDir: "/Users/test",
    })).toBe("/Users/test/Library/Application Support/Claude-3p/configLibrary");
    // Windows reads LOCALAPPDATA first; APPDATA is only the Electron userData fallback.
    // Asserted with `win32.join` because the separator follows the target platform, not the host.
    expect(resolveDesktop3pConfigLibraryPath({
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      platform: "win32",
      homeDir: "C:\\Users\\test",
    })).toBe(win32.join("C:\\Users\\test\\AppData\\Local", "Claude-3p", "configLibrary"));
    expect(resolveDesktop3pConfigLibraryPath({
      env: { XDG_CONFIG_HOME: "/xdg/config" },
      platform: "linux",
      homeDir: "/home/test",
    })).toBe("/xdg/config/Claude-3p/configLibrary");
    expect(resolveDesktop3pConfigLibraryPath({
      env: {},
      platform: "linux",
      homeDir: "/home/test",
    })).toBe("/home/test/.config/Claude-3p/configLibrary");
  });

  test("derives stable golden codes", () => {
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toBe("ncb");
    expect(deriveDesktop3pCode("opencode-go/glm-5.2")).toBe("yrf");
    expect(deriveDesktop3pCode("native/gpt-5.6-sol")).toMatch(/^[a-z][0-9a-z]{2}$/);
  });

  test("aliases use the opus-4-8 prefix and never collide with real dateless ids", () => {
    expect(desktop3pAlias("native", "gpt-5.6-sol")).toBe("claude-opus-4-8-ncb");
    expect(legacyDesktop3pAlias("native", "gpt-5.6-sol")).toBe("claude-opus-4-ncb");
    // Real Anthropic ids pass through untouched (dateless canonical form).
    expect(desktop3pAlias("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    // Letter-first suffix: can never equal a bare real id or a numeric date suffix.
    expect(desktop3pAlias("native", "gpt-5.6-sol")).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
  });

  test("generates labeled opus-tier entries and one family default", () => {
    expect(generateDesktop3pModels(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    )).toEqual([
      {
        name: "claude-opus-4-8-ncb",
        labelOverride: "GPT 5.6 Sol (native)",
        anthropicFamilyTier: "opus",
        isFamilyDefault: true,
      },
      {
        name: "claude-opus-4-8-yrf",
        labelOverride: "GLM 5.2 (opencode-go)",
        anthropicFamilyTier: "opus",
      },
    ]);
  });

  test("an openai context cap reaches the Desktop writer, not just the dashboard", () => {
    // gpt-5.4 is the authoritative 1M native, so it earns supports1m. Capping the provider
    // at 272k has to take that away here too, or the written Desktop config promises a
    // window the proxy will not serve (#854's effective-window contract).
    const uncapped = generateDesktop3pModels(["gpt-5.4"], []);
    expect(uncapped[0]).toMatchObject({ supports1m: true, prefer1m: true });

    const capped = generateDesktop3pModels(["gpt-5.4"], [], undefined, 272_000);
    expect(capped[0]!.supports1m).toBeUndefined();
    expect(capped[0]!.prefer1m).toBeUndefined();
  });

  test("passes Anthropic Claude model ids through without encoding", () => {
    const models = generateDesktop3pModels([], [
      { provider: "anthropic", id: "claude-opus-4-6" },
    ]);
    expect(models[0]?.name).toBe("claude-opus-4-6");
    expect(models[0]?.anthropicFamilyTier).toBe("opus");
  });

  test("keeps real Anthropic ids OUT of the decode registry (native passthrough survives)", () => {
    buildDesktop3pRegistry([], [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "anthropic", id: "claude-fable-5" },
    ]);
    expect(resolveDesktop3pAlias("claude-opus-4-8")).toBeNull();
    expect(resolveDesktop3pAlias("claude-fable-5")).toBeNull();
    // resolveInboundModel stays identity → wantsNativePassthrough keeps firing.
    expect(resolveInboundModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveInboundModel("claude-fable-5")).toBe("claude-fable-5");
  });

  test("[1m] strip resolves registry-backed desktop aliases (audit R2#6)", () => {
    buildDesktop3pRegistry(["gpt-5.6-sol"], []);
    expect(resolveInboundModel("claude-opus-4-8-ncb[1m]")).toBe("gpt-5.6-sol");
  });

  test("resolves aliases from the current registry", () => {
    const registry = buildDesktop3pRegistry(
      ["gpt-5.6-sol"],
      [{ provider: "opencode-go", id: "glm-5.2" }],
    );
    expect(registry.get("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-8-yrf")).toBe("opencode-go/glm-5.2");
    // Legacy pre-rename aliases still decode (stale Desktop configs).
    expect(resolveDesktop3pAlias("claude-opus-4-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-yrf")).toBe("opencode-go/glm-5.2");
    expect(resolveDesktop3pAlias("claude-opus-4-8-unknown")).toBeNull();
  });

  test("warns and skips the second route on an alias collision", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const models = generateDesktop3pModels([], [
        { provider: "test", id: "model-123" },
        { provider: "test", id: "model-155" },
      ]);
      expect(deriveDesktop3pCode("test/model-123")).toBe("vdu");
      expect(deriveDesktop3pCode("test/model-155")).toBe("vdu");
      expect(models).toHaveLength(1);
      expect(resolveDesktop3pAlias("claude-opus-4-8-vdu")).toBe("test/model-123");
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls.flat().join(" ")).toContain("skipping test/model-155");
    } finally {
      warning.mockRestore();
    }
  });

  test("generates a static config by default (list overrides discovery — no merge, devlog 138)", () => {
    const config = generateDesktop3pConfig(
      4096,
      ["gpt-5.6-sol"],
      [{ provider: "anthropic", id: "claude-opus-4-6" }, { provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000 }],
      "test-key",
    );
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed).toMatchObject({
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:4096",
      inferenceGatewayApiKey: "test-key",
      modelDiscoveryEnabled: false,
    });
    // Static list carries the pinned entries.
    expect(reparsed.inferenceModels.map((m: { name: string }) => m.name)).toEqual([
      "claude-opus-4-8-ncb",
      "claude-opus-4-6",
      desktop3pAlias("cursor", "gpt-5.6-luna"),
    ]);
    // supports1m ONLY where an authoritative contextWindow >= 1M was provided. The routed
    // cursor row declares 1M explicitly; the native gpt-5.6-sol row advertises 922,000 (a cap
    // under its measured ceiling) so it must NOT claim the capability, and claude-opus-4-6
    // was given no window at all.
    const byName = new Map(reparsed.inferenceModels.map((m: { name: string }) => [m.name, m]));
    expect((byName.get(desktop3pAlias("cursor", "gpt-5.6-luna")) as { supports1m?: boolean }).supports1m).toBe(true);
    expect((byName.get("claude-opus-4-8-ncb") as { supports1m?: boolean }).supports1m).toBeUndefined();
    expect((byName.get("claude-opus-4-6") as { supports1m?: boolean }).supports1m).toBeUndefined();
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
  });

  test("hybrid mode keeps the static list AND discovery on (CCR-defensive)", () => {
    const config = generateDesktop3pConfig(4096, ["gpt-5.6-sol"], [], "test-key", "hybrid");
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed.modelDiscoveryEnabled).toBe(true);
    expect(reparsed.inferenceModels.map((m: { name: string }) => m.name)).toEqual(["claude-opus-4-8-ncb"]);
  });

  test("generates a discovery-only config with --discovery-only", () => {
    const config = generateDesktop3pConfig(4096, ["gpt-5.6-sol"], [], "test-key", "discovery");
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed.modelDiscoveryEnabled).toBe(true);
    expect(reparsed.inferenceModels).toBeUndefined();
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
  });

  test("parses desktop mode flags with mutual exclusion and unknown-flag rejection", () => {
    expect(parseDesktop3pModeArgs([])).toEqual({ mode: "static" });
    expect(parseDesktop3pModeArgs(["--static"])).toEqual({ mode: "static" });
    expect(parseDesktop3pModeArgs(["--hybrid"])).toEqual({ mode: "hybrid" });
    expect(parseDesktop3pModeArgs(["--discovery-only"])).toEqual({ mode: "discovery" });
    expect("error" in parseDesktop3pModeArgs(["--static", "--discovery-only"])).toBe(true);
    expect("error" in parseDesktop3pModeArgs(["--hybrid", "--static"])).toBe(true);
    expect(parseDesktop3pModeArgs(["--static", "--static"])).toEqual({ mode: "static" });
    expect("error" in parseDesktop3pModeArgs(["--wat"])).toBe(true);
  });

  test("generates a valid static gateway config with --static", () => {
    const config = generateDesktop3pConfig(
      4096,
      ["gpt-5.6-sol"],
      [{ provider: "anthropic", id: "claude-opus-4-6" }],
      "test-key",
      "static",
    );
    const reparsed = JSON.parse(JSON.stringify(config));
    expect(reparsed).toMatchObject({
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
      inferenceGatewayBaseUrl: "http://127.0.0.1:4096",
      inferenceGatewayApiKey: "test-key",
      modelDiscoveryEnabled: false,
    });
    expect(reparsed.inferenceModels.map((model: { name: string }) => model.name)).toEqual([
      "claude-opus-4-8-ncb",
      "claude-opus-4-6",
    ]);
    // Static generation also refreshes the decode registry (new + legacy aliases).
    expect(resolveDesktop3pAlias("claude-opus-4-8-ncb")).toBe("native/gpt-5.6-sol");
    expect(resolveDesktop3pAlias("claude-opus-4-ncb")).toBe("native/gpt-5.6-sol");
  });

  test("renders persisted family/date assignments and installs their decode registry", () => {
    const routed = [{ provider: "cursor", id: "gpt-5.6-luna", contextWindow: 1_000_000 }];
    let profile = reconcileDesktopProfile(undefined, [
      { route: "native/gpt-5.6-sol", label: "GPT 5.6 Sol" },
      { route: "cursor/gpt-5.6-luna", label: "GPT 5.6 Luna", contextWindow: 1_000_000 },
    ]);
    profile = moveDesktopRoute(profile, "cursor/gpt-5.6-luna", "haiku", true);
    const models = generateDesktop3pModels(["gpt-5.6-sol"], routed, profile);
    const luna = models.find(model => model.labelOverride.includes("Luna"));
    expect(luna).toMatchObject({ anthropicFamilyTier: "haiku", isFamilyDefault: true, supports1m: true });
    expect(luna?.name).toMatch(/^claude-opus-4-8-2026\d{4}$/);
    expect(resolveDesktop3pAlias(luna!.name)).toBe("cursor/gpt-5.6-luna");
  });

  test("backs up owned config and preserves old bytes when atomic replacement fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-atomic-"));
    const path = join(dir, "owned.json");
    try {
      writeFileSync(path, "old bytes\n");
      const success = atomicReplaceDesktopConfig(path, "new bytes\n");
      expect(readFileSync(path, "utf8")).toBe("new bytes\n");
      expect(readFileSync(success.backupPath!, "utf8")).toBe("old bytes\n");

      writeFileSync(path, "stable bytes\n");
      expect(() => atomicReplaceDesktopConfig(path, "never written\n", () => { throw new Error("injected"); })).toThrow("injected");
      expect(readFileSync(path, "utf8")).toBe("stable bytes\n");
      expect(readFileSync(`${path}.bak`, "utf8")).toBe("stable bytes\n");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("re-applying an owned profile preserves foreign profile keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-merge-"));
    const previous = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = join(dir, "ocx");
    process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = dir;
    try {
      saveConfig({ providers: { test: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, liveModels: false, models: ["fixture-model"] } }, defaultProvider: "test", port: 4096 } as OcxConfig);
      expect(readConfigDiagnostics().source).toBe("file");
      const id = "owned-profile";
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "_meta.json"), JSON.stringify({
        appliedId: id,
        entries: [{ id, name: "opencodex" }],
      }));
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({
        inferenceProvider: "gateway",
        inferenceCredentialKind: "static",
        inferenceGatewayBaseUrl: "http://127.0.0.1:1",
        inferenceGatewayApiKey: "old-key",
        modelDiscoveryEnabled: false,
        inferenceModels: [],
        foreignDeploymentSetting: { allowed: true },
      }));

      const written = writeDesktop3pConfig(4096, ["gpt-5.6-sol"], [], "new-key", "static", undefined, undefined, { lockPath: join(dir, "locks", "desktop.sqlite") });
      expect(written.written).toBe(true);
      const profile = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
      expect(profile.foreignDeploymentSetting).toEqual({ allowed: true });
      expect(profile.inferenceGatewayBaseUrl).toBe("http://127.0.0.1:4096");
      expect(profile.inferenceGatewayApiKey).toBe("new-key");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
      else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previous;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(dir);
    }
  });

  test("legacy hash collisions stay bound to the same route when default ordering changes", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const routed = [
        { provider: "test", id: "model-123" },
        { provider: "test", id: "model-155" },
      ];
      let profile = reconcileDesktopProfile(undefined, routed.map(model => ({
        route: `${model.provider}/${model.id}`,
        label: model.id,
      })));
      profile = setDesktopFamilyDefault(profile, "opus", "test/model-155");
      generateDesktop3pModels([], routed, profile);
      expect(legacyDesktop3pAlias("test", "model-123")).toBe(legacyDesktop3pAlias("test", "model-155"));
      expect(resolveDesktop3pAlias(legacyDesktop3pAlias("test", "model-123"))).toBe("test/model-123");
      expect(warning.mock.calls.flat().join(" ")).toContain("stays bound to test/model-123");
    } finally {
      warning.mockRestore();
    }
  });
});


test("Desktop FAST base validation preserves exact catalog IDs and clears stale exemptions", () => {
  const unknown = "claude-opus-4-8-20260202--fast";
  const registry = buildDesktop3pRegistry([], [{ provider: "routed", id: "model-one" }]);
  const known = registry.keys().next().value!;
  try {
    expect(isKnownDesktop3pModelId(known)).toBe(true);
    expect(isUnresolvedDesktop3pAlias(known + "--fast")).toBe(false);
    expect(isUnresolvedDesktop3pAlias(unknown)).toBe(true);
    generateDesktop3pModels([], [{ provider: "anthropic", id: unknown }]);
    expect(isKnownDesktop3pModelId(unknown)).toBe(true);
    expect(isUnresolvedDesktop3pAlias(unknown)).toBe(false);
    buildDesktop3pRegistry([], []);
    expect(isKnownDesktop3pModelId(unknown)).toBe(false);
    expect(isUnresolvedDesktop3pAlias(unknown)).toBe(true);
  } finally { buildDesktop3pRegistry([], []); }
});
