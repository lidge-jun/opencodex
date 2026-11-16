import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * #7654: one "PR gates" pull_request_target/status run per event instead of three. The three
 * gates keep their logic in their own files and run as local reusable workflows. These checks pin
 * the consolidation's security-relevant shape: where triggers live, which commit the callees load
 * from, the GITHUB_TOKEN ceilings, and which jobs own which concurrency group.
 */

type Job = Record<string, unknown> & {
  if?: string; uses?: string; permissions?: Record<string, string>; steps?: unknown[];
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
};
type Workflow = Record<string, unknown> & {
  on?: Record<string, unknown> & { pull_request_target?: { types?: string[] } };
  permissions?: Record<string, string>;
  concurrency?: unknown;
  jobs?: Record<string, Job>;
};

const read = (name: string) => Bun.YAML.parse(readFileSync(repoPath(`.github/workflows/${name}`), "utf8")) as Workflow;
const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };

const LABELER_TYPES = ["edited", "labeled", "opened", "synchronize", "unlabeled"];
const HYGIENE_TYPES = ["edited", "labeled", "opened", "reopened", "synchronize", "unlabeled"];
const GATE_TYPES = ["edited", "labeled", "opened", "ready_for_review", "reopened", "synchronize", "unlabeled"];
const CALLEES = { label: "pr-labeler.yml", hygiene: "pr-hygiene.yml", enforce: "enforce-pr-target.yml" } as const;

describe("PR gates caller (#7654)", () => {
  const caller = read("pr-gates.yml");

  test("owns the only pull_request_target and status triggers, as a bare types list", () => {
    expect(Object.keys(caller.on ?? {}).sort()).toEqual(["pull_request_target", "status"]);
    // A branches: or paths: filter would let a PR skip every gate (see ci-workflows.test.ts).
    expect(Object.keys(caller.on?.pull_request_target ?? {})).toEqual(["types"]);
    expect([...(caller.on?.pull_request_target?.types ?? [])].sort()).toEqual(GATE_TYPES);
  });

  test("grants no default token and holds no workflow-level concurrency group", () => {
    expect(caller.permissions).toEqual({});
    expect(caller.concurrency).toBeUndefined();
  });

  test("calls each gate as a local reusable workflow from the caller's own commit", () => {
    expect(Object.keys(caller.jobs ?? {})).toEqual(["label", "hygiene", "enforce"]);
    for (const [job, file] of Object.entries(CALLEES)) {
      const spec = caller.jobs![job]!;
      // ./ resolves from the caller's commit, which for pull_request_target and status is the
      // default branch. An @ref or a remote path would load code from somewhere else.
      expect(spec.uses).toBe(`./.github/workflows/${file}`);
      expect(Object.keys(spec).every(key => ["if", "uses", "permissions", "name"].includes(key))).toBe(true);
      expect(spec.steps).toBeUndefined();
    }
  });

  test("starts the labeler and hygiene only for the pull_request_target actions they used to subscribe to", () => {
    const actions = (condition: string | undefined) => {
      const list = /fromJSON\('(\[[^']*\])'\)/.exec(String(condition ?? ""));
      expect(list).not.toBeNull();
      return (JSON.parse(list![1]!) as string[]).sort();
    };
    for (const [job, types] of [["label", LABELER_TYPES], ["hygiene", HYGIENE_TYPES]] as const) {
      const condition = caller.jobs![job]!.if;
      expect(String(condition)).toContain("github.event_name == 'pull_request_target'");
      expect(String(condition)).toContain("github.event.action");
      expect(actions(condition)).toEqual([...types]);
    }
    // The gate decides for itself: resolve-pr keeps the trusted status / label filter.
    expect(caller.jobs!.enforce!.if).toBeUndefined();
  });

  test("caps each callee token at exactly what its jobs request", () => {
    for (const [job, file] of Object.entries(CALLEES)) {
      const cap = caller.jobs![job]!.permissions ?? {};
      const callee = read(file);
      const requested = [callee.permissions ?? {}, ...Object.values(callee.jobs ?? {}).map(spec => spec.permissions ?? {})];
      const needed: Record<string, string> = {};
      for (const scopes of requested) {
        for (const [scope, level] of Object.entries(scopes)) {
          if ((LEVEL[level] ?? 0) > (LEVEL[needed[scope] ?? "none"] ?? 0)) needed[scope] = level;
        }
      }
      expect(cap).toEqual(needed);
    }
  });
});

describe("PR gate callees (#7654)", () => {
  test("run only as reusable workflows, so no second run starts per event", () => {
    for (const file of Object.values(CALLEES)) {
      const callee = read(file);
      expect(Object.keys(callee.on ?? {})).toEqual(["workflow_call"]);
      expect(callee.concurrency).toBeUndefined();
    }
  });

  test("keep their concurrency groups on their own jobs, which exist only when the caller job runs", () => {
    const label = read("pr-labeler.yml").jobs!.label!;
    expect(label.concurrency).toEqual({ group: "pr-labeler-${{ github.event.pull_request.number }}", "cancel-in-progress": true });
    const hygiene = read("pr-hygiene.yml").jobs!.hygiene!;
    expect(hygiene.concurrency).toEqual({ group: "pr-gate-comment-${{ github.event.pull_request.number }}", "cancel-in-progress": false });
    const gate = read("enforce-pr-target.yml").jobs!["enforce-target"]!;
    expect(gate.concurrency).toEqual({ group: "pr-gate-comment-${{ needs.resolve-pr.outputs.pull-number }}", "cancel-in-progress": false });
  });
});
