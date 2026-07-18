/**
 * One-shot migrator: add provenance + costKind, fix known AA Coding contradictions.
 * Run: node gui/scripts/patch-frontier-provenance.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "src", "data", "frontier-benchmarks.json");
const data = JSON.parse(readFileSync(path, "utf8"));

/** Boards whose $/task figures are leaderboard-published measurements. */
const MEASURED = new Set(["deepswe", "frontiercode", "aa-intelligence-index", "aa-coding-agent"]);

const PROVENANCE = {
  deepswe: {
    url: "https://www.deepwiki.com/deepswe",
    capturedAt: "2026-07-16",
    license: "Public leaderboard snapshot; verify current rankings on the source before citing.",
  },
  "aa-coding-agent": {
    url: "https://artificialanalysis.ai/agents/coding-agents",
    capturedAt: "2026-07-09",
    version: "Coding Agent Index (post GPT-5.6 GA)",
    license: "Figures from Artificial Analysis public pages; not affiliated with AA.",
  },
  "aa-intelligence-index": {
    url: "https://artificialanalysis.ai/leaderboards/models",
    capturedAt: "2026-07-16",
    license: "Figures from Artificial Analysis public pages; not affiliated with AA.",
  },
  frontiercode: {
    url: "https://cognition.com/frontiercode",
    capturedAt: "2026-07-16",
    license: "Public FrontierCode snapshot; verify on cognition.com before citing.",
  },
  frontierswe: {
    url: "https://frontierswe.com",
    capturedAt: "2026-07-16",
    license: "Scores from FrontierSWE; costs are illustrative API/relative blends, not measured $/task.",
  },
  "terminal-bench-2.1": {
    url: "https://www.tbench.ai",
    capturedAt: "2026-07-11",
    license: "Harness results from Terminal-Bench; costs are estimates / API blends.",
  },
  "program-bench": {
    url: "https://programbench.com",
    capturedAt: "2026-06-23",
    license: "Scores from ProgramBench; some cost fields disputed vs extended board — treated as estimated.",
  },
  "swe-marathon": {
    url: "https://swe-marathon.org",
    capturedAt: "2026-07-09",
    license: "Scores from SWE-Marathon; costs are estimates.",
  },
  "frontend-code-arena": {
    url: "https://arena.ai",
    capturedAt: "2026-07-16",
    license: "Elo/scores from Code Arena; costs are estimates.",
  },
  cybench: {
    url: "https://cybench.github.io",
    capturedAt: "2026-07-16",
    license: "Please cite Cybench when republishing results (see cybench.github.io).",
    citation: "Cybench — https://cybench.github.io",
  },
};

for (const b of data.benchmarks) {
  const prov = PROVENANCE[b.id] ?? {
    url: "https://github.com/lidge-jun/opencodex",
    capturedAt: b.updated || "2026-07-01",
    license: "Illustrative snapshot; confirm on the original leaderboard before citing.",
  };
  b.provenance = prov;
  b.updated = prov.capturedAt;

  const kind = MEASURED.has(b.id) ? "measured" : "estimated";
  for (const row of b.rows) {
    if (!row.costKind) row.costKind = kind;
  }

  // Axis honesty for estimate boards
  if (kind === "estimated") {
    if (b.axes?.xLabel && /cost/i.test(b.axes.xLabel) && !/estimat|illustrat|relative|api/i.test(b.axes.xLabel)) {
      b.axes.xLabel = "Estimated cost (USD, illustrative)";
    }
  }
}

// Fix AA Coding Agent contradicted GPT-5.6 / Grok 4.5 figures (review 2026-07-18).
const aa = data.benchmarks.find(b => b.id === "aa-coding-agent");
if (aa) {
  aa.updated = "2026-07-09";
  aa.sourceNote =
    "Artificial Analysis Coding Agent Index snapshot (post GPT-5.6 GA, 2026-07-09). See provenance.url. Not live OpenCodex metering.";
  const patch = {
    "gpt-5.6-sol": { score: 80, avgCostUsd: 3.9 },
    "gpt-5.6-terra": { score: 77, avgCostUsd: 2.4 },
    "gpt-5.6-luna": { score: 75, avgCostUsd: 1.55 },
    "grok-4.5": { score: 76, avgCostUsd: 2.54 },
  };
  for (const row of aa.rows) {
    const p = patch[row.model];
    if (p) {
      row.score = p.score;
      row.avgCostUsd = p.avgCostUsd;
      row.costKind = "measured";
    }
  }
}

data.version = Math.max(Number(data.version) || 1, 2);

writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
console.log("patched", path, "boards", data.benchmarks.length);
