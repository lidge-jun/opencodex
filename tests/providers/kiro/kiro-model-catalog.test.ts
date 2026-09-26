import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccountSet, removeAccount, saveCredential } from "../../../src/oauth/store";
import type { ProviderAccount } from "../../../src/oauth/types";
import type { OcxProviderConfig } from "../../../src/types";
import { fetchProviderModelsWithAuth, refreshingModelsAuthResolver } from "../../../src/codex/catalog/provider-models";
import {
  awaitKiroModelRefreshForTests, clearKiroAccountModels, kiroAccountSupportsModel,
  kiroObservedContextWindow, KIRO_MODEL_CATALOG_TTL_MS, readKiroAccountModels,
  refreshKiroAccountModelsDetached,
} from "../../../src/providers/kiro-model-catalog";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalSwitch = process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
let home: string | undefined;
const provider = { baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", adapter: "kiro" } as OcxProviderConfig;

function setup(): void {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-catalog-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = "1";
  clearKiroAccountModels();
}

afterEach(() => {
  clearKiroAccountModels();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (originalSwitch === undefined) delete process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
  else process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = originalSwitch;
  if (home) removeTreeWithRetry(home);
  home = undefined;
});

async function add(label: string, region = "us-east-1"): Promise<ProviderAccount> {
  await saveCredential("kiro", { access: `access-${label}`, refresh: `refresh-${label}`,
    expires: Date.now() + 48 * 3_600_000, accountId: label,
    kiro: { profileArn: `arn:aws:codewhisperer:${region}:123456789012:profile/${label}`,
      apiRegion: region } }, { addAccount: true });
  return getAccountSet("kiro")!.accounts.find(row => row.credential.accountId === label)!;
}

function wire(body: unknown, calls: Array<{ url: string; bearer: string; target: string; profile: string }>) {
  return {
    resolveAddresses: async (url: string) => ({ hostname: new URL(url).hostname,
      addresses: [{ address: "1.1.1.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async (url: string, _pinned: unknown, raw: string, _signal: unknown,
      options: { headers?: HeadersInit }) => {
      const headers = new Headers(options.headers);
      calls.push({ url, bearer: headers.get("authorization") ?? "",
        target: headers.get("x-amz-target") ?? "", profile: JSON.parse(raw).profileArn });
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  } as never;
}

test("management ListAvailableModels pairs each bearer with its own profile and region", async () => {
  setup();
  const a = await add("a", "eu-west-1");
  const b = await add("b", "ap-southeast-2");
  const calls: Array<{ url: string; bearer: string; target: string; profile: string }> = [];
  const deps = wire({ models: [{ modelId: "model-one", tokenLimits: { maxInputTokens: 123_000 } }] }, calls);
  refreshKiroAccountModelsDetached(a, provider, deps);
  refreshKiroAccountModelsDetached(b, provider, deps);
  await Promise.all([awaitKiroModelRefreshForTests(a.id), awaitKiroModelRefreshForTests(b.id)]);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.bearer).toBe("Bearer access-a");
  expect(calls[0]!.target).toBe("KiroControlPlaneBearerService.ListAvailableModels");
  expect(new URL(calls[0]!.url).hostname).toBe("management.eu-west-1.kiro.dev");
  expect(new URL(calls[0]!.url).searchParams.get("profileArn")).toBe(calls[0]!.profile);
  expect(calls[1]!.bearer).toBe("Bearer access-b");
  expect(new URL(calls[1]!.url).hostname).toBe("management.ap-southeast-2.kiro.dev");
  expect(kiroAccountSupportsModel(a.id, "model-one")).toBe(true);
});

test("Builder ID management discovery follows account region rather than the service ARN", async () => {
  setup();
  await saveCredential("kiro", { access: "builder-access", refresh: "builder-refresh",
    expires: Date.now() + 3_600_000, accountId: "builder",
    kiro: { apiRegion: "eu-west-1", ssoRegion: "eu-west-1",
      clientId: "client-id", clientSecret: "client-secret" } });
  const account = getAccountSet("kiro")!.accounts[0]!;
  const calls: Array<{ url: string; bearer: string; target: string; profile: string }> = [];
  refreshKiroAccountModelsDetached(account, provider, wire({ models: [{ modelId: "model-one" }] }, calls));
  await awaitKiroModelRefreshForTests(account.id);
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).hostname).toBe("management.eu-west-1.kiro.dev");
  expect(new URL(calls[0]!.url).searchParams.get("profileArn")).toBe(calls[0]!.profile);
  expect(calls[0]!.profile).toContain(":us-east-1:");
  expect(calls[0]!.bearer).toBe("Bearer builder-access");
});

test("the per-account catalogue joins concurrent refreshes and reads cache only", async () => {
  setup();
  const account = await add("a");
  const calls: Array<{ url: string; bearer: string; target: string; profile: string }> = [];
  const deps = wire({ models: [{ modelId: "model-one" }] }, calls);
  expect(readKiroAccountModels(account)).toBeUndefined();
  refreshKiroAccountModelsDetached(account, provider, deps);
  refreshKiroAccountModelsDetached(account, provider, deps);
  await awaitKiroModelRefreshForTests(account.id);
  expect(calls).toHaveLength(1);
  expect(readKiroAccountModels(account)?.[0]?.modelId).toBe("model-one");
  refreshKiroAccountModelsDetached(account, provider, deps);
  expect(calls).toHaveLength(1);
});

test("unrecognised or empty management replies preserve the last good list", async () => {
  setup();
  const account = await add("a");
  const calls: Array<{ url: string; bearer: string; target: string; profile: string }> = [];
  refreshKiroAccountModelsDetached(account, provider, wire({ models: [{ modelId: "model-one" }] }, calls));
  await awaitKiroModelRefreshForTests(account.id);
  expect(readKiroAccountModels(account)?.[0]?.modelId).toBe("model-one");
  expect(kiroAccountSupportsModel(account.id, "other")).toBe(false);
  const realNow = Date.now;
  const later = Date.now() + KIRO_MODEL_CATALOG_TTL_MS + 1;
  try {
    Date.now = () => later;
    refreshKiroAccountModelsDetached(account, provider, wire({ models: [] }, calls));
    await awaitKiroModelRefreshForTests(account.id);
    expect(readKiroAccountModels(account)?.[0]?.modelId).toBe("model-one");
  } finally { Date.now = realNow; }
  // A new login invalidates the row before a malformed response can be mistaken for an empty list.
  await saveCredential("kiro", { access: "new", refresh: "new", expires: Date.now() + 3_600_000,
    accountId: "a", kiro: { profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/a" } });
  const replacement = getAccountSet("kiro")!.accounts.find(row => row.id === account.id)!;
  expect(readKiroAccountModels(replacement)).toBeUndefined();
  refreshKiroAccountModelsDetached(replacement, provider, wire({ models: [] }, calls));
  await awaitKiroModelRefreshForTests(account.id);
  expect(readKiroAccountModels(replacement)).toBeUndefined();
});

test("a removed or replaced account cannot publish an in-flight catalogue", async () => {
  setup();
  const old = await add("a");
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const resolveAddresses = async (url: string) => ({ hostname: new URL(url).hostname,
    addresses: [{ address: "1.1.1.1", family: 4 }], privateNetwork: false });
  refreshKiroAccountModelsDetached(old, provider, {
    resolveAddresses, pinnedPost: async () => { start(); return pending; },
  } as never);
  await started;
  const oldFlight = awaitKiroModelRefreshForTests(old.id);
  await saveCredential("kiro", { access: "replacement", refresh: "replacement",
    expires: Date.now() + 3_600_000, accountId: "a",
    kiro: { profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/replacement" } });
  const replacement = getAccountSet("kiro")!.accounts.find(row => row.id === old.id)!;
  expect(readKiroAccountModels(replacement)).toBeUndefined();
  refreshKiroAccountModelsDetached(replacement, provider, {
    resolveAddresses, pinnedPost: async () => new Response(JSON.stringify({ models: [{ modelId: "new" }] })),
  } as never);
  await awaitKiroModelRefreshForTests(old.id);
  finish(new Response(JSON.stringify({ models: [{ modelId: "old" }] })));
  await oldFlight;
  expect(kiroAccountSupportsModel(old.id, "new")).toBe(true);
  expect(kiroAccountSupportsModel(old.id, "old")).toBe(false);
  expect(readKiroAccountModels(old)).toBeUndefined();
});

test("a mixed known/unknown roster never reports more than the smallest known window", async () => {
  setup();
  const a = await add("a");
  await add("b");
  expect(kiroObservedContextWindow("claude-opus-5")).toBe(1_000_000);
  refreshKiroAccountModelsDetached(a, provider,
    wire({ models: [{ modelId: "claude-opus-5", tokenLimits: { maxInputTokens: 150_000 } }] }, []));
  await awaitKiroModelRefreshForTests(a.id);
  expect(kiroObservedContextWindow("claude-opus-5")).toBe(150_000);
  expect(kiroObservedContextWindow("auto")).toBeUndefined();
  await removeAccount("kiro", a.id);
  expect(readKiroAccountModels(a)).toBeUndefined();
});

test("last-good model evidence expires after 24 hours", async () => {
  setup();
  const account = await add("a");
  refreshKiroAccountModelsDetached(account, provider, wire({ models: [{ modelId: "known" }] }, []));
  await awaitKiroModelRefreshForTests(account.id);
  const realNow = Date.now;
  const later = Date.now() + 24 * 60 * 60_000 + 1;
  try {
    Date.now = () => later;
    expect(readKiroAccountModels(account)).toBeUndefined();
    expect(kiroAccountSupportsModel(account.id, "known")).toBeUndefined();
  } finally { Date.now = realNow; }
});

test("model IDs and token limits are validated without inventing capabilities", async () => {
  setup();
  const account = await add("a");
  refreshKiroAccountModelsDetached(account, provider, wire({ models: [
    { modelId: "valid", tokenLimits: { maxInputTokens: 123_456, maxOutputTokens: 99 } },
    { modelId: "bad\nselector", tokenLimits: { maxInputTokens: 999 } },
    { modelId: "invalid-limit", tokenLimits: { maxInputTokens: -1, maxOutputTokens: 999 } },
    { modelId: "valid", tokenLimits: { maxInputTokens: 888 } },
  ] }, []));
  await awaitKiroModelRefreshForTests(account.id);
  expect(readKiroAccountModels(account)).toEqual([
    { modelId: "valid", contextWindow: 123_456 },
    { modelId: "invalid-limit" },
  ]);
  expect(kiroObservedContextWindow("invalid-limit")).toBeUndefined();
});

test("discovery kill switch is read for every detached refresh", async () => {
  setup();
  const account = await add("a");
  const calls: Array<{ url: string; bearer: string; target: string; profile: string }> = [];
  process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = "0";
  refreshKiroAccountModelsDetached(account, provider, wire({ models: [{ modelId: "one" }] }, calls));
  await awaitKiroModelRefreshForTests(account.id);
  expect(calls).toHaveLength(0);
  process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = "1";
  refreshKiroAccountModelsDetached(account, provider, wire({ models: [{ modelId: "one" }] }, calls));
  await awaitKiroModelRefreshForTests(account.id);
  expect(calls).toHaveLength(1);
});

test("cached account models augment the static catalog without gathering from network", async () => {
  setup();
  const account = await add("a");
  refreshKiroAccountModelsDetached(account, provider,
    wire({ models: [{ modelId: "observed", tokenLimits: { maxInputTokens: 123_000 } }] }, []));
  await awaitKiroModelRefreshForTests(account.id);
  const staticProvider = { ...provider, liveModels: false, models: ["shipped"] } as OcxProviderConfig;
  const result = await fetchProviderModelsWithAuth({ name: "kiro", provider: staticProvider,
    metadataModelIdCaseFold: false } as never, 60_000, undefined, refreshingModelsAuthResolver);
  expect(result.models.map(model => model.id)).toEqual(["shipped", "observed"]);
  expect(result.models.find(model => model.id === "observed")?.contextWindow).toBe(123_000);
});
