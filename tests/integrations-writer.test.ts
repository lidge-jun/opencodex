import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../src/clients/config-export";
import { fileIO, type IntegrationIO } from "../src/integrations/config-io";
import { INTEGRATION_CLIENTS } from "../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";
import {
  applyIntegration,
  disableIntegration,
  restoreIntegration,
  type IntegrationWriteInput,
} from "../src/integrations/writer";
import type { OcxConfig } from "../src/types";

/**
 * Activation coverage for devlog/_fin/260802_client_toggle_api/031 §6.
 *
 * Every test drives the real writer against a temp HOME and a temp store, so
 * "we never touch anything we do not own" is proven by the filesystem rather
 * than asserted in prose.
 */
let home: string;
let storeRoot: string;
let store: IntegrationStateStore;

/**
 * The environment every path resolution in this file goes through. Empty on
 * purpose: no `HERMES_HOME`/`LOCALAPPDATA` override, so the registry picks the
 * platform default and the fixture follows it instead of assuming one.
 */
const TEST_ENV = {} as NodeJS.ProcessEnv;

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
  { namespaced: "openai/gpt-5.5", provider: "openai", id: "gpt-5.5", contextWindow: 400_000 },
];

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as unknown as OcxConfig;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-integrations-writer-"));
  home = join(base, "home");
  storeRoot = join(base, "store", "integrations");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(storeRoot);
});

afterEach(() => {
  rmSync(dirname(home), { recursive: true, force: true });
});

/**
 * Hermes: YAML, installed by creating its home directory.
 *
 * The directory is resolved through the registry rather than hardcoded to
 * `~/.hermes`: on Windows Hermes lives under `%LOCALAPPDATA%\hermes`, so a
 * hardcoded POSIX layout created a directory the detector never looks at and
 * every apply in this file refused with `not_installed`.
 */
