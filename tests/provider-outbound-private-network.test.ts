import { describe, expect, test } from "bun:test";
import { providerOutboundGet, ProviderOutboundPolicyError } from "../src/lib/provider-outbound";
import { resolvePublicAddresses } from "../src/lib/destination-policy";

/**
 * #758: a stock Ollama provider passed config validation -- which consults the registry's
 * `allowPrivateNetworkByDefault` -- and was then refused at the outbound fetch, which read only
 * the operator's `allowPrivateNetwork` flag. Two boundaries disagreeing about one provider.
 *
 * These drive the PINNED transport path (no `provider.fetch`), because that is where discovery
 * actually runs and where the permission was being dropped. `resolveAddresses` is injected so the
 * decision is observable without a network: the value it receives IS the fix.
 */

const localProvider = { baseUrl: "http://localhost:11434/v1" };

/** Captures the permission the resolver was called with, then fails the call. */
function capturingResolver(): { calls: boolean[]; resolve: typeof resolvePublicAddresses } {
  const calls: boolean[] = [];
  const resolve = (async (_url: string, opts?: { allowPrivateNetwork?: boolean }) => {
    calls.push(opts?.allowPrivateNetwork === true);
    throw new ProviderOutboundPolicyError("stop here — the permission has already been decided");
  }) as unknown as typeof resolvePublicAddresses;
  return { calls, resolve };
}

describe("provider outbound private-network permission (#758)", () => {
  test("a registry-local provider passes allowPrivateNetwork even without an operator flag", async () => {
    // The defect. Before the fix this resolver saw `false` and discovery was refused for a
    // provider whose registry entry is local by definition.
    const { calls, resolve } = capturingResolver();
    await providerOutboundGet("ollama", localProvider, "http://localhost:11434/v1/models", {}, { resolveAddresses: resolve })
      .catch(() => undefined);
    expect(calls).toEqual([true]);
  });

  test("a provider with neither a registry default nor a flag is still denied", async () => {
    // The permission has to come from somewhere; an arbitrary custom provider gains nothing.
    const { calls, resolve } = capturingResolver();
    await providerOutboundGet("custom", { baseUrl: "http://192.168.1.10:8080/v1" }, "http://192.168.1.10:8080/v1/models", {}, { resolveAddresses: resolve })
      .catch(() => undefined);
    expect(calls).toEqual([false]);
  });

  test("an explicit operator flag still stands on its own", async () => {
    const { calls, resolve } = capturingResolver();
    await providerOutboundGet("custom", { baseUrl: "http://10.0.0.5:8080/v1", allowPrivateNetwork: true }, "http://10.0.0.5:8080/v1/models", {}, { resolveAddresses: resolve })
      .catch(() => undefined);
    expect(calls).toEqual([true]);
  });

  test.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["link-local", "http://169.254.1.1/v1/models"],
    ["unspecified", "http://0.0.0.0/v1/models"],
  ])("a registry-local provider still cannot reach %s", async (_label, url) => {
    // The load-bearing case. Ollama is the provider that GAINED private-network access, so if the
    // SSRF exclusions were ever folded into the same permission, it shows up here first.
    // 169.254.169.254 is the AWS/GCP credential endpoint; an SSRF there leaks instance creds.
    // These run through the executor branch, where the literal assessment rejects before any
    // permission check -- proving the exclusions sit in FRONT of the widened permission.
    await expect(providerOutboundGet(
      "ollama",
      { ...localProvider, fetch: (async () => new Response("{}")) as unknown as typeof fetch },
      url,
    )).rejects.toThrow(ProviderOutboundPolicyError);
  });
});
