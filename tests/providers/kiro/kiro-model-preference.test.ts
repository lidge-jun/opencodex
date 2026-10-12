import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireAccountLease, type AccountLease } from "../../../src/oauth/kiro-account-load";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import type { ProviderAccount } from "../../../src/oauth/types";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import {
  clearGenericFailoverHealth, preferredInitialAccount, refusalAwareInitialKiroAccount,
  rotateGenericOAuthAccountOn429,
} from "../../../src/oauth/generic-account-failover";
import { awaitKiroModelRefreshForTests, clearKiroAccountModels,
  refreshKiroAccountModelsDetached } from "../../../src/providers/kiro-model-catalog";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const originalSwitch = process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
let home: string | undefined;
let leases: AccountLease[] = [];
const provider = { baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", adapter: "kiro" } as OcxProviderConfig;

function setup(): void {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-preference-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = "1";
  clearKiroAccountModels();
  clearGenericFailoverHealth("kiro");
}

afterEach(() => {
  for (const lease of leases) lease.release();
  leases = [];
  clearKiroAccountModels();
  clearGenericFailoverHealth("kiro");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (originalSwitch === undefined) delete process.env.OPENCODEX_KIRO_MODEL_DISCOVERY;
  else process.env.OPENCODEX_KIRO_MODEL_DISCOVERY = originalSwitch;
  if (home) removeTreeWithRetry(home);
  home = undefined;
});

async function add(label: string): Promise<ProviderAccount> {
  await saveCredential("kiro", { access: `access-${label}`, refresh: `refresh-${label}`,
    expires: Date.now() + 3_600_000, accountId: label,
    kiro: { profileArn: `arn:aws:codewhisperer:us-east-1:123456789012:profile/${label}` } },
  { addAccount: true });
  return getAccountSet("kiro")!.accounts.find(row => row.credential.accountId === label)!;
}

async function prime(account: ProviderAccount, models: string[]): Promise<void> {
  refreshKiroAccountModelsDetached(account, provider, {
    resolveAddresses: async (url: string) => ({ hostname: new URL(url).hostname,
      addresses: [{ address: "1.1.1.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async () => new Response(JSON.stringify({ models: models.map(modelId => ({ modelId })) })),
  } as never);
  await awaitKiroModelRefreshForTests(account.id);
}

function config(strategy: string, cap?: number, enabled = true): OcxConfig {
  return { pool: { kernel: true }, providers: { kiro: { ...provider,
    oauthAccountFailover: { enabled, strategy,
      ...(cap !== undefined ? { maxConcurrentPerAccount: cap } : {}) } } } } as OcxConfig;
}

test("fill-first leaves a healthy active account that lacks the model for a sibling that lists it", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  expect(preferredInitialAccount(config("fill-first"), "kiro", Date.now(), "wanted")).toBe(b.id);
});

test("refusal-aware first admission prefers a sibling that lists the model", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  expect(refusalAwareInitialKiroAccount(config("quota"), a.id, Date.now(), "wanted")).toBe(b.id);
});

test("no catalogue evidence never moves a healthy active account", async () => {
  setup();
  const a = await add("a");
  await add("b");
  await setActiveAccount("kiro", a.id);
  expect(preferredInitialAccount(config("fill-first"), "kiro", Date.now(), "wanted")).toBeNull();
  expect(refusalAwareInitialKiroAccount(config("quota"), a.id, Date.now(), "wanted")).toBeNull();
});

test("a listing sibling at its cap does not displace an active account with room", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  leases.push((await acquireAccountLease("kiro", b.id))!);
  expect(preferredInitialAccount(config("fill-first", 1), "kiro", Date.now(), "wanted")).toBeNull();
  expect(refusalAwareInitialKiroAccount(config("quota", 1), a.id, Date.now(), "wanted")).toBeNull();
});

test("reactive Kiro rotation prefers model evidence after room filtering", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  const c = await add("c");
  await prime(b, ["other"]);
  await prime(c, ["wanted"]);
  expect(rotateGenericOAuthAccountOn429(config("quota"), "kiro", a.id, null,
    Date.now(), "wanted")).toBe(c.id);
});

test("positive membership outranks lower load for proactive least-loaded choice", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  leases.push((await acquireAccountLease("kiro", b.id))!);
  expect(preferredInitialAccount(config("least-loaded"), "kiro", Date.now(), "wanted")).toBe(b.id);
});

test("explicit proactive off keeps the healthy active account despite model evidence", async () => {
  setup();
  const a = await add("a");
  const b = await add("b");
  await setActiveAccount("kiro", a.id);
  await prime(a, ["other"]);
  await prime(b, ["wanted"]);
  expect(preferredInitialAccount(config("fill-first", undefined, false), "kiro",
    Date.now(), "wanted")).toBeNull();
  expect(refusalAwareInitialKiroAccount(config("quota", undefined, false), a.id,
    Date.now(), "wanted")).toBeNull();
});
