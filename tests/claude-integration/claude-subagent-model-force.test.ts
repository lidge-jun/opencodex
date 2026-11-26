import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { buildClaudeEnv, buildNativeClaudeEnv } from "../../src/cli/claude";
import { buildClaudeAgentDefs } from "../../src/claude/agents-inject";
import { entryParts, resolveSubagentForceModel, withSubagentContextMarker } from "../../src/claude/subagent-model";
import { inspectSubagentForceStatus, probeInstalledClaudeCodeVersion, subagentForceSupport } from "../../src/claude/subagent-force-status";
import { extractOcxRouteDirective } from "../../src/claude/inbound-model-options";
import { configDiagnosticsFromRaw, validateConfigCandidate } from "../../src/config/diagnostics";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

const config = (force?: string): OcxConfig => ({ port: 10100, providers: {}, defaultProvider: "openai", claudeCode: { ...(force === undefined ? {} : { subagentModelForce: force }) } });
const deps = { forceAvailable: ["combo/tev-auto", "gpt-6.1-sol", "mock/model"], authDetect: {
  readClaudeJson: () => undefined, credentialsFileExists: () => false, keychainProbe: () => "absent" as const,
} };
const MODEL = "CLAUDE_CODE_SUBAGENT_MODEL";
const FORCE = "CLAUDE_CODE_SUBAGENT_MODEL_FORCE";

test("unset preserves env exactly; routed force uses shared combo alias and native launch adds neither", () => {
  const baseline = buildClaudeEnv(config(), 10100, {}, {}, deps);
  expect(baseline[MODEL]).toBeUndefined();
  expect(baseline[FORCE]).toBeUndefined();
  const forced = buildClaudeEnv(config("combo/tev-auto"), 10100, {}, {}, deps);
  expect(forced[MODEL]).toBe("ocx-claude-combo--tev-auto");
  expect(forced[FORCE]).toBe("1");
  delete forced[MODEL]; delete forced[FORCE];
  expect(forced).toEqual(baseline);
  const native = buildNativeClaudeEnv(config("combo/tev-auto"), {}, deps);
  expect(native[MODEL]).toBeUndefined(); expect(native[FORCE]).toBeUndefined();
});

test("exported values independently win and native launches retain exports", () => {
  for (const base of [{ [MODEL]: "exported" }, { [FORCE]: "0" }, { [MODEL]: "exported", [FORCE]: "0" }]) {
    const env = buildClaudeEnv(config("combo/tev-auto"), 10100, base, {}, deps);
    expect(env[MODEL]).toBe(base[MODEL] ?? "ocx-claude-combo--tev-auto");
    expect(env[FORCE]).toBe(base[FORCE] ?? "1");
    expect(buildNativeClaudeEnv(config("combo/tev-auto"), base, deps)).toMatchObject(base);
  }
});

test("alias resolution reuses roster provider/native semantics and the long-context boundary", () => {
  for (const entry of deps.forceAvailable) {
    const c = config(entry);
    const { alias } = entryParts(entry, c);
    expect(resolveSubagentForceModel(c, { [alias]: 829_799 }, { entries: deps.forceAvailable })).toBe(alias);
    expect(resolveSubagentForceModel(c, { [alias]: 829_800 }, { entries: deps.forceAvailable })).toBe(`${alias}[1m]`);
    expect(resolveSubagentForceModel(c, { [alias]: 1000000 }, { entries: deps.forceAvailable })).toBe(`${alias}[1m]`);
  }
});

test("unsafe, stale and retained unavailable targets warn and inject neither variable", () => {
  for (const force of ["bad\nmodel", "missing/model", "combo/tev-auto"]) {
    const warnings: string[] = [];
    const env = buildClaudeEnv({ ...config(force), subagentModels: [force] }, 10100, {}, {}, { ...deps, forceAvailable: [], warn: line => warnings.push(line) });
    expect(env[MODEL]).toBeUndefined(); expect(env[FORCE]).toBeUndefined(); expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(force);
  }
});

