import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileScript, runEnforcePrTarget } from "../helpers/enforce-pr-target-harness";
import { repoRoot } from "../helpers/repo-root";

// Head-specific exception approvals (#7652): each one counts only for the head
// the hygiene workflow recorded it under, on every evaluation, not only when the
// triggering event happens to be a synchronize that survived the concurrency
// queue. These run the real workflow scripts against a recording client.

const requireFromTest = createRequire(import.meta.url);
const messages = requireFromTest(join(repoRoot(), ".github", "scripts", "pr-quality-messages.cjs")) as {
  GATE_MARKER: string;
  HYGIENE_MARKER: string;
  HYGIENE_BLOCK_START: string;
  HYGIENE_BLOCK_END: string;
  authoritativeHygieneSection(comments: unknown[]): string | null;
  withHygieneSection(body: string, lines: string[]): string;
  extractHygieneSection(body: string): string | null;
};
const { parseApprovalRecord } = requireFromTest(join(repoRoot(), ".github", "scripts", "pr-hygiene.cjs")) as {
  parseApprovalRecord(source: string | null): { head: string; headRewrites: number | null } | null;
};

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HARNESS_HEAD = "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b";
const APPROVAL = "test-exception-approved";
const FORCE_PUSH = { event: "head_ref_force_pushed" };
const BEHAVIOR_ONLY = [{ filename: "src/feature.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }];
const WITH_TEST = [...BEHAVIOR_ONLY, { filename: "tests/feature.test.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }];

const recordLine = (head: string, headRewrites: number | null) =>
  "<!-- pr-hygiene-approvals " + JSON.stringify({ head, headRewrites }) + " -->";

type Comment = { id: number; user: { login: string }; body: string };
type EventRead = Array<Array<{ event: string }>> | Error;

function gateComment(hygieneLines: string[]): Comment {
  return {
    id: 7,
    user: { login: "github-actions[bot]" },
    body: messages.withHygieneSection(messages.GATE_MARKER + "\n\n## ⏳ DRAFT", hygieneLines),
  };
}

function workflowScript(file: string, job: string, stepName: string): string {
  const workflow = Bun.YAML.parse(readFileSync(join(repoRoot(), ".github", "workflows", file), "utf8")) as {
    jobs: Record<string, { steps: Array<{ name?: string; with?: { script?: string } }> }>;
  };
  const script = workflow.jobs[job]?.steps.find(step => step.name === stepName)?.with?.script;
  if (typeof script !== "string") throw new Error(file + ": step not found: " + stepName);
  return script;
}

type HygieneRun = {
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  failures: string[];
  comments: Comment[];
  error: unknown;
};

async function runHygiene(options: {
  action: string;
  head?: string;
  /** Head reported by each successive pulls.get; the last one repeats. */
  headReads?: string[];
  labels?: string[];
  files?: Array<{ filename: string; status: string; patch: string }>;
  comments?: Comment[];
  eventReads?: EventRead[];
  removeLabelStatus?: number;
}): Promise<HygieneRun> {
  const calls: HygieneRun["calls"] = [];
  const failures: string[] = [];
  const labels = new Set(options.labels ?? []);
  const reads = [...(options.eventReads ?? [])];
  const headReads = [...(options.headReads ?? [])];
  let lastHead = options.head ?? HEAD_B;
  let comments = (options.comments ?? []).map(comment => ({ ...comment }));
  const note = (method: string, args: Record<string, unknown>) => calls.push({ method, args });
  const ok = <T>(data: T) => ({ data });
  const github = {
    paginate: async (fn: (args: Record<string, unknown>) => Promise<{ data?: unknown[]; pages?: unknown[][] }>, args: Record<string, unknown>) => {
      const result = await fn(args);
      return result.pages ? result.pages.flat() : result.data;
    },
    rest: {
      issues: {
        getLabel: async (args: Record<string, unknown>) => (note("issues.getLabel", args), ok({})),
        createLabel: async (args: Record<string, unknown>) => (note("issues.createLabel", args), ok({})),
        listEvents: async (args: Record<string, unknown>) => {
          note("issues.listEvents", args);
          const next = reads.shift() ?? [[]];
          if (next instanceof Error) throw next;
          return { pages: next };
        },
        removeLabel: async (args: Record<string, unknown>) => {
          note("issues.removeLabel", args);
          if (options.removeLabelStatus) {
            throw Object.assign(new Error("removeLabel failed"), { status: options.removeLabelStatus });
          }
          labels.delete(String(args.name));
          return ok({});
        },
        addLabels: async (args: Record<string, unknown>) => {
          note("issues.addLabels", args);
          for (const name of args.labels as string[]) labels.add(name);
          return ok({});
        },
        listComments: async (args: Record<string, unknown>) => (note("issues.listComments", args), ok(comments.map(c => ({ ...c })))),
        updateComment: async (args: Record<string, unknown>) => {
          note("issues.updateComment", args);
          comments = comments.map(c => (c.id === args.comment_id ? { ...c, body: String(args.body) } : c));
          return ok({});
        },
        createComment: async (args: Record<string, unknown>) => {
          note("issues.createComment", args);
          comments.push({ id: 100 + comments.length, user: { login: "github-actions[bot]" }, body: String(args.body) });
          return ok({});
        },
      },
      pulls: {
        get: async (args: Record<string, unknown>) => {
          note("pulls.get", args);
          return ok({
            number: 42,
            title: "fix: adjust feature",
            body: "",
            user: { login: "contributor" },
            head: { sha: (lastHead = headReads.shift() ?? lastHead) },
            base: { ref: "dev" },
            labels: [...labels].map(name => ({ name })),
          });
        },
        listFiles: async (args: Record<string, unknown>) => (note("pulls.listFiles", args), ok(options.files ?? BEHAVIOR_ONLY)),
        listCommits: async (args: Record<string, unknown>) => (note("pulls.listCommits", args), ok([])),
      },
      repos: {
        getCollaboratorPermissionLevel: async (args: Record<string, unknown>) =>
          (note("repos.getCollaboratorPermissionLevel", args), ok({ permission: "write" })),
      },
    },
  };
  const core = {
    info: () => {},
    debug: () => {},
    notice: () => {},
    warning: () => {},
    error: () => {},
    setFailed: (message: string) => failures.push(String(message)),
    setOutput: () => {},
  };
  const context = {
    eventName: "pull_request_target",
    repo: { owner: "lidge-jun", repo: "opencodex" },
    payload: { action: options.action, pull_request: { number: 42, base: { ref: "dev" } } },
  };
  let error: unknown = null;
  try {
    await compileScript(workflowScript("pr-hygiene.yml", "hygiene", "Enforce deterministic PR hygiene"))({
      github,
      octokit: github,
      context,
      core,
      require: requireFromTest,
      __original_require__: requireFromTest,
      process: { cwd: () => repoRoot(), env: {} },
    });
  } catch (caught) {
    error = caught;
  }
  return { calls, failures, comments, error };
}

const removed = (run: HygieneRun) =>
  run.calls.filter(call => call.method === "issues.removeLabel").map(call => call.args.name);
const regressionFailure = (run: HygieneRun) => run.failures.some(f => f.includes("missing_regression_test"));
function hygieneSection(run: HygieneRun): string {
  const gate = run.comments.find(c => c.body.includes(messages.GATE_MARKER));
  const section = gate ? messages.extractHygieneSection(gate.body) : run.comments.at(-1)?.body;
  if (typeof section !== "string") throw new Error("no hygiene section was written");
  return section;
}
const lastLine = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean).at(-1);

describe("pr-hygiene head-bound approvals", () => {
  test("an edited run after a head change drops an approval recorded for the old head", async () => {
    const run = await runHygiene({
      action: "edited",
      head: HEAD_B,
      labels: [APPROVAL],
      comments: [gateComment(["✅ **Deterministic PR hygiene checks passed.**", recordLine(HEAD_A, 0)])],
      eventReads: [[[]], [[]]],
    });
    expect(run.error).toBeNull();
    expect(removed(run)).toEqual([APPROVAL]);
    expect(regressionFailure(run)).toBe(true);
    expect(hygieneSection(run)).toContain("ℹ️ Removed \x60" + APPROVAL + "\x60");
    expect(lastLine(hygieneSection(run))).toBe(recordLine(HEAD_B, 0));
  });

  test("an approval applied while the recorded head is current is kept and recorded", async () => {
    const run = await runHygiene({
      action: "labeled",
      labels: [APPROVAL],
      comments: [gateComment(["⚠️ **Deterministic hygiene checks failed.**", recordLine(HEAD_B, 0)])],
      eventReads: [[[]], [[]]],
    });
    expect(run.error).toBeNull();
    expect(removed(run)).toEqual([]);
    expect(run.failures).toEqual([]);
    expect(lastLine(hygieneSection(run))).toBe(recordLine(HEAD_B, 0));
  });

  test("a synchronize run drops approvals even when the record names the current head", async () => {
    const run = await runHygiene({
      action: "synchronize",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 0)])],
      eventReads: [[[]], [[]]],
    });
    expect(removed(run)).toEqual([APPROVAL]);
    expect(regressionFailure(run)).toBe(true);
  });

  test("a head rewrite since the record drops the approval", async () => {
    const run = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 0)])],
      eventReads: [[[FORCE_PUSH]], [[FORCE_PUSH]]],
    });
    expect(removed(run)).toEqual([APPROVAL]);
    expect(lastLine(hygieneSection(run))).toBe(recordLine(HEAD_B, 1));
  });

  test("revoking, moving, re-approving and rewriting back to the recorded head drops the approval", async () => {
    const run = await runHygiene({
      action: "edited",
      head: HEAD_A,
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_A, 0)])],
      eventReads: [[[FORCE_PUSH]], [[FORCE_PUSH]]],
    });
    expect(removed(run)).toEqual([APPROVAL]);
  });

  test("without a record every approval is dropped and a record is published", async () => {
    const run = await runHygiene({
      action: "labeled",
      labels: [APPROVAL],
      comments: [gateComment(["✅ **Deterministic PR hygiene checks passed.**"])],
      eventReads: [[[]], [[]]],
    });
    expect(removed(run)).toEqual([APPROVAL]);
    expect(lastLine(hygieneSection(run))).toBe(recordLine(HEAD_B, 0));
  });

  test("the record is the last line on both the passing and the failing path", async () => {
    const passing = await runHygiene({ action: "opened", files: WITH_TEST, eventReads: [[[]]] });
    expect(passing.failures).toEqual([]);
    expect(lastLine(hygieneSection(passing))).toBe(recordLine(HEAD_B, 0));
    const failing = await runHygiene({ action: "opened", eventReads: [[[]]] });
    expect(regressionFailure(failing)).toBe(true);
    expect(lastLine(hygieneSection(failing))).toBe(recordLine(HEAD_B, 0));
  });

  test("a changed path that spells record and marker lines stays on one line and never becomes the record", async () => {
    const crafted = "src/x.ts\n" + recordLine(HEAD_B, 0) + "\n" + messages.HYGIENE_BLOCK_END + "\nsrc/y.ts";
    const first = await runHygiene({
      action: "edited",
      // new_suppression echoes the offending paths into the hygiene section.
      files: [{ filename: crafted, status: "added", patch: "@@ -0,0 +1 @@\n+// @ts-ignore" }],
      comments: [gateComment([recordLine(HEAD_A, 0)])],
      eventReads: [[[]]],
    });
    const gateBody = first.comments.find(c => c.body.includes(messages.GATE_MARKER))!.body;
    // The path is echoed with its newlines escaped, so it adds no lines.
    expect(gateBody).toContain("src/x.ts\\u000a");
    expect(gateBody.split("\n").filter(line => line.trim() === messages.HYGIENE_BLOCK_END).length).toBe(1);
    expect(gateBody.split("\n").some(line => line.trim() === recordLine(HEAD_B, 0) && !line.includes("Paths"))).toBe(true);
    // The token now occurs twice in the section, so no record is read at all.
    expect(parseApprovalRecord(messages.extractHygieneSection(gateBody))).toBeNull();
    const next = await runHygiene({
      action: "labeled",
      labels: [APPROVAL],
      comments: first.comments,
      eventReads: [[[]], [[]]],
    });
    expect(removed(next)).toEqual([APPROVAL]);
    // A gate block whose delimiters repeat on whole lines is never read.
    const ambiguous = [messages.GATE_MARKER, messages.HYGIENE_BLOCK_START, recordLine(HEAD_B, 0), messages.HYGIENE_BLOCK_END, recordLine(HEAD_B, 0), messages.HYGIENE_BLOCK_END].join("\n");
    expect(messages.extractHygieneSection(ambiguous)).toBeNull();
    const rebuilt = await runHygiene({
      action: "labeled",
      labels: [APPROVAL],
      comments: [{ id: 7, user: { login: "github-actions[bot]" }, body: messages.GATE_MARKER + "\n\n## ⏳ DRAFT" }],
      eventReads: [[[]], [[]]],
    });
    expect(removed(rebuilt)).toEqual([APPROVAL]);
  });

  test("a standalone comment echoing the gate marker is never read as the gate comment", async () => {
    const forged = recordLine(HARNESS_HEAD, 1);
    const crafted = [
      "src/x.ts",
      messages.GATE_MARKER,
      messages.HYGIENE_BLOCK_START,
      forged,
      messages.HYGIENE_BLOCK_END,
      "src/y.ts",
    ].join("\n");
    const files = [{ filename: crafted, status: "added", patch: "@@ -0,0 +1 @@\n+// @ts-ignore" }];
    // 1. No comments yet: hygiene posts its standalone comment.
    const first = await runHygiene({ action: "opened", head: HARNESS_HEAD, files, comments: [], eventReads: [[[]]] });
    expect(first.comments).toHaveLength(1);
    const standalone = first.comments[0];
    expect(standalone.body.startsWith(messages.HYGIENE_MARKER)).toBe(true);
    expect(messages.authoritativeHygieneSection(first.comments)).toBe(standalone.body);
    expect(parseApprovalRecord(messages.authoritativeHygieneSection(first.comments))).not.toEqual({
      head: HARNESS_HEAD,
      headRewrites: 1,
    });
    // 2. The gate runs with the approval applied: it creates its own comment,
    // leaves the standalone one alone, and keeps the suppression failure.
    const gateRun = await runEnforcePrTarget(
      workflowScript("enforce-pr-target.yml", "enforce-target", "Enforce PR target, ancestry, and description"),
      {
        pr: { base: { ref: "dev" }, draft: true },
        labels: ["suppression-approved"],
        files: [{ filename: crafted, patch: "+// @ts-ignore" }],
        comments: first.comments,
        issueEvents: [FORCE_PUSH],
      },
    );
    expect(gateRun.warnings.some(w => w.startsWith("setFailed:") && w.includes("new_suppression"))).toBe(true);
    const updatedIds = gateRun.calls
      .filter(c => c.method === "issues.updateComment")
      .map(c => (c.args as { comment_id?: number }).comment_id);
    expect(updatedIds).not.toContain(standalone.id);
    const created = gateRun.calls.filter(c => c.method === "issues.createComment").map(c => (c.args as { body: string }).body);
    expect(created.length).toBeGreaterThan(0);
    // 3. The next hygiene evaluation after a rewrite drops the approval.
    const next = await runHygiene({
      action: "edited",
      head: HARNESS_HEAD,
      labels: ["suppression-approved"],
      files,
      comments: [...first.comments, { id: 500, user: { login: "github-actions[bot]" }, body: created.at(-1)! }],
      eventReads: [[[FORCE_PUSH]], [[FORCE_PUSH]]],
    });
    expect(removed(next)).toEqual(["suppression-approved"]);
  });

  test("the record keeps the rewrite count read before the snapshot", async () => {
    const run = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 0)])],
      eventReads: [[[]], [[FORCE_PUSH]]],
    });
    expect(removed(run)).toEqual([APPROVAL]);
    expect(lastLine(hygieneSection(run))).toBe(recordLine(HEAD_B, 0));
  });

  test("unreadable rewrite history never confirms an approval", async () => {
    const both = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 0)])],
      eventReads: [new Error("events unavailable"), new Error("events unavailable")],
    });
    expect(both.error).toBeNull();
    expect(removed(both)).toEqual([APPROVAL]);
    expect(lastLine(hygieneSection(both))).toBe(recordLine(HEAD_B, null));

    const afterOnly = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 0)])],
      eventReads: [[[]], new Error("events unavailable")],
    });
    expect(removed(afterOnly)).toEqual([APPROVAL]);
    expect(lastLine(hygieneSection(afterOnly))).toBe(recordLine(HEAD_B, 0));

    const beforeOnly = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 0)])],
      eventReads: [new Error("events unavailable"), [[]]],
    });
    expect(removed(beforeOnly)).toEqual([]);
    expect(lastLine(hygieneSection(beforeOnly))).toBe(recordLine(HEAD_B, null));
    // A null baseline confirms nothing on the following run.
    const following = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: beforeOnly.comments,
      eventReads: [[[]], [[]]],
    });
    expect(removed(following)).toEqual([APPROVAL]);
  });

  test("rewrite events are counted across every page", async () => {
    const run = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 1)])],
      eventReads: [[[{ event: "labeled" }], [FORCE_PUSH]], [[{ event: "labeled" }], [FORCE_PUSH]]],
    });
    expect(removed(run)).toEqual([]);
    expect(lastLine(hygieneSection(run))).toBe(recordLine(HEAD_B, 1));
  });

  test("a label already gone is tolerated; any other removal failure publishes no record", async () => {
    const gone = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_A, 0)])],
      eventReads: [[[]], [[]]],
      removeLabelStatus: 404,
    });
    expect(gone.error).toBeNull();
    expect(lastLine(hygieneSection(gone))).toBe(recordLine(HEAD_B, 0));

    const broken = await runHygiene({
      action: "edited",
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_A, 0)])],
      eventReads: [[[]], [[]]],
      removeLabelStatus: 500,
    });
    expect(broken.error).not.toBeNull();
    expect(broken.calls.some(c => c.method === "issues.updateComment" || c.method === "issues.createComment")).toBe(false);
  });

  test("files listed after the head moved confirm no approval", async () => {
    const run = await runHygiene({
      action: "edited",
      headReads: [HEAD_B, HEAD_A],
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_B, 0)])],
      eventReads: [[[]], [[]]],
    });
    expect(removed(run)).toEqual([APPROVAL]);
    expect(regressionFailure(run)).toBe(true);
  });

  test("a rewrite not yet visible in either read is not counted (accepted limitation)", async () => {
    const run = await runHygiene({
      action: "edited",
      head: HEAD_A,
      labels: [APPROVAL],
      comments: [gateComment([recordLine(HEAD_A, 0)])],
      eventReads: [[[]], [[]]],
    });
    expect(removed(run)).toEqual([]);
  });
});

