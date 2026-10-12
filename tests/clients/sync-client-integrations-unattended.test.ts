import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, getConfigPath } from "../../src/config";
import { buildDesktop3pRegistry, writeDesktop3pConfig, type Desktop3pConfigMode } from "../../src/claude/desktop-3p";
import * as atomicWrites from "../../src/config/atomic-write";
import * as desktopLibrary from "../../src/claude/desktop-3p-library";
import { syncGrokConfig } from "../../src/grok/sync";
import { grokManagedBlockPresent, injectGrokConfig } from "../../src/grok/inject";
import { markSiblingStart, resetSiblingStartForTests } from "../../src/codex/sibling-start";
import { syncEnabledClientIntegrations } from "../../src/server/management/config-routes";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const envKeys = ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR"] as const;
let root: string;
let library: string;
let grokHome: string;
let config: OcxConfig;
let previous: Partial<Record<typeof envKeys[number], string>>;
let current: boolean;
const unattended = { unattended: { isCurrent: () => current } };
const models = [{ provider: "mock", id: "new-model", contextWindow: 123_000 }];
const refresh = mock<NonNullable<NonNullable<Parameters<typeof syncEnabledClientIntegrations>[2]>["refreshOwnedCatalogIntegrations"]>>(async () => []);
const writer = mock<typeof writeDesktop3pConfig>((...args) => {
  // Production lock identity ignores HOME by design; exercise the real writer with its explicit seam.
  args[7] = { lockPath: join(root, "locks", "desktop.sqlite") };
  return writeDesktop3pConfig(...args);
});
function persist() { writeFileSync(getConfigPath(), JSON.stringify(config)); config = loadConfig(); }
function deps(fetchAllModels = async () => models) {
  return { fetchAllModels, refreshOwnedCatalogIntegrations: refresh, writeDesktop3pConfig: writer };
}
function seed(mode: Desktop3pConfigMode = "static") {
  const result = writeDesktop3pConfig(12345, [], [{ provider: "mock", id: "old-model" }], "fixture-key", mode,
    undefined, undefined, { lockPath: join(root, "locks", "desktop.sqlite") });
  expect(result.written).toBe(true);
  config.claudeCode = { desktopMode: "gateway", desktopProfile: {
    version: 1, assignments: {}, defaults: { opus: null, fable: null, sonnet: null, haiku: null },
    appliedFingerprint: result.fingerprint!,
  } };
  persist();
  return result;
}
function metadata() { return JSON.parse(readFileSync(join(library, "_meta.json"), "utf8")); }
function snapshot() {
  return readdirSync(library).sort().map(name => [name, readFileSync(join(library, name), "utf8")]);
}

beforeEach(() => {
  previous = {};
  root = mkdtempSync(join(tmpdir(), "ocx-unattended-sync-"));
  for (const key of envKeys) previous[key] = process.env[key];
  process.env.HOME = root; process.env.USERPROFILE = root;
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  library = join(root, "desktop"); grokHome = join(root, "grok");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library; process.env.GROK_HOME = grokHome;
  mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
  mkdirSync(library); mkdirSync(grokHome);
  config = { port: 12345, hostname: "127.0.0.1", defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "https://example.test/v1", liveModels: false, models: ["old-model", "new-model"] } },
    clientIntegrations: { grok: false }, claudeCode: { desktopMode: "gateway" },
  } as OcxConfig;
  persist(); current = true; refresh.mockClear(); writer.mockClear(); resetSiblingStartForTests();
});
afterEach(() => {
  resetSiblingStartForTests(); buildDesktop3pRegistry([], []);
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  removeTreeWithRetry(root);
});

