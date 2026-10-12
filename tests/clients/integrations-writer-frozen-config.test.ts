import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegrationCoordinated } from "../../src/integrations/writer";
import { mutateAsideProfiles, previewAsideProfile } from "../../src/integrations/aside-profiles";
import { previewIntegration } from "../../src/integrations/mutation-plan";
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
 * What a committed Aside change does to the retained roster, stated rather than assumed.
 *
 * The change writes the operator's Aside preference into the configuration, so the configuration a
 * roster was admitted under is no longer the one in hand and the roster is retired. The next bound
 * confirmation is answered with "no roster is cached yet" until an ordinary load runs, which is
 * what the Integrations collection read does. This is not new behaviour introduced by binding the
 * roster to the configuration object: persisting the preference rewrites the configuration file,
 * and a roster has always been retired when that file moves.
 */
test("a committed Aside change retires the roster, and an ordinary load brings it back", async () => {
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
      // A bound confirmation hands the mutation the roster the guard used, exactly as the route
      // does, so nothing reloads it in the middle of the change.
      config, models: MODELS, port: 10100, env: {} as NodeJS.ProcessEnv, home, store,
      persistConfig: () => {},
    },
    { profileId: 0, enabled: true },
  );

  expect(result.ok).toBe(true);
  // The preference is now part of the configuration, and the roster was admitted without it.
  expect(config.asideProfileSync).toBeDefined();
  expect(previewExportModels(config)).toBeNull();

  // Recovery is the ordinary flow rather than a special step.
  await loadExportModels(config, []);
  expect(previewExportModels(config)).not.toBeNull();
});

function seedAsideProfile(): string {
  mkdirSync(join(home, ".aside", "u", "0"), { recursive: true });
  writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({
    currentAccountId: 0, accounts: [{ id: 0, name: "Primary" }],
  }));
  const profilePath = join(home, ".aside", "u", "0", "models.json");
  writeFileSync(profilePath, JSON.stringify({ theme: "keep", providers: { personal: { models: [] } } }));
  return profilePath;
}

function asideFixtureConfig(hostname: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "fixture",
    providers: { fixture: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1", liveModels: false, models: ["one", "two"] } },
  } as unknown as OcxConfig;
}

/**
 * The check has to be about the input that will be written, not about whatever the live
 * configuration says at the moment it runs.
 *
 * A configuration can be edited to something else and back again while an action is in flight. A
 * check that rebuilt its own view from the live object would then plan the configuration the
 * operator confirmed, agree with the confirmation, and let the write proceed from the copy the
 * action actually holds, which is the other one.
 */
test("the Aside check plans the prepared input, not the configuration that is live when it runs", async () => {
  const profilePath = seedAsideProfile();
  const before = readFileSync(profilePath, "utf8");
  const config = asideFixtureConfig(CHECKED_HOST);
  const asideInput = { config, models: MODELS, port: 10100, env: {} as NodeJS.ProcessEnv, home, store, persistConfig: () => {} };

  // A: what the operator confirmed.
  const confirmed = await previewAsideProfile(asideInput, { profileId: 0, operation: "apply" });
  expect(confirmed.canApply).toBe(true);

  // B: what the action will hold, because the context copies the configuration when it is created.
  config.hostname = LATER_HOST;

  const checked: string[] = [];
  const result = await mutateAsideProfiles(
    asideInput,
    { profileId: 0, enabled: true },
    {
      revalidate: async prepared => {
        // Live is A again by the time the check runs. Only the prepared input still says B.
        config.hostname = CHECKED_HOST;
        const plan = previewIntegration(prepared, { profileId: 0, operation: "apply" });
        checked.push(plan.fingerprint);
        return plan.fingerprint === confirmed.fingerprint ? null : {
          ok: false, reason: "conflict", state: plan.state, clientId: "aside",
          message: "that confirmation no longer describes this profile", profileId: 0,
        };
      },
    },
  );

  expect(checked).toHaveLength(1);
  expect(checked[0]).not.toBe(confirmed.fingerprint);
  expect(result.ok).toBe(false);
  // Refused before the preference write and before any client write.
  expect(config.asideProfileSync).toBeUndefined();
  expect(readFileSync(profilePath, "utf8")).toBe(before);
});

/**
 * The roster is resolved and copied once, before the check.
 *
 * It used to be resolved lazily at each profile write, which happens after the preference write. A
 * caller still holding those model objects could edit them in that window, and the document
 * carried the edit while the plan vouched for what it read earlier.
 */
test("a roster edited during the preference write is not the roster written", async () => {
  const profilePath = seedAsideProfile();
  const config = asideFixtureConfig(CHECKED_HOST);
  const models: ExportModel[] = [
    { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
  ];

  const result = await mutateAsideProfiles(
    {
      config, models, port: 10100, env: {} as NodeJS.ProcessEnv, home, store,
      persistConfig: () => {
        models[0]!.id = "edited-during-the-preference-write";
        models[0]!.namespaced = "anthropic/edited-during-the-preference-write";
      },
    },
    { profileId: 0, enabled: true },
    // A confirmed change, which is what brings the roster forward: the check has to read the same
    // rows the write will use. An unconfirmed change resolves them later, because a preference
    // write that fails must not have done model work by then.
    { revalidate: async () => null },
  );

  expect(result.ok).toBe(true);
  const written = readFileSync(profilePath, "utf8");
  expect(written).toContain("claude-opus-4-8");
  expect(written).not.toContain("edited-during-the-preference-write");
});

/**
 * A confirmation describes one profile.
 *
 * HTTP refuses a bound change that names none, and this refuses it too. Guessing which prepared
 * input such a confirmation meant would be inventing the thing the check exists to verify.
 */
test("a confirmed change that names no profile is refused rather than guessed", async () => {
  const profilePath = seedAsideProfile();
  const before = readFileSync(profilePath, "utf8");
  const config = asideFixtureConfig(CHECKED_HOST);

  let checked = false;
  let loads = 0;
  await expect(mutateAsideProfiles(
    {
      config,
      // A loader, not an array: resolving the roster is real work that reaches providers and can
      // finalize an initial model selection, and a confirmation this cannot check must not cause
      // it. An inert array would hide that.
      models: async () => { loads += 1; return MODELS; },
      port: 10100, env: {} as NodeJS.ProcessEnv, home, store, persistConfig: () => {},
    },
    { enabled: true },
    { revalidate: async () => { checked = true; return null; } },
  )).rejects.toThrow(/one profile/);

  expect(checked).toBe(false);
  expect(loads).toBe(0);
  expect(config.asideProfileSync).toBeUndefined();
  expect(readFileSync(profilePath, "utf8")).toBe(before);
});