describe("enforce gate reads the hygiene head binding", () => {
  const gateScript = () => workflowScript("enforce-pr-target.yml", "enforce-target", "Enforce PR target, ancestry, and description");
  async function gate(options: { labels: string[]; record?: string; failOn?: string[]; issueEvents?: Array<{ event: string }> }) {
    return runEnforcePrTarget(gateScript(), {
      pr: { base: { ref: "dev" }, draft: true },
      labels: options.labels,
      files: [{ filename: "src/feature.ts", patch: "+b" }],
      comments: options.record ? [{ ...gateComment([options.record]), updated_at: "2026-10-25T00:00:00Z" }] : [],
      issueEvents: options.issueEvents ?? [],
      failOn: options.failOn,
    });
  }
  const gateFlagsRegression = (result: Awaited<ReturnType<typeof runEnforcePrTarget>>) =>
    result.warnings.some(w => w.startsWith("setFailed:") && w.includes("missing_regression_test"));

  test("an approval recorded for another head does not clear the failure", async () => {
    const result = await gate({ labels: [APPROVAL], record: recordLine(HEAD_A, 0) });
    expect(gateFlagsRegression(result)).toBe(true);
    expect(result.calls.some(c => c.method === "issues.removeLabel")).toBe(false);
  });

  test("an approval under the current head and unchanged history clears the failure", async () => {
    const result = await gate({ labels: [APPROVAL], record: recordLine(HARNESS_HEAD, 0) });
    expect(gateFlagsRegression(result)).toBe(false);
    expect(result.calls.some(c => c.method === "issues.removeLabel")).toBe(false);
  });

  test("a rewrite count change or unreadable history keeps the failure", async () => {
    const moved = await gate({ labels: [APPROVAL], record: recordLine(HARNESS_HEAD, 0), issueEvents: [FORCE_PUSH] });
    expect(gateFlagsRegression(moved)).toBe(true);
    const unreadable = await gate({ labels: [APPROVAL], record: recordLine(HARNESS_HEAD, 0), failOn: ["issues.listEvents"] });
    expect(gateFlagsRegression(unreadable)).toBe(true);
  });

  test("a maintainer PR whose files were listed at a newer head does not clear the failure", async () => {
    const result = await runEnforcePrTarget(gateScript(), {
      pr: { base: { ref: "dev" }, draft: false },
      authorPermission: "write",
      labels: [APPROVAL],
      files: [{ filename: "src/feature.ts", patch: "+b" }],
      comments: [{ ...gateComment([recordLine(HARNESS_HEAD, 0)]), updated_at: "2026-10-25T00:00:00Z" }],
      issueEvents: [],
      // First read is this run's PR snapshot; the file snapshot sees a push.
      pullSnapshots: [{}, { head: { sha: "f".repeat(40) } }],
    });
    expect(gateFlagsRegression(result)).toBe(true);
    const graphqlCalls = result.calls.filter(c => c.method === "graphql").map(c => String((c.args as { query?: string }).query ?? ""));
    expect(graphqlCalls.some(query => query.includes("markPullRequestReadyForReview"))).toBe(false);
  });

  test("no approval label means no history read", async () => {
    const result = await gate({ labels: [], record: recordLine(HARNESS_HEAD, 0) });
    expect(result.calls.some(c => c.method === "issues.listEvents")).toBe(false);
  });
});