describe("unattended native and file client admission", () => {
  test("no Desktop marker skips discovery, and file clients exclude Cline with a fresh admit", async () => {
    const fetch = mock(async () => models);
    expect(await syncEnabledClientIntegrations(12345, config, deps(fetch), unattended)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
    const args = refresh.mock.calls[0]!;
    expect(args[1]).toEqual(["mcode", "pi", "aside", "raycast", "omo", "commandcode", "droid", "opencode", "kilo"]);
    expect(args[2]?.refreshOnly).toBe(true); expect(args[2]?.admit?.()).toBe(true);
    config.runtimeRole = "hub"; persist(); expect(args[2]?.admit?.()).toBe(false);
    config.unauthenticatedLoopbackListener = { enabled: true, port: 12346 }; persist();
    expect(args[2]?.admit?.()).toBe(false); current = false; expect(args[2]?.admit?.()).toBe(false);
  });

  test("stale generation, hub and sibling skip all clients", async () => {
    current = false;
    expect(await syncEnabledClientIntegrations(12345, config, deps(), unattended)).toEqual([]);
    current = true; config.runtimeRole = "hub"; persist();
    expect(await syncEnabledClientIntegrations(12345, config, deps(), unattended)).toEqual([]);
    config.runtimeRole = "standalone"; persist(); markSiblingStart(12344);
    expect(await syncEnabledClientIntegrations(12345, config, deps(), unattended)).toEqual([]);
    expect(refresh).not.toHaveBeenCalled(); expect(writer).not.toHaveBeenCalled();
  });

  test("Grok refresh requires a complete managed block", async () => {
    config.clientIntegrations = { grok: true, "claude-desktop": false }; persist();
    writeFileSync(join(grokHome, "config.toml"), 'theme = "personal"\n');
    const fetch = mock(async () => models);
    await syncEnabledClientIntegrations(12345, config, deps(fetch), unattended);
    expect(fetch).not.toHaveBeenCalled(); expect(grokManagedBlockPresent()).toBe(false);
    expect(injectGrokConfig(12345, [{ id: "old-model" }], { grokHome }).ok).toBe(true);
    expect(grokManagedBlockPresent()).toBe(true);
    const results = await syncEnabledClientIntegrations(12345, config, deps(fetch), unattended);
    expect(results).toContainEqual({ client: "grok", ok: true, changed: true });
    expect(readFileSync(join(grokHome, "config.toml"), "utf8")).toContain("new-model");
  });

  test("orphaned Grok fence is not owned refresh permission", () => {
    writeFileSync(join(grokHome, "config.toml"), '# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>\n');
    expect(grokManagedBlockPresent()).toBe(false);
  });

  for (const change of ["remove-block", "stop", "disable", "hub"] as const) {
    test(`Grok ${change} during discovery prevents the synchronous write`, async () => {
      config.clientIntegrations = { grok: true, "claude-desktop": false }; persist();
      expect(injectGrokConfig(12345, [{ id: "old-model" }], { grokHome }).ok).toBe(true);
      let expected = readFileSync(join(grokHome, "config.toml"), "utf8");
      await syncEnabledClientIntegrations(12345, config, deps(async () => {
        if (change === "remove-block") { expected = 'theme = "personal"\n'; writeFileSync(join(grokHome, "config.toml"), expected); }
        if (change === "stop") current = false;
        if (change === "disable") { config.clientIntegrations!.grok = false; persist(); }
        if (change === "hub") { config.runtimeRole = "hub"; persist(); }
        return models;
      }), unattended);
      expect(readFileSync(join(grokHome, "config.toml"), "utf8")).toBe(expected);
      if (change === "stop") expect(refresh).not.toHaveBeenCalled();
    });
  }

  test("attended sync still first-applies Desktop in static mode and passes Cline without refresh options", async () => {
    const results = await syncEnabledClientIntegrations(12345, config, deps());
    expect(results).toContainEqual({ client: "claude-desktop", ok: true, changed: true });
    expect(writer.mock.calls[0]).toHaveLength(7);
    const selected = metadata().appliedId;
    expect(JSON.parse(readFileSync(join(library, `${selected}.json`), "utf8")).modelDiscoveryEnabled).toBe(false);
    expect(refresh.mock.calls[0]).toHaveLength(2); expect(refresh.mock.calls[0]?.[1]).toContain("cline");
  });

  test("attended Grok still first-enrolls without a managed block", async () => {
    config.clientIntegrations = { grok: true, "claude-desktop": false }; persist();
    // Attended discovery keeps its existing default seam; stub just that dependency for this call.
    const management = await import("../../src/server/management-api");
    const fetch = spyOn(management, "fetchAllModels").mockResolvedValue(models);
    try {
      expect(await syncEnabledClientIntegrations(12345, config, deps())).toContainEqual({ client: "grok", ok: true, changed: true });
      expect(grokManagedBlockPresent()).toBe(true);
    } finally { fetch.mockRestore(); }
  });
});

describe("Desktop refresh-only retains ownership and selected bytes", () => {
  for (const mode of ["static", "hybrid", "discovery"] as const) {
    test(`an applied ${mode} profile retains its mode and selected id`, async () => {
      const applied = seed(mode); const before = metadata();
      const results = await syncEnabledClientIntegrations(12345, config, deps(), unattended);
      expect(results).toContainEqual({ client: "claude-desktop", ok: true, changed: true });
      expect(metadata()).toEqual(before);
      const written = JSON.parse(readFileSync(applied.path, "utf8"));
      expect(written.modelDiscoveryEnabled).toBe(mode !== "static");
      expect(Array.isArray(written.inferenceModels)).toBe(mode !== "discovery");
      expect(loadConfig().claudeCode?.desktopProfile?.appliedFingerprint).not.toBe(applied.fingerprint);
      expect(writer.mock.calls[0]?.[7]).toBeUndefined(); expect(writer.mock.calls[0]?.[8]?.admit()).toBe(true);
    });
  }

  for (const drift of ["no-marker", "stale-marker", "foreign", "standard", "deleted", "edited", "stopped", "hub"] as const) {
    test(`${drift} refuses without changing metadata, recreating a profile or allocating an id`, async () => {
      const applied = seed();
      if (drift === "no-marker") delete config.claudeCode!.desktopProfile!.appliedFingerprint;
      if (drift === "stale-marker") config.claudeCode!.desktopProfile!.appliedFingerprint = "0000000000000000";
      if (drift === "foreign" || drift === "standard") {
        const meta = metadata(); meta.appliedId = "other";
        meta.entries.push({ id: "other", name: drift === "standard" ? "opencodex-standard" : "personal" });
        writeFileSync(join(library, "_meta.json"), JSON.stringify(meta));
        writeFileSync(join(library, "other.json"), drift === "standard" ? "{}" : readFileSync(applied.path, "utf8"));
      }
      if (drift === "deleted") unlinkSync(applied.path);
      if (drift === "edited") writeFileSync(applied.path, readFileSync(applied.path, "utf8") + " ");
      if (drift === "stopped") current = false;
      if (drift === "hub") config.runtimeRole = "hub";
      persist(); const before = snapshot();
      const results = await syncEnabledClientIntegrations(12345, config, deps(), unattended);
      expect(results.find(row => row.client === "claude-desktop")).toBeUndefined(); expect(snapshot()).toEqual(before);
      // Invoke the writer too: the cheap fan-out gate alone must not be the ownership boundary.
      const result = writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
        undefined, { lockPath: join(root, "locks", "desktop.sqlite") },
        { appliedFingerprint: config.claudeCode?.desktopProfile?.appliedFingerprint ?? "", admit: () => current && config.runtimeRole !== "hub" });
      expect(result).toEqual({ written: false, path: library, reason: "desktop_refresh_only_skipped" });
      expect(snapshot()).toEqual(before); expect(existsSync(applied.path)).toBe(drift !== "deleted");
    });
  }

  for (const drift of ["stop", "marker", "hub", "first-party"] as const) {
    test(`Desktop ${drift} during discovery wins over the captured profile`, async () => {
      seed("hybrid"); const before = snapshot();
      const results = await syncEnabledClientIntegrations(12345, config, deps(async () => {
        if (drift === "stop") current = false;
        if (drift === "marker") delete config.claudeCode!.desktopProfile!.appliedFingerprint;
        if (drift === "hub") config.runtimeRole = "hub";
        if (drift === "first-party") config.claudeCode!.desktopMode = "first-party";
        persist(); return models;
      }), unattended);
      expect(results.find(row => row.client === "claude-desktop")).toBeUndefined(); expect(snapshot()).toEqual(before);
    });
  }

  test("writer ignores caller mode and rejects a persisted marker change at its in-lock gate", () => {
    const applied = seed("discovery");
    const successful = writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
      undefined, { lockPath: join(root, "locks", "desktop.sqlite") }, { appliedFingerprint: applied.fingerprint!, admit: () => true });
    expect(successful.written).toBe(true);
    expect(JSON.parse(readFileSync(successful.path, "utf8")).inferenceModels).toBeUndefined();
    const before = snapshot(); config.claudeCode!.desktopProfile!.appliedFingerprint = "0000000000000000"; persist();
    const refused = writeDesktop3pConfig(12345, [], models, "fixture-key", "hybrid", config.claudeCode?.desktopProfile,
      undefined, { lockPath: join(root, "locks", "desktop.sqlite") }, { appliedFingerprint: successful.fingerprint!, admit: () => true });
    expect(refused.reason).toBe("desktop_refresh_only_skipped"); expect(snapshot()).toEqual(before);
  });
});


