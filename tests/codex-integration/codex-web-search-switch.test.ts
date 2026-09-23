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
    const out = ensureRootWebSearchDisabled(NATIVE, true).content;
    expect(out).toContain(PAIR);
    expect(out.indexOf(ROOT_WEB_SEARCH_DISABLED_LINE)).toBeLessThan(out.indexOf("[features]"));
    // A config without any table gets the pair at EOF; TOML root keys may not nest under one.
    expect(ensureRootWebSearchDisabled('model = "gpt-5.6-luna"\n', true).content)
      .toBe(`model = "gpt-5.6-luna"\n${PAIR}\n`);
  });

  test("applying either direction twice is byte-identical to applying it once", () => {
    const off = ensureRootWebSearchDisabled(NATIVE, true).content;
    expect(ensureRootWebSearchDisabled(off, true).content).toBe(off);
    expect(ensureRootWebSearchDisabled(off, false).content).toBe(NATIVE);
    expect(ensureRootWebSearchDisabled(NATIVE, false).content).toBe(NATIVE);
  });

  test("a user-owned line is replaced, never duplicated", () => {
    const userOwned = ['web_search = "cached"', 'model = "gpt-5.6-luna"', "", "[features]", "fast_mode = true", ""].join("\n");
    const out = ensureRootWebSearchDisabled(userOwned, true);
    // Two root keys of the same name are invalid TOML: Codex would refuse the whole file.
    expect(rootWebSearchLines(out.content)).toEqual([ROOT_WEB_SEARCH_DISABLED_LINE]);
    expect(out.content).not.toContain('"cached"');
    // Reported so the journal can carry it; the value is not silently gone.
    expect(out.replacedUserLine).toBe('web_search = "cached"');
    expect(out.wroteValue).toBe("disabled");
  });

  test("a user-owned line survives an injection cycle that does not ask for off", () => {
    const userOwned = 'web_search = "live"\nmodel = "gpt-5.6-luna"\n';
    expect(ensureRootWebSearchDisabled(userOwned, false).content).toBe(userOwned);
    expect(stripInjectedRootWebSearch(userOwned)).toBe(userOwned);
  });

  test("a same-named key inside a table is left alone in both directions", () => {
    const tableForm = ['model = "gpt-5.6-luna"', "", "[tools]", "web_search = false", ""].join("\n");
    const out = ensureRootWebSearchDisabled(tableForm, true).content;
    expect(out).toContain("web_search = false");
    expect(rootWebSearchLines(out)).toEqual([ROOT_WEB_SEARCH_DISABLED_LINE]);
    expect(ensureRootWebSearchDisabled(out, false).content).toBe(tableForm);
  });

  test("the purge path drops the pair with the rest of the injection", () => {
    expect(stripOpencodexConfig(ensureRootWebSearchDisabled(NATIVE, true).content)).not.toContain("web_search");
  });

  test("the operator's own mode comes back when the sidecar does", () => {
    const userOwned = 'web_search = "live"\nmodel = "gpt-5.6-luna"\n';
    const off = ensureRootWebSearchDisabled(userOwned, true);
    // A second pass while the switch is still off finds no user line left, and must keep the one
    // it already recorded instead of treating the operator's mode as never having existed.
    const again = ensureRootWebSearchDisabled(off.content, true, { replacedUserLine: off.replacedUserLine });
    expect(again.replacedUserLine).toBe('web_search = "live"');
    const on = ensureRootWebSearchDisabled(again.content, false, { replacedUserLine: again.replacedUserLine });
    expect(rootWebSearchLines(on.content)).toEqual(['web_search = "live"']);
    expect(on.content).not.toContain(OCX_ROUTING_MARKER_LINE);
    expect(on.content).not.toContain("disabled");
    // A key the operator has taken back is not overwritten by the record.
    const reclaimed = `${on.content}web_search = "indexed"\n`;
    expect(ensureRootWebSearchDisabled(reclaimed, false, { replacedUserLine: 'web_search = "live"' }).content)
      .toBe(reclaimed);
  });

  test("a marker-less line the journal proves we wrote is still ours", () => {
    // The Codex app reserializes config.toml: values kept, comments dropped (#1798).
    const rewritten = ensureRootWebSearchDisabled(NATIVE, true).content.replace(`${OCX_ROUTING_MARKER_LINE}\n`, "");
    expect(rootWebSearchLines(rewritten)).toEqual([ROOT_WEB_SEARCH_DISABLED_LINE]);
    expect(ensureRootWebSearchDisabled(rewritten, false, { injectedValue: "disabled" }).content).toBe(NATIVE);
    // Without that evidence the line is the operator's own choice and stays.
    expect(ensureRootWebSearchDisabled(rewritten, false).content).toBe(rewritten);
    expect(ensureRootWebSearchDisabled(rewritten, false, { injectedValue: "cached" }).content).toBe(rewritten);
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

  test("a hand-set mode survives the off/on round trip, journal and comment-dropping rewrite included", () => {
    const userOwned = `web_search = "live"\n${NATIVE}`;
    writeFileSync(join(codexHome, "config.toml"), userOwned, "utf8");

    const off = runInject(JSON.stringify({ webSearchSidecar: { enabled: false } }));
    expect(off.status, off.stderr).toBe(0);
    expect(rootWebSearchLines(readFileSync(join(codexHome, "config.toml"), "utf8")))
      .toEqual([ROOT_WEB_SEARCH_DISABLED_LINE]);
    // Two root keys of the same name are invalid TOML, so the operator's line has to leave the
    // file; the journal is what remembers it was there.
    const journal = JSON.parse(readFileSync(join(codexHome, "opencodex-journal.json"), "utf8"));
    expect(journal.injectedRootWebSearch).toBe("disabled");
    expect(journal.replacedRootWebSearch).toBe('web_search = "live"');

    // A Codex app reserialize keeps values and drops comments (#1798): our line is left without the
    // marker that names its owner.
    const rewritten = readFileSync(join(codexHome, "config.toml"), "utf8")
      .replace(`${OCX_ROUTING_MARKER_LINE}\n${ROOT_WEB_SEARCH_DISABLED_LINE}`, ROOT_WEB_SEARCH_DISABLED_LINE);
    writeFileSync(join(codexHome, "config.toml"), rewritten, "utf8");

    const on = runInject(JSON.stringify({ webSearchSidecar: { model: "gpt-5.6-luna" } }));
    expect(on.status, on.stderr).toBe(0);
    const enabled = readFileSync(join(codexHome, "config.toml"), "utf8");
    // Both halves: the marker-less residue is recognized as ours by its recorded value, and the
    // mode the operator had is back rather than replaced by the sidecar's own silence.
    expect(enabled).not.toContain("disabled");
    expect(rootWebSearchLines(enabled)).toEqual(['web_search = "live"']);
  });
});