test("invalid hand edits degrade without losing providers; strict candidate validation rejects them", () => {
  const invalid = config("bad\nmodel");
  expect(validateConfigCandidate(invalid).ok).toBe(false);
  const diagnostics = configDiagnosticsFromRaw(JSON.stringify(invalid));
  expect(diagnostics.config.claudeCode?.subagentModelForce).toBeUndefined();
  expect(diagnostics.warnings.some(warning => warning.includes("subagentModelForce"))).toBe(true);
});

test("explicit wire model outranks legacy roster directive even without saved force", () => {
  const body = { model: "ocx-claude-combo--tev-auto", system: "<!-- ocx-route: ocx-claude-other--model -->" };
  expect(extractOcxRouteDirective(body)).toBe(body.model);
});

test("version boundary and read-only settings key presence are bounded and private", async () => {
  for (const version of [null, "bad"]) expect(subagentForceSupport(version)).toBe("unknown");
  expect(subagentForceSupport("2.1.256")).toBe("unsupported");
  for (const version of ["2.1.257", "2.2.0", "3.0.0"]) expect(subagentForceSupport(version)).toBe("supported");
  const dir = mkdtempSync(join(tmpdir(), "ocx-force-status-"));
  try {
    for (const key of [MODEL, FORCE]) {
      const text = JSON.stringify({ env: { [key]: "private-value" } });
      writeFileSync(join(dir, "settings.json"), text);
      const result = await inspectSubagentForceStatus(true, dir, async () => "2.1.257");
      expect(result).toMatchObject({ support: "supported", settingsOverride: true, settingsReadable: true });
      expect(JSON.stringify(result)).not.toContain("private-value");
      expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(text);
    }
    writeFileSync(join(dir, "settings.json"), "{");
    expect(await inspectSubagentForceStatus(false, dir, async () => null)).toMatchObject({ targetValid: false, support: "unknown", settingsReadable: false });
  } finally { removeTreeWithRetry(dir); }
});

test.skipIf(process.platform === "win32")("a SIGTERM-resistant Claude CLI hits the Fable probe deadline and shares the cached fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-claude-version-"));
  const cli = join(dir, "claude");
  const previousPath = process.env.PATH;
  writeFileSync(cli, '#!/bin/sh\ntrap "" TERM\nprintf "%s\\n" "$$" >> "$0.pids"\nexec /bin/sleep 4\n', { mode: 0o755 });
  try {
    process.env.PATH = [dir, previousPath].filter(Boolean).join(delimiter);
    const started = performance.now();
    const versions = await Promise.all([probeInstalledClaudeCodeVersion(), probeInstalledClaudeCodeVersion()]);
    expect(Math.round(performance.now() - started)).toBeLessThan(1850);
    expect(versions).toEqual([null, null]);
    expect(await probeInstalledClaudeCodeVersion()).toBeNull();
    const pids = readFileSync(`${cli}.pids`, "utf8").trim().split("\n");
    expect(pids).toHaveLength(1);
    // Allow the OS to reap the killed process after the promise settles.
    await Bun.sleep(100);
    expect(() => process.kill(Number(pids[0]), 0)).toThrow(/ESRCH/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    removeTreeWithRetry(dir);
  }
}, 10_000);


test("wire selection survives exported overrides and saved force changed or cleared after launch", () => {
  const launched = buildClaudeEnv(config("combo/tev-auto"), 10100, { [MODEL]: "ocx-claude-mock--model" }, {}, deps);
  const body = { model: launched[MODEL], system: "<!-- ocx-route: ocx-claude-other--roster -->" };
  // The request resolver no longer receives mutable config. New launches may
  // differ while this already-launched request keeps its own selector.
  for (const current of [config("combo/tev-auto"), config("mock/model"), config()]) {
    const next = buildClaudeEnv(current, 10100, {}, {}, deps);
    expect(next[MODEL]).toBe(current.claudeCode?.subagentModelForce === "combo/tev-auto"
      ? "ocx-claude-combo--tev-auto" : current.claudeCode?.subagentModelForce ? "ocx-claude-mock--model" : undefined);
    expect(extractOcxRouteDirective(body)).toBe("ocx-claude-mock--model");
  }
  expect(buildClaudeEnv(config("combo/tev-auto"), 10100, { [FORCE]: "0" }, {}, deps)[FORCE]).toBe("0");
});

