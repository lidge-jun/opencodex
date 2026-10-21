import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { captureProviderApiKeySelection, providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, getKeyCooldownUntil, recordDistributedKeyFailure,
  rotateKeyOn401, selectProactiveApiKeyTransport } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { routedProviderConfig } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const NAME = "selection-cooldown";
const A = "fixture-selection-alpha";
const B = "fixture-selection-beta";
let home: string;
let previousHome: string | undefined;
let releaseOwner: () => void;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-selection-cooldown-"));
  process.env.OPENCODEX_HOME = home;
  releaseOwner = acquireOwnedSpendHome();
  clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
});
afterEach(() => {
  releaseOwner(); clearKeyCooldowns(); forgetApiKeyRotationCursor(); resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(): OcxConfig {
  return { port: 0, defaultProvider: NAME, providers: { [NAME]: { adapter: "anthropic", authMode: "key",
    baseUrl: "https://example.test", apiKey: A, apiKeySelectionRevision: "revision-fixture",
    apiKeyPool: [{ id: "a", key: A }, { id: "b", key: B }],
    requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
  } } } as OcxConfig;
}
function binding(config: OcxConfig, index = 0): OcxProviderConfig {
  const provider = config.providers[NAME]!;
  const entry = provider.apiKeyPool![index]!;
  return routedProviderConfig(NAME, { ...provider, apiKey: entry.key,
    _apiKeyAttempt: { entryId: entry.id, reference: entry.key, revision: provider.apiKeySelectionRevision, distributed: true } });
}
function cool(config: OcxConfig, route: OcxProviderConfig, now = Date.now(), retryAfter = "30") {
  expect(recordDistributedKeyFailure(config, NAME, route._apiKeyAttempt, 429, now, retryAfter)).toBe(true);
}
function accepted(config: OcxConfig, route: OcxProviderConfig) {
  expect(providerApiKeySelectionIsCurrent(config, NAME, route)).toBe(true);
  expect(resolveCurrentProviderApiKeyTransport(config, NAME, route)?.apiKey).toBe(route.apiKey);
}
function rejected(config: OcxConfig, route: OcxProviderConfig) {
  expect(providerApiKeySelectionIsCurrent(config, NAME, route)).toBe(false);
  expect(resolveCurrentProviderApiKeyTransport(config, NAME, route)).toBeNull();
}

describe("distributed selection cooldown validation", () => {
  test("rejects a cooled exact binding and resolver while its healthy sibling remains current", () => {
    const config = fixture();
    const first = binding(config); const second = binding(config, 1);
    accepted(config, first); accepted(config, second);
    cool(config, first);
    rejected(config, first); accepted(config, second);
    expect(config.providers[NAME]!.apiKey).toBe(A);
    expect(config.providers[NAME]!.apiKeySelectionRevision).toBe("revision-fixture");
  });

  for (const field of ["entry", "reference", "revision"] as const) test(`rejects a stale distributed ${field} independently of cooldown`, () => {
    const config = fixture(); const route = binding(config);
    if (field === "entry") config.providers[NAME]!.apiKeyPool![0]!.id = "replacement-entry";
    if (field === "reference") config.providers[NAME]!.apiKeyPool![0]!.key = "fixture-replacement-reference";
    if (field === "revision") config.providers[NAME]!.apiKeySelectionRevision = "replacement-revision";
    expect(recordDistributedKeyFailure(config, NAME, route._apiKeyAttempt, 429)).toBe(false);
    rejected(config, route);
    expect(getKeyCooldownUntil(NAME, "a")).toBeNull();
  });

  test("expiry makes the same distributed binding usable at the exact cooldown boundary", () => {
    const config = fixture(); const route = binding(config);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      cool(config, route, now, "1");
      clock.mockReturnValue(now + 999); rejected(config, route);
      expect(getKeyCooldownUntil(NAME, "a")).toBe(now + 1_000);
      clock.mockReturnValue(now + 1_000); accepted(config, route);
      expect(getKeyCooldownUntil(NAME, "a")).toBeNull();
    } finally { clock.mockRestore(); }
  });

  test("duplicate references cool together without cooling a healthy distinct reference", () => {
    const config = fixture();
    config.providers[NAME]!.apiKeyPool!.splice(1, 0, { id: "a-duplicate", key: A });
    const first = binding(config); const duplicate = binding(config, 1); const sibling = binding(config, 2);
    cool(config, duplicate);
    expect(getKeyCooldownUntil(NAME, "a")).toBe(getKeyCooldownUntil(NAME, "a-duplicate"));
    rejected(config, first); rejected(config, duplicate); accepted(config, sibling);
    const replacement = selectProactiveApiKeyTransport(config, NAME, first)!;
    expect(replacement.apiKey).toBe(B);
    expect(replacement._apiKeyAttempt?.entryId).toBe("b");
  });

  test("a shorter concurrent 429 cannot undo a 401 cooldown, including duplicate references", () => {
    const config = fixture();
    config.providers[NAME]!.apiKeyPool!.splice(1, 0, { id: "a-duplicate", key: A });
    const first = binding(config); const duplicate = binding(config, 1); const sibling = binding(config, 2);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(recordDistributedKeyFailure(config, NAME, first._apiKeyAttempt, 401, now)).toBe(true);
      clock.mockReturnValue(now + 100);
      expect(recordDistributedKeyFailure(config, NAME, duplicate._apiKeyAttempt, 429, now + 100, "1")).toBe(true);
      expect(getKeyCooldownUntil(NAME, "a")).toBe(now + 600_000);
      expect(getKeyCooldownUntil(NAME, "a-duplicate")).toBe(now + 600_000);
      clock.mockReturnValue(now + 2_000);
      rejected(config, first); rejected(config, duplicate); accepted(config, sibling);
      expect(config.providers[NAME]!.apiKey).toBe(A);
      expect(config.providers[NAME]!.apiKeySelectionRevision).toBe("revision-fixture");
      clearKeyCooldowns(NAME);
      accepted(config, first); accepted(config, duplicate);
      expect(getKeyCooldownUntil(NAME, "a")).toBeNull();
      expect(getKeyCooldownUntil(NAME, "a-duplicate")).toBeNull();
    } finally { clock.mockRestore(); }
  });

  test("a persistent binding keeps its existing validation semantics even when that entry is cooled", () => {
    const config = fixture(); const distributed = binding(config);
    cool(config, distributed);
    delete config.providers[NAME]!.requestPacing;
    const configured = config.providers[NAME]!;
    const persistent = routedProviderConfig(NAME, { ...configured, _apiKeyAttempt: captureProviderApiKeySelection(configured) });
    accepted(config, persistent);
    expect(recordDistributedKeyFailure(config, NAME, persistent._apiKeyAttempt, 429)).toBe(false);
  });

  test("default-off persistent mode retains committed 401 rotation and revision updates", () => {
    const config = fixture(); delete config.providers[NAME]!.requestPacing;
    saveConfig(config);
    const route = routedProviderConfig(NAME, config.providers[NAME]!);
    expect(selectProactiveApiKeyTransport(config, NAME, route)).toBeNull();
    expect(route._apiKeyAttempt?.distributed).toBeUndefined();
    expect(recordDistributedKeyFailure(config, NAME, route._apiKeyAttempt, 401)).toBe(false);
    const replacement = rotateKeyOn401(config, NAME, Date.now(), A, route._apiKeyAttempt)!;
    expect(replacement.apiKey).toBe(B);
    expect(config.providers[NAME]!.apiKey).toBe(B);
    expect(config.providers[NAME]!.apiKeySelectionRevision).not.toBe("revision-fixture");
    const persisted = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as OcxConfig;
    expect(persisted.providers[NAME]!.apiKey).toBe(B);
    expect(persisted.providers[NAME]!.apiKeySelectionRevision).toBe(config.providers[NAME]!.apiKeySelectionRevision);
    expect(getKeyCooldownUntil(NAME, "a")).not.toBeNull();
    accepted(config, routedProviderConfig(NAME, config.providers[NAME]!));
    expect(providerApiKeySelectionIsCurrent(config, NAME, route)).toBe(false);
  });
});
