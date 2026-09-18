import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

/**
 * `ci.yml` decides which runs cancel which through two Actions expressions. A
 * test that matched their text would pass on any rewrite that kept the words,
 * so this file evaluates them instead, against the narrow grammar they use:
 * `${{ ... }}` interpolation, `github.<field>` lookups, single-quoted literals,
 * `==` and `!=`, and the `a && b || c` ternary idiom.
 *
 * The evaluator is a model of GitHub, not GitHub, so it refuses anything
 * outside that grammar rather than guessing. An expression that grows a
 * function call fails here and gets read by a human, which is the only
 * honest outcome for a model that would otherwise quietly stop describing
 * the thing it models.
 */
type GithubContext = { event_name: string; ref: string; run_id: string };

function term(source: string, github: GithubContext): string | boolean {
  const text = source.trim();
  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(text);
  if (comparison) {
    const left = term(comparison[1]!, github);
    const right = term(comparison[3]!, github);
    return comparison[2] === "==" ? left === right : left !== right;
  }
  const literal = /^'([^']*)'$/.exec(text);
  if (literal) return literal[1]!;
  const lookup = /^github\.([a-z_]+)$/.exec(text);
  if (lookup && lookup[1]! in github) return github[lookup[1]! as keyof GithubContext];
  throw new Error(`unsupported expression term: ${text}`);
}

/** GitHub treats `false` and the empty string as falsy; nothing else here can be. */
const falsy = (value: string | boolean): boolean => value === false || value === "";

function evaluate(expression: string, github: GithubContext): string | boolean {
  let value: string | boolean = false;
  for (const alternative of expression.split("||")) {
    value = false;
    for (const part of alternative.split("&&")) {
      value = term(part, github);
      if (falsy(value)) break;
    }
    if (!falsy(value)) return value;
  }
  return value;
}

const render = (template: string, github: GithubContext): string =>
  template.replace(/\$\{\{(.*?)\}\}/g, (_match, expression: string) => String(evaluate(expression, github)));

const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: string | boolean };
};

function concurrency(github: GithubContext): { group: string; cancels: string } {
  const block = workflow.concurrency;
  expect(typeof block?.group).toBe("string");
  expect(typeof block?.["cancel-in-progress"]).toBe("string");
  return {
    group: render(String(block?.group), github),
    cancels: render(String(block?.["cancel-in-progress"]), github),
  };
}

const DEV = "refs/heads/dev";
const dispatch = (run_id: string): GithubContext => ({ event_name: "workflow_dispatch", ref: DEV, run_id });
const push = (run_id: string): GithubContext => ({ event_name: "push", ref: DEV, run_id });

test("a merge into dev cannot cancel a lane dispatched against dev", () => {
  // #5037: the `macos control` lane is the longest job in this workflow at
  // roughly fifty minutes, and under one shared group it was cancelled by the
  // next merge every time. Run 35318264610 was cancelled in the same second its
  // job started. That made the lane uncompletable on any branch under active
  // development, and it reported neither pass nor fail while doing it.
  expect(concurrency(dispatch("35318264610")).group).not.toBe(concurrency(push("35321034825")).group);
  expect(concurrency(dispatch("35318264610")).cancels).toBe("false");
});

test("a second dispatch of the same ref does not queue behind the first", () => {
  // Two probes of the same ref are two questions, not a revision of one.
  expect(concurrency(dispatch("1")).group).not.toBe(concurrency(dispatch("2")).group);
});

test("push and pull_request still supersede an older head on their own ref", () => {
  // The saving this buys is real and must survive: a run per superseded head,
  // across nine Windows shards and two macOS shards, for an answer nobody reads.
  for (const event of ["push", "pull_request"]) {
    const older = { event_name: event, ref: DEV, run_id: "1" };
    const newer = { event_name: event, ref: DEV, run_id: "2" };
    const elsewhere = { event_name: event, ref: "refs/heads/preview", run_id: "3" };
    expect(concurrency(older).group).toBe(concurrency(newer).group);
    expect(concurrency(older).group).not.toBe(concurrency(elsewhere).group);
    expect(concurrency(older).cancels).toBe("true");
  }
});

test("every trigger this workflow declares is one the cases above cover", () => {
  // A fourth trigger would arrive with no decision recorded about whether it
  // supersedes anything, and would inherit the push answer by accident.
  expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
});

test("the evaluator refuses an expression it does not model", () => {
  expect(() => render("${{ startsWith(github.ref, 'refs/tags/') }}", push("1"))).toThrow(/unsupported expression term/);
});
