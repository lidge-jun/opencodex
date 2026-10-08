/**
 * Client-contract regression for the Command Code integration.
 *
 * The cases below were found by running the PUBLISHED consumer
 * (`command-code@1.66.0`) against our exported provider, not by reading our own
 * output. Each test carries the client-side expression it is proving, taken from
 * `dist/cli.mjs` of that release:
 *
 *   - root selection: `const o = e.provider ?? e.providers;`
 *   - home resolution: `homeDir15(e) => e.env().HOME ?? e.env().USERPROFILE`,
 *     then `${home}/.commandcode/providers.json`
 *   - credential form: a raw string is refused; a `$ENV` / `{env:VAR}` / `!command`
 *     reference, or `false` for a keyless endpoint, is accepted
 *
 * The parser is reproduced here as `publishedCommandCodeRoot`, not imported, so
 * the test states the contract explicitly and fails loudly if we ever contradict
 * it. `COMMANDCODE_HOME` does not appear anywhere in the shipped bundle
 * (`grep -c COMMANDCODE_HOME dist/cli.mjs` → 0), which is why the path resolver
 * takes no override.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildClientContribution,
  buildCommandCodeClientConfig,
  commandCodeConfigPath,
  commandCodeHomeDir,
  commandCodeProviderRoot,
  type ExportContext,
} from "../../src/clients/config-export";
import { setPath } from "../../src/integrations/merge";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { OPENCODE_PROVIDER_ID } from "../../src/clients/config-export/constants";
import { MANAGED_PATH_TEMPLATES } from "../../src/integrations/mutation-plan";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { readIntegrationState } from "../../src/integrations/state";
import {
  applyIntegration,
  disableIntegration,
  restoreIntegration,
  type IntegrationWriteInput,
} from "../../src/integrations/writer";

/** `const o = e.provider ?? e.providers;` — verbatim from command-code@1.66.0. */
function publishedCommandCodeRoot(document: unknown): Record<string, unknown> | undefined {
  const doc = document as { provider?: unknown; providers?: unknown } | null;
  const o = doc?.provider ?? doc?.providers;
  return typeof o === "object" && o !== null && !Array.isArray(o)
    ? (o as Record<string, unknown>)
    : undefined;
}

/** `isApiKeyReference` — a raw secret is not one. */
function publishedAcceptsApiKey(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value !== "string") return false;
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    || /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
    || value.startsWith("!");
}