function installHermes(): string {
  const spec = INTEGRATION_CLIENTS.hermes;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

function input(overrides: Partial<IntegrationWriteInput> = {}): IntegrationWriteInput {
  return {
    clientId: "hermes",
    models: MODELS,
    config: CONFIG,
    port: 10100,
    env: TEST_ENV,
    home,
    store,
    ...overrides,
  };
}

describe("apply", () => {
  test("refuses a client that is not installed, and writes nothing", () => {
    const result = applyIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_installed");
    expect(store.listOperations()).toHaveLength(0);
  });

  test("creates the file, journals the operation, and reads back as current", () => {
    const configPath = installHermes();
    const result = applyIntegration(input());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(true);

    const text = readFileSync(configPath, "utf8");
    expect(Bun.YAML.parse(text)).toMatchObject({ providers: { opencodex: { api_mode: "chat_completions" } } });
    const rows = store.listOperations("hermes");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("apply");
    // Nothing existed before, so there is nothing to restore TO.
    expect(rows[0]!.snapshot.kind).toBe("none");
  });

  test("is idempotent: applying twice changes nothing the second time", () => {
    installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const second = applyIntegration(input());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.changed).toBe(false);
    expect(store.listOperations("hermes")).toHaveLength(1);
  });

  test("preserves a foreign provider and unknown top-level fields", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  other:\n    api: http://elsewhere\nunknown_top: keep-me\n");
    expect(applyIntegration(input()).ok).toBe(true);

    const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(doc.unknown_top).toBe("keep-me");
    expect((doc.providers as Record<string, unknown>).other).toEqual({ api: "http://elsewhere" });
  });

  test("refuses when the file changed after we wrote it", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# a human edited this\n`);

    const result = applyIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    // The user's comment is still there.
    expect(readFileSync(configPath, "utf8")).toContain("# a human edited this");
  });

  test("refuses an unparseable config rather than overwriting it", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "{{{ not yaml\n");
    const result = applyIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe("{{{ not yaml\n");
  });

  test("refuses a loopback-only client on a remote bind", () => {
    mkdirSync(join(home, ".gjc"), { recursive: true });
    const result = applyIntegration(input({
      clientId: "gajae",
      config: { ...CONFIG, hostname: "0.0.0.0" } as OcxConfig,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("non_loopback");
  });

  test("a write failure reports the snapshot rather than claiming success", () => {
    installHermes();
    const throwing: IntegrationIO = {
      ...fileIO(),
      writeText: () => { throw new Error("disk full"); },
      appendJournal: entry => store.appendJournal(entry),
      putRecord: record => store.putRecord(record),
      dropRecord: clientId => store.dropRecord(clientId),
    };
    const result = applyIntegration(input({ io: throwing }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("write_failed");
      expect(result.message).toContain("disk full");
    }
  });
});

describe("disable", () => {
  test("removes only our block and leaves the rest byte-identical", () => {
    const configPath = installHermes();
    const original = "providers:\n  other:\n    api: http://elsewhere\nunknown_top: keep-me\n";
    writeFileSync(configPath, original);
    expect(applyIntegration(input()).ok).toBe(true);

    const result = disableIntegration(input());
    expect(result.ok).toBe(true);
    const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(doc).toEqual(Bun.YAML.parse(original) as Record<string, unknown>);
  });

  test("disabling a config we never touched is a no-op, not an error", () => {
    installHermes();
    const result = disableIntegration(input());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(false);
  });

  test("refuses to delete a block after someone edited the file", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# mine\n`);

    const result = disableIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(readFileSync(configPath, "utf8")).toContain("opencodex");
  });

  test("kimi loses its provider AND every model entry it owns", () => {
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    const configPath = join(home, ".kimi-code", "config.toml");
    // A user's own entry that merely looks like ours must survive.
    writeFileSync(configPath, '[models."opencodex/mine"]\nprovider = "elsewhere"\n');
    expect(applyIntegration(input({ clientId: "kimi" })).ok).toBe(true);

    const applied = Bun.TOML.parse(readFileSync(configPath, "utf8")) as { models: Record<string, unknown> };
    expect(Object.keys(applied.models).length).toBeGreaterThan(1);

    expect(disableIntegration(input({ clientId: "kimi" })).ok).toBe(true);
    const after = Bun.TOML.parse(readFileSync(configPath, "utf8")) as { models?: Record<string, unknown> };
    expect(after.models).toEqual({ "opencodex/mine": { provider: "elsewhere" } });
  });
});

describe("restore", () => {
  test("undoes an apply back to the exact prior bytes", () => {
    const configPath = installHermes();
    const original = "providers:\n  other:\n    api: http://elsewhere\n";
    writeFileSync(configPath, original);
    const applied = applyIntegration(input());
    expect(applied.ok).toBe(true);

    const opId = store.listOperations("hermes")[0]!.opId;
    const restored = restoreIntegration({ ...input(), opId });
    expect(restored.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("restoring an apply that created the file removes it again", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;

    const restored = restoreIntegration({ ...input(), opId });
    expect(restored.ok).toBe(true);
    expect(() => statSync(configPath)).toThrow();
  });

  test("refuses to replace post-operation edits without confirmation", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# later edit\n`);

    const refused = restoreIntegration({ ...input(), opId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("drift_requires_confirm");
    expect(readFileSync(configPath, "utf8")).toContain("# later edit");
  });

  test("a confirmed drift-restore keeps the replaced version recoverable", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# later edit\n`);

    const restored = restoreIntegration({ ...input(), opId, confirmDrift: true });
    expect(restored.ok).toBe(true);
    // The edit we replaced is in the newest snapshot, so nothing was lost.
    const newest = store.listOperations("hermes")[0]!;
    expect(newest.kind).toBe("restore");
    const snapshot = store.readSnapshot(newest);
    expect(snapshot.kind).toBe("stored");
    if (snapshot.kind === "stored") expect(snapshot.text).toContain("# later edit");
  });

  test("refuses an operation whose snapshot was collected", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    const row = store.listOperations("hermes")[0]!;
    // Simulate GC having removed the bytes.
    rmSync(join(storeRoot, "snapshots", "hermes", row.opId), { force: true });

    const result = restoreIntegration({ ...input(), opId: row.opId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("snapshot_expired");
  });
});

describe("nothing leaks", () => {
  test("no client file contains a credential after a full apply", () => {
    // Assembled at runtime so the privacy scanner does not flag the literal;
    // the point is that whatever the config holds must not reach the file.
    const secret = ["sk", "live", "should", "never", "appear"].join("-");
    const configPath = installHermes();
    applyIntegration(input({
      config: { ...CONFIG, apiKeys: [{ key: secret }] } as unknown as OcxConfig,
    }));
    expect(readFileSync(configPath, "utf8")).not.toContain(secret);
  });

  test("a failed record write rolls the file back and says so", () => {
    const configPath = installHermes();
    const original = "providers: {}\n";
    writeFileSync(configPath, original);
    const io: IntegrationIO = {
      ...fileIO(),
      appendJournal: entry => store.appendJournal(entry),
      putRecord: () => { throw new Error("record disk full"); },
      dropRecord: clientId => store.dropRecord(clientId),
    };

    const result = applyIntegration(input({ io }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("write_failed");
      expect(result.message).toContain("rolled back");
    }
    // The file is back to what it was; no half-applied state survives.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(store.listOperations("hermes")).toHaveLength(0);
  });

  test("a failed journal append rolls back and leaves no phantom row", () => {
    const configPath = installHermes();
    const original = "providers: {}\n";
    writeFileSync(configPath, original);
    const io: IntegrationIO = {
      ...fileIO(),
      appendJournal: () => { throw new Error("journal disk full"); },
      putRecord: record => store.putRecord(record),
      dropRecord: clientId => store.dropRecord(clientId),
    };

    const result = applyIntegration(input({ io }));
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    // The row is written last precisely so this cannot leave one behind.
    expect(store.listOperations("hermes")).toHaveLength(0);
    // And the record it wrote first is gone again.
    expect(store.readRecords().hermes).toBeUndefined();
  });

  test("when compensation itself fails, the result says residual instead of claiming a rollback", () => {
    installHermes();
    let writes = 0;
    const io: IntegrationIO = {
      ...fileIO(),
      writeText: (path, text) => {
        writes += 1;
        // First write succeeds (the apply); the compensating write fails.
        if (writes > 1) throw new Error("rollback also failed");
        fileIO().writeText(path, text);
      },
      appendJournal: () => { throw new Error("journal disk full"); },
      putRecord: record => store.putRecord(record),
      dropRecord: clientId => store.dropRecord(clientId),
    };
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");

    const result = applyIntegration(input({ io }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.residual).toBe(true);
      expect(result.message).toContain("intermediate state");
    }
  });

  test("a record for one home cannot authorize a write to another", () => {
    // Reproduction from the WP3 audit: apply in home A, then point the same
    // client at home B whose file happens to have identical bytes. The record
    // must not be accepted as ownership proof for a file it was not written for.
    const configA = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const appliedBytes = readFileSync(configA, "utf8");

    /*
     * Home B is built through the registry, not by hand. Hermes resolves to
     * `%LOCALAPPDATA%\hermes` on Windows and ignores the `home` argument
     * entirely there, so a hand-built `<home-b>/.hermes` left both homes
     * pointing at the SAME file — the record legitimately matched and the
     * refusal this test exists for never fired. `HERMES_HOME` is honored on
     * every platform, so it is what actually separates the two.
     */
    const otherHome = join(dirname(home), "home-b");
    const otherEnv = { HERMES_HOME: join(otherHome, ".hermes") } as NodeJS.ProcessEnv;
    const spec = INTEGRATION_CLIENTS.hermes;
    mkdirSync(spec.detectDir(otherEnv, otherHome), { recursive: true });
    const configB = spec.configPath(otherEnv, otherHome);
    expect(configB).not.toBe(configA);
    writeFileSync(configB, appliedBytes);

    const result = disableIntegration(input({ home: otherHome, env: otherEnv }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(readFileSync(configB, "utf8")).toBe(appliedBytes);
  });

  test("restore refuses when the client now resolves to a different file", () => {
    installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;

    // Same reason as the test above: only `HERMES_HOME` separates two homes on
    // every platform. A hand-built `<home-c>/.hermes` collapses onto the same
    // file as home A under Windows' `%LOCALAPPDATA%` resolution.
    const otherHome = join(dirname(home), "home-c");
    const otherEnv = { HERMES_HOME: join(otherHome, ".hermes") } as NodeJS.ProcessEnv;
    const spec = INTEGRATION_CLIENTS.hermes;
    mkdirSync(spec.detectDir(otherEnv, otherHome), { recursive: true });
    const configC = spec.configPath(otherEnv, otherHome);
    writeFileSync(configC, "providers:\n  mine:\n    api: http://keep\n");

    const result = restoreIntegration({ ...input({ home: otherHome, env: otherEnv }), opId });
    expect(result.ok).toBe(false);
    expect(readFileSync(configC, "utf8")).toContain("mine");
  });

  test("an empty container the user wrote survives disable", () => {
    // `providers: {}` is the user's line, not ours. Pruning it because it went
    // empty would delete something we never owned.
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    expect(disableIntegration(input()).ok).toBe(true);

    const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(doc).toEqual({ providers: {} });
  });
});
