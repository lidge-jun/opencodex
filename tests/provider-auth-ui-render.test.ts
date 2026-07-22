import { createRequire } from "node:module";
import { describe, expect, test } from "bun:test";
import ProviderCatalog from "../gui/src/components/provider-catalog/ProviderCatalog";
import ProviderSummaryPanel from "../gui/src/components/provider-catalog/ProviderSummaryPanel";
import { en } from "../gui/src/i18n/en";
import { I18nContext, interpolate, type TFn } from "../gui/src/i18n/shared";
import { partitionAccountProviderRows } from "../gui/src/provider-workspace/auth";

const requireFromGui = createRequire(new URL("../gui/package.json", import.meta.url));
const { createElement } = requireFromGui("react");
const { renderToStaticMarkup } = requireFromGui("react-dom/server");
const t: TFn = (key, vars) => interpolate(en[key], vars);

describe("provider auth UI rendering", () => {
  test("renders separate OAuth and API summary regions", () => {
    const html = renderToStaticMarkup(createElement("div", { className: "prov-auth-grid" },
      createElement(ProviderSummaryPanel, {
        headingId: "oauth-providers-title",
        title: "OAuth",
        description: "Connected accounts",
        addLabel: "Connect account provider",
        addDescription: "Find another account provider",
        onAdd: () => {},
      }, createElement("div", { className: "oauth-row", "data-provider-id": "xai" }, "xAI (Grok)")),
      createElement(ProviderSummaryPanel, {
        headingId: "api-providers-title",
        title: "API Providers",
        description: "Configured keys",
        emptyMessage: "No API providers configured yet.",
        addLabel: "Add API provider",
        addDescription: "Choose a provider",
        onAdd: () => {},
      }),
    ));

    expect(html).toMatchSnapshot();
  });

  test("renders only unconfigured API-key-capable catalog entries", () => {
    const html = renderToStaticMarkup(createElement(I18nContext.Provider, {
      value: { locale: "en", setLocale: () => {}, t },
    }, createElement(ProviderCatalog, {
      apiKeyOnly: true,
      excludedProviderIds: ["openrouter"],
      presets: [
        { id: "xai", label: "xAI (Grok)", adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", auth: "oauth", supportsApiKey: true },
        { id: "anthropic", label: "Anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", auth: "oauth" },
        { id: "openrouter", label: "OpenRouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", auth: "key" },
      ],
      onSelectPreset: () => {},
      onSelectCustom: () => {},
    })));

    expect(html).toContain("xAI (Grok)");
    expect(html).not.toContain(">Anthropic<");
    expect(html).not.toContain(">OpenRouter<");
    expect(html).toMatchSnapshot();
  });

  test("keeps connected providers out of the searchable picker", () => {
    const rows = [
      { id: "xai", label: "xAI (Grok)" },
      { id: "kimi", label: "Kimi (Moonshot)" },
      { id: "cursor", label: "Cursor" },
    ];
    const result = partitionAccountProviderRows(
      rows,
      { xai: { loggedIn: true } },
      { kimi: true },
      "cur",
    );

    expect(result.connected.map(row => row.id)).toEqual(["xai", "kimi"]);
    expect(result.available.map(row => row.id)).toEqual(["cursor"]);
  });
});
