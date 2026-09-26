import { describe, expect, test } from "bun:test";
import { readPageFromHash, resolveAppHashChange } from "../src/app-routing";
import { splitHashQuery } from "../src/hash-routing";
import { readModelsTab } from "../src/pages/models-tab";
import {
  compatibilityPairHash,
  protocolPairUpstream,
  providerAccountsHash,
  providerSettingsHash,
  readCompatibilityPair,
  readProviderDeepLinkTab,
  readProviderSettingsTarget,
} from "../src/protocol-deep-links";

describe("compatibility pair hash", () => {
  test("round-trips a pair and reads unknown values as any", () => {
    const hash = compatibilityPairHash({ inbound: "chat", upstream: "messages" });
    expect(hash).toBe("models/compatibility?inbound=chat&upstream=messages");
    expect(readCompatibilityPair(`#${hash}`)).toEqual({ inbound: "chat", upstream: "messages" });
    expect(readCompatibilityPair("#models/compatibility?inbound=anthropic&upstream=grpc")).toEqual({ inbound: "", upstream: "" });
    expect(compatibilityPairHash({ inbound: "", upstream: "" })).toBe("models/compatibility");
  });

  test("another route is not a pair, so it cannot clear the matrix filter", () => {
    expect(readCompatibilityPair("#models")).toBeNull();
    expect(readCompatibilityPair("#logs?inbound=chat")).toBeNull();
  });

  test("an upstream with no Lab identity links as any", () => {
    expect(protocolPairUpstream("other")).toBe("");
    expect(protocolPairUpstream(undefined)).toBe("");
    expect(protocolPairUpstream("messages")).toBe("messages");
  });
});

describe("provider settings hash", () => {
  test("encodes the name and reads it back", () => {
    const hash = providerSettingsHash("my provider/1");
    expect(splitHashQuery(hash).path).toBe("providers");
    expect(readProviderSettingsTarget(`#${hash}`)).toBe("my provider/1");
  });

  test("an empty, over-long or foreign name is no target", () => {
    expect(readProviderSettingsTarget("#providers")).toBeNull();
    expect(readProviderSettingsTarget("#providers?provider=%20")).toBeNull();
    expect(readProviderSettingsTarget(`#providers?provider=${"p".repeat(201)}`)).toBeNull();
    expect(readProviderSettingsTarget("#models?provider=x")).toBeNull();
  });

  test("an accounts link names the provider and the Accounts tab; anything else is Settings", () => {
    const hash = providerAccountsHash("my provider/1");
    expect(hash).toBe("providers?provider=my+provider%2F1&tab=accounts");
    expect(readProviderSettingsTarget(`#${hash}`)).toBe("my provider/1");
    expect(readProviderDeepLinkTab(`#${hash}`)).toBe("accounts");
    expect(readProviderDeepLinkTab(`#${providerSettingsHash("x")}`)).toBe("settings");
    expect(readProviderDeepLinkTab("#providers?provider=x&tab=usage")).toBe("settings");
    expect(readProviderDeepLinkTab("#models?provider=x&tab=accounts")).toBe("settings");
    expect(resolveAppHashChange(hash)).toEqual({ page: "providers", replaceTo: null });
  });
});

describe("routing keeps the query only where a page owns it", () => {
  test("providers and compatibility keep their query without a rewrite", () => {
    expect(resolveAppHashChange("providers?provider=x")).toEqual({ page: "providers", replaceTo: null });
    expect(resolveAppHashChange("models/compatibility?inbound=chat")).toEqual({ page: "models", replaceTo: null });
  });

  test("any other route drops the query passively", () => {
    expect(resolveAppHashChange("logs?inbound=chat")).toEqual({ page: "logs", replaceTo: "logs" });
    expect(resolveAppHashChange("models/combos?x=1")).toEqual({ page: "models", replaceTo: "models/combos" });
    expect(resolveAppHashChange("lab?inbound=chat")).toEqual({ page: "models", replaceTo: "models/compatibility" });
  });

  test("page and tab resolution read the path alone", () => {
    expect(readPageFromHash("#providers?provider=x")).toBe("providers");
    expect(readPageFromHash("#models/compatibility?inbound=chat")).toBe("models");
    expect(readModelsTab("#models/compatibility?inbound=chat&upstream=messages")).toBe("compatibility");
  });
});
