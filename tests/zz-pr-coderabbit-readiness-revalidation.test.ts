import { describe, expect, test } from "bun:test";

type WorkflowJob = {
  if?: string;
  "runs-on"?: string;
  steps?: Array<{
    name?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
  }>;
};

type Workflow = {
  on?: {
    issue_comment?: { types?: string[] };
    pull_request_target?: { types?: string[] };
    pull_request_review?: { types?: string[] };
    workflow_run?: { workflows?: string[]; types?: string[] };
    status?: unknown;
  };
  jobs?: Record<string, WorkflowJob>;
};

describe("workflow comment-spam hardening", () => {
  test("PR gate consumes CodeRabbit commit status from the trusted default branch", async () => {
    const text = await Bun.file(
      new URL("../.github/workflows/enforce-pr-target.yml", import.meta.url),
    ).text();
    const workflow = Bun.YAML.parse(text) as Workflow;

    expect(workflow.on?.issue_comment).toBeUndefined();
    expect(workflow.on?.pull_request_review).toBeUndefined();
    expect(workflow.on?.workflow_run).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(workflow.on ?? {}, "status")).toBe(true);
    expect(workflow.on?.pull_request_target?.types).toEqual(expect.arrayContaining([
      "edited",
      "labeled",
      "ready_for_review",
      "synchronize",
      "unlabeled",
    ]));

    const resolver = workflow.jobs?.["resolve-pr"];
    const resolverIf = (resolver?.if ?? "").replace(/\s+/g, " ").trim();
    for (const guard of [
      "github.event_name == 'status'",
      "github.event.context == 'CodeRabbit'",
      "github.event.state == 'success'",
      "github.event.sender.login == 'coderabbitai[bot]'",
      "github.event.sender.id == 136622811",
      "github.event.action != 'labeled'",
      "github.event.action != 'unlabeled'",
      "github.event.label.name == 'gui-screenshot-waived'",
    ]) {
      expect(resolverIf).toContain(guard);
    }

    const job = workflow.jobs?.["enforce-target"];
    expect(job?.if).toBe("needs.resolve-pr.outputs.pull-number != ''");

    const checkoutStep = job?.steps?.find(
      step => step.name === "Checkout trusted PR-quality scripts",
    );
    // Trusted scripts come from a fixed set of integration branches, never
    // from the pull request itself. `status` keeps the default-branch
    // boundary that owns the event; a `main`-targeting PR matches the workflow
    // definition loaded from `main`; every other base resolves to `dev`.
    expect(checkoutStep?.with?.ref).toBe(
      "${{ github.event_name == 'status' && github.event.repository.default_branch || (github.event.pull_request.base.ref == 'main' && 'main' || 'dev') }}",
    );

    const gateStep = job?.steps?.find(
      step => step.name === "Enforce PR target, ancestry, and description",
    );
    const script = gateStep?.with?.script ?? "";
    expect(gateStep?.env?.RESOLVED_PULL_NUMBER).toBe(
      "${{ needs.resolve-pr.outputs.pull-number }}",
    );
    expect(script).toContain("process.env.RESOLVED_PULL_NUMBER");
    expect(script).not.toContain("listPullRequestsAssociatedWithCommit");
    expect(script).toContain('const GUI_SCREENSHOT_WAIVER_LABEL = "gui-screenshot-waived"');
    expect(script).toContain("screenshotWaiverNotice");
    expect(script).toContain("unresolvedFindingsClaim");
  });

  test("issue-comment translation rejects PR and bot comments before runner allocation", async () => {
    const text = await Bun.file(
      new URL("../.github/workflows/enforce-issue-quality.yml", import.meta.url),
    ).text();
    const workflow = Bun.YAML.parse(text) as Workflow;
    const jobIf = workflow.jobs?.["translate-comment"]?.if ?? "";

    expect(jobIf).toContain("github.event_name == 'issue_comment'");
    expect(jobIf).toContain("github.event.issue.pull_request == null");
    expect(jobIf).toContain("github.event.comment.user.type != 'Bot'");
  });

  test("contributor docs describe the label waiver and commit-status trust boundary", async () => {
    const docs = await Bun.file(
      new URL("../docs-site/src/content/docs/contributing/pr-quality.md", import.meta.url),
    ).text();

    expect(docs).toContain("gui-screenshot-waived");
    expect(docs).toContain("`CodeRabbit` commit status");
    expect(docs).toContain("`status` event");
    expect(docs).toContain("exactly one open");
    expect(docs).toContain("CodeRabbit status-comment edits do not trigger the PR gate");
  });
});