const CONTEXT: ExportContext = {
  baseUrl: "http://127.0.0.1:10100/v1",
  models: [
    { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5", contextWindow: 200_000 },
    { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000 },
  ],
};

describe("Command Code client contract (published command-code@1.66.0)", () => {
  test("a plural-root target keeps its root, and the client still reads every provider", () => {
    // BEFORE: the user's own plural-root document.
    const before = {
      providers: {
        acme: { name: "Acme", api: "openai-completions", baseURL: "https://api.acme.test/v1", apiKey: "secret", models: { "acme/large": {} } },
      },
    };

    const contribution = buildClientContribution("commandcode", { ...CONTEXT, document: before });
    const after = contribution.fragments.reduce(
      (doc, fragment) => setPath(doc, fragment.path, fragment.value),
      before,
    );

    // The fragment landed under the root the target already used.
    expect(contribution.fragments).toHaveLength(1);
    expect(contribution.fragments[0]!.path).toEqual(["providers", OPENCODE_PROVIDER_ID]);

    // THE REGRESSION THIS GUARDS: the published client resolves
    // `document.provider ?? document.providers`. If we had written a singular root
    // into this document, `provider` would win and the user's `acme` provider would
    // still be on disk but invisible to the consumer.
    const resolved = publishedCommandCodeRoot(after);
    expect(resolved).toBeDefined();
    expect(Object.keys(resolved!).sort()).toEqual([OPENCODE_PROVIDER_ID, "acme"].sort());
    expect(resolved!.acme).toEqual(before.providers.acme);
    expect((resolved as Record<string, { models: Record<string, unknown> }>)[OPENCODE_PROVIDER_ID]!.models["openai/gpt-5.6-sol"]).toBeDefined();
  });

  test("a singular-root target keeps the singular root", () => {
    const before = { provider: { legacy: { name: "Legacy", api: "openai-completions", baseURL: "https://legacy.test/v1", apiKey: "secret", models: {} } } };
    const contribution = buildClientContribution("commandcode", { ...CONTEXT, document: before });
    expect(contribution.fragments[0]!.path).toEqual(["provider", OPENCODE_PROVIDER_ID]);

    const after = contribution.fragments.reduce((doc, f) => setPath(doc, f.path, f.value), before);
    const resolved = publishedCommandCodeRoot(after);
    expect(Object.keys(resolved!).sort()).toEqual([OPENCODE_PROVIDER_ID, "legacy"].sort());
  });

  test("a fresh target writes the singular root and the client resolves it", () => {
    const doc = buildCommandCodeClientConfig(CONTEXT);
    const resolved = publishedCommandCodeRoot(doc);
    expect(resolved).toBeDefined();
    expect(Object.keys(resolved!)).toEqual([OPENCODE_PROVIDER_ID]);
  });

  test("both roots are declared as managed paths so disable can remove either", () => {
    // `mutation-plan` refuses to publish an undeclared path; if only the singular
    // root were declared, a block written under the plural root could never be
    // removed again.
    expect(MANAGED_PATH_TEMPLATES.commandcode).toEqual([
      ["provider", OPENCODE_PROVIDER_ID],
      ["providers", OPENCODE_PROVIDER_ID],
    ]);
  });

  test("the exported provider is accepted by the published credential check", () => {
    const provider = buildCommandCodeClientConfig(CONTEXT).provider[OPENCODE_PROVIDER_ID]!;
    // The literal "opencodex-loopback" this exporter used to write is NOT accepted.
    expect(publishedAcceptsApiKey("opencodex-loopback")).toBe(false);
    expect(publishedAcceptsApiKey(provider.apiKey)).toBe(true);
  });

  test("the config path ignores COMMANDCODE_HOME, which the client does not read", () => {
    const relocated = "/tmp/commandcode-relocated";
    // The client resolves `HOME ?? USERPROFILE` + `/.commandcode/providers.json`
    // and never consults COMMANDCODE_HOME, so honouring it would make `enable`
    // report success at a path Command Code never opens.
    expect(commandCodeHomeDir({ COMMANDCODE_HOME: relocated }, "/home/user")).toBe(join("/home/user", ".commandcode"));
    expect(commandCodeConfigPath({ COMMANDCODE_HOME: relocated }, "/home/user")).toBe(join("/home/user", ".commandcode", "providers.json"));
    // The real home still resolves the ordinary way.
    expect(commandCodeConfigPath({}, homedir())).toBe(join(homedir(), ".commandcode", "providers.json"));
  });

  test("a before/after write through the real path leaves the file parseable by the client", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-contract-"));
    const path = join(dir, "providers.json");
    const before = { providers: { acme: { name: "Acme", api: "openai-completions", baseURL: "https://api.acme.test/v1", apiKey: "secret", models: { "acme/large": {} } } } };
    writeFileSync(path, JSON.stringify(before, null, 2), "utf8");

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const contribution = buildClientContribution("commandcode", { ...CONTEXT, document: onDisk });
    const after = contribution.fragments.reduce((doc, f) => setPath(doc, f.path, f.value), onDisk);
    writeFileSync(path, JSON.stringify(after, null, 2), "utf8");

    // Re-read exactly as the client does, and confirm nothing the user configured
    // was lost or shadowed.
    const reloaded = publishedCommandCodeRoot(JSON.parse(readFileSync(path, "utf8")));
    expect(reloaded).toBeDefined();
    expect(reloaded!.acme).toEqual(before.providers.acme);
    expect(reloaded![OPENCODE_PROVIDER_ID]).toBeDefined();
  });
});

describe("commandCodeProviderRoot nullish precedence (published command-code@1.66.0)", () => {
  const cases: Array<[unknown, "provider" | "providers", string]> = [
    [{}, "provider", "empty document defaults to singular creation root"],
    [{ provider: {} }, "provider", "valid singular root"],
    [{ providers: {} }, "providers", "valid plural root"],
    [{ provider: null, providers: {} }, "providers", "null singular falls through to plural"],
    [{ provider: undefined, providers: {} }, "providers", "undefined singular falls through to plural"],
    [{ provider: {}, providers: {} }, "provider", "both roots present prefers singular"],
    [{ provider: "invalid", providers: {} }, "provider", "non-nullish string singular does not fall through"],
    [{ provider: [], providers: {} }, "provider", "non-nullish array singular does not fall through"],
    [{ provider: "", providers: {} }, "provider", "empty string singular does not fall through"],
    [{ provider: false, providers: {} }, "provider", "boolean false singular does not fall through"],
    [{ provider: 0, providers: {} }, "provider", "numeric 0 singular does not fall through"],
    [{ providers: "invalid" }, "providers", "plural string root remains selected for validation"],
    [{ providers: [] }, "providers", "plural array root remains selected for validation"],
    [{ provider: null, providers: "invalid" }, "providers", "null singular with invalid plural selects plural for validation"],
    [{ provider: null }, "provider", "null singular without plural defaults to singular"],
    [{ provider: null, providers: null }, "provider", "both null defaults to singular"],
  ];

  for (const [doc, expected, label] of cases) {
    test(label, () => {
      expect(commandCodeProviderRoot(doc)).toBe(expected);
    });
  }
});

