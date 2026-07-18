import { describe, expect, test } from "bun:test";
import catalog from "../gui/src/data/frontier-benchmarks.json";
import {
  benchmarkHasUniformMeasuredCost,
  benchmarkModeKind,
  rankFrontierRows,
  type FrontierBenchmark,
  type FrontierCatalog,
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

describe("frontier snapshot integrity", () => {
  const data = catalog as FrontierCatalog;

  test("ProgramBench costs match extended leaderboard and are measured", () => {
    const pb = data.benchmarks.find(b => b.id === "program-bench");
    expect(pb).toBeTruthy();
    expect(benchmarkHasUniformMeasuredCost(pb!)).toBe(true);
    const byId = Object.fromEntries(pb!.rows.map(r => [r.id, r.avgCostUsd]));
    expect(byId["pb-gpt-5.5-xhigh"]).toBe(8.85);
    expect(byId["pb-gpt-5.5-high"]).toBe(3.65);
    expect(byId["pb-claude-opus-4.7-xhigh"]).toBe(10.96);
    expect(byId["pb-gpt-5.5-default"]).toBe(1.21);
    expect(pb!.provenance.url).toContain("programbench.com/extended");
  });

  test("harness boards advertise modeKind=harness", () => {
    for (const id of ["frontierswe", "terminal-bench-2.1", "swe-marathon"]) {
      const b = data.benchmarks.find(x => x.id === id);
      expect(b, id).toBeTruthy();
      expect(benchmarkModeKind(b!)).toBe("harness");
    }
    expect(benchmarkModeKind(data.benchmarks.find(b => b.id === "deepswe")!)).toBe("effort");
  });
});
