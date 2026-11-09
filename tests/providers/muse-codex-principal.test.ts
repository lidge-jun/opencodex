import { describe, expect, test } from "bun:test";
import { museCodexPrincipal } from "../../src/adapters/muse-msp/codex-principal";
import { museContinuationOwner } from "../../src/adapters/muse-msp/owner";

const config = {apiKeys: []} as any;
const loopback = {kind:"loopback",source:"loopback"} as const;
const headers = (value: string) => new Headers({authorization:`Bearer ${value}`,"chatgpt-account-id":"test-account"});
describe("Muse caller identity from Codex login", () => {
  test("scopes a continuation by its existing bearer and thread", () => {
    const a=museCodexPrincipal(headers("a".repeat(64)),config,loopback);
    const b=museCodexPrincipal(headers("b".repeat(64)),config,loopback);
    expect(a).toMatch(/^[0-9a-f]{64}$/);expect(a).not.toBe(b);
    expect(a).toBe(museCodexPrincipal(headers("a".repeat(64)),config,loopback));
    const parsed:any={_museCodexPrincipal:a,_codexOwnThreadId:"thread-one",_museNativeRoute:{providerName:"muse-code",providerDestinationIdentity:"destination",adapterName:"muse-msp",modelId:"model",credentialIdentity:"native-muse-host"}};
    expect(museContinuationOwner(parsed)).toBeDefined();
    expect(museContinuationOwner({...parsed,_museCodexPrincipal:b})).not.toBe(museContinuationOwner(parsed));
    expect(museContinuationOwner({...parsed,_codexOwnThreadId:"thread-two"})).not.toBe(museContinuationOwner(parsed));
  });
  test("does not use missing, short or remote credentials", () => {
    expect(museCodexPrincipal(new Headers(),config,loopback)).toBeUndefined();
    expect(museCodexPrincipal(headers("short"),config,loopback)).toBeUndefined();
    expect(museCodexPrincipal(headers("a".repeat(64)),config,undefined)).toBeUndefined();
  });
});
