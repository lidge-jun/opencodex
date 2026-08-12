import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "ja", "ko", "ru", "tr", "zh", "zh-TW"] as const;

async function readDict(locale: string): Promise<Map<string, string>> {
  const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

// When the English locale grows, `scripts/sync-locale-keys.mjs` seeds the new key into every
// locale as an English placeholder so the build does not break. That is fine for de/ko/ja/zh/ru
// (they each have a human owner who will translate later), but zh-TW is this PR's contribution
// and the review specifically asked for a guard that makes a stale English placeholder fail
// visibly as the English locale evolves. The existing key-set parity test in
// claude-desktop-locale.test.ts catches a *missing* key; this test catches a *present but
// untranslated* one.
//
// The allowlist below is the set of zh-TW keys whose value is intentionally identical to the
// English source: protocol/endpoint names, provider proper nouns, brand names, model family
// identifiers, short UI toggle states, units, and identifiers that Taiwan usage keeps in
// English. Each entry was reviewed against ko/zh (which also keep many of these in English)
// and ja (which translates some) — the decision is a localization choice, not a translation
// gap. Anything *not* on this list that ships an English-identical value is treated as a stale
// placeholder and fails the build.
const ZH_TW_KEEP_ENGLISH: ReadonlySet<string> = new Set([
  // API protocol/endpoint names
  "api.chatCompletionsEndpoint",
  "api.messagesEndpoint",
  "api.modelsEndpoint",
  "api.protocolChatCompletions",
  "api.protocolMessages",
  "api.protocolResponses",
  "api.responsesEndpoint",
  // Provider proper nouns (Taiwan keeps the English brand; "火山方舟" is Mainland usage)
  "provider.name.volcengine",
  "provider.name.volcengineAgentPlan",
  "provider.name.volcengineCodingPlan",
  // Backend/brand names
  "dash.backendAnthropic",
  "dash.backendOpenAI",
  // Claude app labels
  "claude.pageTitle",
  "claude.tabCode",
  "claude.tabDesktop",
  // Claude Desktop model-family labels (proper nouns)
  "claudeDesktop.effort.supported",
  "claudeDesktop.family.fable",
  "claudeDesktop.family.haiku",
  "claudeDesktop.family.opus",
  "claudeDesktop.family.sonnet",
  "claudeDesktop.supports1m",
  "claudeDesktop.title",
  // Claude fast-mode toggle states (short ON/OFF/Auto labels kept in English)
  "claude.fastAuto",
  "claude.fastMode",
  "claude.fastOff",
  "claude.fastOn",
  // Dash / logs short labels, units, and surface badges
  "dash.col.baseUrl",
  "dash.mem.arrayBuffers",
  "dash.mem.external",
  "dash.mem.jsHeapArena",
  "logs.badge.claude",
  "logs.badge.grok",
  "logs.col.estimatedCost",
  "logs.col.tokPerSec",
  "logs.detail.ttft",
  "logs.filter.surface.claude",
  "logs.filter.surface.codex",
  "logs.filter.surface.grok",
  // Modal labels: transport headers, badges, URL field kept in English (zh/ko agree)
  "modal.apiKeyTransportBearer",
  "modal.badge.direct",
  "modal.badge.oauth",
  "modal.baseUrl",
  "modal.baseUrlPlaceholder",
  "modal.forwardCredentials",
  // Nav labels (short product/surface names)
  "nav.api",
  "nav.claude",
  "nav.grok",
  // Other short identifiers, commands, and product names kept in English
  "api.clientConfig.clientOpencode",
  "api.clientConfig.clientPi",
  "api.clientConfig.clientOmp",
  "api.clientConfig.clientHermes",
  "api.clientConfig.clientOpenclaw",
  "api.clientConfig.clientKimi",
  "api.clientConfig.clientGajae",
  "codexAuth.codexApp",
  "codexAuth.creditNextBadge",
  "common.github",
  "grok.title",
  // Integration tabs: client/product proper nouns kept in English
  "integrations.tab.codex",
  "integrations.tab.claude",
  "integrations.tab.grok",
  "integrations.tab.opencode",
  "integrations.tab.pi",
  "integrations.tab.omp",
  "integrations.tab.hermes",
  "integrations.tab.openclaw",
  "integrations.tab.kimi",
  "integrations.tab.gajae",
  "integrations.codex.title",
  // Provider proper nouns kept in English
  "provider.name.commandCodeAuth",
  "provider.name.commandCodeApi",
  // Routing analytics identifiers and short labels
  "routing.revision",
  "routing.unavailable",
  "routing.analyticsP50",
  "routing.analyticsP95",
  "routing.analyticsP99",
  // Format template with placeholder only; other locales (zh/ja/ko) keep it identical to en
  "models.shadowCallOriginal",
  "models.v2Mode_default",
  "models.v2Mode_v1",
  "models.v2Mode_v2",
  "prov.accountId",
  "pws.sort.az",
  "pws.sort.za",
  "startup.protection.shim",
  "startup.shim",
  "storage.card.home",
  "storage.cleanup.preset",
]);

test("zh-TW ships no untranslated English placeholders beyond the intentional allowlist", async () => {
  const en = await readDict("en");
  const tw = await readDict("zh-TW");

  const stale: string[] = [];
  for (const [key, value] of tw) {
    const enValue = en.get(key);
    if (enValue === undefined) continue; // key-set parity is the other test's job
    if (!value.trim()) continue; // blank-value is the other test's job
    if (value === enValue && !ZH_TW_KEEP_ENGLISH.has(key)) {
      stale.push(key);
    }
  }

  // A non-empty stale list means sync-locale-keys.mjs added a key and nobody translated it.
  // Either translate it or, if English is the intended Taiwan rendering, add it to
  // ZH_TW_KEEP_ENGLISH with a comment explaining why.
  expect(
    `zh-TW keys still English placeholders (translate or allowlist): ${stale.join(", ")}`,
  ).toBe(`zh-TW keys still English placeholders (translate or allowlist): `);
});

// Cross-locale key-set parity is also asserted here so the zh-TW contribution carries its own
// complete parity guard, independent of the claude-desktop-locale file.
test("every locale key set matches the English source", async () => {
  const en = [...(await readDict("en")).keys()].sort();
  for (const locale of LOCALES.filter(l => l !== "en")) {
    const other = [...(await readDict(locale)).keys()].sort();
    expect(`${locale} key count: ${other.length}`).toBe(`${locale} key count: ${en.length}`);
    expect(other).toEqual(en);
  }
});