describe("refresh transaction revalidation", () => {
  test("Grok exclusion persisted during discovery keeps the excluded model out", async () => {
    config.clientIntegrations = { grok: true, "claude-desktop": false };
    config.grokExcludedModels = ["mock/new-model"]; persist();
    await syncGrokConfig(12345, config, { grokHome }, { fetchAllModels: async () => models, injectGrokConfig });
    const before = readFileSync(join(grokHome, "config.toml"), "utf8");
    config.grokExcludedModels = []; persist();
    const results = await syncEnabledClientIntegrations(12345, config, deps(async () => {
      config.grokExcludedModels = ["mock/new-model"]; persist(); return models;
    }), unattended);
    expect(results).toContainEqual({ client: "grok", ok: true, changed: false });
    expect(readFileSync(join(grokHome, "config.toml"), "utf8")).toBe(before);
    expect(before).not.toContain('model = "mock/new-model"');
    expect(refresh).not.toHaveBeenCalled();
  });

  for (const key of ["hostname", "disabledModels"] as const) {
    test(`changed ${key} refuses the remaining fan-out`, async () => {
      seed(); const before = snapshot();
      await syncEnabledClientIntegrations(12345, config, deps(async () => {
        if (key === "hostname") config.hostname = "localhost";
        else config.disabledModels = ["mock/new-model"];
        persist(); return models;
      }), unattended);
      expect(snapshot()).toEqual(before); expect(refresh).not.toHaveBeenCalled();
    });
  }

  for (const invalid of ["missing", "orphaned", "revoked", "non-loopback", "dangling-backup"] as const) {
    test(`Grok transaction refuses ${invalid} without a write`, () => {
      const path = join(grokHome, "config.toml");
      if (invalid === "orphaned") writeFileSync(path, '# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>\n');
      else if (invalid !== "missing") injectGrokConfig(12345, [{ id: "old" }], { grokHome });
      const before = existsSync(path) ? readFileSync(path, "utf8") : null;
      if (invalid === "dangling-backup") symlinkSync(join(root, "missing-target"), `${path}.bak-opencodex`);
      const result = injectGrokConfig(12345, [{ id: "new" }], {
        grokHome, hostname: invalid === "non-loopback" ? "proxy.test" : "127.0.0.1",
        refreshOnly: { admit: () => invalid !== "revoked" },
      });
      expect(result).toMatchObject({ ok: true, changed: false, skippedReason: "refresh-only" });
      expect(existsSync(path) ? readFileSync(path, "utf8") : null).toBe(before);
      expect(existsSync(join(root, "missing-target"))).toBe(false);
    });
  }

  test("Grok fence removed after pre-check is not re-created by the injector", async () => {
    expect(injectGrokConfig(12345, [{ id: "old" }], { grokHome }).changed).toBe(true);
    expect(grokManagedBlockPresent(grokHome)).toBe(true);
    const path = join(grokHome, "config.toml");
    const personal = 'theme = "personal"\n';
    const result = await syncGrokConfig(12345, config, { grokHome, refreshOnly: { admit: () => true } }, {
      fetchAllModels: async () => models,
      injectGrokConfig: (...args) => { writeFileSync(path, personal); return injectGrokConfig(...args); },
    });
    expect(result).toMatchObject({ ok: true, changed: false, skippedReason: "refresh-only" });
    expect(readFileSync(path, "utf8")).toBe(personal);
  });

  for (const target of ["config", "backup"] as const) {
    test(`Grok symlinked ${target} is untouched`, () => {
      injectGrokConfig(12345, [{ id: "old" }], { grokHome });
      const path = join(grokHome, "config.toml"); const before = readFileSync(path, "utf8");
      const linked = target === "config" ? path : `${path}.bak-opencodex`;
      const external = join(root, "grok-target"); writeFileSync(external, before);
      if (existsSync(linked)) unlinkSync(linked);
      symlinkSync(external, linked);
      if (target === "config") expect(grokManagedBlockPresent(grokHome)).toBe(false);
      expect(injectGrokConfig(12345, [{ id: "new" }], { grokHome, refreshOnly: { admit: () => true } }))
        .toMatchObject({ ok: true, changed: false, skippedReason: "refresh-only" });
      expect(readFileSync(external, "utf8")).toBe(before); expect(readFileSync(path, "utf8")).toBe(before);
    });
  }

  for (const target of ["profile", "backup", "metadata", "library"] as const) {
    test(`Desktop symlinked ${target} refuses with the target untouched`, () => {
      const applied = seed(); const before = snapshot();
      const linked = target === "profile" ? applied.path : target === "backup" ? `${applied.path}.bak`
        : target === "metadata" ? join(library, "_meta.json") : library;
      const external = join(root, `desktop-target-${target}`);
      if (target === "library") renameSync(library, external);
      else {
        writeFileSync(external, target === "metadata" ? readFileSync(linked) : readFileSync(applied.path));
        if (existsSync(linked)) unlinkSync(linked);
      }
      symlinkSync(external, linked);
      const result = writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
        undefined, { lockPath: join(root, "locks", "desktop.sqlite") },
        { appliedFingerprint: applied.fingerprint!, admit: () => true });
      expect(result.reason).toBe("desktop_refresh_only_skipped");
      if (target === "backup") {
        expect(readFileSync(external, "utf8")).toBe(readFileSync(applied.path, "utf8"));
      } else expect(snapshot()).toEqual(before);
    });
  }

  test("Desktop rejects a non-regular selected profile", () => {
    const applied = seed(); unlinkSync(applied.path); mkdirSync(applied.path);
    const meta = readFileSync(join(library, "_meta.json"), "utf8");
    const result = writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
      undefined, { lockPath: join(root, "locks", "desktop.sqlite") },
      { appliedFingerprint: applied.fingerprint!, admit: () => true });
    expect(result.reason).toBe("desktop_refresh_only_skipped");
    expect(readFileSync(join(library, "_meta.json"), "utf8")).toBe(meta);
  });

  test("Desktop edit after inspection refuses before backup and replacement", () => {
    const applied = seed(); const edited = readFileSync(applied.path, "utf8") + " ";
    const meta = readFileSync(join(library, "_meta.json"), "utf8");
    const realRead = desktopLibrary.readDesktopProfileForeignKeys;
    const read = spyOn(desktopLibrary, "readDesktopProfileForeignKeys").mockImplementation(path => {
      const preserved = realRead(path); writeFileSync(path, edited); return preserved;
    });
    try {
      const result = writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
        undefined, { lockPath: join(root, "locks", "desktop.sqlite") },
        { appliedFingerprint: applied.fingerprint!, admit: () => true });
      expect(read).toHaveBeenCalled(); expect(result.reason).toBe("desktop_refresh_only_skipped");
      expect(readFileSync(applied.path, "utf8")).toBe(edited); expect(existsSync(`${applied.path}.bak`)).toBe(false);
      expect(readFileSync(join(library, "_meta.json"), "utf8")).toBe(meta);
    } finally { read.mockRestore(); }
  });

  test("Desktop refresh preserves exact metadata bytes and concurrent native selection", () => {
    const applied = seed(); const metaPath = join(library, "_meta.json");
    const customMeta = JSON.stringify(metadata()) + "  "; writeFileSync(metaPath, customMeta);
    const run = () => writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
      undefined, { lockPath: join(root, "locks", "desktop.sqlite") },
      { appliedFingerprint: config.claudeCode!.desktopProfile!.appliedFingerprint!, admit: () => true });
    const result = run(); expect(result.written).toBe(true); expect(result.fingerprint).toBeDefined();
    expect(readFileSync(metaPath, "utf8")).toBe(customMeta);
    config.claudeCode!.desktopProfile!.appliedFingerprint = result.fingerprint!; persist();
    const selectedElsewhere = JSON.stringify({ ...metadata(), appliedId: "native-choice" });
    const profileBefore = readFileSync(applied.path, "utf8");
    const backupPath = `${applied.path}.bak`;
    writeFileSync(backupPath, "original backup bytes");
    const backupBefore = readFileSync(backupPath, "utf8");
    const realRead = desktopLibrary.readDesktopProfileForeignKeys;
    const read = spyOn(desktopLibrary, "readDesktopProfileForeignKeys").mockImplementation(path => {
      const preserved = realRead(path); writeFileSync(metaPath, selectedElsewhere); return preserved;
    });
    try {
      expect(run().reason).toBe("desktop_refresh_only_skipped");
      expect(readFileSync(metaPath, "utf8")).toBe(selectedElsewhere);
      expect(readFileSync(applied.path, "utf8")).toBe(profileBefore);
      expect(readFileSync(backupPath, "utf8")).toBe(backupBefore);
    }
    finally { read.mockRestore(); }
  });
});


