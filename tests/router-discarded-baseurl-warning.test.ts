import { expect, test } from "bun:test";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

/**
 * A pinned registry entry outranks a saved `baseUrl`. That behavior is intentional and is
 * asserted in tests/router-template-baseurl.test.ts; these tests cover the diagnostic that
 * tells the user it happened, so a wrong-region URL stops surfacing as a bare 401.
 *
 * `google` is the pinned fixture: a fixed remote registry endpoint, no `allowBaseUrlOverride`.
 * Warnings dedupe per (provider, discarded URL, effective URL), so each test uses a distinct
 * discarded URL and the suite stays order-independent.
 */
const PINNED_PROVIDER = "google";
const PINNED_REGISTRY_BASE_URL = "https://generativelanguage.googleapis.com";

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
    configFor(PINNED_PROVIDER, { adapter: "google", baseUrl } as OcxProviderConfig),
    `${PINNED_PROVIDER}/gemini-3-pro`,
    times,
  );
}

test("warns when a pinned provider discards a configured baseUrl", () => {
  const warnings = routePinned("https://vertex-relay.example.test/v1");

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`provider "${PINNED_PROVIDER}"`);
  // The configured side is named by origin only; its path is never logged.
  expect(warnings[0]).toContain("https://vertex-relay.example.test/…");
  expect(warnings[0]).not.toContain("/v1");
  // The effective side is a registry constant, so it is printed in full.
  expect(warnings[0]).toContain(PINNED_REGISTRY_BASE_URL);
});

test("routing is unchanged by the warning", () => {
  const config = configFor(PINNED_PROVIDER, {
    adapter: "google",
    baseUrl: "https://routing-unchanged.example.test/v1",
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    expect(routeModel(config, `${PINNED_PROVIDER}/gemini-3-pro`).provider.baseUrl)
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

test("redacts a token embedded in the URL path, which redactUrlForLog keeps", () => {
  const warnings = routePinned("https://path-secret.example.test/v1/sk-live-ijklmnop/chat");

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("path-secret.example.test");
  expect(warnings[0]).not.toContain("sk-live-ijklmnop");
});

test("withholds an opaque high-entropy path credential with no recognizable prefix", () => {
  // The case pattern-based redaction cannot catch: an account-scoped route token that looks
  // like an ordinary path segment. Nothing in redactSecretString matches it, so the only safe
  // answer is to log no path at all.
  const opaque = "8fK2mP7qR4nV6xZ1cT5wY9bJ";
  const warnings = routePinned(`https://opaque.example.test/v1/${opaque}`);

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain(opaque);
  // The origin still names the mismatch, and the marker shows a path existed.
  expect(warnings[0]).toContain("https://opaque.example.test/…");
});

test("withholds every path segment, not just the credential-looking one", () => {
  const warnings = routePinned("https://segments.example.test/tenant-42/v1/route/Zx9Qw");

  expect(warnings).toHaveLength(1);
  for (const segment of ["tenant-42", "route", "Zx9Qw"]) {
    expect(warnings[0]).not.toContain(segment);
  }
});

test("warns once for URLs that differ only in their credentials", () => {
  const warnings = [
    ...routePinned("https://alice:secret-one@shared-endpoint.example.test/v1"),
    ...routePinned("https://bob:secret-two@shared-endpoint.example.test/v1"),
  ];

  // Both redact to the same endpoint, so the second is a repeat of a mismatch already reported.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain("secret-one");
  expect(warnings[0]).not.toContain("secret-two");
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

/**
 * The split this diagnostic exists for (#457): the Beijing Personal Edition entry is pinned, and
 * the international Team Edition is a separate provider that honors its configured endpoint.
 * Locking it here means a change to either registry entry has to face this test.
 */
const ALIBABA_BEIJING_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const ALIBABA_INTL_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

test("alibaba-token-plan is pinned to Beijing and warns about a saved international URL", () => {
  const config = configFor("alibaba-token-plan", {
    adapter: "openai-chat",
    baseUrl: ALIBABA_INTL_BASE_URL,
  });
  const warnings = routeCapturingWarnings(config, "alibaba-token-plan/qwen3.8-max");

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("token-plan.ap-southeast-1.maas.aliyuncs.com");
  expect(warnings[0]).toContain(ALIBABA_BEIJING_BASE_URL);

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    expect(routeModel(config, "alibaba-token-plan/qwen3.8-max").provider.baseUrl)
      .toBe(ALIBABA_BEIJING_BASE_URL);
  } finally {
    console.warn = originalWarn;
  }
});

test("alibaba-token-plan-intl honors its configured international endpoint silently", () => {
  const config = configFor("alibaba-token-plan-intl", {
    adapter: "openai-chat",
    baseUrl: ALIBABA_INTL_BASE_URL,
  });

  expect(routeCapturingWarnings(config, "alibaba-token-plan-intl/qwen3.7-max")).toEqual([]);
  expect(routeModel(config, "alibaba-token-plan-intl/qwen3.7-max").provider.baseUrl)
    .toBe(ALIBABA_INTL_BASE_URL);
});

test("alibaba-token-plan-intl honors its pay-as-you-go choice too", () => {
  const payg = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const config = configFor("alibaba-token-plan-intl", { adapter: "openai-chat", baseUrl: payg });

  expect(routeCapturingWarnings(config, "alibaba-token-plan-intl/qwen3.7-max")).toEqual([]);
  expect(routeModel(config, "alibaba-token-plan-intl/qwen3.7-max").provider.baseUrl).toBe(payg);
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