test("legacy bare fallback stays intact and main turns have no route override", () => {
  for (const model of ["claude-sonnet-5", "unknown", "ocx-claude-invalid"]) {
    expect(extractOcxRouteDirective({ model, system: "<!-- ocx-route: ocx-claude-other--roster -->" }))
      .toBe("ocx-claude-other--roster");
  }
  for (const model of ["ocx-claude-mock--model", "claude-ocx-mock--model", "ocx-claude2-openrouter--vendor~smodel[1M]"]) {
    expect(extractOcxRouteDirective({ model, system: "<!-- ocx-route: other -->" })).toBe(model);
    expect(extractOcxRouteDirective({ model, system: "ordinary main turn" })).toBeNull();
  }
});

test("native Claude force has distinguishable identity and keeps authoritative context", () => {
  const c = config("anthropic/claude-sonnet-5");
  expect(resolveSubagentForceModel(c, { "claude-sonnet-5": 1000000 }, { entries: ["anthropic/claude-sonnet-5"] }))
    .toBe("ocx-claude-native--claude-sonnet-5[1m]");
  expect(resolveSubagentForceModel(c, {}, { selectors: ["claude-sonnet-5"] }))
    .toBe("ocx-claude-native--claude-sonnet-5");
});

test("fresh wire exposure is independent of windows and failed discovery cannot use stale windows", () => {
  const c = config("mock/model");
  expect(buildClaudeEnv(c, 10100, {}, {}, { ...deps, forceAvailable: undefined, forceAvailableSelectors: ["claude-ocx-mock--model[1m]"] })[MODEL])
    .toBe("ocx-claude-mock--model");
  const warnings: string[] = [];
  const env = buildClaudeEnv(c, 10100, {}, { "mock/model": 1000000 }, { ...deps, forceAvailable: undefined, warn: message => warnings.push(message) });
  expect(env[MODEL]).toBeUndefined(); expect(env[FORCE]).toBeUndefined(); expect(warnings).toHaveLength(1);
});


test("force rejects caller million markers without advertised identity or authoritative capacity", () => {
  for (const entry of ["mock/model[1m]", "gpt-6.1-sol[1M]", "anthropic/claude-sonnet-5[1m]"]) {
    const c = config(entry);
    const unmarked = entry.replace(/\[1m\]$/i, "");
    const alias = entryParts(unmarked, c).alias;
    expect(resolveSubagentForceModel(c, {}, { entries: [unmarked] })).toBeNull();
    expect(resolveSubagentForceModel(c, {}, { selectors: [alias] })).toBeNull();
    expect(resolveSubagentForceModel(c, { [alias]: 200000 }, { selectors: [alias] })).toBeNull();
    expect(resolveSubagentForceModel(c, { [alias]: Number.POSITIVE_INFINITY }, { selectors: [alias] })).toBeNull();
    expect(resolveSubagentForceModel(c, { [alias]: 1000000 }, { entries: [unmarked] })).not.toBeNull();
  }
});

