import { expect, test } from "bun:test";
import { captureJournalConfigFields, restoreJournalConfigFields } from "../../src/codex/journal-config-restore";

const url = "http://127.0.0.1:10100/v1";
const ownership = { injectedOpenaiBaseUrl: url, injectedRealtimeWsBaseUrl: url, injectedCatalogPath: "/fixture/catalog.json" };
const original = 'model = "before"\nopenai_base_url = "https://native.example/v1"\n';
const injected = `openai_base_url = "${url}"\nexperimental_realtime_ws_base_url = "${url}"\nmodel_catalog_json = "/fixture/catalog.json"\nmodel = "before"\n[model_providers.opencodex]\nname = "OCX"\nbase_url = "${url}"\n`;
const journal = { ...ownership, injectedConfigFields: captureJournalConfigFields(injected, ownership) };

test("explicit recovery restores only recorded routing fields and blocks, preserving unrelated bytes", () => {
  const edits = 'model = "user/model"\nweb_search = "live"\n';
  const suffix = '[hooks]\nnotify = ["hook"]\n[projects.\'/fixture/work\']\ntrust_level = "trusted"\n';
  const current = injected.replaceAll(url, "https://edited.example/v1")
    .replace('model = "before"\n', edits).replace('/fixture/catalog.json', '/user/catalog.json') + suffix;
  expect(restoreJournalConfigFields(current, original, journal)).toBeNull();
  expect(restoreJournalConfigFields(current, original, journal, true)).toBe('openai_base_url = "https://native.example/v1"\n' + edits + suffix);
});

test("one-operation force never claims an unrecorded routing key by URL resemblance", () => {
  const current = 'openai_base_url = "http://127.0.0.1:10100/v1"\nmodel = "user"\n';
  expect(restoreJournalConfigFields(current, original, {}, true)).toBeNull();
});

test("marker text inside multiline data cannot authorize legacy cleanup", () => {
  const current = 'note = """\n# Auto-injected by opencodex\n"""\nopenai_base_url = "https://edited.example/v1"\n';
  expect(restoreJournalConfigFields(current, original, {}, true)).toBeNull();
});

test("legacy explicit recovery recognizes exactly marked blocks, preserving neighboring tables", () => {
  const current = '# Auto-injected by opencodex\n[model_providers.opencodex]\nbase_url = "https://edited.example/v1"\n[hooks]\nnotify = ["user"]\n';
  expect(restoreJournalConfigFields(current, '', {}, true)).toBe('[hooks]\nnotify = ["user"]\n');
  expect(restoreJournalConfigFields(current.replace('# Auto-injected by opencodex', '# user mentions Auto-injected by opencodex'), '', {}, true)).toBeNull();
});

test("unsupported nested and duplicated owned tables refuse rather than stripping a partial block", () => {
  const child = injected + '[model_providers.opencodex.http_headers]\ncustom = "user"\n';
  expect(restoreJournalConfigFields(child, original, journal, true)).toBeNull();
  expect(restoreJournalConfigFields(injected + '[model_providers.opencodex]\nname = "duplicate"\n', original, journal, true)).toBeNull();
});

test("recovery preserves the user's changed web-search preference", () => {
  const before = 'web_search = "cached"\n';
  const record = {injectedRootWebSearch: "disabled", injectedConfigFields: {web_search: 'web_search = "disabled"'}};
  expect(restoreJournalConfigFields('web_search = "live"\n', before, record, true)).toBe('web_search = "live"\n');
});

test("consecutive marked owned blocks are both removed without consuming the next block's marker", () => {
  const current = '# Auto-injected by opencodex\n[model_providers.opencodex]\nbase_url = "https://edited.example/v1"\n'
    + '# Auto-injected by opencodex\n[profiles.opencodex]\nmodel_provider = "opencodex"\n[hooks]\nnotify = ["user"]\n';
  expect(restoreJournalConfigFields(current, '', {}, true)).toBe('[hooks]\nnotify = ["user"]\n');
});
