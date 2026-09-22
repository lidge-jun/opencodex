import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { callsTo, runEnforcePrTarget, type Comment } from "../helpers/enforce-pr-target-harness";

const HEAD = "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b";
const NEXT = "b".repeat(40);
const OLD = "All CI tests are green on my local testing.";
const CURRENT = "Required local validation passed; commands, results, and any full-suite exception are documented.";
const START = "<!-- pr-quality-readiness-checklist:start -->";
const END = "<!-- pr-quality-readiness-checklist:end -->";
const T0 = "2026-09-22T00:00:00Z";
const T1 = "2026-09-22T00:00:02Z";
const T2 = "2026-09-22T00:00:04Z";
const T3 = "2026-09-22T00:00:06Z";
const T4 = "2026-09-22T00:00:08Z";
const T5 = "2026-09-22T00:00:10Z";
const workflow = Bun.YAML.parse(readFileSync(repoPath(".github/workflows/enforce-pr-target.yml"), "utf8")) as {
  jobs: Record<string, { steps: Array<{ name?: string; with?: { script?: string } }> }>;
};
const script = workflow.jobs["enforce-target"]!.steps.find(step => step.name === "Enforce PR target, ancestry, and description")!.with!.script!;

function body(label = CURRENT, checks = 4): string {
  return ["## Summary", "", "Update managed validation wording while preserving the author's text and explicitly requiring a fresh attestation.", "",
    "## Verification", "", "Hosted workflow regression coverage will exercise the managed checklist state transitions.", "", START,
    ...[label, "I pushed my PR to the latest dev commit.", "I resolved all correct Codex and CodeRabbit findings.", "My PR is ready for review."]
      .map((text, index) => `- [${index < checks ? "x" : " "}] ${text}`), END].join("\n");
}
type Result = Awaited<ReturnType<typeof runEnforcePrTarget>>;
function saved(result: Result, updated_at: string): Comment {
  const writes = result.calls.filter(call => call.method === "issues.updateComment" || call.method === "issues.createComment");
  const last = writes.at(-1)?.args as { body?: string; comment_id?: number } | undefined;
  expect(last?.body).toContain("<!-- opencodex-pr-gate -->");
  return { id: last?.comment_id ?? 99, user: { login: "github-actions[bot]" }, body: last!.body!, updated_at };
}
function pending(comment: Comment) {
  const json = comment.body!.match(/<!-- opencodex-pr-gate-state:([\s\S]*?) -->/)![1]!;
  return JSON.parse(json).pendingReattestation;
}
function promotions(result: Result) {
  return (callsTo(result, "graphql") as Array<{ query: string }>).filter(call => call.query.includes("markPullRequestReadyForReview"));
}
function bodyWrites(result: Result) {
  return (callsTo(result, "pulls.update") as Array<{ body?: string }>).filter(call => call.body !== undefined);
}
async function initialize() {
  const result = await runEnforcePrTarget(script, {
    pr: { body: body(OLD), draft: true, head: { sha: HEAD }, updated_at: T0 },
    eventAction: "synchronize", commentUpdatedAt: T1, commentUpdatedAts: [T1, T2],
  });
  expect(promotions(result)).toEqual([]);
  expect(bodyWrites(result)).toEqual([]);
  const comment = saved(result, T2);
  expect(pending(comment)).toMatchObject({ headSha: HEAD, phase: "await-clear" });
  return comment;
}
async function clear(comment: Comment) {
  const result = await runEnforcePrTarget(script, {
    pr: { body: body(CURRENT, 0), draft: true, head: { sha: HEAD }, updated_at: T2 },
    eventAction: "edited", previousBody: body(OLD), comments: [comment], commentUpdatedAt: T3, commentUpdatedAts: [T3, T4],
  });
  expect(bodyWrites(result)).toEqual([]);
  expect(promotions(result)).toEqual([]);
  const next = saved(result, T4);
  expect(pending(next)).toMatchObject({ headSha: HEAD, phase: "await-check" });
  return next;
}

