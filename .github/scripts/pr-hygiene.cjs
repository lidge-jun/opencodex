"use strict";

const { assessSponsoredSurface } = require("./pr-sponsored-surface.cjs");
const { assessCarryAttribution } = require("./pr-carry-attribution.cjs");

const GENERATED_PREFIXES = [
  "gui/dist/",
  "dist/",
  "coverage/",
  ".next/",
  "node_modules/",
];
const BEHAVIOR_PREFIXES = ["src/", "gui/src/"];
const TEST_PREFIXES = ["tests/"];
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[^.]+)$/;
const SUPPRESSION_PATTERN = /(?:@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|prettier-ignore)/;
const FOCUSED_TEST_PATTERN = /\b(?:describe|it|test)\.(?:only|skip)\s*\(/;

function addedLines(patch) {
  if (typeof patch !== "string") return [];
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function hasDeletions(patch) {
  if (typeof patch !== "string") return false;
  return patch
    .split("\n")
    .some((line) => line.startsWith("-") && !line.startsWith("---"));
}

// Lines that survive in the result of a hunk: additions plus context. Used for
// empty-catch detection when the hunk also deletes lines, so deleting a catch
// body cannot bypass the check.
//
// Returned per hunk, never as one flat list. Hunks are disjoint windows onto the
// file, so concatenating them puts unrelated lines next to each other: a hunk
// ending at `} catch (e) {` followed by one starting at `}` reads as an empty
// catch that does not exist anywhere in the file.
function resultLinesByHunk(patch) {
  if (typeof patch !== "string") return [];
  const hunks = [];
  let current = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      current = [];
      hunks.push(current);
      continue;
    }
    if (current === null) {
      // A patch without a hunk header (some API shapes omit it) is one window.
      current = [];
      hunks.push(current);
    }
    if ((line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" ")) {
      current.push(line.slice(1));
    }
  }
  return hunks;
}

// Flat form, kept for callers that only need the surviving text of a patch.
function resultLines(patch) {
  return resultLinesByHunk(patch).flat();
}

function isGeneratedPath(path) {
  return GENERATED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isBehaviorPath(path) {
  return BEHAVIOR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isTestPath(path) {
  return TEST_PREFIXES.some((prefix) => path.startsWith(prefix)) || TEST_FILE_PATTERN.test(path);
}

// A hunk whose surviving and removed lines are all comments or blank changed no
// behavior, so it cannot owe a regression test. This matters because the review
// standard here asks for dense explanatory comments in the source: a PR that
// only sharpens a comment about WHY something fails closed would otherwise be
// told to add a test for a change it did not make, and the only escape would be
// a maintainer label — which trains contributors to ask for the label instead of
// writing tests, weakening the gate everywhere it actually matters.
//
// Deliberately narrow: a single non-comment line anywhere in the file's patch
// makes the whole file count as behavior again. Block-comment CONTINUATION
// lines are recognized only in the common leading-asterisk form; anything more
// clever than that reads as code and keeps the requirement.
function isCommentOnlyChange(patch) {
  if (typeof patch !== "string") return false;
  const changed = patch
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    )
    .map((line) => line.slice(1).trim());
  if (changed.length === 0) return false;
  return changed.every(
    (line) =>
      line === "" ||
      line.startsWith("//") ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("#"),
  );
}

function hasEmptyCatch(lines) {
  const text = lines.join("\n");
  return /catch\s*(?:\([^)]*\))?\s*\{\s*\}/m.test(text);
}

