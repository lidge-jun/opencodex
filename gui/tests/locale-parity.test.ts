import { expect, test } from "bun:test";

const LOCALES = ["en", "de", "fr", "ja", "ko", "ru", "tr", "zh", "zh-TW"] as const;

async function readDict(locale: string): Promise<Map<string, string>> {
  const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
  const out = new Map<string, string>();
  // NOT anchored to the line start: these catalogs pack several entries onto one line, and a
  // `^\s*`-anchored pattern silently reads only the first of them. That made this parity check
  // report a phantom missing key while the catalogs were in fact identical.
  for (const m of src.matchAll(/"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/g)) {
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
  // A bare em dash: the "no Reasoning control" marker is a symbol, not copy.
  "integrations.cursor.noControl",
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
  // A literal filename, not prose: AGENTS.md is the file Codex reads from the
  // working directory, and Taiwan renders it the same way every other locale does.
  "codexSet.layer.agents-md",
  // "{position} / {total}" is punctuation and two placeholders, identical in
  // every locale that ships it - there are no words to render in Chinese.
  "codexSet.custom.navPosition",
  // "{position} / {total}" - a numeric position, identical in every language for the
  // same reason navPosition above is.
  "codexSet.base.position",
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
  "api.clientConfig.clientDsh",
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
  "integrations.tab.dsh",
  "integrations.tab.mcode",
  "integrations.tab.zcode",
  "api.clientConfig.clientMcode",
  "api.clientConfig.clientZcode",
  "integrations.tab.prime",
  "api.clientConfig.clientPrime",
  "integrations.tab.aside",
  "api.clientConfig.clientAside",
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
  // A one-glyph marker plus the model id, sitting inside a narrow table column. The glyph is
  // an icon-shaped affordance rather than a word, and its meaning is carried by the tooltip
  // (`logs.badge.interceptedHelperTitle`), which IS translated. Localizing the glyph per
  // locale would make the same badge unrecognizable across a screenshot or a bug report for
  // no gain in comprehension.
  "logs.badge.interceptedHelper",
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
  // Cursor product names and UI labels Cursor itself renders in English
  "integrations.tab.cursor",
  "integrations.cursor.title",
  "integrations.cursor.privateInference",
  "integrations.cursor.baseUrl",
  // Cost cells are a fixed `$0.1401` / `≥$0.1401` in every locale (the column header is the
  // untranslated `~$`); the templates are pure placeholders on purpose.
  "logs.cost.approximate",
  "logs.cost.lowerBound",
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

/**
 * The Cursor tab landed with six locales carrying English copies that key-set parity could
 * not see. This guard is scoped to the Cursor keys in EVERY locale: a value equal to English
 * is a placeholder unless it is a brand or a label Cursor itself renders in English.
 */
const CURSOR_KEEP_ENGLISH: ReadonlySet<string> = new Set([
  "integrations.tab.cursor",
  "integrations.cursor.title",
  // Em-dash marker, identical in every locale.
  "integrations.cursor.noControl",
  "integrations.cursor.privateInference",
  "integrations.cursor.baseUrl",
  // "API Key" is the literal field name in Cursor's gateway form.
  "integrations.cursor.apiKey",
]);

/** Per-locale cognates: English-identical values that are correct in that one locale only. */
const CURSOR_KEEP_ENGLISH_BY_LOCALE: Record<string, ReadonlySet<string>> = {
  // "Model" is the Turkish word too; the table header is a true cognate, not a placeholder.
  tr: new Set(["integrations.cursor.colModel"]),
};

test("every locale translates the Cursor tab beyond the brand labels", async () => {
  const en = await readDict("en");
  for (const locale of LOCALES.filter(l => l !== "en")) {
    const dict = await readDict(locale);
    const stale: string[] = [];
    for (const [key, value] of dict) {
      if (!key.startsWith("integrations.cursor.") && !key.startsWith("integrations.detail.cursor")) continue;
      if (CURSOR_KEEP_ENGLISH.has(key)) continue;
      if (CURSOR_KEEP_ENGLISH_BY_LOCALE[locale]?.has(key)) continue;
      if (value === en.get(key)) stale.push(key);
    }
    expect(`${locale} Cursor keys still English placeholders: ${stale.join(", ")}`)
      .toBe(`${locale} Cursor keys still English placeholders: `);
  }
});

const DSH_VISIBLE_COPY: Record<(typeof LOCALES)[number], readonly [string, string, string]> = {
  en: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex manages only llm-pi-ai.providers.opencodex in $DSH_HOME/settings.yaml. DSH hot reloads this provider; your default model and deepseek-official stay unchanged. Currently loopback-only; no real credential is written.",
  ],
  fr: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex gère uniquement llm-pi-ai.providers.opencodex dans $DSH_HOME/settings.yaml. DSH recharge ce fournisseur à chaud ; votre modèle par défaut et deepseek-official restent inchangés. Seule l’adresse de bouclage est actuellement prise en charge ; aucun identifiant réel n’est écrit.",
  ],
  de: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex verwaltet nur llm-pi-ai.providers.opencodex in $DSH_HOME/settings.yaml. DSH lädt diesen Anbieter im laufenden Betrieb neu; Ihr Standardmodell und deepseek-official bleiben unverändert. Derzeit nur über Loopback; es werden keine echten Zugangsdaten geschrieben.",
  ],
  ja: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex が管理するのは $DSH_HOME/settings.yaml 内の llm-pi-ai.providers.opencodex だけです。DSH はこのプロバイダーをホットリロードし、既定のモデルと deepseek-official は変更しません。現在はループバック専用で、実際の認証情報は書き込みません。",
  ],
  ko: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex는 $DSH_HOME/settings.yaml의 llm-pi-ai.providers.opencodex만 관리합니다. DSH는 이 provider를 hot reload하며 기본 model과 deepseek-official은 변경하지 않습니다. 현재 loopback 전용이며 실제 credential을 기록하지 않습니다.",
  ],
  ru: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex управляет только llm-pi-ai.providers.opencodex в $DSH_HOME/settings.yaml. DSH применяет этот провайдер горячей перезагрузкой; модель по умолчанию и deepseek-official остаются без изменений. Сейчас поддерживается только loopback; реальные учётные данные не записываются.",
  ],
  tr: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex yalnızca $DSH_HOME/settings.yaml içindeki llm-pi-ai.providers.opencodex bölümünü yönetir. DSH bu sağlayıcıyı çalışırken yeniden yükler; varsayılan modeliniz ve deepseek-official değişmez. Şimdilik yalnızca geri döngü desteklenir; gerçek kimlik bilgisi yazılmaz.",
  ],
  zh: [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex 只管理 $DSH_HOME/settings.yaml 中的 llm-pi-ai.providers.opencodex。DSH 会热重载该 provider；你的默认模型和 deepseek-official 保持不变。目前仅支持环回地址，且不会写入真实凭据。",
  ],
  "zh-TW": [
    "DeepSeek Harness (DSH)",
    "DSH",
    "OpenCodex 只管理 $DSH_HOME/settings.yaml 中的 llm-pi-ai.providers.opencodex。DSH 會熱重載該 provider；你的預設模型與 deepseek-official 維持不變。目前僅支援 loopback，且不會寫入真實憑證。",
  ],
};