describe("refresh-only publication hook", () => {
  test("Desktop hardlinked backup and the other link stay untouched", () => {
    const applied = seed(); const backupPath = `${applied.path}.bak`;
    const other = join(root, "other-backup-link"); writeFileSync(other, "previous backup"); linkSync(other, backupPath);
    const result = writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
      undefined, { lockPath: join(root, "locks", "desktop.sqlite") },
      { appliedFingerprint: applied.fingerprint!, admit: () => true });
    expect(result.written).toBe(true); expect(readFileSync(other, "utf8")).toBe("previous backup");
    expect(readFileSync(backupPath, "utf8")).toBe("previous backup");
  });

  for (const drift of ["profile", "symlink", "selection", "ownership", "revoked"] as const) {
    test(`Desktop ${drift} after temp write refuses publication`, () => {
      const applied = seed(); const profileBefore = readFileSync(applied.path, "utf8");
      const backupPath = `${applied.path}.bak`; writeFileSync(backupPath, "old backup");
      const target = join(root, "profile-target"); writeFileSync(target, profileBefore);
      const realWrite = atomicWrites.atomicWriteFileNoFollow;
      let called = false;
      const write = spyOn(atomicWrites, "atomicWriteFileNoFollow").mockImplementation((path, content, io, hooks) => {
        called = true;
        return realWrite(path, content, io, { ...hooks, afterTempWrite: () => {
          if (drift === "profile") writeFileSync(path, profileBefore + " ");
          if (drift === "symlink") { unlinkSync(path); symlinkSync(target, path); }
          if (drift === "selection" || drift === "ownership") {
            const meta = metadata();
            if (drift === "selection") meta.appliedId = "native-choice";
            else meta.entries[0].name = "personal";
            writeFileSync(join(library, "_meta.json"), JSON.stringify(meta));
          }
          if (drift === "revoked") current = false;
        } });
      });
      try {
        const result = writeDesktop3pConfig(12345, [], models, "fixture-key", "static", config.claudeCode?.desktopProfile,
          undefined, { lockPath: join(root, "locks", "desktop.sqlite") },
          { appliedFingerprint: applied.fingerprint!, admit: () => current });
        expect(called).toBe(true); expect(result.reason).toBe("desktop_refresh_only_skipped");
        expect(readFileSync(applied.path, "utf8")).toBe(profileBefore + (drift === "profile" ? " " : ""));
        expect(readFileSync(target, "utf8")).toBe(profileBefore);
        expect(readFileSync(backupPath, "utf8")).toBe("old backup");
        expect(readdirSync(library).some(name => name.endsWith(".tmp"))).toBe(false);
      } finally { write.mockRestore(); }
    });
  }

  for (const drift of ["edit", "symlink", "revoked"] as const) {
    test(`Grok ${drift} after temp write refuses publication`, () => {
      const path = join(grokHome, "config.toml");
      injectGrokConfig(12345, [{ id: "old" }], { grokHome });
      const before = readFileSync(path, "utf8"); const edited = before + '# another process\n';
      const backupPath = `${path}.bak-opencodex`; const target = join(root, "grok-target");
      writeFileSync(backupPath, "old backup"); writeFileSync(target, before);
      const realWrite = atomicWrites.atomicWriteFileNoFollow;
      let called = false;
      const write = spyOn(atomicWrites, "atomicWriteFileNoFollow").mockImplementation((path, content, io, hooks) => {
        called = true;
        return realWrite(path, content, io, { ...hooks, afterTempWrite: () => {
          if (drift === "edit") writeFileSync(path, edited);
          if (drift === "symlink") { unlinkSync(path); symlinkSync(target, path); }
          if (drift === "revoked") current = false;
        } });
      });
      try {
        const result = injectGrokConfig(12345, [{ id: "new" }], { grokHome, refreshOnly: { admit: () => current } });
        expect(called).toBe(true);
        expect(result).toMatchObject({ ok: true, changed: false, skippedReason: "refresh-only" });
        expect(readFileSync(path, "utf8")).toBe(drift === "edit" ? edited : before);
        expect(readFileSync(target, "utf8")).toBe(before); expect(readFileSync(backupPath, "utf8")).toBe("old backup");
        expect(readdirSync(grokHome).some(name => name.endsWith(".tmp"))).toBe(false);
      } finally { write.mockRestore(); }
    });
  }
});
