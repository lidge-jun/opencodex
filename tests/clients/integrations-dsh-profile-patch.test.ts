import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DSH_PROFILE_PROVIDER_PATH, type ExportModel } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { defaultIntegrationIO } from "../../src/integrations/config-io";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { readIntegrationState, readPath } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegration,
  applyIntegrationCoordinated,
  disableIntegration,
  disableIntegrationCoordinated,
  refreshIntegration,
  restoreIntegrationCoordinated,
  overwriteIntegration,
  type IntegrationWriteInput,
} from "../../src/integrations/writer";
import { IntegrationWriterLockBusyError, IntegrationWriterLockIOError, type IntegrationWriterLockSeams } from "../../src/integrations/writer-lock";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * DSH 0.1.7+ reads provider routes from the Desktop profile's patch, a YAML
 * list of loader rows, and imports `$DSH_HOME/settings.yaml` only once. These
 * pin that the integration writes the row DSH reads and leaves every other
 * byte of a file DSH keeps rewriting itself: its header, its `!!js` rows, and
 * the user's own providers in the same row.
 */
let home: string;
let store: IntegrationStateStore;

const TEST_ENV = {} as NodeJS.ProcessEnv;
const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];
const MORE_MODELS: ExportModel[] = [
  ...MODELS,
  { namespaced: "xai/grok-4-2", provider: "xai", id: "grok-4-2", contextWindow: 256_000 },
];
const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as unknown as OcxConfig;

/** What DSH writes into a profile it has just created. */
const TEMPLATE = [
  "# Your patch layer for this dsh profile, applied after every bundle layer:",
  "# a top-level YAML array of loader patch entries (id-targeted config",
  "# overrides, disables, and insert lists; `!!js` expressions allowed).",
  "[]",
  "",
].join("\n");

const LIVED_IN = [
  "# Your patch layer for this dsh profile.",
  "- id: session-persistence-jsonl",
  "  config:",
  "    root: !!js dshHomePath('sessions')",
  "- id: llm-pi-ai",
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  "  config:",
  "    providers:",
  "      mine: # kept by hand",
  "        api: openai-completions",
  "        baseURL: http://127.0.0.1:9999/v1",
  "- id: ui-chat",
  "  config:",
  "    transcriptView: detailed",
  "",
].join("\n");

const spec = () => INTEGRATION_CLIENTS.dsh;
const storePath = () => spec().currentStore!.path(TEST_ENV, home);
const settingsPath = () => spec().configPath(TEST_ENV, home);
const readStore = () => readFileSync(storePath(), "utf8");
const parsedStore = () => Bun.YAML.parse(readStore());

function installDesktop(contents: string): string {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function input(overrides: Partial<IntegrationWriteInput> = {}): IntegrationWriteInput {
  return { clientId: "dsh", models: MODELS, config: CONFIG, port: 10100, env: TEST_ENV, home, store, ...overrides };
}

// Observe actual filesystem locks at the mutation boundary, including undo.
function lockedInput(): IntegrationWriteInput {
  const io = defaultIntegrationIO(store);
  return input({ io: { ...io, writeText: (path, text) => {
    expect(existsSync(`${settingsPath()}.lock`)).toBe(true);
    if (path === storePath()) expect(existsSync(join(dirname(path), "package.json.lock"))).toBe(true);
    io.writeText(path, text);
  } } });
}

function realLocks(onAcquire?: (path: string) => void): IntegrationWriterLockSeams {
  return {
    writeFile: async (path, payload, options) => {
      onAcquire?.(path);
      await writeFile(path, payload, options);
    },
    removeFile: async path => { await rm(path); },
    now: () => 0, delay: async () => {}, pid: 4242,
  };
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-dsh-profile-"));
  home = join(base, "home");
  mkdirSync(join(home, ".dsh"), { recursive: true });
  store = createIntegrationStateStore(join(base, "store", "integrations"));
});

afterEach(() => {
  removeTreeWithRetry(dirname(home));
});

