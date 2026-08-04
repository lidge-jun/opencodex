import { describe, expect, test } from "bun:test";
import { buildProviderModelGroups } from "../gui/src/models-groups";

type Row = { provider: string; id: string; native?: boolean };

describe("Models page provider grouping", () => {
  test("keeps configured zero-model providers visible with discovery state", () => {
    const groups = buildProviderModelGroups<Row>(
      [{ provider: "openai", id: "gpt-5.6-sol", native: true }],
      [
        { name: "openai", authMode: "forward" },
        {
          name: "empty-live",
          liveModels: true,
          discovery: { status: "failed", reason: "http", httpStatus: 401 },
        },
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
    expect(groups[1]?.discovery).toEqual({ status: "failed", reason: "http", httpStatus: 401 });
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
});
