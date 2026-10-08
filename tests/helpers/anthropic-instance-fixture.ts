import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import type { AnthropicAccountPoolConfig } from "../../src/types/anthropic-account-pool";
import type { AnthropicInstanceId } from "../../src/providers/anthropic-instance-id";
import type { OAuthCredentials } from "../../src/oauth/types";

export const INSTANCE_FIXTURE_IDS = ["shared-slot-1", "shared-slot-2"] as const;
export const INSTANCE_FIXTURE_SESSION = "shared-session";
export const INSTANCE_FIXTURE_MODEL = "claude-sonnet-4-6";
export const INSTANCE_FIXTURE_INSTANCES = ["anthropic", "anthropic2"] as const;

export function anthropicInstanceConfig(
  pools: Partial<Record<AnthropicInstanceId, AnthropicAccountPoolConfig>> = {},
): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", defaultModel: INSTANCE_FIXTURE_MODEL },
      anthropic2: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", anthropicOAuthInstance: "anthropic2",
        defaultModel: INSTANCE_FIXTURE_MODEL, anthropicAccountPool: { enabled: true, ...pools.anthropic2 } },
    },
    anthropicAccountPool: { enabled: true, ...pools.anthropic },
  };
}

export interface AnthropicFixtureSend {
  instance: AnthropicInstanceId;
  accountId: string;
  token: string;
  uuid?: string;
  model?: string;
}

/** Independent oracle: expected tokens/UUIDs are fixture constants, never derived from a resolver. */
export function instanceFixtureCredential(instance: AnthropicInstanceId, slot: number): OAuthCredentials {
  return {
    access: `synthetic-${instance}-${slot}-access`,
    refresh: `synthetic-${instance}-${slot}-refresh`,
    expires: Date.now() + 3_600_000,
    source: "oauth",
    accountId: instanceFixtureUuid(instance, slot),
  };
}
export function instanceFixtureUuid(instance: AnthropicInstanceId, slot: number): string {
  const uuid = {
    anthropic: ["11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"],
    anthropic2: ["22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"],
  }[instance][slot - 1];
  if (!uuid) throw new Error("fixture slot must be 1 or 2");
  return uuid;
}

export class AnthropicInstanceSendLedger {
  readonly sends: AnthropicFixtureSend[] = [];
  record(send: AnthropicFixtureSend): void {
    const slot = INSTANCE_FIXTURE_IDS.indexOf(send.accountId as typeof INSTANCE_FIXTURE_IDS[number]) + 1;
    if (slot <= 0 || send.token !== instanceFixtureCredential(send.instance, slot).access
      || (send.uuid !== undefined && send.uuid !== instanceFixtureUuid(send.instance, slot))) {
      // Do not put even synthetic credentials in assertion messages shared with CI.
      throw new Error("wrong instance credential or UUID on physical send");
    }
    this.sends.push({ ...send });
  }
  assertNoCrossSend(): void {
    for (const send of this.sends) {
      const slot = INSTANCE_FIXTURE_IDS.indexOf(send.accountId as typeof INSTANCE_FIXTURE_IDS[number]) + 1;
      if (send.token !== instanceFixtureCredential(send.instance, slot).access
        || (send.uuid !== undefined && send.uuid !== instanceFixtureUuid(send.instance, slot))) {
        throw new Error("wrong instance credential or UUID on physical send");
      }
    }
  }
  clear(): void { this.sends.length = 0; }
}

/** Deterministic await barrier for credential/config replacement tests; no sleeps. */
export function anthropicInstanceBarrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

