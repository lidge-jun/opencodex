"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  detectTypeLabelFromTitle,
  detectTypeLabelFromCommits,
  hasHumanTypeLabelOverride,
  planTypeLabelSync,
  TYPE_LABELS,
} = require("./pr-labeler.cjs");

describe("detectTypeLabelFromTitle", () => {
  it("maps conventional prefixes to type labels", () => {
    assert.equal(detectTypeLabelFromTitle("fix(codex): warn after sync"), "bug");
    assert.equal(detectTypeLabelFromTitle("feat(images): add bridge"), "enhancement");
    assert.equal(detectTypeLabelFromTitle("docs: update guide"), "documentation");
    assert.equal(detectTypeLabelFromTitle("chore!: drop legacy"), "chore");
  });

  it("maps sentence-case prefixes when no conventional colon is present", () => {
    assert.equal(
      detectTypeLabelFromTitle("Fix Console Go tool schema sanitization"),
      "bug",
    );
    assert.equal(detectTypeLabelFromTitle("Feat add Grok image bridge"), "enhancement");
    assert.equal(detectTypeLabelFromTitle("Docs update setup guide"), "documentation");
  });

  it("returns null without a recognized prefix", () => {
    assert.equal(detectTypeLabelFromTitle("Warn or restart stale app-server"), null);
    assert.equal(detectTypeLabelFromTitle(""), null);
    assert.equal(detectTypeLabelFromTitle("constructor: drop legacy"), null);
    assert.equal(detectTypeLabelFromTitle("Fixed Console Go tool schema"), null);
    assert.equal(detectTypeLabelFromTitle("Fix"), null);
  });
});

describe("hasHumanTypeLabelOverride", () => {
  it("is false when only the Actions bot touched type labels", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), false);
  });

  it("is true after a human replaces the bot type label (PR #518)", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      { event: "unlabeled", label: { name: "bug" }, actor: { login: "Wibias" } },
      { event: "labeled", label: { name: "enhancement" }, actor: { login: "Wibias" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), true);
  });

  it("stays true even if the bot later reverts the human choice", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      { event: "unlabeled", label: { name: "bug" }, actor: { login: "Wibias" } },
      { event: "labeled", label: { name: "enhancement" }, actor: { login: "Wibias" } },
      { event: "unlabeled", label: { name: "enhancement" }, actor: { login: "github-actions[bot]" } },
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), true);
  });

  it("ignores non-type labels from humans", () => {
    const events = [
      { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      { event: "labeled", label: { name: "needs-triage" }, actor: { login: "Wibias" } },
    ];
    assert.equal(hasHumanTypeLabelOverride(events), false);
  });
});

