import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Cycle 1 of 260914_godfile_round2. No file is split here. The gate is a bun
 * test in the existing suite, not a new ci.yml job, because PR checkouts are a
 * single refs/pull/N/merge commit at fetch-depth 1 and cannot see origin/dev.
 *
 * The scanner exports evaluate() so this file can feed it synthetic FileSize
 * rows. Importing the module must not scan the repository: privacy-scan.ts runs
 * on import and that pattern is forbidden here.
 *
 * Source-oracle reads go through tests/helpers/repo-root.ts (INV-TESTS-01).
 */
import {
  GENERATED_PATHS,
  THRESHOLD,
  countLines,
  evaluate,
  isOffender,
  isScannedPath,
  loadBaseline,
  scanRepo,
  updateBaseline,
  type Baseline,
  type FileSize,
} from "../../scripts/file-size-ratchet";
import { repoPath, repoRoot } from "../helpers/repo-root";

/**
 * The ratchet must fail for the reason it claims. A single "repo is currently
 * green" test would stay green if evaluate() started returning NEW_OK for a
 * 2,000-line new file, as long as this tree had no such file today.
 *
 * Five pure cases plus one repository scan. Do not add a seventh test():
 * SHRANK already covers updateBaseline (lower, drop missing, never raise,
 * seed only when asked).
 */
const emptyBaseline = (): Baseline => ({ generated: [], files: {} });

const linesOf = (count: number): string => {
  const rows = Array.from({ length: count }, (_, i) => `line ${i}`);
  return `${rows.join("\n")}\n`;
};

describe("file-size ratchet: countLines", () => {
  test("NEW_OVERSIZED: baseline에 없고 2000줄 이상이면 실패", () => {
    // The formula is the contract: split on \n, then drop the phantom cell that a
    // trailing newline creates. wc -l disagrees on files that do not end in a newline,
    // so the helper is asserted here instead of trusted from the scanner comments.
    expect(countLines(linesOf(THRESHOLD))).toBe(THRESHOLD);
    expect(countLines(linesOf(THRESHOLD - 1))).toBe(THRESHOLD - 1);
    expect(countLines("")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);

    const oversized: FileSize[] = [{ path: "src/new-god.ts", lines: THRESHOLD }];
    const under: FileSize[] = [{ path: "src/new-small.ts", lines: THRESHOLD - 1 }];
    const baseline = emptyBaseline();

    expect(evaluate(oversized, baseline)).toEqual([
      { path: "src/new-god.ts", lines: THRESHOLD, verdict: "NEW_OVERSIZED" },
    ]);
    expect(evaluate(under, baseline)).toEqual([
      { path: "src/new-small.ts", lines: THRESHOLD - 1, verdict: "NEW_OK" },
    ]);
    expect(evaluate(oversized, baseline).filter(isOffender)).toHaveLength(1);
    expect(evaluate(under, baseline).filter(isOffender)).toEqual([]);
  });
});

describe("file-size ratchet: caps", () => {
  test("GREW: baseline 캡보다 길어지면 실패", () => {
    // Grandfathered files may stay oversized, but they may not grow. Equality is
    // UNCHANGED, not SHRANK; a test that only checked isOffender() would not notice
    // if equality started reporting GREW.
    const baseline: Baseline = { generated: [], files: { "src/config.ts": 4707 } };
    const grew = evaluate([{ path: "src/config.ts", lines: 4708 }], baseline);
    const same = evaluate([{ path: "src/config.ts", lines: 4707 }], baseline);

    expect(grew).toEqual([{ path: "src/config.ts", lines: 4708, verdict: "GREW" }]);
    expect(same).toEqual([{ path: "src/config.ts", lines: 4707, verdict: "UNCHANGED" }]);
    expect(grew.filter(isOffender)).toHaveLength(1);
    expect(same.filter(isOffender)).toEqual([]);
  });

  test("SHRANK: 줄면 통과하고 --update는 캡을 내리기만 한다", () => {
    // --update is operator tooling, not a seventh test(). The seed path is the only
    // way a 2,000+ file enters `files`; after that, a later --update without seed
    // must not re-grandfather a new godfile, must not raise a cap, and must keep a
    // shrunken former godfile so the facade cannot grow back.
    const baseline: Baseline = {
      generated: [],
      files: { "src/keep.ts": 2100, "src/gone.ts": 2500, "src/small.ts": 800 },
    };
    const current: FileSize[] = [
      { path: "src/keep.ts", lines: 2099 },
      { path: "src/small.ts", lines: 800 },
      { path: "src/new-ok.ts", lines: 1200 },
    ];

    expect(evaluate(current, baseline)).toEqual([
      { path: "src/keep.ts", lines: 2099, verdict: "SHRANK" },
      { path: "src/small.ts", lines: 800, verdict: "UNCHANGED" },
      { path: "src/new-ok.ts", lines: 1200, verdict: "NEW_OK" },
    ]);
    expect(evaluate(current, baseline).filter(isOffender)).toEqual([]);

    // seed=false: lower keep, drop gone, do not add new-ok (it is under 2000 and
    // must remain free to grow until 1999). small.ts stays at 800 even though it
    // is under the threshold — a former godfile must not grow back.
    const lowered = updateBaseline(current, baseline, false);
    expect(lowered.files).toEqual({ "src/keep.ts": 2099, "src/small.ts": 800 });
    expect(lowered.files["src/gone.ts"]).toBeUndefined();
    expect(lowered.files["src/new-ok.ts"]).toBeUndefined();

    // A later --update must never raise. If it did, ratchet:update would launder GREW.
    const notRaised = updateBaseline(
      [{ path: "src/keep.ts", lines: 3000 }],
      { generated: [], files: { "src/keep.ts": 2099 } },
      false,
    );
    expect(notRaised.files["src/keep.ts"]).toBe(2099);

    // seed=true is the first-commit path only (baseline file missing). Exempt
    // generated paths stay out of files even at 9000 lines. Under-threshold files
    // stay out so the 2,000 cap remains the policy for new modules.
    const seeded = updateBaseline(
      [
        { path: "src/old.ts", lines: 2500 },
        { path: "src/fresh.ts", lines: 1800 },
        { path: "gui/src/i18n/en.ts", lines: 9000 },
      ],
      { generated: ["gui/src/i18n/en.ts"], files: {} },
      true,
    );
    expect(seeded.files).toEqual({ "src/old.ts": 2500 });
  });

  test("GENERATED: baseline.generated 경로는 커져도 통과", () => {
    // Exact paths only. A sibling under cursor/gen/ that is not in generated[] is a
    // new oversized file, even though a glob would have exempted the whole directory.
    const path = "src/adapters/cursor/gen/agent_pb.ts";
    const baseline: Baseline = {
      generated: [path],
      files: { [path]: 100 },
    };
    const rows = evaluate([{ path, lines: 99_999 }], baseline);
    expect(rows).toEqual([{ path, lines: 99_999, verdict: "GENERATED" }]);
    expect(rows.filter(isOffender)).toEqual([]);

    const globWouldHaveCaught = evaluate(
      [{ path: "src/adapters/cursor/gen/hand-written.ts", lines: 2500 }],
      { generated: [path], files: {} },
    );
    expect(globWouldHaveCaught[0]?.verdict).toBe("NEW_OVERSIZED");
  });
});

