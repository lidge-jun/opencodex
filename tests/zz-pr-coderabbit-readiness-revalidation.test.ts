import { describe, expect, test } from "bun:test";
import {
  callsTo,
  runEnforcePrTarget,
} from "./helpers/enforce-pr-target-harness";

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

const GATE_MARKER = "<!-- opencodex-pr-gate -->";
const CHECKLIST_START = "<!-- pr-quality-readiness-checklist:start -->";
const CHECKLIST_END = "<!-- pr-quality-readiness-checklist:end -->";
const CHECKLIST_ITEMS = [
  "All CI tests are green on my local testing.",
  "I pushed my PR to the latest dev commit.",
  "I resolved all correct Codex and CodeRabbit findings.",
  "My PR is ready for review.",
];

const MAINTAINERS_FIXTURE = [
  "## Current maintainers",
  "",
  "| GitHub account | Project role | Responsibilities |",
  "| --- | --- | --- |",
  "| [@lidge-jun](https://github.com/lidge-jun) | Project owner | x |",
  "| [@Ingwannu](https://github.com/Ingwannu) | Maintainer | x |",
  "| [@Wibias](https://github.com/Wibias) | Maintainer | x |",
].join("\n");

function completedChecklistBody(): string {
  const description = [
    "## Summary",
    "",
    "Fix the PR-quality gate so an unchanged CodeRabbit status wake cannot rewrite its own READY comment.",
    "",
    "## Test plan",
    "",
    "- Run the PR-quality regression tests.",
  ].join("\n");
  return [
    description,
    CHECKLIST_START,
    "## Review readiness checklist",
    "",
    ...CHECKLIST_ITEMS.map(item => `- [x] ${item}`),
    CHECKLIST_END,
  ].join("\n");
}

async function readGateScript(): Promise<string> {
  const text = await Bun.file(
    new URL("../.github/workflows/enforce-pr-target.yml", import.meta.url),
  ).text();
  const workflow = Bun.YAML.parse(text) as Workflow;
  const script = workflow.jobs?.["enforce-target"]?.steps?.find(
    step => step.name === "Enforce PR target, ancestry, and description",
  )?.with?.script;
  if (typeof script !== "string") {
    throw new Error("enforce-target step has no inline script");
  }
  return script;
}

function gateBodyFrom(
  result: Awaited<ReturnType<typeof runEnforcePrTarget>>,
): string {
  const updates = callsTo(result, "issues.updateComment") as Array<{ body: string }>;
  const creates = callsTo(result, "issues.createComment") as Array<{ body: string }>;
  const body = updates.at(-1)?.body ?? creates.at(-1)?.body;
  if (!body?.includes(GATE_MARKER)) {
    throw new Error("scenario recorded no PR gate comment body");
  }
  return body;
}

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

  test("an unchanged READY comment is not rewritten on a CodeRabbit status wake", async () => {
    const script = await readGateScript();
    const body = completedChecklistBody();

    const initial = await runEnforcePrTarget(script, {
      pr: { base: { ref: "dev" }, draft: true, body },
      maintainersFile: MAINTAINERS_FIXTURE,
    });
    const transitionBody = gateBodyFrom(initial);

    const steady = await runEnforcePrTarget(script, {
      pr: { base: { ref: "dev" }, draft: false, body },
      maintainersFile: MAINTAINERS_FIXTURE,
      labels: ["review-ready"],
      comments: [{
        id: 7,
        user: { login: "github-actions[bot]" },
        body: transitionBody,
      }],
    });
    const steadyBody = gateBodyFrom(steady);
    expect(steadyBody).toContain("This pull request is already Ready for Review.");
    expect(steadyBody).not.toContain("@coderabbitai review");

    const statusWake = await runEnforcePrTarget(script, {
      pr: { base: { ref: "dev" }, draft: false, body },
      eventName: "status",
      maintainersFile: MAINTAINERS_FIXTURE,
      labels: ["review-ready"],
      comments: [
        {
          id: 7,
          user: { login: "github-actions[bot]" },
          body: steadyBody,
        },
        {
          id: 8,
          user: { login: "github-actions[bot]" },
          body: "<!-- pr-quality-enforcer -->\nlegacy enforcer comment",
        },
        {
          id: 9,
          user: { login: "github-actions[bot]" },
          body: "<!-- pr-quality-readiness -->\nlegacy readiness comment",
        },
      ],
    });

    expect(callsTo(statusWake, "issues.updateComment")).toEqual([]);
    expect(callsTo(statusWake, "issues.createComment")).toEqual([]);
    expect(callsTo(statusWake, "issues.addLabels")).toEqual([]);
    expect(callsTo(statusWake, "issues.removeLabel")).toEqual([]);
    expect(callsTo(statusWake, "pulls.update")).toEqual([]);
    expect(callsTo(statusWake, "issues.deleteComment")).toEqual([
      { owner: "lidge-jun", repo: "opencodex", comment_id: 8 },
      { owner: "lidge-jun", repo: "opencodex", comment_id: 9 },
    ]);

    const graphqlCalls = callsTo(statusWake, "graphql") as Array<{ query: string }>;
    expect(graphqlCalls.some(call => call.query.includes("convertPullRequestToDraft"))).toBe(false);
    expect(graphqlCalls.some(call => call.query.includes("markPullRequestReadyForReview"))).toBe(false);
  });

  test("a repeated draft-conversion failure restores the failure body after its checkpoint write", async () => {
    const script = await readGateScript();
    const body = completedChecklistBody().replace(
      "- [x] My PR is ready for review.",
      "- [ ] My PR is ready for review.",
    );

    const firstFailure = await runEnforcePrTarget(script, {
      pr: { base: { ref: "dev" }, draft: false, body },
      maintainersFile: MAINTAINERS_FIXTURE,
      failGraphqlOn: ["convertPullRequestToDraft"],
    });
    const previousFailureBody = gateBodyFrom(firstFailure);
    expect(previousFailureBody).toContain('"autoDraftedByBot":false');
    expect(previousFailureBody).toContain("Automatic draft conversion failed");

    const repeatedFailure = await runEnforcePrTarget(script, {
      pr: { base: { ref: "dev" }, draft: false, body },
      maintainersFile: MAINTAINERS_FIXTURE,
      failGraphqlOn: ["convertPullRequestToDraft"],
      comments: [{
        id: 7,
        user: { login: "github-actions[bot]" },
        body: previousFailureBody,
      }],
    });

    const updates = callsTo(repeatedFailure, "issues.updateComment") as Array<{
      body: string;
      comment_id: number;
    }>;
    expect(callsTo(repeatedFailure, "issues.createComment")).toEqual([]);
    expect(updates).toHaveLength(2);
    expect(updates.map(update => update.comment_id)).toEqual([7, 7]);
    expect(updates[0]?.body).toContain('"autoDraftedByBot":true');
    expect(updates[1]?.body).toContain('"autoDraftedByBot":false');
    expect(updates[1]?.body).toContain("Automatic draft conversion failed");
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
