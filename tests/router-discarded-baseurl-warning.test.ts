import { expect, test } from "bun:test";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

/**
 * A pinned registry entry outranks a saved `baseUrl`. That behavior is intentional and is
 * asserted in tests/router-template-baseurl.test.ts; these tests cover the diagnostic that
 * tells the user it happened, so a wrong-region URL stops surfacing as a bare 401.
 *
 * `anthropic` is the pinned fixture: a fixed remote registry endpoint, no `allowBaseUrlOverride`.
 * Warnings dedupe per (provider, discarded URL, effective URL), so each test uses a distinct
 * discarded URL and the suite stays order-independent.
 */
const PINNED_PROVIDER = "anthropic";
const PINNED_REGISTRY_BASE_URL = "https://api.anthropic.com";

function configFor(providerName: string, provider: OcxProviderConfig): OcxConfig {
  return {
    port: 10100,
    defaultProvider: providerName,
    providers: { [providerName]: provider },
  };
}

/** Route once, capturing anything the router writes to `console.warn`. */
function routeCapturingWarnings(config: OcxConfig, model: string, times = 1): string[] {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    for (let i = 0; i < times; i++) routeModel(config, model);
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function routePinned(baseUrl: unknown, times = 1): string[] {
  return routeCapturingWarnings(
    configFor(PINNED_PROVIDER, { adapter: "anthropic", baseUrl } as OcxProviderConfig),
    `${PINNED_PROVIDER}/claude-sonnet-5`,
    times,
  );
}

test("warns when a pinned provider discards a configured baseUrl", () => {
  const discarded = "https://vertex-relay.example.test/v1";
  const warnings = routePinned(discarded);

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`provider "${PINNED_PROVIDER}"`);
  expect(warnings[0]).toContain(discarded);
  expect(warnings[0]).toContain(PINNED_REGISTRY_BASE_URL);
});

test("routing is unchanged by the warning", () => {
  const config = configFor(PINNED_PROVIDER, {
    adapter: "anthropic",
    baseUrl: "https://routing-unchanged.example.test/v1",
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    expect(routeModel(config, `${PINNED_PROVIDER}/claude-sonnet-5`).provider.baseUrl)
      .toBe(PINNED_REGISTRY_BASE_URL);
  } finally {
    console.warn = originalWarn;
  }
});

test("warns once per provider and URL pair across repeated routing", () => {
  expect(routePinned("https://repeated.example.test/v1", 5)).toHaveLength(1);
});

test("redacts credentials in the discarded URL", () => {
  const warnings = routePinned("https://user:hunter2@redacted.example.test/v1?api_key=sk-live-abcdefgh");

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("redacted.example.test");
  expect(warnings[0]).not.toContain("hunter2");
  expect(warnings[0]).not.toContain("sk-live-abcdefgh");
});

for (const [label, baseUrl] of [
  ["an absent baseUrl", undefined],
  ["an empty baseUrl", ""],
  ["a whitespace-only baseUrl", "   \t"],
  ["an unresolved placeholder", "https://{region}.anthropic.example/v1"],
  ["the registry endpoint itself", PINNED_REGISTRY_BASE_URL],
  ["the registry endpoint with a trailing slash", `${PINNED_REGISTRY_BASE_URL}/`],
  ["the registry endpoint with surrounding space", `  ${PINNED_REGISTRY_BASE_URL}  `],
] as const) {
  test(`stays silent for ${label}`, () => {
    expect(routePinned(baseUrl)).toEqual([]);
  });
}

test("stays silent for a non-string baseUrl (control: unchanged pre-existing behavior)", () => {
  // A non-string baseUrl is already dropped by the `typeof` guard in routedProviderConfig and is
  // a config-schema concern, not this diagnostic's. Pinned here so the omission stays deliberate.
  expect(routePinned(42 as unknown as string)).toEqual([]);
});

for (const { label, id, adapter, baseUrl } of [
  {
    label: "a provider that opts into baseUrl override",
    id: "ollama",
    adapter: "openai-chat",
    baseUrl: "http://ollama.lan:3210/v1",
  },
  {
    label: "a resolved registry template",
    id: "azure-openai",
    adapter: "azure-openai",
    baseUrl: "https://myres.openai.azure.com/openai",
  },
  {
    label: "a provider absent from the registry",
    id: "my-custom-provider",
    adapter: "openai-chat",
    baseUrl: "https://custom.example.test/v1",
  },
] as const) {
  test(`stays silent for ${label}, whose baseUrl is honored`, () => {
    const config = configFor(id, { adapter, baseUrl } as OcxProviderConfig);
    const warnings = routeCapturingWarnings(config, `${id}/model`);

    expect(warnings).toEqual([]);
    expect(routeModel(config, `${id}/model`).provider.baseUrl).toBe(baseUrl);
  });
}