describe("file-size ratchet: scan filter", () => {
  test("스캔제외: 화이트리스트 밖·제외 접두·bun.lock은 evaluate에 안 들어온다", () => {
    // evaluate() never sees excluded paths; the filter is isScannedPath(). devlog/,
    // assets, docs-site public/assets, gui/dist, bun.lock, and non-whitelist
    // extensions (.mdx, .png) stay out. src/generated/model-metadata.ts is scanned:
    // it is not on the 12-path exemption list, and if it crosses 2,000 it must fail.
    // Whitelist hits. .yml and .json are in the contract list; .mdx is not.
    expect(isScannedPath("src/config.ts")).toBe(true);
    expect(isScannedPath("gui/src/pages/Models.tsx")).toBe(true);
    expect(isScannedPath(".github/workflows/ci.yml")).toBe(true);
    expect(isScannedPath("scripts/foo.sh")).toBe(true);
    expect(isScannedPath("package.json")).toBe(true);
    expect(isScannedPath("README.md")).toBe(true);
    expect(isScannedPath("gui/src/styles.css")).toBe(true);
    expect(isScannedPath(".github/scripts/issue-quality.test.cjs")).toBe(true);
    expect(isScannedPath("scripts/foo.mjs")).toBe(true);

    // Prefix and exact exclusions. gui/dist without a trailing slash is listed
    // in the contract alongside gui/dist/ children.
    expect(isScannedPath("devlog/_plan/260914_godfile_round2/010.md")).toBe(false);
    expect(isScannedPath("assets/banner.png")).toBe(false);
    expect(isScannedPath("docs-site/public/favicon.png")).toBe(false);
    expect(isScannedPath("docs-site/src/assets/og.png")).toBe(false);
    expect(isScannedPath("gui/dist/index.js")).toBe(false);
    expect(isScannedPath("gui/dist")).toBe(false);
    expect(isScannedPath("bun.lock")).toBe(false);
    expect(isScannedPath("docs-site/src/content/docs/index.mdx")).toBe(false);
    expect(isScannedPath("src/generated/model-metadata.ts")).toBe(true);
  });
});

describe("file-size ratchet: repository", () => {
  test("저장소 스캔: 커밋된 기준선 대비 offender가 없다", () => {
    // Mirrors tests/ci-workflows/repo-hygiene.test.ts: git ls-files + expect([]).
    // An empty scan would also equal [], so scanned.length > 0 is the non-vacuous
    // guard. generated[] is the committed JSON, not the script constant used alone.
    const baseline = loadBaseline(
      readFileSync(repoPath("tests/fixtures/file-size-baseline.json"), "utf8"),
    );
    expect(baseline.generated).toEqual([...GENERATED_PATHS]);

    const scanned = scanRepo(repoRoot());
    expect(scanned.length).toBeGreaterThan(0);
    expect(scanned.some((file) => file.path.startsWith("devlog/"))).toBe(false);
    expect(scanned.some((file) => file.path === "bun.lock")).toBe(false);

    const rows = evaluate(scanned, baseline);
    expect(rows.filter(isOffender)).toEqual([]);
    expect(
      rows.filter((row) => row.verdict === "GENERATED").map((row) => row.path).sort(),
    ).toEqual([...GENERATED_PATHS].slice().sort());
  });
});
