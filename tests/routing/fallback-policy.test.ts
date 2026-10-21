/**
 * OCX-11 fallback policy resolver (src/routing/fallback-policy.ts): precedence across scopes,
 * hop classification, malformed-leaf degrade, device identity, the refusal contract and the
 * privacy of recorded events.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearFallbackEventsForTests,
  fallbackDeviceIds,
  fallbackHopKind,
  guardFallbackHop,
  recentFallbackEvents,
  resetFallbackLinkCacheForTests,
  resolveFallbackPolicy,
} from "../../src/routing/fallback-policy";
import { fallbackPolicyError, fallbackPolicySchema } from "../../src/config/schema/fallback-policy";
import { writeLinkStore } from "../../src/link/store";
import { linkStorePath } from "../../src/link/paths";
import type { OcxConfig } from "../../src/types";
import type { OcxFallbackConfig } from "../../src/types/fallback";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const cfg = (fallback?: OcxFallbackConfig): OcxConfig => ({ fallback } as unknown as OcxConfig);
const LINK = "lnk_0123456789abcdef";

describe("precedence: device off is a ceiling; otherwise route > provider > global", () => {
  type Leaf = boolean | undefined;
  const leaves: Leaf[] = [undefined, true, false];
  for (const device of leaves) for (const route of leaves) for (const provider of leaves) for (const global of leaves) {
    const name = "device=" + device + " route=" + route + " provider=" + provider + " global=" + global;
    test(name, () => {
      const policy: OcxFallbackConfig = {
        ...(global !== undefined ? { provider: global } : {}),
        ...(provider !== undefined ? { providers: { anthropic: { provider } } } : {}),
        ...(route !== undefined ? { routes: { "combo/coding": { provider: route } } } : {}),
        ...(device !== undefined ? { devices: { [LINK]: { provider: device } } } : {}),
      };
      const decision = resolveFallbackPolicy(cfg(policy), {
        kind: "provider", routes: ["combo/coding"], provider: "anthropic", deviceIds: [LINK],
      });
      const expected = device === false ? { allowed: false, scope: "device" }
        : route !== undefined ? { allowed: route, scope: "route" }
          : provider !== undefined ? { allowed: provider, scope: "provider" }
            : global !== undefined ? { allowed: global, scope: "global" }
              : { allowed: true, scope: "default" };
      expect({ allowed: decision.allowed, scope: decision.scope }).toEqual(expected);
    });
  }

  test("kinds resolve independently", () => {
    const config = cfg({ model: false, routes: { "combo/x": { provider: false } } });
    expect(resolveFallbackPolicy(config, { kind: "model", routes: ["combo/x"] }).allowed).toBe(false);
    expect(resolveFallbackPolicy(config, { kind: "provider", routes: ["combo/x"] })).toEqual({ allowed: false, scope: "route", scopeKey: "combo/x" });
    expect(resolveFallbackPolicy(config, { kind: "provider", routes: ["combo/other"] })).toEqual({ allowed: true, scope: "default" });
  });

  test("a later alias matches when the first selector has no override", () => {
    const config = cfg({ routes: { "my-alias": { model: false } } });
    expect(resolveFallbackPolicy(config, { kind: "model", routes: ["combo/x", "my-alias"] }).scopeKey).toBe("my-alias");
  });

  test("absent or non-object policy allows (today's behavior)", () => {
    expect(resolveFallbackPolicy(cfg(), { kind: "model" })).toEqual({ allowed: true, scope: "default" });
    expect(resolveFallbackPolicy({ fallback: "off" } as unknown as OcxConfig, { kind: "model" }).allowed).toBe(true);
  });
});

describe("hop kind", () => {
  test("provider change, model change, and same target", () => {
    expect(fallbackHopKind({ provider: "a", model: "m" }, { provider: "b", model: "m" })).toBe("provider");
    expect(fallbackHopKind({ provider: "a", model: "m" }, { provider: "a", model: "n" })).toBe("model");
    expect(fallbackHopKind({ provider: "a", model: "m" }, { provider: "a", model: "m" })).toBeNull();
  });
});

describe("config degrade", () => {
  test("a malformed leaf reads as absent and diagnostics name the section", () => {
    const raw = { model: "no", provider: false, routes: { "bad key": { model: false }, ok: { model: "x", provider: false } } };
    const parsed = fallbackPolicySchema.parse(raw);
    expect(parsed.model).toBeUndefined();
    expect(parsed.provider).toBe(false);
    expect(parsed.routes?.ok).toEqual({ provider: false });
    // The bad key survives the read but the resolver never matches it.
    expect(resolveFallbackPolicy(cfg(parsed as OcxFallbackConfig), { kind: "model", routes: ["bad key"] }).scope).toBe("default");
    expect(fallbackPolicyError({ fallback: raw })).toContain("fallback");
    expect(fallbackPolicyError({ fallback: { model: false, devices: { [LINK]: { localFallback: true } } } })).toBeUndefined();
    expect(fallbackPolicyError({})).toBeUndefined();
  });
});

describe("device identity", () => {
  let home: TempHome;
  beforeEach(() => {
    home = createTempHome("ocx-fallback-device-");
    resetFallbackLinkCacheForTests();
  });
  afterEach(() => {
    resetFallbackLinkCacheForTests();
    home.remove();
  });

  test("a link data key resolves to its link id, a Hub key to itself, others to nothing", () => {
    writeLinkStore(linkStorePath(), {
      version: 1,
      listenerPort: 41000,
      links: [{ id: LINK, alias: "mac-studio", direction: "client-initiated", hostKeyFingerprint: null, tunnelPort: 41001, apiKeyId: "key_link", createdAt: "2026-10-22T00:00:00.000Z" }],
    });
    const config = cfg({ devices: { [LINK]: { model: false } } });
    expect(fallbackDeviceIds(config, { kind: "configured", keyId: "key_link" })).toEqual([LINK, "key_link"]);
    expect(fallbackDeviceIds(config, { kind: "configured", keyId: "key_hub" })).toEqual(["key_hub"]);
    expect(fallbackDeviceIds(config, { kind: "loopback" })).toEqual([]);
    expect(fallbackDeviceIds(config, undefined)).toEqual([]);
    // No device overrides: the store is never read and no identity is attached.
    expect(fallbackDeviceIds(cfg({ model: false }), { kind: "configured", keyId: "key_link" })).toEqual([]);
  });
});

describe("guard and refusal contract", () => {
  beforeEach(() => clearFallbackEventsForTests());

  test("a refused reactive hop keeps the failure status and names the command that allows it", async () => {
    const result = guardFallbackHop(cfg({ routes: { "combo/coding": { provider: false } } }), {
      site: "combo",
      route: "combo/coding",
      from: { provider: "anthropic", model: "claude-x" },
      to: { provider: "openai", model: "gpt-y" },
      trigger: "rate_limited",
      failureStatus: 429,
      retryAfter: "30",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get("x-opencodex-fallback")).toBe("refused");
    expect(result.response.headers.get("retry-after")).toBe("30");
    const body = await result.response.json() as { error: Record<string, unknown> };
    expect(body.error.type).toBe("fallback_refused");
    expect(body.error.code).toBe("fallback_refused");
    expect(body.error.fallback).toEqual({
      kind: "provider", scope: "route", scopeKey: "combo/coding",
      from: "anthropic/claude-x", to: "openai/gpt-y", trigger: "rate_limited",
    });
    expect(String(body.error.message)).toContain("ocx fallback on --kind provider --route combo/coding");
  });

  test("a proactive refusal answers 429 for quota triggers and 503 otherwise", () => {
    const off = cfg({ model: false });
    const hop = (trigger: "cooldown" | "unavailable") => guardFallbackHop(off, {
      site: "subagent", route: "a/m", from: { provider: "a", model: "m" }, to: { provider: "a", model: "n" }, trigger,
    });
    const cooled = hop("cooldown");
    const unavailable = hop("unavailable");
    expect(cooled.ok || cooled.response.status).toBe(429);
    expect(unavailable.ok || unavailable.response.status).toBe(503);
  });

  test("allowed hops are recorded as taken; a same-target retry is not a hop", () => {
    const config = cfg();
    expect(guardFallbackHop(config, { site: "combo", route: "combo/x", from: { provider: "a", model: "m" }, to: { provider: "a", model: "m" }, trigger: "upstream_5xx" }))
      .toEqual({ ok: true, kind: null });
    expect(guardFallbackHop(config, { site: "combo", route: "combo/x", from: { provider: "a", model: "m" }, to: { provider: "b", model: "m" }, trigger: "upstream_5xx" }).ok).toBe(true);
    const events = recentFallbackEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "taken", kind: "provider", from: "a/m", to: "b/m", scope: "default" });
  });

  test("the ring keeps the last 20 events", () => {
    for (let i = 0; i < 25; i += 1) {
      guardFallbackHop(cfg(), { site: "combo", route: "combo/x", from: { provider: "a", model: "m" + i }, to: { provider: "a", model: "n" }, trigger: "upstream_5xx" });
    }
    const events = recentFallbackEvents();
    expect(events).toHaveLength(20);
    expect(events[0]!.from).toBe("a/m5");
  });

  test("events carry selectors and codes only, never admission secrets", () => {
    guardFallbackHop(cfg({ devices: { key_hub: { model: false } } }), {
      site: "combo", route: "combo/x", from: { provider: "a", model: "m" }, to: { provider: "a", model: "n" },
      trigger: "rate_limited", admission: { kind: "configured", keyId: "key_hub", secret: "sk-should-never-appear" } as never,
    });
    const serialized = JSON.stringify(recentFallbackEvents());
    expect(serialized).not.toContain("sk-should-never-appear");
    expect(Object.keys(recentFallbackEvents()[0]!).sort()).toEqual(
      ["at", "deviceId", "from", "kind", "outcome", "route", "scope", "scopeKey", "site", "to", "trigger"],
    );
  });
});
