import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DSH_PROFILE_PROVIDER_PATH, type ExportModel } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { readIntegrationState, readPath } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegration,
  applyIntegrationCoordinated,
  disableIntegration,
  refreshIntegration,
  type IntegrationWriteInput,
} from "../../src/integrations/writer";
import type { IntegrationWriterLockSeams } from "../../src/integrations/writer-lock";
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

  test("disable keeps a row we created once the user put something of theirs in it", () => {
    installDesktop(TEMPLATE);
    expect(applyIntegration(input()).ok).toBe(true);
    writeFileSync(storePath(), readStore().replace("  config:\n", "  name: '@deepseek-ai/dsh-llm-pi-ai'\n  config:\n"));

    expect(disableIntegration(input()).ok).toBe(true);

    expect(parsedStore()).toEqual([{ id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" }]);
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
});
