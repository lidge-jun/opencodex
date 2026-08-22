import { expect, test } from "bun:test";
import { routeModel } from "../src/router";
import { providerDestinationConfigError } from "../src/lib/destination-policy";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

/**
 * Regression coverage for the allowBaseUrlOverride opt-in on the
 * google-antigravity registry entry.
 *
 * Before the opt-in, the pinned registry endpoint silently outranked a saved
 * baseUrl and the router emitted the discarded-baseUrl diagnostic (see
 * tests/router-discarded-baseurl-warning.test.ts). Users routing Antigravity
 * traffic through a local relay or region-specific proxy therefore could not
 * redirect the provider at all. These tests pin the new contract: a resolved
 * user baseUrl wins, no warning fires, and the registry endpoint remains the
 * default when nothing is configured.
 */
const PROVIDER = "google-antigravity";
const REGISTRY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const MODEL = PROVIDER + "/gemini-3.7-flash";

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

test("google-antigravity honors a configured baseUrl override", () => {
  const { baseUrl, warnings } = routeCapturingWarnings(configFor({
    adapter: "google",
    baseUrl: "https://antigravity-relay.example.test",
  } as OcxProviderConfig));

  expect(baseUrl).toBe("https://antigravity-relay.example.test");
  // The override is applied, so the discarded-baseUrl diagnostic must not fire.
  expect(warnings).toHaveLength(0);
});

test("google-antigravity keeps the registry endpoint when the seeded baseUrl is unchanged", () => {
  // providerConfigSeed copies the registry baseUrl into every saved config, so the
  // no-override case reaches the router as a config whose baseUrl equals the registry URL.
  const { baseUrl, warnings } = routeCapturingWarnings(configFor({
    adapter: "google",
    baseUrl: REGISTRY_BASE_URL,
  } as OcxProviderConfig));

  expect(baseUrl).toBe(REGISTRY_BASE_URL);
  expect(warnings).toHaveLength(0);
});

test("google-antigravity requires a resolved baseUrl once override is enabled", () => {
  // allowBaseUrlOverride providers fail closed on a missing baseUrl instead of silently
  // re-pinning the registry endpoint; the seed guarantees real configs always carry one.
  expect(() => routeModel(configFor({
    adapter: "google",
  } as OcxProviderConfig), MODEL)).toThrow(/Invalid baseUrl/);
});

test("google-antigravity rejects an unresolved template baseUrl override", () => {
  expect(() => routeModel(configFor({
    adapter: "google",
    baseUrl: "https://{region}.example.test",
  } as OcxProviderConfig), MODEL)).toThrow(/Invalid baseUrl/);
});

/**
 * Security regression (CodeRabbit, PR #2110): google-antigravity is an OAuth provider, so an
 * allowBaseUrlOverride endpoint receives bearer credentials. A cleartext http override to a
 * non-local destination must be rejected on BOTH enforcement paths: routing (normal requests,
 * via assertProviderDestinationAllowed) and providerDestinationConfigError, the shared gate
 * that config validation and the outbound layer (providerGet/providerPost in
 * src/lib/provider-outbound.ts) consult before any fetch.
 */
test("google-antigravity rejects a cleartext http override on the routing path", () => {
  expect(() => routeModel(configFor({
    adapter: "google",
    baseUrl: "http://antigravity-relay.example.test",
  } as OcxProviderConfig), MODEL)).toThrow(/https/);
});

test("google-antigravity rejects a cleartext http override on the discovery/config gate", () => {
  expect(providerDestinationConfigError(PROVIDER, {
    baseUrl: "http://antigravity-relay.example.test",
  } as OcxProviderConfig)).toMatch(/https/);
  // The https form of the same destination stays accepted.
  expect(providerDestinationConfigError(PROVIDER, {
    baseUrl: "https://antigravity-relay.example.test",
  } as OcxProviderConfig)).toBeNull();
});

test("google-antigravity keeps http for an explicitly local relay", () => {
  // The local proxy (127.0.0.1) is the motivating use case for this override; the https
  // requirement must not break it. allowPrivateNetwork is the documented local opt-in.
  const { baseUrl, warnings } = routeCapturingWarnings(configFor({
    adapter: "google",
    baseUrl: "http://127.0.0.1:47821",
    allowPrivateNetwork: true,
  } as OcxProviderConfig));

  expect(baseUrl).toBe("http://127.0.0.1:47821");
  expect(warnings).toHaveLength(0);
});

