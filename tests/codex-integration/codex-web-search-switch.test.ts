/**
 * The web-search sidecar's Off row is more than an OpenCodex-side switch. Codex keeps declaring
 * its native hosted `web_search` tool until its OWN config says otherwise, and the tool a client
 * advertises is the one a model reaches for — so an operator who wants an MCP search server to be
 * the only search path needs that root key off. These tests pin the transform that owns it and the
 * injection that is the only thing writing it.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRootWebSearchDisabled,
  isRootWebSearchLine,
  ROOT_WEB_SEARCH_DISABLED_LINE,
  stripInjectedRootWebSearch,
} from "../../src/codex/inject/config-toml";
import { stripOpencodexConfig } from "../../src/codex/inject/remove";
import { OCX_ROUTING_MARKER_LINE } from "../../src/codex/injected-marker";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

const repoRoot = resolveRepoRoot();
const NATIVE = ['model = "gpt-5.6-luna"', "", "[features]", "fast_mode = true", ""].join("\n");
const PAIR = `${OCX_ROUTING_MARKER_LINE}\n${ROOT_WEB_SEARCH_DISABLED_LINE}`;

setDefaultTimeout(SPAWN_BUDGET_MS);

/** Root-section `web_search` lines only: a same-named key inside a table is not ours to touch. */
function rootWebSearchLines(content: string): string[] {
  const lines = content.split("\n");
  const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
  return lines.slice(0, firstTable === -1 ? lines.length : firstTable).filter(isRootWebSearchLine);
}

describe("root web_search ownership", () => {
  test("off writes the marker-owned pair ahead of the first table", () => {
    const out = ensureRootWebSearchDisabled(NATIVE, true);
    expect(out).toContain(PAIR);
    expect(out.indexOf(ROOT_WEB_SEARCH_DISABLED_LINE)).toBeLessThan(out.indexOf("[features]"));
    // A config without any table gets the pair at EOF; TOML root keys may not nest under one.
    expect(ensureRootWebSearchDisabled('model = "gpt-5.6-luna"\n', true))
      .toBe(`model = "gpt-5.6-luna"\n${PAIR}\n`);
  });

  test("applying either direction twice is byte-identical to applying it once", () => {
    const off = ensureRootWebSearchDisabled(NATIVE, true);
    expect(ensureRootWebSearchDisabled(off, true)).toBe(off);
    expect(ensureRootWebSearchDisabled(off, false)).toBe(NATIVE);
    expect(ensureRootWebSearchDisabled(NATIVE, false)).toBe(NATIVE);
  });

  test("a user-owned line is replaced, never duplicated", () => {
    const userOwned = ['web_search = "cached"', 'model = "gpt-5.6-luna"', "", "[features]", "fast_mode = true", ""].join("\n");
    const out = ensureRootWebSearchDisabled(userOwned, true);
    // Two root keys of the same name are invalid TOML: Codex would refuse the whole file.
    expect(rootWebSearchLines(out)).toEqual([ROOT_WEB_SEARCH_DISABLED_LINE]);
    expect(out).not.toContain('"cached"');
  });

  test("a user-owned line survives an injection cycle that does not ask for off", () => {
    const userOwned = 'web_search = "live"\nmodel = "gpt-5.6-luna"\n';
    expect(ensureRootWebSearchDisabled(userOwned, false)).toBe(userOwned);
    expect(stripInjectedRootWebSearch(userOwned)).toBe(userOwned);
  });

  test("a same-named key inside a table is left alone in both directions", () => {
    const tableForm = ['model = "gpt-5.6-luna"', "", "[tools]", "web_search = false", ""].join("\n");
    const out = ensureRootWebSearchDisabled(tableForm, true);
    expect(out).toContain("web_search = false");
    expect(rootWebSearchLines(out)).toEqual([ROOT_WEB_SEARCH_DISABLED_LINE]);
    expect(ensureRootWebSearchDisabled(out, false)).toBe(tableForm);
  });

  test("the purge path drops the pair with the rest of the injection", () => {
    expect(stripOpencodexConfig(ensureRootWebSearchDisabled(NATIVE, true))).not.toContain("web_search");
  });
});

describe("the injection is what writes the switch", () => {
  let codexHome: string;
  let ocxHome: string;

  beforeEach(() => {
    codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-web-search-codex-")));
    ocxHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-web-search-home-")));
    writeFileSync(join(codexHome, "config.toml"), NATIVE, "utf8");
  });

  afterEach(() => {
    removeTreeWithRetry(codexHome);
    removeTreeWithRetry(ocxHome);
  });

  function runInject(configJson: string): { stdout: string; stderr: string; status: number } {
    const script = `
      const { injectCodexConfig } = require("./src/codex/inject");
      injectCodexConfig(10100, JSON.parse(process.env.TEST_OCX_CONFIG)).then(result => {
        console.log(JSON.stringify(result));
      });
    `;
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: "",
        OPENCODEX_HOME: ocxHome,
        TEST_OCX_CONFIG: configJson,
      },
      encoding: "utf8",
      timeout: SPAWN_BUDGET_MS - 5_000,
    });
    return {
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? "",
      status: result.status ?? 1,
    };
  }

  test("the sidecar's Off switch reaches config.toml and is removed again when it comes back on", () => {
    const off = runInject(JSON.stringify({ webSearchSidecar: { enabled: false } }));
    expect(off.status, off.stderr).toBe(0);
    expect(JSON.parse(off.stdout)).toMatchObject({ success: true });
    const disabled = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(rootWebSearchLines(disabled)).toEqual([ROOT_WEB_SEARCH_DISABLED_LINE]);

    const on = runInject(JSON.stringify({ webSearchSidecar: { model: "gpt-5.6-luna" } }));
    expect(on.status, on.stderr).toBe(0);
    expect(JSON.parse(on.stdout)).toMatchObject({ success: true });
    const enabled = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(enabled).not.toContain("web_search");
    // The rest of the injection is untouched by the removal.
    expect(enabled).toContain('model = "gpt-5.6-luna"');
  });
});