describe("approval record survives comment rewrites", () => {
  const gateScript = () => workflowScript("enforce-pr-target.yml", "enforce-target", "Enforce PR target, ancestry, and description");

  test("a gate rebuild keeps the record, so the next hygiene run keeps a current approval", async () => {
    const existing = gateComment(["✅ **Deterministic PR hygiene checks passed.**", recordLine(HARNESS_HEAD, 0)]);
    const gateRun = await runEnforcePrTarget(gateScript(), {
      pr: { base: { ref: "dev" }, draft: true },
      labels: [APPROVAL],
      files: [{ filename: "src/feature.ts", patch: "+b" }],
      comments: [existing],
      issueEvents: [],
    });
    const writes = gateRun.calls
      .filter(c => c.method === "issues.updateComment" || c.method === "issues.createComment")
      .map(c => (c.args as { body: string }).body);
    expect(writes.length).toBeGreaterThan(0);
    const rebuilt = writes.at(-1)!;
    expect(rebuilt).not.toBe(existing.body);
    const rebuiltComment = { id: 7, user: { login: "github-actions[bot]" }, body: rebuilt };
    expect(parseApprovalRecord(messages.authoritativeHygieneSection([rebuiltComment]))).toEqual({
      head: HARNESS_HEAD,
      headRewrites: 0,
    });
    const next = await runHygiene({
      action: "edited",
      head: HARNESS_HEAD,
      labels: [APPROVAL],
      comments: [rebuiltComment],
      eventReads: [[[]], [[]]],
    });
    expect(removed(next)).toEqual([]);
  });

  for (const token of ["$&", "$1", "$`", "$'"]) {
    test("an echoed path containing " + token + " is written literally", async () => {
      const filename = "src/" + token + ".ts";
      const run = await runHygiene({
        action: "edited",
        files: [{ filename, status: "added", patch: "@@ -0,0 +1 @@\n+// @ts-ignore" }],
        comments: [gateComment(["✅ **Deterministic PR hygiene checks passed.**", recordLine(HEAD_B, 0)])],
        eventReads: [[[]]],
      });
      const body = run.comments.find(c => c.body.startsWith(messages.GATE_MARKER))!.body;
      expect(body).toContain(filename);
      expect(body.split("\n").filter(line => line.trim() === messages.HYGIENE_BLOCK_START)).toHaveLength(1);
      expect(body.split("\n").filter(line => line.trim() === messages.HYGIENE_BLOCK_END)).toHaveLength(1);
      expect(parseApprovalRecord(messages.authoritativeHygieneSection(run.comments))).toEqual({ head: HEAD_B, headRewrites: 0 });
    });
  }
});

