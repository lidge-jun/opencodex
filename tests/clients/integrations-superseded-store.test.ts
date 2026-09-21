import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClientPathError, type ExportModel } from "../../src/clients/config-export";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { resolveIntegrationTarget } from "../../src/integrations/target";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { readIntegrationState } from "../../src/integrations/state";
import {
  applyIntegration,
  disableIntegration,
  refreshIntegration,
  type IntegrationWriteInput,
} from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A write the client cannot read is refused, not reported (#5348).
 *
 * ZCode 3.14 moved its providers to a second file and kept the first one
 * reachable only through an import that runs once, on an install that has never
 * created the second. Everything the integration checks still passed: the file
 * was writable, the block merged, the journal recorded a correct apply. The
 * only wrong part was the report, so these cases are about what the operation
 * SAYS as much as what it writes.
 *
 * These are the cases where the store cannot be written: it holds no document
 * whose schema has been observed, or it is not there at all. Writing the store
 * is the sibling file; this one is what happens when that is impossible, which
 * is why the refusal has to stay correct rather than become dead code.
 *
 * Every path here comes from the registry resolvers rather than a literal, so a
 * change to where either file lives moves the fixture with the source instead
 * of leaving it green against a location nobody uses.
 */
let home: string;
let store: IntegrationStateStore;

const TEST_ENV = {} as NodeJS.ProcessEnv;

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as unknown as OcxConfig;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-superseded-store-"));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(join(base, "store", "integrations"));
});

afterEach(() => {
  removeTreeWithRetry(dirname(home));
});

const spec = () => INTEGRATION_CLIENTS.zcode;

/** Install the client: its detect directory and the parent of its config file. */
function installZcode(): string {
  mkdirSync(spec().detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec().configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

/** The file whose presence means the client stopped reading its config file. */
function storePath(env: NodeJS.ProcessEnv = TEST_ENV): string {
  return spec().currentStore!.path(env, home);
}

function createStore(contents = "{}\n"): string {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function input(overrides: Partial<IntegrationWriteInput> = {}): IntegrationWriteInput {
  return { clientId: "zcode", models: MODELS, config: CONFIG, port: 10100, env: TEST_ENV, home, store, ...overrides };
}

describe("a client that moved its provider store", () => {
  test("apply refuses instead of writing a file nothing reads", () => {
    const configPath = installZcode();
    const storeFile = createStore();

    const result = applyIntegration(input());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("superseded_store");
      // Both locations, because the user has to know which file to look at and
      // which one the client opens instead.
      expect(result.message).toContain(storeFile);
      expect(result.message).toContain(configPath);
    }
    // The point of the refusal: nothing was written, and nothing claims we own
    // anything here.
    expect(existsSync(configPath)).toBe(false);
    expect(Object.keys(store.readRecords())).not.toContain("zcode");
  });

  test("refresh refuses on the same evidence", () => {
    installZcode();
    createStore();
    const result = refreshIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("superseded_store");
  });

  test("the preview refuses before the operator confirms anything", () => {
    installZcode();
    createStore();
    const plan = previewIntegration(input(), { operation: "apply" });
    expect(plan.refusalReason).toBe("superseded_store");
    expect(plan.canApply).toBe(false);
    expect(plan.willChange).toBe(false);
  });

  test("an absent store leaves the existing write path alone", () => {
    const configPath = installZcode();
    expect(existsSync(storePath())).toBe(false);

    const result = applyIntegration(input());

    expect(result.ok).toBe(true);
    // A client that has never run still imports the file we write, which is why
    // the refusal is keyed on the store's presence and not on the client at all.
    expect(readFileSync(configPath, "utf8")).toContain("opencodex");
    expect(readIntegrationState(input())).toMatchObject({ state: "current" });
  });

  test("status reports the store beside a block that really is current", () => {
    installZcode();
    expect(applyIntegration(input()).ok).toBe(true);
    const storeFile = createStore();

    const status = readIntegrationState(input());

    // Both halves are true at once, and only the second one is new.
    expect(status.state).toBe("current");
    expect(status.supersededBy).toBe(storeFile);
  });

  test("disable still removes what we wrote before the client moved", () => {
    const configPath = installZcode();
    expect(applyIntegration(input()).ok).toBe(true);
    createStore();

    const result = disableIntegration(input());

    expect(result.ok).toBe(true);
    // Removing our own bytes from this file is as effective as it ever was, and
    // refusing it would leave the block unremovable through the tool.
    expect(readFileSync(configPath, "utf8")).not.toContain("opencodex");
    expect(readIntegrationState(input())).toMatchObject({ state: "absent" });
  });

  test("only a regular file counts as the store", () => {
    installZcode();
    // A directory at that path is not a provider list the client loaded, and
    // refusing over it would block an apply that would have worked.
    mkdirSync(storePath(), { recursive: true });
    const resolved = resolveIntegrationTarget({
      clientId: "zcode",
      configPath: spec().configPath(TEST_ENV, home),
      io: store.io(),
      record: null,
      env: TEST_ENV,
      home,
    });
    expect(resolved.ineffective).toBeNull();
    expect(resolved.configPath).toBe(spec().configPath(TEST_ENV, home));
    expect(applyIntegration(input()).ok).toBe(true);
  });

  test("a relative store override is refused rather than resolved against a guess", () => {
    installZcode();
    const env = { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "v2/provider_config.json" } as NodeJS.ProcessEnv;
    // The client resolves it against its own working directory; we cannot know
    // that one, and here the answer decides whether an apply is called effective.
    expect(() => storePath(env)).toThrow(ClientPathError);
    const result = applyIntegration(input({ env }));
    expect(result.ok).toBe(false);
  });

  test("an operator who relocated the store is measured against the file they moved it to", () => {
    installZcode();
    const relocated = join(home, "elsewhere", "provider_config.json");
    mkdirSync(dirname(relocated), { recursive: true });
    writeFileSync(relocated, "{}\n");
    const env = { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: relocated } as NodeJS.ProcessEnv;

    const result = applyIntegration(input({ env }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(relocated);
    // The default location is empty, so only the override could have produced this.
    expect(existsSync(spec().currentStore!.path(TEST_ENV, home))).toBe(false);
  });
});
