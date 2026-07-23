import { describe, expect, test } from "bun:test";
import type { TKey } from "../gui/src/i18n/shared";
import {
  buildProviderModelGroups,
  discoveryFailureBadgeLabel,
  type ProviderDiscoverySummary,
} from "../gui/src/models-groups";

type Row = { provider: string; id: string; native?: boolean };

describe("Models page provider grouping", () => {
  test("keeps configured zero-model providers visible with discovery state", () => {
    const groups = buildProviderModelGroups<Row>(
      [{ provider: "openai", id: "gpt-5.6-sol", native: true }],
      [
        { name: "openai", authMode: "forward" },
        { name: "empty-live", liveModels: true },
        { name: "empty-static", liveModels: false, models: [] },
      ],
    );

    expect(groups.map(group => [group.provider, group.rows.length, group.liveModels])).toEqual([
      ["openai", 1, true],
      ["empty-live", 0, true],
      ["empty-static", 0, false],
    ]);
    expect(groups[0]?.native).toBe(true);
    expect(groups[1]?.native).toBe(false);
    expect(groups[1]?.discovery).toBeNull();
  });

  test("excludes disabled and empty forward providers but preserves row-backed groups", () => {
    const groups = buildProviderModelGroups<Row>(
      [
        { provider: "disabled", id: "stale-custom-row" },
        { provider: "combo", id: "coding" },
        { provider: "configured", id: "m1" },
      ],
      [
        { name: "disabled", disabled: true },
        { name: "forward-only", authMode: "forward" },
        { name: "configured", liveModels: false, models: ["m1"] },
      ],
    );

    expect(groups.map(group => group.provider)).toEqual(["combo", "configured"]);
    expect(groups.find(group => group.provider === "configured")?.configuredModels).toEqual(["m1"]);
  });

  test("forwards provider discovery status into each group (#329)", () => {
    const discovery: ProviderDiscoverySummary = {
      ok: false,
      kind: "http",
      httpStatus: 401,
      fallback: "configured",
      at: 1,
    };
    const groups = buildProviderModelGroups<Row>(
      [],
      [{ name: "ark-plan", liveModels: true, discovery }],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.discovery).toEqual(discovery);
  });
});

describe("discoveryFailureBadgeLabel", () => {
  const labels: Partial<Record<TKey, string>> = {
    "models.discoveryFailed": "Discovery failed",
    "models.discoveryFailedHttp": "Discovery failed (HTTP {status})",
    "models.discoveryFailedNetwork": "Discovery failed (network)",
    "models.discoveryFailedPolicy": "Discovery failed (blocked)",
    "models.discoveryFailedMalformed": "Discovery failed (invalid response)",
  };
  const t = (key: TKey, vars?: Record<string, string | number>) => {
    let out = labels[key] ?? key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        out = out.split(`{${name}}`).join(String(value));
      }
    }
    return out;
  };

  test("returns null for missing or successful discovery", () => {
    expect(discoveryFailureBadgeLabel(null, t)).toBeNull();
    expect(discoveryFailureBadgeLabel({ ok: true, kind: "ok" }, t)).toBeNull();
    expect(discoveryFailureBadgeLabel({ ok: true, kind: "empty" }, t)).toBeNull();
  });

  test("formats HTTP, network, policy, and malformed failures", () => {
    expect(discoveryFailureBadgeLabel({ ok: false, kind: "http", httpStatus: 401 }, t))
      .toBe("Discovery failed (HTTP 401)");
    expect(discoveryFailureBadgeLabel({ ok: false, kind: "http", httpStatus: 403 }, t))
      .toBe("Discovery failed (HTTP 403)");
    expect(discoveryFailureBadgeLabel({ ok: false, kind: "network" }, t))
      .toBe("Discovery failed (network)");
    expect(discoveryFailureBadgeLabel({ ok: false, kind: "policy" }, t))
      .toBe("Discovery failed (blocked)");
    expect(discoveryFailureBadgeLabel({ ok: false, kind: "malformed" }, t))
      .toBe("Discovery failed (invalid response)");
  });
});
