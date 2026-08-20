import { expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { providerDestinationConfigError } from "../src/lib/destination-policy";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

/**
 * Regression coverage for the allowBaseUrlOverride opt-in on the anthropic
 * registry entry.
 *
 * Before the opt-in, the pinned registry endpoint silently outranked a saved
 * baseUrl and the router emitted the discarded-baseUrl diagnostic (see
 * tests/router-discarded-baseurl-warning.test.ts, which now pins google as
 * its fixture). Users routing Claude traffic through a local relay or an
 * enterprise gateway therefore could not redirect the provider at all. These
 * tests pin the new contract: a resolved user baseUrl wins, no warning fires,
 * and the registry endpoint remains the default seeded value.
 */
const PROVIDER = "anthropic";
const REGISTRY_BASE_URL = "https://api.anthropic.com";
const MODEL = PROVIDER + "/claude-sonnet-5";

function configFor(provider: OcxProviderConfig): OcxConfig {
  return {
    port: 10100,
    defaultProvider: PROVIDER,
    providers: { [PROVIDER]: provider },
  };
}

function routeCapturingWarnings(config: OcxConfig): { baseUrl: string; warnings: string[] } {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const route = routeModel(config, MODEL);
    return { baseUrl: route.provider.baseUrl, warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("anthropic honors a configured baseUrl override", () => {
  const { baseUrl, warnings } = routeCapturingWarnings(configFor({
    adapter: "anthropic",
    baseUrl: "https://claude-relay.example.test",
  } as OcxProviderConfig));

  expect(baseUrl).toBe("https://claude-relay.example.test");
  // The override is applied, so the discarded-baseUrl diagnostic must not fire.
  expect(warnings).toHaveLength(0);
});

test("anthropic keeps the registry endpoint when the seeded baseUrl is unchanged", () => {
  // providerConfigSeed copies the registry baseUrl into every saved config, so the
  // no-override case reaches the router as a config whose baseUrl equals the registry URL.
  const { baseUrl, warnings } = routeCapturingWarnings(configFor({
    adapter: "anthropic",
    baseUrl: REGISTRY_BASE_URL,
  } as OcxProviderConfig));

  expect(baseUrl).toBe(REGISTRY_BASE_URL);
  expect(warnings).toHaveLength(0);
});

test("anthropic requires a resolved baseUrl once override is enabled", () => {
  // allowBaseUrlOverride providers fail closed on a missing baseUrl instead of silently
  // re-pinning the registry endpoint; the seed guarantees real configs always carry one.
  expect(() => routeModel(configFor({
    adapter: "anthropic",
  } as OcxProviderConfig), MODEL)).toThrow(/Invalid baseUrl/);
});

test("anthropic rejects an unresolved template baseUrl override", () => {
  expect(() => routeModel(configFor({
    adapter: "anthropic",
    baseUrl: "https://{region}.example.test",
  } as OcxProviderConfig), MODEL)).toThrow(/Invalid baseUrl/);
});

/**
 * Security regression (CodeRabbit, PR #2109): anthropic is an OAuth provider, so an
 * allowBaseUrlOverride endpoint receives bearer credentials. A cleartext http override to a
 * non-local destination must be rejected on BOTH enforcement paths: routing (normal requests,
 * via assertProviderDestinationAllowed) and providerDestinationConfigError, the shared gate
 * that config validation and the model-discovery outbound layer (providerGet/providerPost in
 * src/lib/provider-outbound.ts) consult before any fetch.
 */
test("anthropic rejects a cleartext http override on the routing path", () => {
  expect(() => routeModel(configFor({
    adapter: "anthropic",
    baseUrl: "http://claude-relay.example.test",
  } as OcxProviderConfig), MODEL)).toThrow(/https/);
});

test("anthropic rejects a cleartext http override on the discovery/config gate", () => {
  expect(providerDestinationConfigError(PROVIDER, {
    baseUrl: "http://claude-relay.example.test",
  } as OcxProviderConfig)).toMatch(/https/);
  // The https form of the same destination stays accepted.
  expect(providerDestinationConfigError(PROVIDER, {
    baseUrl: "https://claude-relay.example.test",
  } as OcxProviderConfig)).toBeNull();
});

test("anthropic keeps http for an explicitly local relay", () => {
  // Loopback and allowPrivateNetwork opt-ins are the documented local-transport escape
  // hatch; the https requirement must not break a localhost proxy.
  const { baseUrl, warnings } = routeCapturingWarnings(configFor({
    adapter: "anthropic",
    baseUrl: "http://127.0.0.1:8787",
    allowPrivateNetwork: true,
  } as OcxProviderConfig));

  expect(baseUrl).toBe("http://127.0.0.1:8787");
  expect(warnings).toHaveLength(0);
});


test("a public http override cannot buy transport security with allowPrivateNetwork", () => {
  // allowPrivateNetwork states that a destination is intentionally LOCAL. It is not a waiver of
  // transport security. Reading it before classifying the address let http://attacker.example
  // carry this provider's OAuth bearer in cleartext to a public host.
  //
  // Routing REFUSES rather than downgrading: a request must not reach an endpoint that would
  // receive the token in the clear, so this fails closed at the route boundary.
  expect(() => routeCapturingWarnings(configFor({
    adapter: "anthropic",
    baseUrl: "http://attacker.example/v1",
    allowPrivateNetwork: true,
  } as OcxProviderConfig))).toThrow(/must use https/);
});

test("the seeded https endpoint is still reachable with the opt-in set", () => {
  // Guard against over-correcting: the fix must refuse cleartext to a public host without
  // refusing an ordinary https override that happens to carry the flag.
  const { baseUrl, warnings } = routeCapturingWarnings(configFor({
    adapter: "anthropic",
    baseUrl: "https://gateway.example/v1",
    allowPrivateNetwork: true,
  } as OcxProviderConfig));

  expect(baseUrl).toBe("https://gateway.example/v1");
  expect(warnings).toHaveLength(0);
});