test("force preserves exact advertised genuine marked models and legacy alias identity", () => {
  const c = config("kimi/k3[1m]");
  const marked = "ocx-claude-kimi--k3[1m]";
  expect(resolveSubagentForceModel(c, {}, { entries: ["kimi/k3[1m]"] })).toBe(marked);
  expect(resolveSubagentForceModel(c, {}, { selectors: ["claude-ocx-kimi--k3[1M]"] })).toBe(marked);
  expect(resolveSubagentForceModel(c, { [marked]: 1048576 }, { entries: ["kimi/k3[1m]"] })).toBe(marked);
  expect(resolveSubagentForceModel(c, { [marked]: 350000 }, { entries: ["kimi/k3[1m]"] })).toBe(marked);
  expect(resolveSubagentForceModel(config("mock/model[1m]"), { "ocx-claude-mock--model[1m]": 200000, "ocx-claude-mock--model": 1000000 }, { entries: ["mock/model"] })).toBeNull();
  expect(withSubagentContextMarker("ocx-claude-mock--legacy[1m]", {})).toBe("ocx-claude-mock--legacy[1m]");
});

test("bare combo aliases resolve to canonical combo selectors across entryParts, force, [1m], disabledModels and agents-inject", () => {
  const comboCfg = (force?: string, overrides: Partial<OcxConfig> = {}): OcxConfig => ({
    ...config(force),
    combos: {
      "bare-combo": { alias: "bare-combo", targets: [{ provider: "ollama", model: "qwen3" }] },
      "combo-id": { alias: "aliased-combo", targets: [{ provider: "ollama", model: "qwen3" }] },
      fast: { alias: "team/fast", targets: [{ provider: "ollama", model: "qwen3" }] },
    },
    ...overrides,
  });

  expect(entryParts("bare-combo", comboCfg())).toEqual({ alias: "ocx-claude-combo--bare-combo", id: "bare-combo", provider: "combo" });
  expect(entryParts("combo/bare-combo", comboCfg())).toEqual({ alias: "ocx-claude-combo--bare-combo", id: "bare-combo", provider: "combo" });
  expect(entryParts("bare-combo[1m]", comboCfg())).toEqual({ alias: "ocx-claude-combo--bare-combo[1m]", id: "bare-combo[1m]", provider: "combo" });
  expect(entryParts("bare-combo[1M]", comboCfg())).toEqual({ alias: "ocx-claude-combo--bare-combo[1M]", id: "bare-combo[1M]", provider: "combo" });
  expect(entryParts("aliased-combo", comboCfg())).toEqual({ alias: "ocx-claude-combo--combo-id", id: "combo-id", provider: "combo" });
  expect(entryParts("combo/combo-id", comboCfg())).toEqual({ alias: "ocx-claude-combo--combo-id", id: "combo-id", provider: "combo" });
  expect(entryParts("team/fast", comboCfg())).toEqual({ alias: "ocx-claude-combo--fast", id: "fast", provider: "combo" });

  const selector = "ocx-claude-combo--bare-combo";
  for (const force of ["bare-combo", "combo/bare-combo"]) {
    const c = comboCfg(force);
    expect(resolveSubagentForceModel(c, {}, { entries: ["bare-combo"] })).toBe(selector);
    expect(resolveSubagentForceModel(c, {}, { selectors: [selector] })).toBe(selector);
    expect(resolveSubagentForceModel(c, { [selector]: 829_799 }, { entries: ["bare-combo"] })).toBe(selector);
    expect(resolveSubagentForceModel(c, { [selector]: 829_800 }, { entries: ["bare-combo"] })).toBe(`${selector}[1m]`);
    expect(resolveSubagentForceModel(c, { [selector]: 1_000_000 }, { selectors: [selector] })).toBe(`${selector}[1m]`);
  }

  expect(resolveSubagentForceModel(comboCfg("bare-combo[1m]"), {}, { entries: ["bare-combo"] })).toBeNull();
  expect(resolveSubagentForceModel(comboCfg("bare-combo[1m]"), { [selector]: 1_000_000 }, { entries: ["bare-combo"] })).toBe(`${selector}[1m]`);
  expect(resolveSubagentForceModel(comboCfg("bare-combo[1M]"), {}, { entries: ["bare-combo"] })).toBeNull();
  expect(resolveSubagentForceModel(comboCfg("bare-combo[1M]"), { [selector]: 1_000_000 }, { entries: ["bare-combo"] })).toBe(`${selector}[1M]`);
  expect(resolveSubagentForceModel(comboCfg("aliased-combo"), {}, { entries: ["aliased-combo"] })).toBe("ocx-claude-combo--combo-id");
  expect(resolveSubagentForceModel(comboCfg("combo/combo-id"), {}, { entries: ["aliased-combo"] })).toBe("ocx-claude-combo--combo-id");
  expect(resolveSubagentForceModel(comboCfg("aliased-combo"), {}, { selectors: ["ocx-claude-combo--combo-id"] })).toBe("ocx-claude-combo--combo-id");
  expect(resolveSubagentForceModel(comboCfg("team/fast"), {}, { entries: ["team/fast"] })).toBe("ocx-claude-combo--fast");
  expect(resolveSubagentForceModel(comboCfg("team/fast"), {}, { selectors: ["ocx-claude-combo--fast"] })).toBe("ocx-claude-combo--fast");

  expect(resolveSubagentForceModel(comboCfg("bare-combo", { disabledModels: ["combo/bare-combo"] }), {}, { entries: ["bare-combo"] })).toBeNull();
  expect(resolveSubagentForceModel(comboCfg("combo/bare-combo", { disabledModels: ["bare-combo"] }), {}, { selectors: [selector] })).toBeNull();

  const localEnv = buildClaudeEnv(comboCfg("bare-combo"), 10100, {}, { [selector]: 1_000_000 }, { ...deps, forceAvailable: ["bare-combo"] });
  expect(localEnv[MODEL]).toBe(`${selector}[1m]`);
  expect(localEnv[FORCE]).toBe("1");
  const connectedEnv = buildClaudeEnv(comboCfg("bare-combo"), 10100, {}, { [selector]: 1_000_000 }, { ...deps, forceAvailable: undefined, forceAvailableSelectors: [selector] });
  expect(connectedEnv[MODEL]).toBe(`${selector}[1m]`);
  expect(connectedEnv[FORCE]).toBe("1");

  const dir = mkdtempSync(join(tmpdir(), "ocx-bare-combo-agents-"));
  try {
    const defs = buildClaudeAgentDefs(comboCfg(undefined, { subagentModels: ["bare-combo", "combo/bare-combo", "aliased-combo"] }), { [selector]: 1_000_000 }, dir);
    expect(defs.map(d => ({ name: d.name, model: d.model, file: d.file }))).toEqual([
      { name: "ocx-bare-combo", model: `${selector}[1m]`, file: "ocx-bare-combo.md" },
      { name: "ocx-combo-id", model: "ocx-claude-combo--combo-id", file: "ocx-combo-id.md" },
    ]);
    expect(defs[0]?.description).toContain("bare-combo (combo)");
    expect(defs[1]?.description).toContain("combo-id (combo)");
  } finally {
    removeTreeWithRetry(dir);
  }
});

