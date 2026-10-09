import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";

let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(async () => { await f?.dispose(); });

for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  test(`${instance}: account health projection reads only its equal-ID cooldown`, async () => {
    const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
    const now = Date.now();
    const own = f.routing.anthropicRoutingFor(instance);
    own.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "60", now);
    const ownAccount = f.store.getAccountSet(instance)!.accounts.find(row => row.id === f.ids[0])!;
    const peerAccount = f.store.getAccountSet(other)!.accounts.find(row => row.id === f.ids[0])!;
    const cooled = projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true });
    const peer = projectStoredOAuthAccountHealth(other, peerAccount, now, { observeOnly: true });
    expect(cooled.status).toBe("cooldown");
    expect(cooled).toMatchObject({ until: new Date(now + 60_000).toISOString() });
    expect(peer.status).toBe("healthy");
    own.clearAnthropicAccountCooldown(f.ids[0]);
    expect(projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true }).status).toBe("healthy");
  });
  test(`${instance}: reset-derived quota cooldown is separate from sibling rate-limit cooldown`, async () => {
    const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
    const now = Math.floor(Date.now() / 1000) * 1000;
    const headers = new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": String((now + 120_000) / 1000) });
    f.routing.anthropicRoutingFor(instance).recordAnthropicAccount429(f.config, f.ids[0], null, now, headers);
    f.routing.anthropicRoutingFor(other).recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "30", now);
    const ownAccount = f.store.getAccountSet(instance)!.accounts[0]!;
    const peerAccount = f.store.getAccountSet(other)!.accounts[0]!;
    expect(projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "quota", until: new Date(now + 120_000).toISOString() });
    expect(projectStoredOAuthAccountHealth(other, peerAccount, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "rate_limit", until: new Date(now + 30_000).toISOString() });
  });
}