describe("DSH Desktop profile patch", () => {
  test("enable replaces the empty `[]` with our row and keeps DSH's header", () => {
    const path = installDesktop(TEMPLATE);

    expect(applyIntegration(input()).ok).toBe(true);

    const text = readStore();
    expect(text.startsWith(TEMPLATE.slice(0, TEMPLATE.indexOf("[]")))).toBe(true);
    expect(text).toContain("- id: llm-pi-ai\n  config:\n    providers:\n      opencodex:\n");
    expect(readPath(parsedStore(), [...DSH_PROFILE_PROVIDER_PATH, "api"])).toBe("openai-responses");
    // The file DSH stopped reading is not where the provider went.
    expect(existsSync(settingsPath())).toBe(false);
    expect(store.readRecords().dsh?.configPath).toBe(path);
    expect(readIntegrationState(input())).toMatchObject({ state: "current", configPath: path });
  });

  test("enable joins the user's own llm-pi-ai row without touching any other byte", () => {
    installDesktop(LIVED_IN);

    expect(applyIntegration(input()).ok).toBe(true);

    const text = readStore();
    const ours = text.indexOf("      opencodex:");
    expect(ours).toBeGreaterThan(0);
    // Everything before our block and everything after it is what the user had.
    expect(text.slice(0, ours)).toBe(LIVED_IN.slice(0, LIVED_IN.indexOf("- id: ui-chat")));
    expect(text.endsWith("- id: ui-chat\n  config:\n    transcriptView: detailed\n")).toBe(true);
    const providers = readPath(parsedStore(), ["[id=llm-pi-ai]", "config", "providers"]) as Record<string, unknown>;
    expect(Object.keys(providers)).toEqual(["mine", "opencodex"]);
  });

  test("a refresh rewrites only our provider, after DSH added a row of its own", () => {
    installDesktop(LIVED_IN);
    expect(applyIntegration(input()).ok).toBe(true);
    // DSH's settings form appends a row while we are not looking.
    writeFileSync(storePath(), `${readStore()}- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-08-13.1\n`);

    expect(refreshIntegration(input({ models: MORE_MODELS })).ok).toBe(true);

    const models = readPath(parsedStore(), [...DSH_PROFILE_PROVIDER_PATH, "models"]) as Array<{ id: string }>;
    expect(models.map(model => model.id)).toEqual(MORE_MODELS.map(model => model.namespaced));
    expect(readStore()).toContain("    root: !!js dshHomePath('sessions')\n");
    expect(readStore().endsWith("    welcomeNoticeVersion: 2026-08-13.1\n")).toBe(true);
  });

  for (const initial of [TEMPLATE, "[]\n"]) {
    for (const position of ["before", "after"] as const) {
      test(`refresh keeps a created row's position with a user row ${position} (${initial === TEMPLATE ? "template" : "empty"})`, () => {
        installDesktop(initial);
        expect(applyIntegration(input()).ok).toBe(true);
        const created = store.readRecords().dsh!.createdContainers;
        const userRow = "# user's loader row\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-08-13.1 # keep this comment\n";
        const managed = readStore();
        const header = initial.slice(0, initial.indexOf("[]"));
        writeFileSync(storePath(), position === "after"
          ? managed + userRow : header + userRow + managed.slice(header.length));

        expect(refreshIntegration(input({ models: MORE_MODELS }))).toMatchObject({ ok: true, changed: true });
        expect((parsedStore() as Array<{ id: string }>).map(row => row.id)).toEqual(position === "after"
          ? ["llm-pi-ai", "ui-settings-general"] : ["ui-settings-general", "llm-pi-ai"]);
        expect(readPath(parsedStore(), [...DSH_PROFILE_PROVIDER_PATH, "models"])).toHaveLength(MORE_MODELS.length);
        expect(readStore()).toContain(userRow);
        expect(store.readRecords().dsh!.createdContainers).toEqual(created);
        // A second refresh must not forget who originally created the row.
        expect(refreshIntegration(input({ port: 10101 }))).toMatchObject({ ok: true, changed: true });
        expect(disableIntegration(input()).ok).toBe(true);
        expect(readStore()).toBe(header + userRow);
      });
    }
  }

  test("explicit overwrite also keeps a created row before a later user row", () => {
    installDesktop(TEMPLATE);
    expect(applyIntegration(input()).ok).toBe(true);
    const later = "- id: ui-chat\n  config:\n    transcriptView: detailed # keep\n";
    writeFileSync(storePath(), readStore().replace("openai-responses", "openai-completions") + later);
    expect(overwriteIntegration(input({ models: MORE_MODELS }))).toMatchObject({ ok: true, changed: true });
    expect((parsedStore() as Array<{ id: string }>).map(row => row.id)).toEqual(["llm-pi-ai", "ui-chat"]);
    expect(disableIntegration(input()).ok).toBe(true);
    expect(readStore()).toBe(TEMPLATE.slice(0, TEMPLATE.indexOf("[]")) + later);
  });

  test("disable gives back the exact file it was enabled on", () => {
    installDesktop(TEMPLATE);
    expect(applyIntegration(input()).ok).toBe(true);
    expect(disableIntegration(input()).ok).toBe(true);
    expect(readStore()).toBe(TEMPLATE);

    installDesktop(LIVED_IN);
    expect(applyIntegration(input()).ok).toBe(true);
    expect(disableIntegration(input()).ok).toBe(true);
    expect(readStore()).toBe(LIVED_IN);
  });

  for (const original of ["[]", "[]\r\n", "# header\r\n[]", TEMPLATE.replaceAll("\n", "\r\n"), LIVED_IN.trimEnd(), LIVED_IN.replaceAll("\n", "\r\n")]) {
    test(`disable preserves final newline and line endings (${JSON.stringify(original.slice(-12))})`, () => {
      installDesktop(original);
      expect(applyIntegration(input()).ok).toBe(true);
      expect(disableIntegration(input()).ok).toBe(true);
      expect(readStore()).toBe(original);
    });
  }

  test("disable keeps a row we created once the user put something of theirs in it", () => {
    installDesktop(TEMPLATE);
    expect(applyIntegration(input()).ok).toBe(true);
    writeFileSync(storePath(), readStore().replace("  config:\n", "  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n"));

    expect(disableIntegration(input()).ok).toBe(true);

    expect(parsedStore()).toEqual([{ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" }]);
  });

  test("a Desktop profile whose patch is missing is reported, never written to the settings file", () => {
    // DSH manages the profile (its manifest exists) and renames settings.yaml to .imported on
    // startup, so a write there would orphan the ownership record: refuse with the remedy.
    mkdirSync(dirname(storePath()), { recursive: true });
    writeFileSync(join(dirname(storePath()), "package.json"), "{}\n");

    const status = readIntegrationState(input());
    expect(status.supersededBy).toBe(storePath());
    expect(status.supersededReason).toBe("missing-store");
    expect(status.missingStoreDocument).toBe("[]");
    // The preview carries the same structured remedy, so the dashboard can name what to create
    // in its own language instead of only the generic superseded-store refusal.
    expect(previewIntegration(input(), { operation: "apply" })).toMatchObject({
      canApply: false,
      refusalReason: "superseded_store",
      supersededReason: "missing-store",
      missingStoreDocument: "[]",
    });
    const applied = applyIntegration(input());
    expect(applied.ok).toBe(false);
    if (!applied.ok) {
      expect(applied.reason).toBe("superseded_store");
      expect(applied.message).toContain("does not exist");
      expect(applied.message).toContain("`[]`");
    }
    expect(existsSync(settingsPath())).toBe(false);
    expect(existsSync(storePath())).toBe(false);
    expect(store.readRecords().dsh).toBeUndefined();

    // Once the patch is back, enable writes the row DSH reads.
    installDesktop("[]\n");
    expect(applyIntegration(input()).ok).toBe(true);
    expect(readPath(parsedStore(), [...DSH_PROFILE_PROVIDER_PATH, "api"])).toBe("openai-responses");
  });

  test("the declared empty patch is the document the remedy text names", () => {
    const missing = spec().currentStore?.missingStore;
    expect(missing?.emptyDocument).toBe("[]");
    expect(missing?.remedy).toContain(`\`${missing?.emptyDocument}\``);
  });

  test("without a Desktop profile the legacy settings file is still the target", () => {
    expect(applyIntegration(input()).ok).toBe(true);
    expect(existsSync(settingsPath())).toBe(true);
    expect(existsSync(storePath())).toBe(false);
  });

  test("a profile patch that is not a list of rows is reported, never merged into", () => {
    installDesktop("llm-pi-ai:\n  providers: {}\n");

    const status = readIntegrationState(input());

    expect(status.supersededBy).toBe(storePath());
    expect(readStore()).toBe("llm-pi-ai:\n  providers: {}\n");
  });

  test("two llm-pi-ai rows are ambiguous, so nothing is written", () => {
    const twice = `${LIVED_IN}- id: llm-pi-ai\n  config:\n    providers: {}\n`;
    installDesktop(twice);

    expect(applyIntegration(input()).ok).toBe(false);
    expect(readStore()).toBe(twice);
  });

  test("a coordinated write holds DSH's profile lock as well as the settings lock", async () => {
    installDesktop(TEMPLATE);
    const locks: string[] = [];
    const seams: IntegrationWriterLockSeams = {
      writeFile: async path => { locks.push(path); },
      removeFile: async () => {},
      now: () => 0,
      delay: async () => {},
      pid: 4242,
    };

    expect((await applyIntegrationCoordinated(input(), { lockSeams: seams })).ok).toBe(true);

    expect(locks).toEqual([`${settingsPath()}.lock`, join(dirname(storePath()), "package.json.lock")]);
  });

  test("a profile appearing during settings-lock acquisition is locked before mutation", async () => {
    const acquired: string[] = [];
    const seams = realLocks(path => {
      acquired.push(path);
      if (path === `${settingsPath()}.lock`) installDesktop(TEMPLATE);
      else {
        expect(existsSync(`${settingsPath()}.lock`)).toBe(true);
        expect(readStore()).toBe(TEMPLATE);
      }
    });
    expect((await applyIntegrationCoordinated(lockedInput(), { lockSeams: seams })).ok).toBe(true);
    expect(acquired).toEqual([`${settingsPath()}.lock`, join(dirname(storePath()), "package.json.lock")]);
    expect(store.readRecords().dsh!.configPath).toBe(storePath());
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("a profile appearing during revalidation is locked and revalidated again", async () => {
    let validations = 0;
    const options = {
      lockSeams: realLocks(),
      revalidate: async () => {
        validations += 1;
        expect(existsSync(`${settingsPath()}.lock`)).toBe(true);
        if (validations === 1) installDesktop(TEMPLATE);
        else expect(existsSync(join(dirname(storePath()), "package.json.lock"))).toBe(true);
        expect(readStore()).toBe(TEMPLATE);
        return null;
      },
    };
    expect((await applyIntegrationCoordinated(lockedInput(), options)).ok).toBe(true);
    expect(validations).toBe(2);
    expect(store.readRecords().dsh!.configPath).toBe(storePath());
  });

  test("revalidation can refuse the newly locked profile without writing it", async () => {
    let validations = 0;
    const result = await applyIntegrationCoordinated(lockedInput(), {
      lockSeams: realLocks(),
      revalidate: async () => {
        if (++validations === 1) { installDesktop(TEMPLATE); return null; }
        expect(existsSync(join(dirname(storePath()), "package.json.lock"))).toBe(true);
        return { ok: false, clientId: "dsh", reason: "conflict", state: "conflict", message: "plan changed" };
      },
    });
    expect(result).toMatchObject({ ok: false, message: "plan changed" });
    expect(readStore()).toBe(TEMPLATE);
    expect(store.readRecords().dsh).toBeUndefined();
    expect(existsSync(`${settingsPath()}.lock`)).toBe(false);
    expect(existsSync(join(dirname(storePath()), "package.json.lock"))).toBe(false);
  });

  for (const code of ["EACCES", "EEXIST"]) {
    test(`nested profile-lock acquisition failure (${code}) releases the settings lock`, async () => {
      installDesktop(TEMPLATE);
      const profileLock = join(dirname(storePath()), "package.json.lock");
      if (code === "EEXIST") writeFileSync(profileLock, "another writer\n");
      let now = 0;
      const seams = realLocks(path => {
        if (path === profileLock) {
          expect(existsSync(`${settingsPath()}.lock`)).toBe(true);
          expect(readStore()).toBe(TEMPLATE);
          throw Object.assign(new Error("lock denied"), { code });
        }
      });
      seams.now = () => now;
      seams.delay = async milliseconds => { now += milliseconds; };
      await expect(applyIntegrationCoordinated(lockedInput(), { lockSeams: seams })).rejects.toBeInstanceOf(
        code === "EEXIST" ? IntegrationWriterLockBusyError : IntegrationWriterLockIOError,
      );
      expect(existsSync(`${settingsPath()}.lock`)).toBe(false);
      expect(readStore()).toBe(TEMPLATE);
      expect(store.readRecords().dsh).toBeUndefined();
      if (code === "EEXIST") expect(readFileSync(profileLock, "utf8")).toBe("another writer\n");
    });
  }

  test("restore refuses a removed profile directory in preview and mutation", async () => {
    installDesktop(TEMPLATE);
    const options = { lockSeams: realLocks() };
    expect((await applyIntegrationCoordinated(lockedInput(), options)).ok).toBe(true);
    const disabled = await disableIntegrationCoordinated(lockedInput(), options);
    if (!disabled.ok || !disabled.opId) throw new Error("missing disable operation");
    const profileDir = dirname(storePath());
    removeTreeWithRetry(profileDir);
    expect(existsSync(spec().detectDir(TEST_ENV, home))).toBe(true);
    const operations = store.listOperations("dsh").length;
    const request = { operation: "restore", opId: disabled.opId, confirmDrift: true } as const;
    expect(previewIntegration(input(), request)).toMatchObject({
      canApply: false, refusalReason: "unsafe", state: "unsafe",
    });
    expect(existsSync(profileDir)).toBe(false);
    for (const revalidate of [undefined, async () => null]) {
      const restored = await restoreIntegrationCoordinated({ ...input(), ...request }, { ...options, revalidate });
      expect(restored).toMatchObject({ ok: false, reason: "unsafe", state: "unsafe" });
      if (!restored.ok) expect(restored.message).toContain("store directory is missing; restore will not create it");
      expect(existsSync(profileDir)).toBe(false);
      expect(existsSync(`${settingsPath()}.lock`)).toBe(false);
      expect(store.listOperations("dsh")).toHaveLength(operations);
      expect(store.readRecords().dsh).toBeUndefined();
    }
  });

  test("disable and restore both hold the profile lock through their writes", async () => {
    installDesktop(TEMPLATE);
    const options = { lockSeams: realLocks() };
    expect((await applyIntegrationCoordinated(lockedInput(), options)).ok).toBe(true);
    const managed = readStore();
    const disabled = await disableIntegrationCoordinated(lockedInput(), options);
    expect(disabled).toMatchObject({ ok: true, changed: true });
    if (!disabled.ok || !disabled.opId) throw new Error("missing disable operation");
    expect(readStore()).toBe(TEMPLATE);
    expect((await restoreIntegrationCoordinated({ ...lockedInput(), opId: disabled.opId }, options)).ok).toBe(true);
    expect(readStore()).toBe(managed);
    expect(existsSync(`${settingsPath()}.lock`)).toBe(false);
    expect(existsSync(join(dirname(storePath()), "package.json.lock"))).toBe(false);
  });
});
