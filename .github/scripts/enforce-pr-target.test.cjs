"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { latestCodeRabbitReviewForHead } = require("./pr-quality-state.cjs");

describe("enforce-pr-target workflow", () => {
  const workflowPath = path.join(__dirname, "../workflows/enforce-pr-target.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  it("uses pull_request_target without checking out PR head code", () => {
    assert.match(workflow, /pull_request_target:/);
    assert.doesNotMatch(
      workflow,
      /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/,
      "enforcer must not check out untrusted PR head code",
    );
  });

  it("grants contents:write so draft GraphQL mutations work with GITHUB_TOKEN", () => {
    // convertPullRequestToDraft / markPullRequestReadyForReview fail with
    // "Resource not accessible by integration" when contents stays unset/read
    // (seen on #626). Assert the real permissions block, not comment text
    // that also mentions these scopes.
    const permissionsBlock = workflow.match(/^permissions:\n((?:[ \t]+.+\n)+)/m);
    assert.ok(permissionsBlock, "workflow must declare a top-level permissions block");
    const lines = permissionsBlock[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(lines, ["contents: write", "pull-requests: write"]);
  });

  it("fails the required check on a wrong base even if draft conversion fails", () => {
    assert.match(workflow, /core\.setFailed\(/);
    assert.match(workflow, /draftConversionFailed/);
    assert.match(workflow, /Could not convert pull request to draft/);
  });

  it("soft-fails ready-for-review restoration the same way", () => {
    assert.match(workflow, /readyConversionFailed/);
    assert.match(workflow, /Could not mark pull request ready for review/);
  });

  it("listens for synchronize so rebase can clear ancestry failures", () => {
    assert.match(workflow, /synchronize/);
  });

  it("uses label events for GUI waivers, hygiene sponsorship, and a trusted CodeRabbit status signal", () => {
    assert.doesNotMatch(workflow, /^  issue_comment:/m);
    assert.match(workflow, /- labeled/);
    assert.match(workflow, /- unlabeled/);
    assert.match(workflow, /^  status:/m);
    assert.match(workflow, /github\.event\.context == 'CodeRabbit'/);
    assert.match(workflow, /github\.event\.state == 'success'/);
    assert.match(workflow, /github\.event\.label\.name == 'gui-screenshot-waived'/);
    assert.match(workflow, /github\.event\.label\.name == 'intake: hygiene-blocked'/);
    assert.match(workflow, /github\.event\.label\.name == 'maintainer-sponsored'/);
    assert.match(workflow, /listPullRequestsAssociatedWithCommit/);
    assert.match(workflow, /candidate\.head\?\.sha === statusSha/);
    assert.match(workflow, /candidates\.length !== 1/);
  });

  it("does not add review events that would break the trusted-base model", () => {
    // `pull_request_review` / `pull_request_review_comment` load the workflow
    // from the PR head branch (like `pull_request`), while this workflow's
    // checkout pins the base SHA — head YAML + base scripts mismatch, so the
    // gate crashes (`parseGateState is not a function`) and the head controls
    // the workflow definition under a write token. The findings claim runs on
    // every `pull_request_target` event instead (opened/edited/synchronize/
    // ready_for_review).
    assert.doesNotMatch(workflow, /^  pull_request_review:/m);
    assert.doesNotMatch(workflow, /^  pull_request_review_comment:/m);
  });

  it("queries review threads and feeds them to the findings claim check", () => {
    // Paginated read: `after: $cursor` + `pageInfo.hasNextPage`, so a busy PR
    // with more than 100 threads cannot hide unresolved bot threads (fail-open
    // gap in a fail-closed check).
    assert.match(workflow, /reviewThreads\(first: 100, after: \$cursor\)/);
    assert.match(workflow, /hasNextPage/);
    assert.match(workflow, /unresolvedFindingsClaim/);
    assert.match(workflow, /findingsClaim\.byBot/);
    assert.match(workflow, /review_findings/);
  });

  it("fails closed when review threads cannot be read", () => {
    assert.match(workflow, /findingsUnverifiable/);
    assert.match(workflow, /findings claim could not be verified/);
  });

  it("writes exactly one consolidated comment via a single upsert helper", () => {
    assert.match(workflow, /GATE_MARKER,/);
    assert.match(workflow, /comment\.body\?\.includes\(GATE_MARKER\)/);
    assert.match(workflow, /upsertGateComment/);
    assert.match(workflow, /buildGateCommentBody/);
    // No legacy two-comment write path remains.
    assert.doesNotMatch(workflow, /upsertReadinessComment/);
    assert.doesNotMatch(workflow, /buildReadinessCommentBody/);
    // No intermediate checkpoint comment writes.
    assert.doesNotMatch(workflow, /Draft conversion pending/);
    assert.doesNotMatch(workflow, /Recording ownership state/);
  });

  it("manages the review-ready status label at the ready moment", () => {
    assert.match(workflow, /REVIEW_READY_LABEL\s*=\s*"review-ready"/);
    assert.match(workflow, /github\.rest\.issues\.addLabels/);
    assert.match(workflow, /github\.rest\.issues\.removeLabel/);
    assert.match(workflow, /reviewReadyDesired/);
  });

  it("does not embed a literal CodeRabbit review command in the ready notice", () => {
    // A literal "@coderabbitai review" inside the gate comment is executed by
    // CodeRabbit as a review command even when rendered as inline code. Its
    // success status then wakes this workflow again, which rewrites the same
    // comment, which CodeRabbit reads as a new command -- a self-sustaining
    // loop that only stops on CodeRabbit's per-hour rate limit. The ready
    // notice must describe the label without issuing a command (PR #1630).
    assert.doesNotMatch(workflow, /coderabbitai review/);
  });

  it("does not rewrite the gate comment when the rebuilt body is unchanged", () => {
    // The ready-path rebuild is deterministic: on a CodeRabbit status wake the
    // gate recomputes the same READY body and would call updateComment on it.
    // That no-op edit is still a mutation event to review bots and restarts the
    // loop above, so the upsert must skip the write when body equals the posted
    // comment body (PR #1630).
    assert.match(workflow, /if \(gateComment\?\.body === body\)/);
    assert.match(workflow, /let body = buildGateCommentBody/);
  });

  it("keeps CodeRabbit auto-review unfiltered so maintainer PRs are not starved", () => {
    // A positive `labels:` filter under `reviews.auto_review` in
    // `.coderabbit.yaml` would restrict ALL automatic reviews to PRs carrying
    // that label. Maintainer PRs never carry `review-ready` (no checklist), so
    // such a filter would silently stop CodeRabbit from reviewing maintainer
    // PRs. The label is a status marker only; assert the reviewer config
    // directly, since the workflow never writes a labels block.
    const coderabbit = fs.readFileSync(
      path.join(__dirname, "../../.coderabbit.yaml"),
      "utf8",
    );
    const autoReview = coderabbit.match(/auto_review:[\s\S]*?(?=\n\S|\n\s{2}\S)/);
    assert.ok(autoReview, ".coderabbit.yaml must declare auto_review");
    assert.doesNotMatch(autoReview[0], /labels:/);
  });

  it("migrates legacy two-comment PRs and deletes the old comments", () => {
    assert.match(workflow, /migrateLegacyCommentsIfNeeded/);
    assert.match(workflow, /migrateLegacyGateState/);
    assert.match(workflow, /github\.rest\.issues\.deleteComment/);
    assert.match(workflow, /legacyEnforcerComment/);
    assert.match(workflow, /legacyReadinessComment/);
  });

  it("checks out scripts from the event-specific trusted boundary (never PR head)", () => {
    // Scope the assertions to the checkout step itself, so a stray `ref:` on
    // another step cannot satisfy the pin while the checkout stays mutable.
    const checkoutStep = workflow
      .split("- name: Checkout trusted PR-quality scripts")[1]
      .split(/\n {6}- name:/)[0];
    assert.match(checkoutStep, /actions\/checkout@[0-9a-f]{40}/);
    // The trusted ref comes from a fixed set of integration branches, never
    // from the PR's own base commit: a stacked child's base is another open
    // PR's head, and `base.sha` would let that unpromoted commit choose the
    // code that runs with this job's write-capable token.
    //
    // `status` has no pull_request payload and sources from the default branch
    // that supplied the privileged workflow. A `main`-targeting PR sources
    // from `main` so the workflow definition and the scripts match. Everything
    // else resolves to `dev`.
    //
    // Exact equality, not fragment matching: separate checks for `status`,
    // `main`, and `dev` would all pass with the operator grouping wrong or a
    // surviving `base.sha` fallback.
    const ref = checkoutStep.match(/^\s*ref:\s*(.+)$/m)?.[1];
    assert.ok(ref, "trusted checkout must declare ref");
    assert.equal(
      ref.replace(/\s+/g, " ").trim(),
      "${{ github.event_name == 'status' && github.event.repository.default_branch || (github.event.pull_request.base.ref == 'main' && 'main' || 'dev') }}",
    );
    assert.doesNotMatch(ref, /base\.sha|head\.(?:sha|ref)/);
    // Pinning the checkout ref only gates one step. A later `run:` or
    // `github-script` step interpolating a head ref would execute
    // PR-controlled content with this workflow's write-capable token, so the
    // whole file is gated. (`pr.head.sha` read back from the API is an
    // identity for comparison, not an interpolated ref, and is unaffected.)
    assert.doesNotMatch(
      workflow,
      /github\.event\.pull_request\.head\.(?:sha|ref|repo)/,
      "no step in a pull_request_target workflow may interpolate a PR head ref",
    );
    // `refs/pull/<n>/head` reaches the same PR-controlled tree without ever
    // naming `head`, so ban the merge-ref form too.
    assert.doesNotMatch(
      workflow,
      /refs\/pull\//,
      "no step may check out a refs/pull/* ref",
    );
    // Banning literal text is not enough: `format('refs/{0}/{1}/{2}', ...)`
    // builds the same PR-controlled ref without ever spelling it. Every
    // checkout in a pull_request_target workflow must therefore declare a ref
    // drawn from the trusted allowlist, and no other step may name the PR
    // number in a ref-shaped expression.
    // An ALLOWLIST, not a denylist: every checkout in this workflow must use
    // exactly the trusted expression. Banning known-bad shapes lost twice —
    // first to `refs/pull/<n>/head`, then to `format('refs/{0}/...')` — and a
    // `repository:` override pointing at the fork head is a third shape no
    // denylist would have caught.
    const checkouts = workflow.match(/uses:\s*actions\/checkout@[\s\S]*?(?=\n {6}- name:|$)/g) ?? [];
    for (const step of checkouts) {
      const stepRef = (step.match(/^\s*ref:\s*(.+)$/m)?.[1] ?? "").replace(/\s+/g, " ").trim();
      assert.equal(stepRef, "${{ github.event_name == 'status' && github.event.repository.default_branch || (github.event.pull_request.base.ref == 'main' && 'main' || 'dev') }}", "every checkout must use the trusted ref");
      assert.doesNotMatch(step, /repository:/, "a checkout must not retarget its repository");
    }
    // Checkout is not the only way to obtain PR-controlled code. A `run:` step
    // can fetch it directly, and that is a realistic future edit rather than a
    // synthetic one, so executable steps are gated on the acquisition verbs
    // themselves.
    // Stop enumerating command shapes. A denylist lost four times here
    // (`refs/pull`, `format()`, `repository:`, `gh pr checkout`), and
    // `git clone https://github.com/<fork>` would have been the fifth. The
    // invariant is simpler than the attack surface: under
    // `pull_request_target`, nothing executable may name the PR head or the
    // fork repository at all.
    // Comments may discuss the head ref; only executable content may not use
    // it, so YAML comment lines are stripped before this check.
    const executable = workflow
      .split("\n")
      .filter(line => !/^\s*#/.test(line) && !/^\s*\/\//.test(line.replace(/^\s*/, "")))
      .join("\n");
    assert.doesNotMatch(
      executable.replace(/^\s*\/\/.*$/gm, ""),
      /github\.head_ref|pull_request(?:\[['"]head['"]\]|\.head)\s*(?:\[|\.)?\s*['"]?repo/,
      "no executable step may reference the PR head repository",
    );
    // Belt and braces for the acquisition verbs, which have no legitimate use
    // in either gate: both only read PR metadata through the API.
    assert.doesNotMatch(
      workflow,
      /gh\s+pr\s+checkout|git\s+(?:fetch|checkout|clone|switch)|refs\/pull/,
      "no step may acquire pull-request code",
    );
    // The readiness ping reads MAINTAINERS.md from the same trusted checkout.
    assert.match(checkoutStep, /sparse-checkout:\s*\|\s*\n\s*\.github\/scripts\n\s*MAINTAINERS\.md/);
    assert.match(checkoutStep, /persist-credentials:\s*false/);
    assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head/);
  });

  it("orders same-head CodeRabbit reviews deterministically without timestamps", () => {
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const latest = latestCodeRabbitReviewForHead({
      reviews: [
        {
          id: 41,
          commit_id: head,
          user: { login: "coderabbitai[bot]" },
          body: "older",
        },
        {
          id: 42,
          commit_id: head,
          user: { login: "coderabbitai[bot]" },
          body: "newer",
        },
      ],
      liveHeadSha: head,
    });
    assert.equal(latest?.id, 42);
  });

  it("loads pr-quality via require from the checked-out scripts", () => {
    assert.match(workflow, /pr-quality\.cjs/);
    assert.match(workflow, /collectPrQualityFailures/);
    assert.match(workflow, /pr-hygiene\.cjs/);
    assert.match(workflow, /collectDeterministicHygieneFailures/);
    assert.match(workflow, /pulls\.listFiles/);
  });

  it("checks stacked bases via open PR heads before wrong_base enforcement", () => {
    assert.match(workflow, /stackedBase/);
    assert.match(workflow, /github\.rest\.pulls\.list/);
    assert.match(workflow, /treating as stacked/);
    assert.match(workflow, /other\.base\?\.repo\?\.owner/);
    const qualityCall = workflow.match(
      /collectPrQualityFailures\(\{([\s\S]*?)\}\);/,
    );
    assert.ok(qualityCall, "must call collectPrQualityFailures");
    assert.match(qualityCall[1], /stackedBase/);
    assert.match(qualityCall[1], /changedFilePaths/);
    assert.match(qualityCall[1], /filesTruncated/);
    assert.match(workflow, /isChangedFileListTruncated/);
  });

  it("strips stale WRONG BRANCH prefix on failure when base is corrected", () => {
    const failureBlock = workflow.match(
      /if \(mustDraft\) \{([\s\S]*?)core\.setFailed\(/,
    );
    assert.ok(failureBlock, "workflow must have a draft path");
    const failurePath = failureBlock[1];
    assert.match(failurePath, /shouldStripTitlePrefix/);
    assert.match(failurePath, /!hasWrongBase/);
    assert.match(failurePath, /titlePrefixedByBot = false/);
    assert.match(failurePath, /pr\.title\.slice\(TITLE_PREFIX\.length\)/);
  });
});