describe("Command Code real integration writer root-precedence and lifecycle", () => {
  let home: string;
  let store: IntegrationStateStore;

  function input(overrides: Partial<IntegrationWriteInput> = {}): IntegrationWriteInput {
    return {
      clientId: "commandcode",
      models: [
        { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol", contextWindow: 922_000 },
      ],
      config: { port: 10100, hostname: "127.0.0.1" } as unknown as IntegrationWriteInput["config"],
      port: 10100,
      env: {},
      home,
      store,
      ...overrides,
    };
  }

  function setupConfig(initialContent: string): string {
    const spec = INTEGRATION_CLIENTS.commandcode;
    const configPath = spec.configPath({}, home);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, initialContent, "utf8");
    return configPath;
  }

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "cc-real-writer-"));
    home = join(base, "home");
    const storeRoot = join(base, "store", "integrations");
    mkdirSync(home, { recursive: true });
    store = createIntegrationStateStore(storeRoot);
  });

  test("default catalog refresh replaces an enabled Command Code model roster", async () => {
    const configPath = setupConfig('{"providers":{}}');
    const initial = input();
    expect(applyIntegration(initial).ok).toBe(true);
    const before = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(before.providers[OPENCODE_PROVIDER_ID].models)).toEqual(["openai/gpt-5.6-sol"]);

    const rosterB = [CONTEXT.models[0]!];
    const { config, port } = initial;
    const outcomes = await refreshOwnedCatalogIntegrations({ models: rosterB, config, port, env: {}, home, store });

    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Object.keys(after.providers[OPENCODE_PROVIDER_ID].models)).toEqual(["anthropic/claude-opus-5"]);
    expect(outcomes.find(outcome => outcome.client === "commandcode"))
      .toEqual({ client: "commandcode", ok: true, changed: true });
  });

  test("default catalog refresh leaves unowned Command Code bytes untouched without loading models", async () => {
    const original = '{\n  "providers": {"opencodex": {"models": {"personal/model": {}}}}\n}\n';
    const configPath = setupConfig(original);
    let loads = 0;
    const { config, port } = input();
    const outcomes = await refreshOwnedCatalogIntegrations({
      models: async () => { loads++; return CONTEXT.models; },
      config, port, env: {}, home, store,
    });

    expect(outcomes).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(loads).toBe(0);
  });

  test("refuses when singular provider root is a string, leaves file untouched, appends no journal entry", async () => {
    const rawContent = JSON.stringify({ provider: "invalid", providers: { acme: { models: {} } } }, null, 2);
    const configPath = setupConfig(rawContent);

    const state = readIntegrationState(input());
    expect(state).toMatchObject({ state: "unsafe", reason: "blocked-container" });

    const applyRes = await applyIntegration(input());
    expect(applyRes.ok).toBe(false);
    expect(applyRes.state).toBe("unsafe");
    expect(applyRes.reason).toBe("unsafe");

    // File must be byte-for-byte unchanged
    expect(readFileSync(configPath, "utf8")).toBe(rawContent);
    // Zero journal entries recorded
    expect(store.listOperations("commandcode")).toHaveLength(0);
    // State does not report current
    expect(readIntegrationState(input()).state).not.toBe("current");
  });

  test("refuses when singular provider root is an array, leaves file untouched, appends no journal entry", async () => {
    const rawContent = JSON.stringify({ provider: [], providers: { acme: { models: {} } } }, null, 2);
    const configPath = setupConfig(rawContent);

    const state = readIntegrationState(input());
    expect(state).toMatchObject({ state: "unsafe", reason: "blocked-container" });

    const applyRes = await applyIntegration(input());
    expect(applyRes.ok).toBe(false);
    expect(applyRes.state).toBe("unsafe");
    expect(applyRes.reason).toBe("unsafe");

    expect(readFileSync(configPath, "utf8")).toBe(rawContent);
    expect(store.listOperations("commandcode")).toHaveLength(0);
    expect(readIntegrationState(input()).state).not.toBe("current");
  });

  test("preserves provider: null fallback and writes under providers", async () => {
    const rawContent = JSON.stringify({
      provider: null,
      providers: { acme: { name: "Acme", api: "openai-completions", baseURL: "https://acme.test/v1", apiKey: false, models: {} } },
    }, null, 2);
    const configPath = setupConfig(rawContent);

    const state = readIntegrationState(input());
    expect(state.state).toBe("absent");

    const applyRes = await applyIntegration(input());
    expect(applyRes.ok).toBe(true);
    expect(applyRes.state).toBe("current");

    const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
    expect(onDisk.provider).toBeNull();
    expect(onDisk.providers[OPENCODE_PROVIDER_ID]).toBeDefined();
    expect(onDisk.providers.acme).toBeDefined();

    const consumerResolved = publishedCommandCodeRoot(onDisk);
    expect(consumerResolved).toBeDefined();
    expect(consumerResolved![OPENCODE_PROVIDER_ID]).toBeDefined();
    expect(consumerResolved!.acme).toBeDefined();
  });

  test.each(["providers", "provider"] as const)("executes full lifecycle (Apply -> Disable -> Undo) on ordinary %s-root files", async root => {
    const rawContent = JSON.stringify({
      [root]: { acme: { name: "Acme", api: "openai-completions", baseURL: "https://acme.test/v1", apiKey: false, models: {} } },
    }, null, 2);
    const configPath = setupConfig(rawContent);

    // 1. Apply
    const applyRes = await applyIntegration(input());
    expect(applyRes.ok).toBe(true);
    expect(applyRes.state).toBe("current");

    const appliedDoc = JSON.parse(readFileSync(configPath, "utf8"));
    expect(appliedDoc[root][OPENCODE_PROVIDER_ID]).toBeDefined();
    expect(appliedDoc[root].acme).toBeDefined();
    expect(appliedDoc[root === "providers" ? "provider" : "providers"]).toBeUndefined();

    // Consumer reads both
    expect(publishedCommandCodeRoot(appliedDoc)![OPENCODE_PROVIDER_ID]).toBeDefined();
    expect(publishedCommandCodeRoot(appliedDoc)!.acme).toBeDefined();

    // 2. Undo the apply directly (restores original document byte-for-byte)
    const undoApplyRes = await restoreIntegration({ ...input(), opId: (applyRes as any).opId });
    expect(undoApplyRes.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(rawContent);

    // Re-apply for disable test
    const reapplyRes = await applyIntegration(input());
    expect(reapplyRes.ok).toBe(true);

    // 3. Disable
    const disableRes = await disableIntegration(input());
    expect(disableRes.ok).toBe(true);

    const disabledDoc = JSON.parse(readFileSync(configPath, "utf8"));
    expect(disabledDoc[root][OPENCODE_PROVIDER_ID]).toBeUndefined();
    expect(disabledDoc[root].acme).toBeDefined();
    expect(disabledDoc[root === "providers" ? "provider" : "providers"]).toBeUndefined();

    // 4. Undo the disable (restores the active managed block under the original root)
    const undoDisableRes = await restoreIntegration({ ...input(), opId: (disableRes as any).opId });
    expect(undoDisableRes.ok).toBe(true);
    expect(readIntegrationState(input()).state).toBe("current");
    expect(undoDisableRes.state).toBe(readIntegrationState(input()).state);

    const restoredDoc = JSON.parse(readFileSync(configPath, "utf8"));
    expect(restoredDoc[root][OPENCODE_PROVIDER_ID]).toBeDefined();
    expect(restoredDoc[root].acme).toBeDefined();
    expect(restoredDoc[root === "providers" ? "provider" : "providers"]).toBeUndefined();
    expect(publishedCommandCodeRoot(restoredDoc)![OPENCODE_PROVIDER_ID]).toBeDefined();
  });
  test("undoing a confirmed drift restore preserves an unparseable snapshot", () => {
    const configPath = setupConfig(JSON.stringify({ providers: { acme: { models: {} } } }));
    const applyRes = applyIntegration(input());
    expect(applyRes.ok).toBe(true);
    if (!applyRes.ok) throw new Error("apply failed");

    const editedText = "{ invalid JSON";
    writeFileSync(configPath, editedText, "utf8");
    const restoreRes = restoreIntegration({ ...input(), opId: applyRes.opId!, confirmDrift: true });
    expect(restoreRes.ok).toBe(true);
    if (!restoreRes.ok) throw new Error("restore failed");

    const undoRes = restoreIntegration({ ...input(), opId: restoreRes.opId! });
    expect(undoRes).toMatchObject({ ok: true, state: "conflict" });
    expect(readFileSync(configPath, "utf8")).toBe(editedText);
    expect(readIntegrationState(input()).state).toBe("unsafe");
  });
});