/** Creates every configured directory before loading runtime modules. Never imports the real CLI. */
export async function createAnthropicInstanceFixture(
  pools: Partial<Record<AnthropicInstanceId, AnthropicAccountPoolConfig>> = {},
) {
  const originalEnv = Object.fromEntries(["HOME", "OPENCODEX_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"].map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), "ocx-anthropic-instance-fixture-"));
  const paths = { HOME: home, OPENCODEX_HOME: join(home, "ocx"), CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
  for (const [key, path] of Object.entries(paths)) { mkdirSync(path, { recursive: true }); process.env[key] = path; }
  // A valid local fake credential prevents the detector's fallback to the real macOS Keychain.
  writeFileSync(join(paths.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-unused-cli-access", refreshToken: "synthetic-unused-cli-refresh", expiresAt: Date.now() + 3_600_000,
  } }));
  globalThis.fetch = (async () => { throw new Error("unexpected network in isolated Anthropic fixture"); }) as typeof fetch;
  const [store, routing, quota, modelQuota, ratePolicy, identity, configStore, kernel, cleanup, history, health] = await Promise.all([
    import("../../src/oauth/store"), import("../../src/oauth/anthropic-routing"), import("../../src/providers/quota"),
    import("../../src/oauth/anthropic-model-quota"), import("../../src/oauth/anthropic-rate-limit-policy"),
    import("../../src/oauth/anthropic-identity"), import("../../src/config"), import("../../src/oauth/pool-kernel"), import("../../src/lib/test-home-guard"),
    import("../../src/routing/history/indexer"), import("../../src/routing/health"),
  ]);
  // These process-local owners are shared by serial fixtures. Start each fixture
  // without a previous home's connection or provider/model health-cache entry.
  history.closeRequestHistoryIndex();
  health.clearHealthHistoryCacheForTests();
  const config = anthropicInstanceConfig(pools);
  function publishConfig(next: OcxConfig = config): void { configStore.saveConfig(next); }
  publishConfig();
  routing.clearAllAnthropicAccountPoolState();
  kernel.clearPoolRotationState();
  quota.clearAccountQuotaCache();
  const ledger = new AnthropicInstanceSendLedger();
  async function admit(instance: AnthropicInstanceId, sessionKey: string | null = INSTANCE_FIXTURE_SESSION,
    model = INSTANCE_FIXTURE_MODEL, policy = config) {
    const facade = routing.anthropicRoutingFor(instance);
    const { resolveAnthropicModelRouteForInstance } = await import("../../src/oauth/anthropic-model-routes");
    const route = resolveAnthropicModelRouteForInstance(instance, policy, model);
    if (route.error) throw new Error(route.error);
    const expected = store.captureOAuthAccountSelection(instance);
    const selection = facade.resolveAnthropicAccountForSession(sessionKey, policy, Date.now(), route.decision, model);
    if (!selection.accountId) return { selection, snapshot: null };
    const snapshot = await facade.getAnthropicPoolAccessSnapshot(selection.accountId);
    const committed = await facade.promoteAnthropicActiveAccount(selection.accountId, expected, {
      config: policy, sessionKey, model, reason: selection.reason, routeDecision: route.decision, expectedCredentialGeneration: snapshot.generation,
    });
    if (!committed) throw new Error("fixture account admission did not commit");
    return { selection, snapshot };
  }
  async function seed(instances: readonly AnthropicInstanceId[] = INSTANCE_FIXTURE_INSTANCES): Promise<void> {
    for (const instance of instances) {
      for (let slot = 1; slot <= 2; slot++) {
        const value = instanceFixtureCredential(instance, slot);
        value.anthropicIdentity = identity.bindAnthropicIdentity(value.access, instanceFixtureUuid(instance, slot));
        await store.saveCredential(instance, value);
      }
      await store.mutateStore(auth => {
        const set = auth[instance]!;
        set.accounts.forEach((account, i) => { account.id = INSTANCE_FIXTURE_IDS[i]!; });
        set.activeAccountId = INSTANCE_FIXTURE_IDS[0];
      });
      // Consume the persisted startup preference without warming affinity or cursor state.
      const poolOff = structuredClone(config);
      if (instance === "anthropic") poolOff.anthropicAccountPool = { enabled: false };
      else poolOff.providers.anthropic2!.anthropicAccountPool = { enabled: false };
      await admit(instance, null, INSTANCE_FIXTURE_MODEL, poolOff);
    }
  }
  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    routing.clearAllAnthropicAccountPoolState();
    kernel.clearPoolRotationState();
    // Provider-only clear schedules persistence. Cancel all pending writes while the
    // fixture HOME still owns their target, before removing it or restoring the environment.
    quota.clearAccountQuotaCache();
    globalThis.fetch = originalFetch;
    try {
      // The assembled management dry-run opens this cached SQLite connection for
      // historical route health. Windows retains its file lock until it is closed.
      history.closeRequestHistoryIndex();
      health.clearHealthHistoryCacheForTests();
      cleanup.assertRemovalOutsideProtectedTrees(home);
      // One attempt after releasing owned resources; EBUSY remains a test failure.
      rmSync(home, { recursive: true, force: true, maxRetries: 0 });
    }
    finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  }
  return { home, paths, config, ids: INSTANCE_FIXTURE_IDS, sessionKey: INSTANCE_FIXTURE_SESSION, model: INSTANCE_FIXTURE_MODEL,
    store, routing, quota, modelQuota, ratePolicy, kernel, ledger, publishConfig, seed, admit, dispose };
}
export type AnthropicInstanceFixture = Awaited<ReturnType<typeof createAnthropicInstanceFixture>>;