test("physical combo provider without configured combos preserves routed decoding", () => {
  const physicalCfg: OcxConfig = {
    ...config("combo/vendor-model"),
    providers: {
      combo: { baseUrl: "https://example.invalid", apiKey: "k", api: "openai-completions", models: ["vendor/model"] },
    },
    combos: {},
  };
  expect(entryParts("combo/vendor-model", physicalCfg)).toEqual({
    alias: "ocx-claude2-combo--vendor~smodel",
    id: "vendor/model",
    provider: "combo",
  });
  expect(resolveSubagentForceModel(physicalCfg, {}, { entries: ["combo/vendor-model"] }))
    .toBe("ocx-claude2-combo--vendor~smodel");
  expect(resolveSubagentForceModel(physicalCfg, {}, { selectors: ["ocx-claude2-combo--vendor~smodel"] }))
    .toBe("ocx-claude2-combo--vendor~smodel");
});

test("nativeAlias combo disable and catalog omission preserve still-enabled native OpenAI slug", () => {
  const nativeAliasCfg = (force?: string, overrides: Partial<OcxConfig> = {}): OcxConfig => ({
    ...config(force),
    combos: {
      astra: { alias: "gpt-6.2-astra", nativeAlias: true, targets: [{ provider: "ollama", model: "qwen3" }] },
    },
    ...overrides,
  });

  // Native disabled: combo remains forceable via canonical combo/astra.
  expect(resolveSubagentForceModel(
    nativeAliasCfg("combo/astra", { disabledModels: ["gpt-6.2-astra"] }),
    {},
    { selectors: ["ocx-claude-combo--astra"] },
  )).toBe("ocx-claude-combo--astra");
  expect(resolveSubagentForceModel(
    nativeAliasCfg("combo/astra", { disabledModels: ["gpt-6.2-astra"] }),
    {},
    { entries: ["combo/astra"] },
  )).toBe("ocx-claude-combo--astra");

  // Combo disabled: bare native slug falls back to native OpenAI model across entryParts, force, and agents-inject.
  const disabledComboCfg = nativeAliasCfg("gpt-6.2-astra", { disabledModels: ["combo/astra"] });
  expect(entryParts("gpt-6.2-astra", disabledComboCfg)).toEqual({
    alias: "ocx-claude-native--gpt-6.2-astra",
    id: "gpt-6.2-astra",
    provider: "native",
  });
  expect(resolveSubagentForceModel(disabledComboCfg, {}, { entries: ["gpt-6.2-astra"] }))
    .toBe("ocx-claude-native--gpt-6.2-astra");
  expect(resolveSubagentForceModel(disabledComboCfg, {}, { selectors: ["ocx-claude-native--gpt-6.2-astra"] }))
    .toBe("ocx-claude-native--gpt-6.2-astra");
  expect(resolveSubagentForceModel(
    nativeAliasCfg("combo/astra", { disabledModels: ["combo/astra"] }),
    {},
    { selectors: ["ocx-claude-combo--astra", "ocx-claude-native--gpt-6.2-astra"] },
  )).toBeNull();
  expect(resolveSubagentForceModel(
    nativeAliasCfg("gpt-6.2-astra", { disabledModels: ["combo/astra", "gpt-6.2-astra"] }),
    {},
    { selectors: ["ocx-claude-native--gpt-6.2-astra"] },
  )).toBeNull();

  const dir = mkdtempSync(join(tmpdir(), "ocx-native-alias-disabled-"));
  try {
    const defs = buildClaudeAgentDefs(
      nativeAliasCfg(undefined, { disabledModels: ["combo/astra"], subagentModels: ["gpt-6.2-astra"] }),
      {},
      dir,
    );
    expect(defs.map(d => ({ name: d.name, model: d.model, file: d.file }))).toEqual([
      { name: "ocx-gpt-6-2-astra", model: "ocx-claude-native--gpt-6.2-astra", file: "ocx-gpt-6-2-astra.md" },
    ]);
    expect(defs[0]?.description).toContain("gpt-6.2-astra (native)");
  } finally {
    removeTreeWithRetry(dir);
  }

  // Unhealthy nativeAlias combo omitted from catalog while native OpenAI model is exposed.
  expect(resolveSubagentForceModel(
    nativeAliasCfg("gpt-6.2-astra"),
    {},
    { selectors: ["ocx-claude-native--gpt-6.2-astra"] },
  )).toBe("ocx-claude-native--gpt-6.2-astra");
  expect(resolveSubagentForceModel(
    nativeAliasCfg("gpt-6.2-astra", { disabledModels: ["gpt-6.2-astra"] }),
    {},
    { selectors: ["ocx-claude-native--gpt-6.2-astra"] },
  )).toBeNull();
  expect(resolveSubagentForceModel(
    nativeAliasCfg("combo/astra"),
    {},
    { selectors: ["ocx-claude-native--gpt-6.2-astra"] },
  )).toBeNull();
});