test("every locale carries the exact DSH label and ownership semantics", async () => {
  for (const locale of LOCALES) {
    const dict = await readDict(locale);
    const expected = DSH_VISIBLE_COPY[locale];
    expect(dict.get("api.clientConfig.clientDsh")).toBe(expected[0]);
    expect(dict.get("integrations.tab.dsh")).toBe(expected[1]);
    expect(dict.get("integrations.semantics.dsh")).toBe(expected[2]);
  }
});

/*
 * Aside's ownership sentence carries three facts a user acts on, and each is
 * wrong in a different way if a translation drops it: which key OpenCodex
 * touches (`providers.opencodex`, so the rest of the file is untouched), where
 * the file lives (`~/.aside/u/`, which is per-account and not the bare
 * `~/.aside`), and that Aside rewrites the file while running, so a change does
 * not take until the app is fully quit and reopened. A translator working from
 * the English can render the prose naturally and still lose one.
 *
 * The identifiers are asserted rather than the sentence, unlike the DSH case
 * above: pinning full translated strings freezes wording, and these three tokens
 * are the part that must survive translation unchanged.
 */
test("every locale keeps the three facts Aside's ownership sentence carries", async () => {
  for (const locale of LOCALES) {
    const dict = await readDict(locale);
    expect(dict.get("api.clientConfig.clientAside"), locale).toBe("Aside");
    expect(dict.get("integrations.tab.aside"), locale).toBe("Aside");

    const semantics = dict.get("integrations.semantics.aside") ?? "";
    expect(semantics, `${locale} names the managed key`).toContain("providers.opencodex");
    expect(semantics, `${locale} names the per-account root`).toContain("~/.aside/u/");
    // Aside rewrites models.json as it runs, so a restart hint is not optional.
    expect(semantics.length, `${locale} keeps the restart warning`).toBeGreaterThan(80);
  }
});
