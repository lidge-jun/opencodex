import { expect, test } from "bun:test";
import { captureJournalConfigFields, restoreJournalConfigFields } from "../../src/codex/journal-config-restore";
import { MANAGED_AGENTS_TABLE_MARKER, MANAGED_SUBAGENT_DEFAULT_MARKER } from "../../src/codex/subagent-defaults";

const url = "http://127.0.0.1:10100/v1";
const ownership = { injectedOpenaiBaseUrl: url, injectedRealtimeWsBaseUrl: null, injectedCatalogPath: null };
const original = 'model = "before"\nmodel_provider = "openai"\n';
const injected = `openai_base_url = "${url}"\nmodel = "before"\n[model_providers.opencodex]\nname = "OpenCodex"\nbase_url = "${url}"\n`;
const journal = { ...ownership, injectedConfigFields: captureJournalConfigFields(injected, ownership) };

test("recorded blocks restore independently of edited preferences and opaque multiline data", () => {
  const edits = '\n[hooks]\nnotify = """\n[model_providers.opencodex]\nopenai_base_url = "not a key"\n"""\n';
  const result = restoreJournalConfigFields(injected.replace('model = "before"', 'model = "provider/user-edit"') + edits, original, journal);
  expect(result).toContain('model = "provider/user-edit"');
  expect(result).toContain('model_provider = "openai"');
  expect(result).toContain(edits.trimStart());
  expect(result).not.toContain('name = "OpenCodex"');
  expect(result).not.toContain(url);
});

test("a modified owned block refuses all writes", () => {
  expect(restoreJournalConfigFields(injected.replace('name = "OpenCodex"', 'name = "Edited"'), original, journal)).toBeNull();
});

test("quoted keys and cosmetic comments compare by value", () => {
  const current = injected.replace('openai_base_url =', "'openai_base_url' =").replace('name = "OpenCodex"', "name='OpenCodex' # cosmetic");
  const result = restoreJournalConfigFields(current, original, journal);
  expect(result).not.toBeNull();
  expect(result).not.toContain(url);
});

test("legacy records without per-key evidence cannot guess ownership from comments", () => {
  expect(restoreJournalConfigFields(injected, original, {})).toBeNull();
});

test("a model edited before reinjection never becomes cleanup-owned", () => {
  const edited = injected.replace('model = "before"', 'model = "provider/user-edit"');
  const refreshed = { ...ownership, injectedConfigFields: captureJournalConfigFields(edited, ownership) };
  expect(restoreJournalConfigFields(edited, original, refreshed)).toContain('model = "provider/user-edit"');
});

test("an unchanged user web-search override is not captured as injection-owned", () => {
  const edited = injected.replace('model = "before"', 'model = "before"\nweb_search = "live"');
  const refreshed = { ...ownership, injectedConfigFields: captureJournalConfigFields(edited, ownership) };
  expect(restoreJournalConfigFields(edited, original, refreshed)).toContain('web_search = "live"');
});

test("already removed owned keys stay absent; duplicated owned keys refuse", () => {
  const removed = restoreJournalConfigFields(injected.replace(`openai_base_url = "${url}"\n`, ""), original, journal);
  expect(removed).not.toBeNull();
  expect(removed).not.toContain("openai_base_url");
  expect(restoreJournalConfigFields(`openai_base_url = "${url}"\n` + injected, original, journal)).toBeNull();
});

test("restoring a removed original block does not swallow unrelated root settings", () => {
  const baseline = 'model = "before"\n[profiles.opencodex]\nmodel = "native"\n';
  const routed = `openai_base_url = "${url}"\nmodel = "before"\n`;
  const snapshot = { ...ownership, injectedConfigFields: captureJournalConfigFields(routed, ownership) };
  const result = restoreJournalConfigFields(routed + 'approval_policy = "never"\n', baseline, snapshot)!;
  expect(Bun.TOML.parse(result)).toEqual({ model: "before", approval_policy: "never", profiles: { opencodex: { model: "native" } } });
});

test("managed defaults remove their generated empty table while user extensions survive", () => {
  const defaults = `${MANAGED_AGENTS_TABLE_MARKER}\n[agents]\n${MANAGED_SUBAGENT_DEFAULT_MARKER}\ndefault_subagent_model = "managed-model"\n`;
  const record = { ...journal, injectedSubagentDefaults: { default_subagent_model: "managed-model" } };
  expect(restoreJournalConfigFields(injected + defaults, original, record)).not.toContain("[agents]");
  const extended = restoreJournalConfigFields(injected + defaults + 'max_threads = 7\n', original, record)!;
  expect(extended).toContain("[agents]\nmax_threads = 7");
  expect(extended).not.toContain("Managed by opencodex");
});

test("a user-edited subagent default survives with its stale ownership marker removed", () => {
  const defaults = `${MANAGED_AGENTS_TABLE_MARKER}\n[agents]\n${MANAGED_SUBAGENT_DEFAULT_MARKER}\ndefault_subagent_model = "user-edit"\n`;
  const record = { ...journal, injectedSubagentDefaults: { default_subagent_model: "managed-model" } };
  const result = restoreJournalConfigFields(injected + defaults, original, record)!;
  expect(result).toContain('default_subagent_model = "user-edit"');
  expect(result).not.toContain("Managed by opencodex");
});
