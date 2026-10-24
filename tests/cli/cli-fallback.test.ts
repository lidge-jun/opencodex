/**
 * `ocx fallback` (OCX-11): human status lines, `ocx status --json` fallback when no proxy answers,
 * and usage refusals that never reach the proxy.
 */
import { describe, expect, test } from "bun:test";
import { fallbackStatusLines, handleFallbackCommand } from "../../src/cli/fallback";
import { collectStatusFallback } from "../../src/cli/status-fallback";
import type { OcxConfig } from "../../src/types";

describe("ocx fallback", () => {
  test("status lines name every scope, the device permission and the last event", () => {
    expect(fallbackStatusLines({
      global: { model: true, provider: false },
      providers: { anthropic: { model: false } },
      routes: { "combo/coding": { provider: true } },
      devices: [{ id: "lnk_0123456789abcdef", alias: "mac-studio", localFallback: true, model: false, provider: null }],
      last: { at: "2026-10-22T00:00:00.000Z", outcome: "refused", kind: "provider", route: "combo/coding", from: "a/m", to: "b/n", trigger: "rate_limited", scope: "device" },
    })).toEqual([
      "model fallback: on (global)",
      "provider fallback: off (global)",
      "provider anthropic: model off",
      "route combo/coding: provider on",
      "device lnk_0123456789abcdef (mac-studio): local fallback allowed, model off, provider inherit",
      "last: 2026-10-22T00:00:00.000Z refused provider fallback on combo/coding: a/m -> b/n (rate_limited, device)",
    ]);
    expect(fallbackStatusLines({}).at(-1)).toBe("last: no fallback since this proxy started");
  });

  test("status --json reports the local policy when no proxy answers; a Child claims nothing locally", async () => {
    const config = { fallback: { model: false } } as OcxConfig;
    const local = await collectStatusFallback(config, { live: false, linkChild: false });
    expect(local).toMatchObject({ schema: "ocx.fallback/1", source: "local", global: { model: false, provider: true }, recent: [] });
    const child = await collectStatusFallback(config, { live: false, linkChild: true });
    expect(child).toMatchObject({ source: "local", global: { model: true, provider: true } });
  });

  test("usage errors exit 2 without a request", async () => {
    const calls: string[] = [];
    const deps = { findLiveProxy: async () => { calls.push("probe"); return null; } };
    for (const argv of [["bogus"], ["off", "--kind", "account"], ["off", "--route", "a", "--device", "b"], ["local", "maybe", "--device", "x"], ["local", "on"]]) {
      expect(await handleFallbackCommand(argv, deps as never)).toBe(2);
    }
    expect(calls).toEqual([]);
  });
});