describe("planTypeLabelSync", () => {
  it("adds the detected label and removes other type labels when bot-owned", () => {
    const plan = planTypeLabelSync({
      title: "fix(codex): warn after sync",
      currentLabels: ["enhancement", "needs-triage"],
      events: [
        { event: "labeled", label: { name: "enhancement" }, actor: { login: "github-actions[bot]" } },
      ],
    });
    assert.deepEqual(plan, {
      skip: false,
      detected: "bug",
      add: "bug",
      remove: ["enhancement"],
    });
    assert.ok(TYPE_LABELS.has("bug"));
  });

  it("is a no-op add when the detected label is already present", () => {
    const plan = planTypeLabelSync({
      title: "fix(codex): warn after sync",
      currentLabels: ["bug"],
      events: [
        { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
      ],
    });
    assert.deepEqual(plan, {
      skip: false,
      detected: "bug",
      add: null,
      remove: [],
    });
  });

  it("skips when a human has overridden the type label", () => {
    const plan = planTypeLabelSync({
      title: "fix(codex): warn after sync",
      currentLabels: ["enhancement"],
      events: [
        { event: "labeled", label: { name: "bug" }, actor: { login: "github-actions[bot]" } },
        { event: "unlabeled", label: { name: "bug" }, actor: { login: "Wibias" } },
        { event: "labeled", label: { name: "enhancement" }, actor: { login: "Wibias" } },
      ],
    });
    assert.deepEqual(plan, { skip: true, reason: "human-override" });
  });

  it("labels sentence-case bug-fix titles (PR #524)", () => {
    const plan = planTypeLabelSync({
      title: "Fix Console Go tool schema sanitization",
      currentLabels: [],
      events: [],
    });
    assert.deepEqual(plan, {
      skip: false,
      detected: "bug",
      add: "bug",
      remove: [],
    });
  });

  it("skips titles without a recognized prefix", () => {
    const plan = planTypeLabelSync({
      title: "Warn or restart stale app-server",
      currentLabels: [],
      events: [],
    });
    assert.deepEqual(plan, { skip: true, reason: "no-prefix" });
  });
});

describe("detectTypeLabelFromCommits", () => {
  it("reads the type from unanimous commits", () => {
    assert.equal(
      detectTypeLabelFromCommits([
        "fix(usage): price long-context requests at the published long rate",
      ]),
      "bug",
    );
  });

  it("treats chore as supporting, not competing (PR #955 shape)", () => {
    // Four `fix(codex):` commits plus one `test(codex):`. Requiring unanimity
    // would abstain here, and on almost every real PR — nearly every
    // substantial change carries a test or chore commit alongside its fix.
    assert.equal(
      detectTypeLabelFromCommits([
        "fix(codex): probe reset-derived cooldowns without waiting to be selected",
        "fix(codex): fail closed on an unrecognized plan",
        "fix(codex): classify prolite as a weekly plan",
        "fix(codex): share one window rule instead of a plan allowlist",
        "test(codex): assert the window rule in literals",
      ]),
      "bug",
    );
  });

  it("keeps chore when nothing else competes", () => {
    assert.equal(
      detectTypeLabelFromCommits(["ci: pin an action", "test: add a case"]),
      "chore",
    );
  });

  it("abstains on a genuine mix of fix and feat", () => {
    assert.equal(
      detectTypeLabelFromCommits(["fix(a): repair x", "feat(b): add y"]),
      null,
    );
  });

  it("reads only the first line of a multi-line commit message", () => {
    // A body line starting with `feat:` must not vote.
    assert.equal(
      detectTypeLabelFromCommits([
        "fix(a): repair x\n\nfeat: this is prose in the body, not a type",
      ]),
      "bug",
    );
  });

  it("returns null for absent or unusable input", () => {
    assert.equal(detectTypeLabelFromCommits([]), null);
    assert.equal(detectTypeLabelFromCommits(undefined), null);
    assert.equal(detectTypeLabelFromCommits(["", null]), null);
  });
});

describe("planTypeLabelSync commit fallback", () => {
  it("labels a stack PR whose title carries no type", () => {
    // `stack 3/5:` fails the conventional regex (the `3/5` sits between the
    // word and the colon), reaches the sentence-case fallback, which extracts
    // `stack` — a word with no PREFIX_TO_LABEL entry. The sync used to skip
    // here, and a skip is not a failure, so the `label` check stayed green
    // while all four stack PRs carried no type label.
    const plan = planTypeLabelSync({
      title: "stack 3/5: carry six contributor bug fixes with authorship intact",
      currentLabels: [],
      events: [],
      commitMessages: [
        "fix(kiro): round-trip the redactedContent reasoning blob",
        "fix(responses): close passthrough streams at terminal events",
      ],
    });
    assert.deepEqual(plan, { skip: false, detected: "bug", add: "bug", remove: [] });
  });

  it("does not let commits override a title that already classifies", () => {
    const plan = planTypeLabelSync({
      title: "feat(providers): add a preset",
      currentLabels: [],
      events: [],
      commitMessages: ["fix(a): repair x", "fix(b): repair y"],
    });
    assert.equal(plan.detected, "enhancement");
  });

  it("still skips when neither the title nor the commits classify", () => {
    const plan = planTypeLabelSync({
      title: "stack 1/5: triage the open issue surface",
      currentLabels: [],
      events: [],
      commitMessages: ["wip", "more wip"],
    });
    assert.deepEqual(plan, { skip: true, reason: "no-prefix" });
  });

  it("still honours a human override before consulting commits", () => {
    const plan = planTypeLabelSync({
      title: "stack 2/5: price long-context requests",
      currentLabels: ["enhancement"],
      events: [
        { event: "labeled", label: { name: "enhancement" }, actor: { login: "a-human" } },
      ],
      commitMessages: ["fix(usage): price long-context requests"],
    });
    assert.deepEqual(plan, { skip: true, reason: "human-override" });
  });
});

describe("pr-labeler workflow", () => {
  const workflowPath = path.join(__dirname, "../workflows/pr-labeler.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  function pullRequestTargetTypes() {
    const match = workflow.match(/pull_request_target:\s*\n(?:[ \t].*\n)*?[ \t]+types:\s*\[([^\]]+)\]/);
    assert.ok(match, "expected pull_request_target types array in pr-labeler.yml");
    return match[1].split(",").map((type) => type.trim());
  }

  it("listens for labeled and unlabeled so human overrides cancel stale sync runs", () => {
    const types = pullRequestTargetTypes();
    assert.ok(types.includes("labeled"), "missing pull_request_target type: labeled");
    assert.ok(types.includes("unlabeled"), "missing pull_request_target type: unlabeled");
    assert.ok(types.includes("synchronize"), "missing pull_request_target type: synchronize");
  });

  it("keeps trusted default-branch checkout, concurrency cancel, and minimal permissions", () => {
    assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/);
    assert.match(workflow, /cancel-in-progress:\s*true/);
    assert.match(workflow, /issues:\s*write/);
    // The issues label endpoints are shared with pull requests: writing a label
    // onto a PR number needs pull_requests=write alongside issues=write, which
    // GitHub reports as `issues=write; pull_requests=write`. Pinning this to
    // read made the workflow fail closed on the first PR that actually needed a
    // label applied (#565), so write is the minimum here, not an escalation.
    assert.match(workflow, /pull-requests:\s*write/);
    // contents stays read — the labeler never pushes.
    assert.match(workflow, /contents:\s*read/);
    assert.doesNotMatch(workflow, /contents:\s*write/);
  });
});
