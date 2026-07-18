import { describe, expect, test } from "bun:test";
import {
  benchmarkHasUniformMeasuredCost,
  rankFrontierRows,
  type FrontierBenchmark,
  type FrontierRow,
} from "../gui/src/frontier-types";

function row(partial: Partial<FrontierRow> & Pick<FrontierRow, "id" | "model" | "score" | "avgCostUsd" | "costKind">): FrontierRow {
  return {
    family: "other",
    tags: [],
    ...partial,
  };
}

function board(rows: FrontierRow[]): FrontierBenchmark {
  return {
    id: "t",
    title: "T",
    sourceNote: "",
    updated: "2026-07-01",
    provenance: { url: "https://example.com", capturedAt: "2026-07-01" },
    axes: { xKey: "avgCostUsd", yKey: "score", xLabel: "Cost", yLabel: "Score" },
    rows,
  };
}

describe("frontier ranking / measured costs", () => {
  test("uniform measured board allows value ranking", () => {
    const rows = [
      row({ id: "a", model: "a", score: 50, avgCostUsd: 10, costKind: "measured" }),
      row({ id: "b", model: "b", score: 40, avgCostUsd: 2, costKind: "measured" }),
    ];
    expect(benchmarkHasUniformMeasuredCost(board(rows))).toBe(true);
    const ranked = rankFrontierRows(rows, { preferValue: true });
    expect(ranked.map(r => r.id)).toEqual(["b", "a"]); // 20 score/$ beats 5
  });

  test("mixed or estimated boards never get score/$ ranking", () => {
    const mixed = [
      row({ id: "a", model: "a", score: 50, avgCostUsd: 10, costKind: "measured" }),
      row({ id: "b", model: "b", score: 40, avgCostUsd: 2, costKind: "estimated" }),
    ];
    expect(benchmarkHasUniformMeasuredCost(board(mixed))).toBe(false);
    const ranked = rankFrontierRows(mixed, { preferValue: true });
    expect(ranked.map(r => r.id)).toEqual(["a", "b"]); // score only
  });
});
