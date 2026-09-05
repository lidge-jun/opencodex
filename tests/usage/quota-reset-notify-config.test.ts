import { describe, expect, test } from "bun:test";
import { resolveQuotaResetNotify } from "../../src/quota/reset-notify-config";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";

describe("quotaResetNotify schema", () => {
  function candidate(webhookUrl: string): unknown {
    return { ...getDefaultConfig(), quotaResetNotify: { enabled: true, webhookUrl } };
  }

  test("an http webhookUrl is rejected as schema_invalid", () => {
    // The payload carries account identity and the URL itself is often a bearer-equivalent
    // secret, so cleartext delivery is a boundary violation rather than a preference.
    const result = validateConfigCandidate(candidate("http://hooks.example.test/abc"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("schema_invalid: quotaResetNotify.webhookUrl");
  });

  test("an https webhookUrl is accepted", () => {
    expect(validateConfigCandidate(candidate("https://hooks.example.test/abc")).ok).toBe(true);
  });
});

describe("quotaResetNotify resolution", () => {
  test("an absent section is off", () => {
    expect(resolveQuotaResetNotify(undefined).enabled).toBe(false);
    expect(resolveQuotaResetNotify(null).enabled).toBe(false);
    expect(resolveQuotaResetNotify({}).enabled).toBe(false);
  });

  test("enabled with no sink is treated as off", () => {
    // An enabled notifier with nowhere to send is a misconfiguration. Reporting it as off is
    // what keeps the default-OFF guarantee honest: no sink means no timer and no observation.
    expect(resolveQuotaResetNotify({ enabled: true }).enabled).toBe(false);
    expect(resolveQuotaResetNotify({ enabled: true, command: [] }).enabled).toBe(false);
    expect(resolveQuotaResetNotify({ enabled: true, webhookUrl: "   " }).enabled).toBe(false);
  });

  test("enabled with a webhook or a command is on", () => {
    expect(resolveQuotaResetNotify({
      enabled: true,
      webhookUrl: "https://hooks.example.test/abc",
    }).enabled).toBe(true);
    expect(resolveQuotaResetNotify({ enabled: true, command: ["notify.sh"] }).enabled).toBe(true);
  });

  test("kinds default to both and filter to what was asked for", () => {
    const both = resolveQuotaResetNotify({ enabled: true, command: ["x"] });
    expect([...both.kinds].sort()).toEqual(["scheduled", "surprise"]);

    const only = resolveQuotaResetNotify({ enabled: true, command: ["x"], kinds: ["surprise"] });
    expect([...only.kinds]).toEqual(["surprise"]);

    // An unrecognized value must not silently produce an empty set that drops every event.
    const bogus = resolveQuotaResetNotify({ enabled: true, command: ["x"], kinds: ["nonsense"] });
    expect([...bogus.kinds].sort()).toEqual(["scheduled", "surprise"]);
  });

  test("poll seconds clamp, and 0 means passive-only", () => {
    expect(resolveQuotaResetNotify({ enabled: true, command: ["x"] }).pollMs).toBe(900_000);
    expect(resolveQuotaResetNotify({ enabled: true, command: ["x"], pollSeconds: 0 }).pollMs).toBe(0);
    // Below the floor: a 1-second poll would hammer a quota endpoint that rate-limits.
    expect(resolveQuotaResetNotify({ enabled: true, command: ["x"], pollSeconds: 1 }).pollMs)
      .toBe(600_000);
  });

  test("timeout clamps into a sane band", () => {
    expect(resolveQuotaResetNotify({ enabled: true, command: ["x"] }).timeoutMs).toBe(5_000);
    expect(resolveQuotaResetNotify({ enabled: true, command: ["x"], timeoutMs: 999_999 }).timeoutMs)
      .toBe(30_000);
    expect(resolveQuotaResetNotify({ enabled: true, command: ["x"], timeoutMs: -5 }).timeoutMs)
      .toBe(100);
  });

  test("private-network delivery is opt-in", () => {
    expect(resolveQuotaResetNotify({
      enabled: true,
      webhookUrl: "http://127.0.0.1:9000/hook",
    }).allowPrivateNetwork).toBe(false);
    expect(resolveQuotaResetNotify({
      enabled: true,
      webhookUrl: "http://127.0.0.1:9000/hook",
      allowPrivateNetwork: true,
    }).allowPrivateNetwork).toBe(true);
  });

  test("a garbage section resolves to off rather than throwing", () => {
    expect(resolveQuotaResetNotify("nope").enabled).toBe(false);
    expect(resolveQuotaResetNotify([1, 2, 3]).enabled).toBe(false);
    expect(resolveQuotaResetNotify({ enabled: "yes", webhookUrl: 42 }).enabled).toBe(false);
  });
});