describe("gate preservation ignores marker text in echoed paths", () => {
  test("a changed path containing the block marker text does not drop the record", async () => {
    const existing = gateComment(["⚠️ **Deterministic hygiene checks failed.**", recordLine(HARNESS_HEAD, 0)]);
    const gateRun = await runEnforcePrTarget(
      workflowScript("enforce-pr-target.yml", "enforce-target", "Enforce PR target, ancestry, and description"),
      {
        pr: { base: { ref: "dev" }, draft: true },
        // new_suppression echoes this path into the rebuilt gate body.
        files: [{ filename: "src/pr-hygiene-block.ts", patch: "+// @ts-ignore" }],
        comments: [existing],
        issueEvents: [],
      },
    );
    const writes = gateRun.calls
      .filter(c => c.method === "issues.updateComment" || c.method === "issues.createComment")
      .map(c => (c.args as { body: string }).body);
    expect(writes.length).toBeGreaterThan(0);
    const rebuilt = writes.at(-1)!;
    expect(rebuilt).toContain("pr-hygiene-block.ts");
    expect(parseApprovalRecord(messages.authoritativeHygieneSection([{ id: 7, user: { login: "github-actions[bot]" }, body: rebuilt }]))).toEqual({
      head: HARNESS_HEAD,
      headRewrites: 0,
    });
  });
});