describe("author-applied policy migration with durable re-attestation", () => {
  test("legacy complete -> pending -> wording-only stays pending -> clear -> later retick", async () => {
    const first = await initialize();
    const wording = await runEnforcePrTarget(script, {
      pr: { body: body(), draft: true, head: { sha: HEAD }, updated_at: T2 },
      eventAction: "edited", previousBody: body(OLD), comments: [first], commentUpdatedAt: T3,
    });
    expect(promotions(wording)).toEqual([]);
    expect(bodyWrites(wording)).toEqual([]);
    expect(pending(saved(wording, T3)).phase).toBe("await-clear");
    const cleared = await clear(first);
    const retick = await runEnforcePrTarget(script, {
      pr: { body: body(), draft: true, head: { sha: HEAD }, updated_at: T4 },
      eventAction: "edited", previousBody: body(CURRENT, 0), comments: [cleared], commentUpdatedAt: T5,
    });
    expect(bodyWrites(retick)).toEqual([]);
    expect(promotions(retick)).toHaveLength(1);
    const calls = retick.calls.map(call => call.method);
    expect(calls.indexOf("issues.updateComment")).toBeLessThan(calls.indexOf("issues.getComment"));
    const checkpoint = (callsTo(retick, "issues.updateComment") as Array<{ body: string }>)[0]!;
    expect(pending({ id: 99, body: checkpoint.body })).toMatchObject({ phase: "attested", headSha: HEAD });
    expect(pending(saved(retick, T5))).toBeNull();
  });

  test("identical pending replay does not duplicate notices or mutate author content", async () => {
    const first = await initialize();
    const replay = await runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: true, head: { sha: HEAD }, updated_at: T0 },
      eventAction: "synchronize", comments: [first], commentUpdatedAt: T3,
    });
    for (const name of ["issues.createComment", "issues.updateComment", "issues.addLabels", "issues.removeLabel", "pulls.update"]) {
      expect(callsTo(replay, name)).toEqual([]);
    }
    expect(promotions(replay)).toEqual([]);
  });

  for (const options of [
    { previousBody: undefined, updated_at: T2 },
    { previousBody: body(OLD), updated_at: T1 },
  ]) {
    test(`title-only/equal-time edit cannot arm recheck: ${JSON.stringify(options)}`, async () => {
      const first = await initialize();
      const result = await runEnforcePrTarget(script, {
        pr: { body: body(CURRENT, 0), draft: true, head: { sha: HEAD }, updated_at: options.updated_at },
        eventAction: "edited", previousBody: options.previousBody, comments: [first], commentUpdatedAt: T3,
      });
      expect(pending(saved(result, T3)).phase).toBe("await-clear");
      expect(promotions(result)).toEqual([]);
    });
  }

  test("another head invalidates the clear checkpoint instead of inheriting its ticks", async () => {
    const cleared = await clear(await initialize());
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(), draft: true, head: { sha: NEXT }, updated_at: T4 },
      eventAction: "edited", previousBody: body(CURRENT, 0), comments: [cleared], commentUpdatedAt: T5,
    });
    expect(pending(saved(result, T5))).toMatchObject({ headSha: NEXT, phase: "await-clear", generation: 2 });
    expect(promotions(result)).toEqual([]);
    expect(bodyWrites(result)).toEqual([]);
  });

  test("a failed current-head claim invalidates proof without unchecking the author body", async () => {
    const cleared = await clear(await initialize());
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(), draft: true, head: { sha: HEAD }, updated_at: T4 },
      eventAction: "edited", previousBody: body(CURRENT, 0), comments: [cleared], commentUpdatedAt: T5,
      compareByBasehead: { [`dev...${HEAD}`]: { ahead_by: 0, behind_by: 11 } },
    });
    expect(pending(saved(result, T5)).phase).toBe("await-clear");
    expect(bodyWrites(result)).toEqual([]);
    expect(promotions(result)).toEqual([]);
  });

  test("fresh legacy classification prevents an otherwise scheduled reset writer", async () => {
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(), draft: true, head: { sha: HEAD } }, eventAction: "synchronize",
      pullSnapshots: [{}, {}, {}, { body: body(OLD) }], commentUpdatedAt: T1,
    });
    expect(bodyWrites(result)).toEqual([]);
    expect(pending(saved(result, T1)).phase).toBe("await-clear");
    expect(promotions(result)).toEqual([]);
  });

  test("a moved head on the final read yields no ready or completion side effects", async () => {
    const cleared = await clear(await initialize());
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(), draft: true, head: { sha: HEAD }, updated_at: T4 },
      eventAction: "edited", previousBody: body(CURRENT, 0), comments: [cleared], commentUpdatedAt: T5,
      pullSnapshots: [{}, {}, {}, {}, { head: { sha: NEXT } }],
    });
    expect(promotions(result)).toEqual([]);
    expect(callsTo(result, "issues.addLabels")).toEqual([]);
    expect(bodyWrites(result)).toEqual([]);
    expect(result.warnings.some(w => w.includes("no ready action was taken"))).toBe(true);
    expect(pending(saved(result, T5)).phase).toBe("attested");
  });
});


