import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegrationCoordinated } from "../../src/integrations/writer";
import { mutateAsideProfiles } from "../../src/integrations/aside-profiles";
import { loadExportModels, previewExportModels, resetExportSnapshotForTests } from "../../src/server/management/model-rows";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A coordinated write plans from its input, awaits the writer lock and a revalidation, and only
 * then serializes the document. Everything else it resolves is frozen before that await, and the
 * configuration was the one thing still held by reference: an edit landing in the window meant the
 * plan that authorized the write and the document it produced described different configurations.
 */
let home: string;
let store: IntegrationStateStore;
let priorOcxHome: string | undefined;
const TEST_ENV = {} as NodeJS.ProcessEnv;

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];

const CHECKED_HOST = "127.0.0.1";
const LATER_HOST = "127.0.0.2";

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-writer-frozen-config-"));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(join(base, "store", "integrations"));
  // A roster is admitted beside the configuration file, so these cases need their own
  // configuration home rather than whatever the machine running them happens to have.
  priorOcxHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = join(base, "config");
});

afterEach(() => {
  if (priorOcxHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorOcxHome;
  removeTreeWithRetry(dirname(home));
});

function installHermes(): string {
  const spec = INTEGRATION_CLIENTS.hermes;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

test("the configuration a coordinated write checked is the one it writes", async () => {
  const configPath = installHermes();
  const config = {
    port: 10100,
    hostname: CHECKED_HOST,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  } as unknown as OcxConfig;

  let edited = false;
  const result = await applyIntegrationCoordinated(
    { clientId: "hermes", models: MODELS, config, port: 10100, store, env: TEST_ENV, home },
    {
      revalidate: async () => {
        // The revalidation has just agreed that this write may proceed. A management route editing
        // the live configuration here is the whole hazard: it is after the check and before the
        // document exists.
        config.hostname = LATER_HOST;
        edited = true;
        return null;
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(edited).toBe(true);
  const written = readFileSync(configPath, "utf8");
  // The document describes the configuration the check passed on. Holding the caller's object
  // would have serialized the edit instead, with the plan still vouching for the other one. The
  // port form is asserted rather than the checked host itself because a loopback hostname is
  // normalized on the way into a client document, while the edited one would arrive verbatim.
  expect(written).toContain(":10100/v1");
  expect(written).not.toContain(LATER_HOST);
  // And the edit itself is untouched: freezing the input is not an excuse to write it back.
  expect(config.hostname).toBe(LATER_HOST);
});

/**
 * The same rule one layer up, where the window is wider.
 *
 * An Aside change checks its confirmation, then awaits the preference write, and only then builds
 * each profile's write input. The preference write edits the live configuration itself, so reading
 * that object again afterwards guaranteed the document came from a configuration the check never
 * saw, and anything else editing it during the await arrived the same way.
 */
test("the configuration an Aside change was checked against is the one written", async () => {
  mkdirSync(join(home, ".aside", "u", "0"), { recursive: true });
  writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({
    currentAccountId: 0, accounts: [{ id: 0, name: "Primary" }],
  }));
  const profilePath = join(home, ".aside", "u", "0", "models.json");
  writeFileSync(profilePath, JSON.stringify({ theme: "keep", providers: { personal: { models: [] } } }));

  const config = {
    port: 10100,
    hostname: CHECKED_HOST,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  } as unknown as OcxConfig;

  let checked = false;
  const result = await mutateAsideProfiles(
    {
      config, models: MODELS, port: 10100, env: {} as NodeJS.ProcessEnv, home, store,
      persistConfig: async () => {
        // Both hosts are loopback, so neither is rewritten on the way into a client document and
        // the one that appears is the one the write actually read.
        config.hostname = LATER_HOST;
        // A real suspension, so the profile write below genuinely resumes after this edit rather
        // than being ordered ahead of it by chance.
        await Promise.resolve();
      },
    },
    { profileId: 0, enabled: true },
    {
      revalidate: async () => {
        checked = true;
        return null;
      },
    },
  );

  expect(checked).toBe(true);
  expect(result.ok).toBe(true);
  const written = readFileSync(profilePath, "utf8");
  expect(written).toContain(":10100/v1");
  expect(written).not.toContain(LATER_HOST);
  // The preference write is a real effect on the live configuration and stays one.
  expect(config.hostname).toBe(LATER_HOST);
});

/**
 * The roster is the other half of the same input.
 *
 * A caller passes model objects it still owns, and the plan that authorizes the write is computed
 * from them before the lock. Spreading the input carried those objects by reference, so an edit
 * made after the check was serialized into the document the check had vouched for.
 */
test("the roster a coordinated write checked is the one it writes", async () => {
  const configPath = installHermes();
  const config = {
    port: 10100,
    hostname: CHECKED_HOST,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  } as unknown as OcxConfig;
  const models: ExportModel[] = [
    { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
  ];

  const result = await applyIntegrationCoordinated(
    { clientId: "hermes", models, config, port: 10100, store, env: TEST_ENV, home },
    {
      revalidate: async () => {
        models[0]!.id = "edited-after-the-check";
        models[0]!.namespaced = "anthropic/edited-after-the-check";
        return null;
      },
    },
  );

  expect(result.ok).toBe(true);
  const written = readFileSync(configPath, "utf8");
  expect(written).toContain("claude-opus-4-8");
  expect(written).not.toContain("edited-after-the-check");
});

/**
 * What happens when the input cannot be held still at all.
 *
 * An accessor is not read here, so there is no copy to check a plan against and no way to promise
 * the document matches it. The write is refused before anything is touched, which is bounded and
 * honest; returning the caller's object and calling it frozen would have been neither.
 */
test("an input that cannot be copied refuses the write instead of reading it twice", async () => {
  const configPath = installHermes();
  let reads = 0;
  const config = {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  } as unknown as OcxConfig;
  Object.defineProperty(config, "hostname", {
    configurable: true,
    enumerable: true,
    get: () => { reads += 1; return CHECKED_HOST; },
  });

  let checked = false;
  const result = await applyIntegrationCoordinated(
    { clientId: "hermes", models: MODELS, config, port: 10100, store, env: TEST_ENV, home },
    { revalidate: async () => { checked = true; return null; } },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("an uncopyable input must not be written");
  expect(result.reason).toBe("unsafe");
  // Refused before the plan, the lock and the document: nothing ran and nothing was read.
  expect(checked).toBe(false);
  expect(reads).toBe(0);
  expect(existsSync(configPath)).toBe(false);
});

/**
 * A committed change must not take the roster away from the change after it.
 *
 * The Aside commit reloads the roster while holding the configuration its preference write just
 * edited. If that load cannot admit what it is holding it clears the retained roster, and the next
 * confirmation is answered with "no roster is cached yet" rather than a comparison. That is the
 * difference between a refusal an operator can act on and one they cannot.
 */
test("an Aside change leaves the roster available for the confirmation after it", async () => {
  mkdirSync(join(home, ".aside", "u", "0"), { recursive: true });
  writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({
    currentAccountId: 0, accounts: [{ id: 0, name: "Primary" }],
  }));
  const profilePath = join(home, ".aside", "u", "0", "models.json");
  writeFileSync(profilePath, JSON.stringify({ theme: "keep", providers: { personal: { models: [] } } }));

  const config = {
    port: 10100,
    hostname: CHECKED_HOST,
    defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["one", "two"] } },
  } as unknown as OcxConfig;

  resetExportSnapshotForTests();
  await loadExportModels(config, []);
  expect(previewExportModels(config)).not.toBeNull();

  const result = await mutateAsideProfiles(
    {
      config, models: () => loadExportModels(config), port: 10100, env: {} as NodeJS.ProcessEnv, home, store,
      persistConfig: () => {},
    },
    { profileId: 0, enabled: true },
  );

  expect(result.ok).toBe(true);
  // The commit's own reload is an ordinary authoritative load: it happens while the configuration
  // carries the preference this action just wrote, and it has to be able to admit that.
  expect(previewExportModels(config)).not.toBeNull();
});