function assessHygiene({ files = [], labels = [] }) {
  const labelSet = new Set(labels);
  const failures = [];
  const filenames = files.map((file) => file.filename);
  const removedFilenames = new Set(
    files
      .filter((file) => file.status === "removed")
      .map((file) => file.filename),
  );
  // Renames are classified on both sides: moving a behavior or generated file
  // to a documentation path must not bypass the hygiene gates.
  const previousFilenames = files.flatMap((file) =>
    file.previous_filename ? [file.previous_filename] : [],
  );
  const allPaths = [...new Set([...filenames, ...previousFilenames])];
  // A file whose patch is entirely comments changed no behavior. Renamed-from
  // paths carry no patch of their own, so they are judged by the file that
  // carries them.
  const commentOnlyPaths = new Set(
    files
      .filter((file) => isCommentOnlyChange(file.patch))
      .flatMap((file) =>
        file.previous_filename
          ? [file.filename, file.previous_filename]
          : [file.filename],
      ),
  );
  const behaviorChanged = allPaths.some(
    (path) => isBehaviorPath(path) && !commentOnlyPaths.has(path),
  );
  // Deleted tests add no coverage and must not satisfy the regression gate.
  const testsChanged = allPaths.some(
    (path) => isTestPath(path) && !removedFilenames.has(path),
  );

  if (
    behaviorChanged &&
    !testsChanged &&
    !labelSet.has("test-exception-approved")
  ) {
    failures.push({ code: "missing_regression_test" });
  }

  const generated = allPaths.filter(
    (path) => isGeneratedPath(path) && !removedFilenames.has(path),
  );
  if (
    generated.length > 0 &&
    !labelSet.has("generated-change-approved")
  ) {
    failures.push({ code: "generated_output", paths: generated });
  }

  // A lockfile that MOVED with no manifest beside it is still orphaned, so both
  // sides of a rename count. A lockfile that was DELETED is not: dropping
  // `bun.lock` adds no dependency, which is why the generated-output and
  // regression-test checks above exclude removals the same way.
  if (
    allPaths.includes("bun.lock") &&
    !removedFilenames.has("bun.lock") &&
    !allPaths.includes("package.json") &&
    !labelSet.has("dependency-change-approved")
  ) {
    failures.push({ code: "orphan_lockfile" });
  }

  const suppressions = [];
  const focusedTests = [];
  const emptyCatches = [];
  for (const file of files) {
    const lines = addedLines(file.patch);
    if (lines.some((line) => SUPPRESSION_PATTERN.test(line))) {
      suppressions.push(file.filename);
    }
    if (lines.some((line) => FOCUSED_TEST_PATTERN.test(line))) {
      focusedTests.push(file.filename);
    }
    // Scan hunk by hunk: an empty catch has to be empty within one window.
    const catchWindows = hasDeletions(file.patch)
      ? resultLinesByHunk(file.patch)
      : [lines];
    if (catchWindows.some((window) => hasEmptyCatch(window))) {
      emptyCatches.push(file.filename);
    }
  }

  if (
    suppressions.length > 0 &&
    !labelSet.has("suppression-approved")
  ) {
    failures.push({ code: "new_suppression", paths: suppressions });
  }
  if (
    focusedTests.length > 0 &&
    !labelSet.has("test-exception-approved")
  ) {
    failures.push({ code: "focused_or_skipped_test", paths: focusedTests });
  }
  if (emptyCatches.length > 0) {
    failures.push({ code: "empty_catch", paths: emptyCatches });
  }

  return failures;
}

/**
 * Human-readable one-liners for each deterministic hygiene failure code.
 * Shared by the hygiene workflow comment and the PR quality gate actions.
 */
const HYGIENE_FAILURE_HINTS = {
  missing_regression_test:
    "Behavior changed under `src/` or `gui/src/` without a test change. Add focused coverage or obtain `test-exception-approved`.",
  generated_output:
    "Generated build output is committed. Remove it or obtain `generated-change-approved`.",
  orphan_lockfile:
    "`bun.lock` changed without `package.json`. Revert accidental churn or obtain `dependency-change-approved`.",
  new_suppression:
    "A new TypeScript, lint, formatter, or similar suppression was added. Fix the underlying issue or obtain `suppression-approved`.",
  focused_or_skipped_test:
    "A focused or skipped test was added. Restore the complete suite or obtain `test-exception-approved`.",
  empty_catch:
    "An empty catch block was added. Handle, report, or deliberately propagate the error.",
  unsponsored_surface:
    "This changes an authentication, workflow, release-automation, or dependency surface. `MAINTAINERS.md` requires security review for these; ask a maintainer to apply `maintainer-sponsored` once they have reviewed it.",
  missing_coauthor_credit:
    "This pull request says it reimplements, supersedes, carries, or rebases another author's pull request, but no `Co-authored-by` trailer names that author. Prose in a commit body is not read by anything; the trailer is what GitHub counts. Add it to the description or a commit, or obtain `attribution-approved`.",
};

/**
 * Labels that can clear or reinstate a hygiene failure. The quality gate must
 * wake on these so READY / DRAFT tracks sponsorship and exception approvals
 * without waiting for an unrelated synchronize.
 */
const HYGIENE_GATE_LABELS = [
  "intake: hygiene-blocked",
  "maintainer-sponsored",
  "test-exception-approved",
  "suppression-approved",
  "generated-change-approved",
  "dependency-change-approved",
  "attribution-approved",
];

/**
 * Combine patch-hygiene and sponsored-surface failures into one list so the
 * hygiene workflow and the PR quality gate cannot disagree about Ready.
 */
function collectDeterministicHygieneFailures({
  files = [],
  labels = [],
  authorHasPushPermission = false,
  prAuthorLogin = "",
  title = "",
  body = "",
  commits = [],
  referencedAuthors = {},
}) {
  // Renames must keep the source path: moving a restricted file to a
  // non-restricted destination must not drop the sponsorship requirement.
  const changedFiles = [
    ...new Set(
      files.flatMap((file) => [
        file.filename,
        ...(file.previous_filename ? [file.previous_filename] : []),
      ]),
    ),
  ];
  return [
    ...assessHygiene({ files, labels }),
    ...assessSponsoredSurface({
      authorHasPushPermission,
      changedFiles,
      labels,
    }),
    // Reads the pull request's text rather than its diff: a carry declares
    // itself in prose, and the trailer it needs lives in the same place.
    ...assessCarryAttribution({
      prAuthorLogin,
      title,
      body,
      commits,
      labels,
      referencedAuthors,
    }),
  ];
}

module.exports = {
  addedLines,
  assessHygiene,
  collectDeterministicHygieneFailures,
  HYGIENE_FAILURE_HINTS,
  HYGIENE_GATE_LABELS,
  hasEmptyCatch,
  hasDeletions,
  isBehaviorPath,
  isGeneratedPath,
  isTestPath,
  resultLines,
  resultLinesByHunk,
};