describe("reattest mutation failures and authoritative readback", () => {
  test("failed draft conversion releases persisted ownership", async () => {
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: false, head: { sha: HEAD }, updated_at: T0 },
      failGraphqlOn: ["convertPullRequestToDraft"], commentUpdatedAt: T1,
    });
    expect(saved(result, T1).body).toContain('"autoDraftedByBot":false');
    expect(result.warnings.some(w => w.includes("Could not retain draft state"))).toBe(true);
  });

  test("failed ready-label removal fails pending evaluation", async () => {
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: true, head: { sha: HEAD }, updated_at: T0 },
      labels: ["review-ready"], failOn: ["issues.removeLabel"], commentUpdatedAt: T1,
    });
    expect(result.warnings.some(w => w.startsWith("setFailed:") && w.includes("stale review-ready label"))).toBe(true);
    expect(promotions(result)).toEqual([]);
  });

  test("pending wrong-base evaluation cannot report a successful quality gate", async () => {
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: true, base: { ref: "main" }, head: { sha: HEAD } }, commentUpdatedAt: T1,
    });
    expect(result.warnings.some(w => w.startsWith("setFailed:") && w.includes("re-attestation is pending"))).toBe(true);
    expect(bodyWrites(result)).toEqual([]);
  });

  test("permission lookup failure retains contributor preservation", async () => {
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: true, head: { sha: HEAD } }, failPermissionLookup: true, commentUpdatedAt: T1,
    });
    expect(pending(saved(result, T1)).phase).toBe("await-clear");
    expect(bodyWrites(result)).toEqual([]);
  });

  test("a hygiene update does not move the persisted phase fence", async () => {
    const first = await initialize();
    first.updated_at = T3;
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(CURRENT, 0), draft: true, head: { sha: HEAD }, updated_at: T2 },
      eventAction: "edited", previousBody: body(OLD), comments: [first], commentUpdatedAt: T4,
    });
    expect(pending(saved(result, T4)).phase).toBe("await-check");
  });

  test("unfinished checkpoint is finalized but cannot consume the same author edit", async () => {
    const first = await initialize();
    first.body = first.body!.replace(/"checkpointAt":"[^"]+"/, '"checkpointAt":null');
    first.updated_at = T1;
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(CURRENT, 0), draft: true, head: { sha: HEAD }, updated_at: T2 },
      eventAction: "edited", previousBody: body(OLD), comments: [first], commentUpdatedAt: T3,
    });
    const writes = callsTo(result, "issues.updateComment") as Array<{ body: string }>;
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toContain("0/4");
    expect(pending({ id: 99, body: writes[0]!.body }).checkpointAt).toBeNull();
    expect(pending(saved(result, T3))).toMatchObject({ phase: "await-clear", checkpointAt: T3 });
    expect(promotions(result)).toEqual([]);
  });

  test("unchanged provisional replay uses the already persisted server fence", async () => {
    const first = await initialize();
    first.body = first.body!.replace(/"checkpointAt":"[^"]+"/, '"checkpointAt":null');
    first.updated_at = T1;
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: true, head: { sha: HEAD }, updated_at: T0 },
      eventAction: "synchronize", comments: [first], commentUpdatedAt: T3,
    });
    expect(callsTo(result, "issues.updateComment")).toHaveLength(1);
    expect(pending(saved(result, T3))).toMatchObject({ phase: "await-clear", checkpointAt: T1 });
    expect(promotions(result)).toEqual([]);
  });

  test("phase fence uses the first publication time rather than finalization time", async () => {
    const first = await initialize();
    expect(pending(first)).toMatchObject({ checkpointAt: T1, phase: "await-clear" });
    expect(first.updated_at).toBe(T2);
  });

  test("missing server time leaves provisional state unable to progress", async () => {
    const result = await runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: true, head: { sha: HEAD }, updated_at: T0 },
    });
    expect(pending(saved(result, T1)).checkpointAt).toBeNull();
    expect(result.warnings.some(w => w.includes("no authoritative server timestamp"))).toBe(true);
    expect(promotions(result)).toEqual([]);
  });

  test("failed finalization rejects the run before any ready mutation", async () => {
    await expect(runEnforcePrTarget(script, {
      pr: { body: body(OLD), draft: true, head: { sha: HEAD }, updated_at: T0 },
      commentUpdatedAts: [T1, T2], failCommentWrite: 2,
    })).rejects.toThrow();
  });

  for (const malformed of [false, true]) {
    test(`late saved-state mismatch cannot promote (${malformed})`, async () => {
      const cleared = await clear(await initialize());
      const finalComment = malformed ? { ...cleared, body: '<!-- opencodex-pr-gate-state:{bad -->' } : cleared;
      const result = await runEnforcePrTarget(script, {
        pr: { body: body(), draft: true, head: { sha: HEAD }, updated_at: T4 },
        eventAction: "edited", previousBody: body(CURRENT, 0), comments: [cleared], commentUpdatedAt: T5, finalComment,
      });
      expect(promotions(result)).toEqual([]);
      expect(callsTo(result, "issues.addLabels")).toEqual([]);
      expect(result.warnings.some(w => w.includes("no ready action"))).toBe(true);
    });
  }
});


test("a current checklist that becomes legacy at final read never advances readiness", async () => {
  const result = await runEnforcePrTarget(script, {
    pr: { body: body(), draft: true, head: { sha: HEAD }, updated_at: T4 },
    pullSnapshots: [{}, {}, {}, { body: body(OLD) }], commentUpdatedAt: T5,
  });
  expect(promotions(result)).toEqual([]);
  expect(callsTo(result, "issues.addLabels")).toEqual([]);
  expect(bodyWrites(result)).toEqual([]);
  expect(pending(saved(result, T5)).phase).toBe("await-clear");
});
