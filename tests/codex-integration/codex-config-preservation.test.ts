import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import {
  setRootOpenaiBaseUrlForTarget,
  setRootRealtimeWsBaseUrl,
  stripInjectedOpenaiBaseUrl,
  stripInjectedRootWebSearch,
  removeProfileSection,
  ensureRootWebSearchDisabled, ensureFastModeFeature, stripOpencodexCatalogPath,
  setRootModelCatalogPath,
  stripExistingModelProvider, stripRootContextWindowOverrides,
} from "../../src/codex/inject/config-toml";
import { stripOpencodexConfig } from "../../src/codex/inject/remove";
import { deriveCodexInjectionPlan } from "../../src/codex/inject/plan";
import { rootSourceLines, sourceAssignment, sourceAssignmentSpan } from "../../src/codex/toml-source-lines";
import {
  hasInjectedOpenaiBaseUrl, OCX_ROUTING_MARKER_LINE, OCX_SECTION_MARKER,
  stripJournaledOpenaiBaseUrl,
} from "../../src/codex/injected-marker";

const target = { baseUrl: "http://127.0.0.1:10100/v1", requiresAdmissionToken: false, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" as const };
const userUrl = "https://fixture.invalid/v1";
const parse = (text: string) => Bun.TOML.parse(text.replace(/^\uFEFF/, ""));

describe("structural root ownership and multiline preservation", () => {
  test.each(["openai_base_url", '"openai_base_url"', "'openai_base_url'", '"openai_base_\\u0075rl"'])("user marker quotations never own the root URL (%s)", key => {
    const content = `# user quote: ${OCX_ROUTING_MARKER_LINE}\n${key} = "${userUrl}"\nmodel = "user/model"\n`;
    expect(hasInjectedOpenaiBaseUrl(content)).toBe(false);
    expect(stripInjectedOpenaiBaseUrl(content)).toBe(content);
    expect(parse(stripOpencodexConfig(content))).toEqual(parse(content));
    expect(setRootOpenaiBaseUrlForTarget(content, target)).toEqual({ content, keptUserBaseUrl: true });
  });

  test.each([OCX_SECTION_MARKER, OCX_ROUTING_MARKER_LINE])("exact adjacent markers own quoted root keys (%s)", marker => {
    const content = `${marker}\n"openai_base_url" = "${target.baseUrl}"\n${marker}\n'experimental_realtime_ws_base_url' = "${target.baseUrl}"\nmodel = "fixture-model"\n`;
    expect(hasInjectedOpenaiBaseUrl(content)).toBe(true);
    expect(stripInjectedOpenaiBaseUrl(content)).toBe('model = "fixture-model"\n');
  });

  test("journal value evidence removes its own URL but preserves a user marker quotation", () => {
    const comment = `# user quote: ${OCX_ROUTING_MARKER_LINE}\n`;
    const content = `${comment}"openai_base_url" = "${target.baseUrl}"\nmodel = "fixture-model"\n`;
    expect(stripJournaledOpenaiBaseUrl(content, target.baseUrl)).toBe(comment + 'model = "fixture-model"\n');
    expect(stripJournaledOpenaiBaseUrl(content, userUrl)).toBe(content);
  });

  test("an exact marker above a different root setting remains user data", () => {
    const content = `${OCX_ROUTING_MARKER_LINE}\nmodel = "fixture-model"\nopenai_base_url = "${userUrl}"\n`;
    expect(stripInjectedOpenaiBaseUrl(content)).toBe(content);
    expect(hasInjectedOpenaiBaseUrl(content)).toBe(false);
  });

  const variants = ["\n", "\r\n"].flatMap(eol => ["", "\uFEFF"].flatMap(bom =>
    ['"""', "'''"].map(delimiter => ({ eol, bom, delimiter }))));
  test.each(variants)("actual multiline web-search assignments survive an Off/On rollback (%j)", ({ eol, bom, delimiter }) => {
    const assignment = `  'web_search' = ${delimiter}\nlive${delimiter} # user mode`.replaceAll("\n", eol);
    const content = bom + assignment + eol + `model = "fixture-model"${eol}[user]${eol}value = "keep"${eol}`;
    const off = ensureRootWebSearchDisabled(content, true);
    expect(parse(off.content).web_search).toBe("disabled");
    expect(off.replacedUserLine).toBe(assignment);
    const journal = { injectedValue: off.wroteValue, replacedUserLine: off.replacedUserLine };
    expect(ensureRootWebSearchDisabled(off.content, true, journal).replacedUserLine).toBe(assignment);
    const on = ensureRootWebSearchDisabled(off.content, false, journal).content;
    expect(parse(on)).toEqual(parse(content));
    expect(on).toContain(assignment);
    expect(on.startsWith(bom)).toBe(true);
  });

  test.each(variants)("actual multiline provider assignments are removed as complete spans (%j)", ({ eol, bom, delimiter }) => {
    const content = bom + `"model_provider" = ${delimiter}\nopenai${delimiter}\nmodel = "fixture-model"\n[user]\nvalue = "keep"\n`.replaceAll("\n", eol);
    expect(parse(stripExistingModelProvider(content))).toEqual({ model: "fixture-model", user: { value: "keep" } });
    for (const requiresAdmissionToken of [false, true]) {
      const plan = deriveCodexInjectionPlan(content, { config: undefined, routingTarget: { ...target, requiresAdmissionToken }, catalogPathOption: null, journalReadOnly: true });
      expect(plan.kind).toBe("ok");
      if (plan.kind !== "ok") throw new Error(plan.message);
      expect(parse(plan.content).user).toEqual({ value: "keep" });
      expect(parse(plan.baselineContent)).toEqual(parse(content));
    }
  });

  test.each(['"""', "'''"])("journal value evidence strips a complete marker-less multiline value (%s)", delimiter => {
    const content = `web_search = ${delimiter}\ndisabled${delimiter}\nmodel = "fixture-model"\n`;
    expect(stripInjectedRootWebSearch(content)).toBe(content);
    expect(stripInjectedRootWebSearch(content, "disabled")).toBe('model = "fixture-model"\n');
    expect(stripInjectedRootWebSearch(content, "live")).toBe(content);
    const spaced = content.replace("disabled", " disabled ");
    expect(stripInjectedRootWebSearch(spaced, "disabled")).toBe(spaced);
    const child = `[user]\nmodel_provider = ${delimiter}\nexternal${delimiter}\n`;
    expect(stripExistingModelProvider(child)).toBe(child);
    const owned = child.replace("external", "opencodex");
    expect(parse(stripOpencodexConfig(owned))).toEqual({ user: {} });
  });

  test("context override removal consumes the complete collection without touching its neighbor", () => {
    const content = 'model_context_window = [\n1,\n2\n]\nmodel = "fixture-model"\n';
    expect(parse(stripRootContextWindowOverrides(content))).toEqual({ model: "fixture-model" });
  });

  test.each([
    "9007199254740992", "+9007199254740992", "-9007199254740992",
    "9223372036854775807", "-9223372036854775808", "9_223_372_036_854_775_807",
    "-9_223_372_036_854_775_808", "0x7fff_ffff_ffff_ffff", "0o777777777777777777777",
    "0b111111111111111111111111111111111111111111111111111111111111111",
  ])("value-free removal accepts a complete signed 64-bit integer (%s)", numeric => {
    for (const eol of ["\n", "\r\n"]) for (const bom of ["", "\uFEFF"]) {
      const neighbor = `model = "fixture-model"${eol}# user comment${eol}[child]${eol}value = "keep"${eol}`;
      const key = numeric === "9007199254740992" || numeric === "9223372036854775807"
        ? "model_context_window" : "'model_context_window'";
      const assignment = `  ${key} = ${numeric} # fixture integer`;
      const content = bom + assignment + eol + neighbor;
      const source = rootSourceLines(content);
      expect(sourceAssignment(source.lines, 0, source.rootEnd)).toBeNull();
      expect(sourceAssignmentSpan(source.lines, 0, source.rootEnd)?.text).toBe(assignment);
      expect(stripRootContextWindowOverrides(content)).toBe(bom + neighbor);
      for (const requiresAdmissionToken of [false, true]) {
        const plan = deriveCodexInjectionPlan(content, { config: undefined, routingTarget: { ...target, requiresAdmissionToken }, catalogPathOption: null, journalReadOnly: true });
        expect(plan.kind).toBe("ok");
        if (plan.kind !== "ok") throw new Error(plan.message);
        expect(parse(plan.content).model).toBe("fixture-model");
        expect(plan.baselineContent).toBe(content);
      }
      expect(stripExistingModelProvider(content.replace("model_context_window", "model_provider"))).toBe(bom + neighbor);
      const webSearch = content.replace("model_context_window", "web_search");
      const off = ensureRootWebSearchDisabled(webSearch, true);
      expect(off.replacedUserLine).toBe(assignment.replace("model_context_window", "web_search"));
      const journal = { injectedValue: off.wroteValue, replacedUserLine: off.replacedUserLine };
      expect(ensureRootWebSearchDisabled(off.content, false, journal).content).toContain(off.replacedUserLine!);
      const child = bom + neighbor + `model_provider = ${numeric}${eol}`;
      expect(stripExistingModelProvider(child)).toBe(child);
    }
  });

  test.each([
    "9223372036854775808", "-9223372036854775809", "0x8000000000000000",
    "0o1000000000000000000000", "+0x7fffffffffffffff", "-0x7fffffffffffffff",
    "09007199254740992", "9__007199254740992", "9007199254740992_", "_9007199254740992",
    "9007199254740992 garbage", "9007199254740992 1", "9007199254740992 # invalid\u0001comment",
    "[9007199254740992", '"""unclosed', "'''unclosed", "", "0x", "0b2",
  ])("value-free removal rejects invalid or incomplete integer assignments (%s)", value => {
    const content = `model_context_window = ${value}\nmodel = "fixture-model"\n`;
    expect(() => stripRootContextWindowOverrides(content)).toThrow();
    expect(() => stripExistingModelProvider(content.replace("model_context_window", "model_provider"))).toThrow();
    expect(() => ensureRootWebSearchDisabled(content.replace("model_context_window", "web_search"), true)).toThrow();
  });
  test.each(variants)("restore and injection preserve opaque multiline bytes (%j)", ({ eol, bom, delimiter }) => {
    const value = `a\n${OCX_ROUTING_MARKER_LINE}\n\n\nb\n# user quote: ${OCX_SECTION_MARKER}\nopenai_base_url = "https://data.invalid/v1"\n[profiles.opencodex]\n[not_a_table]\nmodel_provider = "opencodex"\nservice_tier = "priority"\n${OCX_ROUTING_MARKER_LINE}\nweb_search = "disabled"\nz`;
    const content = bom + `instructions = ${delimiter}${value}${delimiter}\n"openai_base_url" = "${userUrl}"\n'web_search' = "live"\n[child]\nnote = ${delimiter}first\n\n\nlast${delimiter}\n[child.headers]\n"x-fixture" = "keep"\n`.replaceAll("\n", eol);
    expect(stripInjectedOpenaiBaseUrl(content)).toBe(content);
    expect(stripInjectedRootWebSearch(content)).toBe(content);
    expect(removeProfileSection(content)).toBe(content);
    expect(hasInjectedOpenaiBaseUrl(content)).toBe(false);
    expect(setRootOpenaiBaseUrlForTarget(content, target)).toEqual({ content, keptUserBaseUrl: true });
    expect(setRootRealtimeWsBaseUrl(content, target).content).toBe(content);
    expect(parse(stripOpencodexConfig(content))).toEqual(parse(content));
    const plan = deriveCodexInjectionPlan(content, { config: undefined, routingTarget: target, catalogPathOption: null, journalReadOnly: true });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") throw new Error(plan.message);
    const next = parse(plan.content);
    const original = parse(content);
    expect(next.instructions).toBe(original.instructions);
    expect(next.child).toEqual(original.child);
    expect(next.openai_base_url).toBe(userUrl);
    expect(next.web_search).toBe("live");
    expect(plan.content.startsWith(bom)).toBe(true);
  });

  test.each(["\n", "\r\n"])("structural whitespace cleanup leaves multiline blank lines and child tables intact (%j)", eol => {
    const content = `# user comment\n\n\n\nmodel = "fixture-model"\n[child]\nbasic = """a\n\n\nb"""\nliteral = '''c\n\n\nd'''\n[child.headers]\n"x-fixture" = "keep"\n\n\n`.replaceAll("\n", eol);
    const result = stripOpencodexConfig(content);
    expect(parse(result)).toEqual(parse(content));
    expect(result).toContain(`a${eol}${eol}${eol}b`);
    expect(result).toContain(`c${eol}${eol}${eol}d`);
    expect(result).toContain('[child.headers]');
  });

  test.each([
    { name: "strip catalog", transform: stripOpencodexCatalogPath },
    { name: "set catalog", transform: (content: string) => setRootModelCatalogPath(content, "fixture-catalog.json") },
    { name: "feature toggle", transform: (content: string) => ensureFastModeFeature(content, true) },
    { name: "web-search toggle", transform: (content: string) => ensureRootWebSearchDisabled(content, true).content },
  ])("key-shaped string data remains opaque (%j)", ({ transform }) => {
    for (const { eol, bom, delimiter } of variants) {
      const content = bom + `instructions = ${delimiter}a\nmodel_catalog_json = "opencodex-catalog.json"\n[features]\nfast_mode = false\nweb_search = "live"\nz${delimiter}\n[child]\nvalue = "keep"\n`.replaceAll("\n", eol);
      const result = transform(content);
      expect(parse(result).instructions).toBe(parse(content).instructions);
      expect(parse(result).child).toEqual(parse(content).child);
      expect(result.startsWith(bom)).toBe(true);
      if (eol === "\r\n") expect(result.replaceAll("\r\n", "")).not.toContain("\n");
    }
  });

  test("provider-shaped string data cannot own a user's routed root model", () => {
    const content = 'instructions = """a\nmodel_provider = "opencodex"\nz"""\nmodel = "user/model"\n';
    expect(parse(stripOpencodexConfig(content))).toEqual(parse(content));
  });

  test.each(['["features"]', "['features']", '["f\\u0065atures"]'])("real quoted feature keys are updated outside opaque values (%s)", header => {
    const content = `\uFEFF${header}\r\nnote = '''a\r\nfast_mode = false\r\n\r\n\r\nb'''\r\n'fast_mode' = false\r\n[features.child]\r\nfast_mode = false\r\n`;
    const result = ensureFastModeFeature(content, true);
    const original = parse(content);
    const next = parse(result);
    expect((next.features as Record<string, unknown>).fast_mode).toBe(true);
    expect((next.features as Record<string, unknown>).note).toBe((original.features as Record<string, unknown>).note);
    expect((next.features as Record<string, unknown>).child).toEqual((original.features as Record<string, unknown>).child);
    expect(result.startsWith("\uFEFF")).toBe(true);
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("owned marker adjacency does not overwrite an incomplete single-line view of a multiline URL", () => {
    const content = `${OCX_ROUTING_MARKER_LINE}\nopenai_base_url = """https://fixture.invalid/v1"""\ninstructions = """a\\\n   \n   b"""\n`;
    const multiline = content.replace('"""https://fixture.invalid/v1"""', '"""\nhttps://fixture.invalid/v1\n"""');
    expect(stripInjectedOpenaiBaseUrl(multiline)).toBe(multiline);
    expect(setRootOpenaiBaseUrlForTarget(multiline, target)).toEqual({ content: multiline, keptUserBaseUrl: true });
    expect(parse(stripOpencodexConfig(multiline))).toEqual(parse(multiline));
  });

  test.each(['"""', "'''"])("artifact failure rollback and journal fallback preserve actual multiline settings (%s)", delimiter => {
    const fixture = mkdtempSync(join(tmpdir(), "ocx-managed-span-"));
    const codexHome = join(fixture, "codex");
    const ocxHome = join(fixture, "opencodex");
    mkdirSync(codexHome);
    mkdirSync(ocxHome);
    const assignment = `  'web_search' = ${delimiter}\nlive${delimiter} # user mode`;
    const native = `${assignment}\nmodel_provider = ${delimiter}\nopenai${delimiter}\nmodel = "fixture-model"\n[user]\nvalue = "keep"\n`;
    writeFileSync(join(codexHome, "config.toml"), native);
    const script = `
      import assert from "node:assert/strict";
      import { readFileSync, appendFileSync, existsSync } from "node:fs";
      import { createHash } from "node:crypto";
      import { join } from "node:path";
      import { injectCodexConfig, restoreNativeCodex, setHistoryArtifactStageForTests } from "./src/codex/inject";
      const configPath = join(process.env.CODEX_HOME, "config.toml");
      const profilePath = join(process.env.CODEX_HOME, "opencodex.config.toml");
      const journalPath = join(process.env.CODEX_HOME, "opencodex-journal.json");
      const original = readFileSync(configPath, "utf8");
      const hash = text => createHash("sha256").update(text).digest("hex");
      let hit = false;
      setHistoryArtifactStageForTests(stage => {
        if (stage === "after-config") { hit = true; throw new Error("synthetic artifact failure"); }
      });
      let failed;
      try { failed = await injectCodexConfig(10100, { webSearchSidecar: { enabled: false } }); }
      catch (error) { assert.match(String(error), /synthetic artifact failure/); }
      assert.equal(hit, true);
      assert.notEqual(failed?.success, true);
      assert.equal(readFileSync(configPath, "utf8"), original);
      assert.equal(existsSync(profilePath), false);
      assert.equal(existsSync(journalPath), false);
      setHistoryArtifactStageForTests(undefined);
      const injected = await injectCodexConfig(10100, { webSearchSidecar: { enabled: false } });
      assert.equal(injected.success, true);
      const firstJournal = JSON.parse(readFileSync(journalPath, "utf8"));
      assert.equal(firstJournal.replacedRootWebSearch, process.env.TEST_ORIGINAL_WEB_SEARCH);
      assert.equal(firstJournal.injectedConfigHash, hash(readFileSync(configPath, "utf8")));
      const exact = restoreNativeCodex({ skipHistory: true, removeProviderTable: true });
      assert.equal(exact.success, true);
      assert.equal(exact.artifacts.config.action, "journal-restored");
      assert.equal(readFileSync(configPath, "utf8"), original);
      const reinjected = await injectCodexConfig(10100, { webSearchSidecar: { enabled: false } });
      assert.equal(reinjected.success, true);
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      assert.equal(journal.replacedRootWebSearch, process.env.TEST_ORIGINAL_WEB_SEARCH);
      assert.equal(journal.injectedConfigHash, hash(readFileSync(configPath, "utf8")));
      appendFileSync(configPath, '\\n[user_edit]\\nvalue = "keep edit"\\n');
      assert.notEqual(journal.injectedConfigHash, hash(readFileSync(configPath, "utf8")));
      const fallback = restoreNativeCodex({ skipHistory: true, removeProviderTable: true });
      assert.equal(fallback.success, true);
      assert.equal(fallback.artifacts.config.action, "owned-fields-stripped");
      const after = readFileSync(configPath, "utf8");
      const parsed = Bun.TOML.parse(after);
      assert.equal(parsed.web_search, "live");
      assert.deepEqual(parsed.user, { value: "keep" });
      assert.deepEqual(parsed.user_edit, { value: "keep edit" });
      assert.ok(after.includes(process.env.TEST_ORIGINAL_WEB_SEARCH));
      console.log(JSON.stringify({ rollback: true, exact: true, fallback: true }));
    `;
    try {
      const child = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
        cwd: repoRoot(), env: { ...process.env, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "", OPENCODEX_HOME: ocxHome, TEST_ORIGINAL_WEB_SEARCH: assignment },
        encoding: "utf8", timeout: SPAWN_BUDGET_MS,
      });
      expect(child.status, child.error?.message ?? child.stderr).toBe(0);
      expect(JSON.parse(child.stdout.trim())).toEqual({ rollback: true, exact: true, fallback: true });
    } finally { removeTreeWithRetry(fixture); }
  }, SPAWN_BUDGET_MS);
});
