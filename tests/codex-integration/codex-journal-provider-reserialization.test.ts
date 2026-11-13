import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { captureJournalConfigFields, restoreJournalConfigFields } from "../../src/codex/journal-config-restore";

const original = 'model = "native"\n';
const injected = 'model_provider = "opencodex"\n[model_providers.opencodex]\nbase_url = "http://127.0.0.1:10100/v1"\n';
const ownership = { injectedConfigFields: captureJournalConfigFields(injected, {}) };

for (const [name, representation] of Object.entries({
  inline: 'model_providers = { opencodex = { base_url = "http://127.0.0.1:10100/v1" } }\n',
  dotted: 'model_providers.opencodex.base_url = "http://127.0.0.1:10100/v1"\n',
  quoted: '"model_providers"."opencodex".base_url = "http://127.0.0.1:10100/v1"\n',
  parent: '[model_providers]\nopencodex = { base_url = "http://127.0.0.1:10100/v1" }\n',
  parentDotted: '[model_providers]\nopencodex.base_url = "http://127.0.0.1:10100/v1"\n',
  profile: 'profiles = { opencodex = { model_provider = "opencodex" } }\n',
})) {
  test(`reserialized ${name} owned table refuses field restoration`, () => {
    const current = 'model_provider = "opencodex"\nmodel = "user-edited"\n' + representation;
    expect(restoreJournalConfigFields(current, original, ownership)).toBeNull();
    expect(restoreJournalConfigFields(current, original, ownership, true)).toBeNull();
  });
}

test("unrelated dotted providers and header-shaped multiline values retain their bytes", () => {
  const user = 'model_providers.other.base_url = "https://other.example/v1"\nnotes = """\nmodel_providers.opencodex.base_url = "data"\n"""\n';
  const current = 'model_provider = "opencodex"\n' + user + injected.slice(injected.indexOf("["));
  expect(restoreJournalConfigFields(current, original, ownership)).toBe(user);
});

test("wide integers in unrelated dotted provider settings remain opaque", () => {
  const user = 'model_providers.other.counter = 9223372036854775807\n';
  const current = 'model_provider = "opencodex"\n' + user + injected.slice(injected.indexOf("["));
  expect(restoreJournalConfigFields(current, original, ownership)).toBe(user);
});

test.each(["inline", "dotted"])("%s provider refusal preserves the actual journal and config", representation => {
  const root = mkdtempSync(join(tmpdir(), "ocx-journal-reserialized-"));
  const codex = join(root, "codex"), ocx = join(root, "ocx");
  mkdirSync(codex); mkdirSync(ocx);
  writeFileSync(join(codex, "config.toml"), original);
  const current = 'model_provider = "opencodex"\n' + (representation === "inline"
    ? 'model_providers = { opencodex = { base_url = "http://127.0.0.1:10100/v1" } }\n'
    : 'model_providers.opencodex.base_url = "http://127.0.0.1:10100/v1"\n');
  const script = `
    const {readFileSync,writeFileSync}=require("node:fs");
    const {writeJournal,markJournalInjectedState,restoreJournalState}=require("./src/codex/journal");
    const c=process.env.CODEX_HOME;
    writeJournal({currentStateIsNative:true,owner:{kind:"client",apiKeyId:"fixture"}});
    writeFileSync(c+"/config.toml",${JSON.stringify(injected)});
    markJournalInjectedState(${JSON.stringify(injected)},null,{
      injectedOpenaiBaseUrl:null,injectedRealtimeWsBaseUrl:null,injectedCatalogPath:null});
    const before=readFileSync(c+"/opencodex-journal.json","utf8");
    writeFileSync(c+"/config.toml",${JSON.stringify(current)});
    const result=restoreJournalState({preserveConfigEdits:true});
    console.log(JSON.stringify({result,config:readFileSync(c+"/config.toml","utf8"),
      retained:readFileSync(c+"/opencodex-journal.json","utf8")===before}));
  `;
  try {
    const child = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot(), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, HOME: root, USERPROFILE: root, OPENCODEX_HOME: ocx, CODEX_HOME: codex, CODEX_SQLITE_HOME: codex },
    });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim());
    expect(result.result.complete).toBe(false);
    expect(result.result.configRewritten).toBe(false);
    expect(result.config).toBe(current);
    expect(result.retained).toBe(true);
  } finally { removeTreeWithRetry(root); }
});
