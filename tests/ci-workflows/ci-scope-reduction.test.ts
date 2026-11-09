import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

/**
 * The expensive CI legs are scoped twice: the shared `ci` filter decides whether
 * a pull request pays for the suite at all, and the `native` filter decides
 * whether the macOS shard, the widget bundle and the desktop shell run on top
 * of it. The native gate spans three places that have to agree — the filter, the
 * three job conditions, and the aggregate's expectation table — and a gate that
 * expects success from jobs the same event declined to select fails every
 * non-native pull request while every literal string still matches. So this file
 * evaluates the conditions against the narrow Actions grammar they use instead
 * of restating them, and executes the workflow's own shell where the contract
 * lives in shell (the matrix emitters, the aggregate expectation table), the way
 * macos-serial-lanes.test.ts executes the platform-macos run block.
 *
 * The emitters and the aggregate expectation loop call jq, which macOS does not
 * ship. Tests that need it declare that dependency and skip rather than fail on
 * a machine that lacks it; hosted CI always has it.
 */

const workflow = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "ci.yml"), "utf8")) as {
  on?: { push?: { branches?: string[] }; workflow_dispatch?: { inputs?: { lane?: { options?: string[] } } } };
  jobs?: Record<string, {
    name?: string;
    if?: string;
    needs?: string | string[];
    "runs-on"?: string;
    outputs?: Record<string, string>;
    strategy?: { matrix?: Record<string, unknown> };
    steps?: Array<{
      name?: string;
      id?: string;
      shell?: string;
      run?: string;
      env?: Record<string, string>;
      uses?: string;
      with?: Record<string, unknown>;
    }>;
  }>;
};

const jobs = workflow.jobs ?? {};
const changes = jobs.changes;
const changesSteps = changes?.steps ?? [];
const filterStep = changesSteps.find(step => step.uses?.startsWith("dorny/paths-filter@"));
const filters = Bun.YAML.parse(String(filterStep?.with?.filters ?? "")) as Record<string, string[]>;

/** The native gate covers exactly these three jobs; anything else is drift. */
const NATIVE_GATED = ["platform-macos", "widget", "desktop-shell"] as const;
/** The macOS jobs never run on a pull request; they run after merge, on push. */
const MACOS_JOBS = ["platform-macos", "widget"] as const;
/** The two smoke jobs whose matrix legs shrink with the event and native selection. */
const MATRIX_JOBS = ["keyring-smoke", "npm-global-smoke"] as const;

test("release history checks run with complete git history in gates", () => {
  const steps = jobs.gates?.steps ?? [];
  const checkout = steps.find(step => step.uses?.startsWith("actions/checkout@"));
  const releaseTests = steps.find(step => step.run?.includes("release-history.test.cjs"));
  expect(releaseTests).toBeDefined();
  expect(checkout?.with?.["fetch-depth"]).toBe(0);
});

type SelectionInputs = { event_name: string; ci: string; native: string; desktop?: string; docker?: string; lane?: string; ref?: string };

function term(source: string, inputs: SelectionInputs): string | boolean {
  const text = source.trim();
  const comparison = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(text);
  if (comparison) {
    const left = term(comparison[1]!, inputs);
    const right = term(comparison[3]!, inputs);
    return comparison[2] === "==" ? left === right : left !== right;
  }
  const literal = /^'([^']*)'$/.exec(text);
  if (literal) return literal[1]!;
  if (text === "github.event_name") return inputs.event_name;
  if (text === "github.event.inputs.lane") return inputs.lane ?? "";
  if (text === "github.ref") return inputs.ref ?? "";
  if (text === "always()") return true;
  const output = /^needs\.changes\.outputs\.([a-z-]+)$/.exec(text);
  if (output) {
    if (output[1] === "ci") return inputs.ci;
    if (output[1] === "native") return inputs.native;
    if (output[1] === "desktop") return inputs.desktop ?? "false";
    if (output[1] === "docker") return inputs.docker ?? "false";
  }
  throw new Error(`unsupported expression term: ${text}`);
}

function splitTopLevel(expression: string, operator: "||" | "&&"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index]!;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && expression.startsWith(operator, index)) {
      parts.push(current);
      current = "";
      index += operator.length - 1;
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** GitHub reads a missing or empty output as falsy; only the string "true" selects. */
const truthy = (value: string | boolean): boolean => value === true || value === "true";

function evaluate(expression: string, inputs: SelectionInputs): boolean {
  const unwrapped = expression.replace(/^\s*\$\{\{/, "").replace(/\}\}\s*$/, "").trim();
  const alternatives = splitTopLevel(unwrapped, "||");
  if (alternatives.length > 1) return alternatives.some(alternative => evaluate(alternative, inputs));
  const factors = splitTopLevel(unwrapped, "&&");
  if (factors.length > 1) return factors.every(factor => evaluate(factor, inputs));
  if (unwrapped.startsWith("(") && unwrapped.endsWith(")")) return evaluate(unwrapped.slice(1, -1), inputs);
  return truthy(term(unwrapped, inputs));
}

/**
 * Every way an event can combine with the two filter outputs, and what must happen.
 * `macos` is platform-macos and widget, which never run on a pull request;
 * `desktopShell` is the ubuntu desktop-shell job, which still follows the native filter.
 */
const SELECTION_SCENARIOS = [
  // The filter outputs are deliberately false for push and dispatch: selection
  // there must not depend on them at all, or the event guard has been lost.
  { name: "a push", inputs: { event_name: "push", ci: "false", native: "false" }, macos: true, desktopShell: true },
  { name: "a workflow_dispatch", inputs: { event_name: "workflow_dispatch", ci: "false", native: "false" }, macos: true, desktopShell: true },
  { name: "a pull request that touches native paths", inputs: { event_name: "pull_request", ci: "true", native: "true" }, macos: false, desktopShell: true },
  { name: "a pull request that touches no native path", inputs: { event_name: "pull_request", ci: "true", native: "false" }, macos: false, desktopShell: false },
  { name: "an out-of-scope pull request", inputs: { event_name: "pull_request", ci: "false", native: "false" }, macos: false, desktopShell: false },
] as const;

/** The matrix output a smoke job consumes, read back out of its own strategy. */
function matrixOutputName(jobName: string): string {
  const matrix = jobs[jobName]?.strategy?.matrix;
  const match = /fromJSON\(needs\.changes\.outputs\.([A-Za-z][A-Za-z_-]*)\)/.exec(JSON.stringify(matrix ?? ""));
  if (!match) throw new Error(`${jobName} matrix is no longer consumed from a changes output`);
  return match[1]!;
}

/** The matrix property the job reads its runner from, read back out of runs-on. */
function matrixValueKey(jobName: string): string {
  const match = /\$\{\{\s*matrix\.([a-z-]+)\s*\}\}/.exec(jobs[jobName]?.["runs-on"] ?? "");
  if (!match) throw new Error(`${jobName} runs-on no longer reads its matrix`);
  return match[1]!;
}

function emitterStep(outputName: string) {
  const step = changesSteps.find(candidate => (candidate.run ?? "").includes(`${outputName}=`));
  if (!step) throw new Error(`no changes-job step emits the ${outputName} output`);
  return step;
}

function renderFilterOutputs(text: string, inputs: { ci: string; native: string; event: string; lane: string }): string {
  // A pull_request emitter sees the plain filter value; the nightly override only matters on schedule.
  const rendered = text.replace(/\$\{\{\s*(?:(?:github\.event_name == 'schedule' && 'true'|\(github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' && \(github\.event\.inputs\.lane == '' \|\| github\.event\.inputs\.lane == 'all'\)\) && 'true') \|\| )?steps\.filter\.outputs\.([a-z_-]+)\s*\}\}/g, (match, name: string) => {
    if (inputs.event === "schedule" || (inputs.event === "workflow_dispatch" && ["", "all"].includes(inputs.lane) && match.includes("github.event.inputs.lane"))) return "true";
    if (name === "ci") return inputs.ci;
    if (name === "native") return inputs.native;
    throw new Error(`unsupported filter output in emitter: ${name}`);
  }).replace(/\$\{\{\s*github\.event_name\s*\}\}/g, inputs.event);
  const leftover = rendered.indexOf("${{");
  if (leftover >= 0) throw new Error(`unrendered expression in emitter: ${rendered.slice(leftover, leftover + 80)}`);
  return rendered;
}

/** Run the emitter step the way Actions would, and parse what it wrote to GITHUB_OUTPUT. */
function emittedOutputs(jobName: string, ci: string, native: string, event = "push", lane = "all"): { exitCode: number; values: Record<string, string> } {
  const step = emitterStep(matrixOutputName(jobName));
  const directory = mkdtempSync(join(tmpdir(), "ocx-ci-scope-"));
  try {
    const outputFile = join(directory, "github-output");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GITHUB_OUTPUT: outputFile,
      GITHUB_ENV: join(directory, "github-env"),
      GITHUB_STEP_SUMMARY: join(directory, "step-summary"),
    };
    for (const [key, value] of Object.entries(step.env ?? {})) env[key] = renderFilterOutputs(String(value), { ci, native, event, lane });
    const run = renderFilterOutputs(String(step.run ?? ""), { ci, native, event, lane });
    const result = Bun.spawnSync(["/bin/bash", "-e", "-o", "pipefail", "-c", run], { env, cwd: directory });
    const values: Record<string, string> = {};
    try {
      const lines = readFileSync(outputFile, "utf8").split("\n");
      for (let index = 0; index < lines.length; index++) {
        const heredoc = /^([^=<<]+)<<(.+)$/.exec(lines[index] ?? "");
        if (heredoc) {
          const body: string[] = [];
          index += 1;
          while (index < lines.length && lines[index] !== heredoc[2]) {
            body.push(lines[index]!);
            index += 1;
          }
          values[heredoc[1]!.trim()] = body.join("\n");
          continue;
        }
        const assignment = /^([^=]+)=(.*)$/.exec(lines[index] ?? "");
        if (assignment) values[assignment[1]!.trim()] = assignment[2] ?? "";
      }
    } catch {
      // The exit-code assertion below reports this; a missing output file is
      // only interesting together with the emitter's own status.
    }
    return { exitCode: result.exitCode ?? 1, values };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function legsFor(jobName: string, ci: "true" | "false", native: "true" | "false", event = "push", lane = "all"): string[] {
  const outputName = matrixOutputName(jobName);
  const { exitCode, values } = emittedOutputs(jobName, ci, native, event, lane);
  expect(exitCode, `${jobName} emitter failed under event=${event} ci=${ci} native=${native}`).toBe(0);
  const raw = values[outputName];
  expect(`${jobName} emitted ${outputName}:${typeof raw === "string" && raw.length > 0}`)
    .toBe(`${jobName} emitted ${outputName}:true`);
  const entries = JSON.parse(raw!) as Array<string | Record<string, unknown>>;
  const valueKey = matrixValueKey(jobName);
  return entries.map(entry => {
    if (typeof entry === "string") return entry;
    const value = entry[valueKey];
    if (typeof value !== "string") throw new Error(`${jobName} matrix entry is missing ${valueKey}: ${JSON.stringify(entry)}`);
    return value;
  });
}

const hostHasJq = Boolean(Bun.which("jq"));
const emittersNeedJq = MATRIX_JOBS.some(name => (emitterStep(matrixOutputName(name)).run ?? "").includes("jq"));
// The changes emitters and the aggregate gate run under bash on ubuntu-latest,
// and the harness launches them through /bin/bash. The Windows runner has no
// /bin/bash, so executing them there tests the host, not the workflow; the
// structural assertions above and below still run on every platform.
const hostRunsWorkflowShell = process.platform !== "win32";
const cannotRunEmitters = !hostRunsWorkflowShell || (emittersNeedJq && !hostHasJq);
const cannotRunGate = !hostRunsWorkflowShell || !hostHasJq;

const gateScript = (jobs.ci?.steps ?? []).find(step => (step.run ?? "").includes("scoped=requested"))?.run ?? "";

function gateSlice(): string {
  const start = gateScript.indexOf("scoped=requested");
  const first = gateScript.indexOf("RESULTS_EOF");
  const last = first >= 0 ? gateScript.indexOf("RESULTS_EOF", first + "RESULTS_EOF".length) : -1;
  if (start < 0 || last < 0) throw new Error("cannot locate the aggregate gate expectation block in ci.yml");
  return gateScript.slice(start, last + "RESULTS_EOF".length);
}

type GateInputs = {
  eventName: string;
  ci: string;
  native: string;
  packaging: string;
  docs: string;
  structure: string;
  lane: string;
  docker?: string;
  keyring?: string;
  fast?: string;
};

const PR_WITHOUT_NATIVE: GateInputs = {
  eventName: "pull_request",
  ci: "true",
  native: "false",
  packaging: "false",
  docs: "false",
  structure: "false",
  lane: "",
  docker: "true",
  keyring: "true",
};

function gateEnvironment(inputs: GateInputs, results: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    EVENT_NAME: inputs.eventName,
    CHANGES_CI: inputs.ci,
    CHANGES_NATIVE: inputs.native,
    CHANGES_PACKAGING: inputs.packaging,
    CHANGES_DOCS: inputs.docs,
    CHANGES_STRUCTURE: inputs.structure,
    CHANGES_DOCKER: inputs.docker ?? "false",
    CHANGES_KEYRING: inputs.keyring ?? "false",
    ...(inputs.fast === undefined ? {} : { CHANGES_FAST: inputs.fast }),
    LANE: inputs.lane,
    // `needs` serializes as an object per job, and the gate reads
    // `.value.result` out of it. Passing a flat name-to-string map makes jq
    // fail on the first entry, which empties the heredoc feeding the check
    // loop — so every assertion over `bad` would pass over a loop that never
    // ran. Shape it the way the real context does.
    RESULTS: JSON.stringify(Object.fromEntries(
      Object.entries(results).map(([job, result]) => [job, { result }]),
    )),
  };
}

/** Execute the gate's own expectation block, then report what it asked of each job. */
function runGate(inputs: GateInputs, results: Record<string, string>): { gatedJobs: string[]; expectations: Record<string, string>; bad: string } {
  const script = [
    gateSlice(),
    'echo "GATEDJOBS=$GATED_JOBS"',
    'for job in $GATED_JOBS; do echo "EXP:$job=$(expected_for "$job")"; done',
    'printf "BAD=%s" "$bad"',
  ].join("\n");
  const result = Bun.spawnSync(["/bin/bash", "-c", script], { env: gateEnvironment(inputs, results) });
  const stdout = result.stdout ? result.stdout.toString() : "";
  const stderr = result.stderr ? result.stderr.toString() : "";
  if (!stdout.includes("GATEDJOBS=")) {
    throw new Error(`aggregate gate harness failed (exit ${result.exitCode}): ${stderr.slice(0, 400)}`);
  }
  const gatedJobs = (/^GATEDJOBS=(.*)$/m.exec(stdout)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const expectations: Record<string, string> = {};
  for (const match of stdout.matchAll(/^EXP:([^=]+)=(.*)$/gm)) expectations[match[1]!] = match[2]!;
  const badIndex = stdout.indexOf("BAD=");
  return { gatedJobs, expectations, bad: badIndex >= 0 ? stdout.slice(badIndex + "BAD=".length) : "" };
}

describe("the dispatch trigger", () => {
  test("does not run from a push event", () => {
    expect(workflow.on?.push).toBeUndefined();
  });
});

test.skipIf(process.platform === "win32")("the unavoidable selector refuses non-dev manual dispatches", () => {
  const selector = jobs["select-windows-runner"]!;
  expect(selector.if).toBeUndefined();
  expect(selector.needs).toBeUndefined();
  const guard = selector.steps?.find(step => step.name === "Validate dispatch source");
  expect(guard?.shell).toBe("bash");
  expect(guard?.env).toEqual({ EVENT_NAME: "${{ github.event_name }}", REF: "${{ github.ref }}" });
  expect(guard?.run).toBeDefined();
  expect(guard?.run).not.toContain("${{");
  for (const [event, ref, expected] of [
    ["workflow_dispatch", "refs/heads/main", 1],
    ["workflow_dispatch", "refs/heads/feature", 1],
    ["workflow_dispatch", "refs/heads/dev", 0],
    ["pull_request", "refs/pull/1/merge", 0],
  ] as const) {
    const result = Bun.spawnSync(["/bin/bash", "-e", "-c", guard!.run!], { env: { EVENT_NAME: event, REF: ref } });
    expect(result.exitCode, `${event} ${ref}`).toBe(expected);
  }
});

test("Windows claim diagnostic is dev-only and bypasses the full graph", () => {
  const lane = "windows-native-claim";
  expect(workflow.on?.workflow_dispatch?.inputs?.lane?.options).toContain(lane);
  const diagnostic = jobs[lane]!;
  expect(diagnostic["runs-on"]).toBe("windows-latest");
  expect(diagnostic.needs).toBeUndefined();
  const base = { ci: "false", native: "false", event_name: "workflow_dispatch", ref: "refs/heads/dev", lane };
  expect(evaluate(diagnostic.if!, base)).toBe(true);
  for (const variation of [{ event_name: "pull_request" }, { event_name: "push" }, { ref: "refs/heads/main" }, { lane: "all" }, { lane: "release-gates" }, { lane: "macos-control" }, { lane: "" }]) {
    expect(evaluate(diagnostic.if!, { ...base, ...variation })).toBe(false);
  }
  expect(evaluate(changes!.if!, base)).toBe(false);
  expect(evaluate(jobs.ci!.if!, base)).toBe(false);
  for (const lane of ["", "all", "release-gates", "macos-control"]) {
    expect(evaluate(changes!.if!, { ...base, lane })).toBe(true);
    expect(evaluate(jobs.ci!.if!, { ...base, lane })).toBe(true);
  }
  expect(evaluate(changes!.if!, { ...base, event_name: "pull_request" })).toBe(true);
  expect(evaluate(jobs.ci!.if!, { ...base, event_name: "pull_request" })).toBe(true);
  for (const [name, job] of Object.entries(jobs)) {
    if ([lane, "select-windows-runner", "changes", "ci"].includes(name)) continue;
    expect(Array.isArray(job.needs) ? job.needs : [job.needs], name).toContain("changes");
    expect(job.if ?? "", name).not.toMatch(/\b(always|failure|cancelled)\s*\(/);
  }
  const steps = diagnostic.steps ?? [];
  const checkout = steps.find(step => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.ref).toBe("${{ github.sha }}");
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  expect(steps.find(step => step.uses === "./.github/actions/setup-project-bun")?.with?.role).toBe("test-runner");
  expect(steps.some(step => step.run?.includes("bun install --frozen-lockfile"))).toBe(true);
  expect(steps.some(step => step.run?.includes("bun test tests/codex-integration/main-quota-provenance.test.ts"))).toBe(true);
  expect(steps.some(step => step.run?.includes("OPENCODEX_HOME") && step.run.includes("CODEX_HOME") && step.run.includes("GITHUB_ENV"))).toBe(true);
});

describe("Docker PR selection", () => {
  test("selects only its Ubuntu smoke for matching inputs without widening event policy", () => {
    const job = jobs["docker-smoke"]!;
    expect(job["runs-on"]).toBe("ubuntu-latest");
    for (const ci of ["true", "false"]) {
      for (const docker of ["true", "false"]) {
        expect(evaluate(job.if!, { event_name: "pull_request", ci, docker, native: "false" }))
          .toBe(ci === "true" && docker === "true");
      }
    }
    for (const event_name of ["push", "workflow_dispatch", "schedule"]) {
      expect(evaluate(job.if!, { event_name, ci: "false", docker: "false", native: "false" })).toBe(true);
    }
  });
});

describe("the native path filter", () => {
  test("lists exactly the surfaces the native-gated jobs build", () => {
    // Exact membership, because every pattern here is a cost decision: widening
    // one drags the macOS shard and the Tauri bundle back onto every src pull
    // request, and dropping one silently unselects a job whose condition still
    // promises it. The ci.yml self-entry is load-bearing the same way it is for
    // the docs and structure filters: an edit to this list must select the run
    // that verifies the edit.
    expect([...(filters.native ?? [])].sort()).toEqual([
      ".github/workflows/ci.yml",
      "app/**",
      "bun.lock",
      "desktop/**",
      "package.json",
      "scripts/build-standalone.ts",
      "scripts/standalone-keyring.ts",
      "src/cli/index.ts",
      "src/lib/bun-runtime.ts",
      "src/lib/keyring-native.ts",
      "src/lib/standalone.ts",
      "src/service/**",
    ]);
  });

  test("is only reachable through the ci filter", () => {
    // The job conditions AND the two outputs, which is only sound if everything
    // the native filter can match is also matched by ci — otherwise a native
    // path could select a job the aggregate believes was never requested.
    for (const pattern of filters.native ?? []) {
      const covered = (filters.ci ?? []).some(candidate =>
        pattern === candidate
        || (candidate.endsWith("/**") && pattern.startsWith(candidate.slice(0, -2))),
      );
      expect(`${pattern}:${covered}`).toBe(`${pattern}:true`);
    }
  });

  test("is published as a changes output", () => {
    expect(changes?.outputs?.native).toBe("${{ steps.matrices.outputs.native }}");
  });
});

describe("the native-gated jobs", () => {
  test("keep macOS off pull requests and leave desktop-shell on the native filter", () => {
    // platform-macos and widget run on macOS runners, which pull requests never pay for.
    for (const name of MACOS_JOBS) {
      expect(`${name}:${jobs[name]?.if}`).toBe(`${name}:github.event_name != 'pull_request'`);
    }
    // desktop-shell runs on ubuntu, so pull requests keep selecting it through the
    // native filter, widened by the package-affecting desktop filter.
    expect(jobs["desktop-shell"]?.if).toBe(
      "github.event_name != 'pull_request' || (needs.changes.outputs.ci == 'true' && (needs.changes.outputs.native == 'true' || needs.changes.outputs.desktop == 'true'))",
    );
    // Another job carrying the native output would silently join the gate, and
    // a gate the aggregate does not know about is the failure this file exists
    // for — so name the full set rather than sampling it.
    const carrying = Object.entries(jobs)
      .filter(([, job]) => (job?.if ?? "").includes("needs.changes.outputs.native"))
      .map(([name]) => name)
      .sort();
    expect(carrying).toEqual(["desktop-shell"]);
  });

  for (const scenario of SELECTION_SCENARIOS) {
    test(`${scenario.name} selects macOS=${scenario.macos} desktop-shell=${scenario.desktopShell}`, () => {
      for (const name of MACOS_JOBS) {
        expect(`${name}:${evaluate(jobs[name]?.if ?? "", { ...scenario.inputs })}`)
          .toBe(`${name}:${scenario.macos}`);
      }
      expect(`desktop-shell:${evaluate(jobs["desktop-shell"]?.if ?? "", { ...scenario.inputs })}`)
        .toBe(`desktop-shell:${scenario.desktopShell}`);
    });
  }
});

describe("the packaged desktop selection", () => {
  test("a pull request that changes only package inputs selects desktop-shell and nothing else native", () => {
    const inputs = { event_name: "pull_request", ci: "true", native: "false", desktop: "true" };
    expect(evaluate(jobs["desktop-shell"]?.if ?? "", inputs)).toBe(true);
    expect(evaluate(jobs["platform-macos"]?.if ?? "", inputs)).toBe(false);
    expect(evaluate(jobs.widget?.if ?? "", inputs)).toBe(false);
  });

  test("an out-of-scope pull request never selects desktop-shell through the package filter", () => {
    const inputs = { event_name: "pull_request", ci: "false", native: "false", desktop: "true" };
    expect(evaluate(jobs["desktop-shell"]?.if ?? "", inputs)).toBe(false);
  });
});

describe("the smoke matrices", () => {
  test.skipIf(cannotRunEmitters)("release evidence names match the full-dispatch workflow graph", () => {
    const { CI_JOBS } = require(repoPath(".github", "scripts", "release-evidence.cjs")) as { CI_JOBS: string[] };
    const scalar = ["changes", "select-windows-runner", "storage-policy", "api-usage", "gates", "macos-control", "docker-smoke", "docs-site-build", "structure-gate", "widget", "desktop-shell", "ci"];
    const expected = scalar.map(id => {
      const name = jobs[id]?.name;
      if (!name) throw new Error(`missing job name: ${id}`);
      return name;
    });
    for (const id of ["test", "platform-macos", "platform-windows"]) {
      const job = jobs[id]!;
      const shards = job.strategy?.matrix?.shard as number[];
      for (const shard of shards) expected.push(job.name!.replace("${{ matrix.shard }}", String(shard)));
    }
    for (const id of ["keyring-smoke", "npm-global-smoke"]) {
      const job = jobs[id]!;
      const output = emittedOutputs(id, "false", "false", "workflow_dispatch").values[matrixOutputName(id)];
      for (const entry of JSON.parse(output!) as Array<Record<string, string>>) {
        expected.push(job.name!.replace(/\$\{\{ matrix\.(name|os) \}\}/, (_, key: string) => entry[key]!));
      }
    }
    for (const id of ["setup-action", "remote-helper"]) {
      const job = jobs[id]!;
      const expression = String(job.strategy?.matrix?.os);
      const arrays = [...expression.matchAll(/'\[([^']+)\]'/g)];
      if (arrays.length !== 2) throw new Error(`unexpected matrix expression: ${id}`);
      for (const os of JSON.parse(`[${arrays[1]![1]}]`) as string[]) expected.push(job.name!.replace("${{ matrix.os }}", os));
    }
    expect([...CI_JOBS].sort()).toEqual(expected.sort());
  });

  test("service evidence names match the service workflow", () => {
    const { serviceJobs } = require(repoPath(".github", "scripts", "release-evidence.cjs")) as { serviceJobs: (sha: string) => string[] };
    const source = "a".repeat(40);
    const service = Bun.YAML.parse(readFileSync(repoPath(".github", "workflows", "service-lifecycle.yml"), "utf8")) as { jobs: Record<string, { name: string }> };
    const names = ["validate-source", "linux-systemd", "macos-launchd", "windows-schtasks"].map(id => service.jobs[id]!.name.replace("${{ github.event.inputs.source_sha }}", source));
    expect(serviceJobs(source)).toEqual(names);
  });

  test("consume their matrices from validated changes outputs", () => {
    for (const jobName of MATRIX_JOBS) {
      const outputName = matrixOutputName(jobName);
      // The output must actually be published by the changes job, not merely
      // referenced from a step that happens to run there.
      expect(changes?.outputs?.[outputName] ?? "").toMatch(/steps\.[A-Za-z-]+\.outputs/);
      // A malformed or empty matrix must fail the changes job instead of
      // reporting success over a matrix that selects nothing — the same rule
      // the ci scope output is held to.
      expect(`${jobName} emitter can fail loud:${(emitterStep(outputName).run ?? "").includes("exit 1")}`)
        .toBe(`${jobName} emitter can fail loud:true`);
    }
  });

  test.skipIf(cannotRunEmitters)("run ubuntu only on pull requests; off-PR keep ubuntu and windows and add macos under the native selection", () => {
    for (const jobName of MATRIX_JOBS) {
      expect(legsFor(jobName, "true", "false", "pull_request")).toEqual(["ubuntu-latest"]);
      expect(legsFor(jobName, "true", "true", "pull_request")).toEqual(["ubuntu-latest"]);
      expect(legsFor(jobName, "true", "false", "push").sort()).toEqual(["ubuntu-latest", "windows-latest"]);
      expect(legsFor(jobName, "true", "true", "push").sort()).toEqual(["macos-latest", "ubuntu-latest", "windows-latest"]);
      expect(legsFor(jobName, "false", "false", "workflow_dispatch", "all").sort()).toEqual(["macos-latest", "ubuntu-latest", "windows-latest"]);
      expect(legsFor(jobName, "false", "false", "workflow_dispatch", "release-gates").sort()).toEqual(["ubuntu-latest", "windows-latest"]);
    }
  });

  test.skipIf(cannotRunEmitters)("keep the keyring legs shaped as name/runner pairs", () => {
    // The job reads matrix.name in its step conditions and matrix.runner in
    // runs-on, so an entry missing either key starts a leg that cannot run.
    const outputName = matrixOutputName("keyring-smoke");
    const entries = JSON.parse(emittedOutputs("keyring-smoke", "true", "true").values[outputName]!) as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.runner).toBe("string");
    }
  });
});

describe("the aggregate gate", () => {
  test("reads the native output the same way the job conditions do", () => {
    const step = (jobs.ci?.steps ?? []).find(candidate => (candidate.run ?? "").includes("scoped=requested"));
    expect(step?.env?.CHANGES_NATIVE).toBe("${{ needs.changes.outputs.native }}");
    expect(step?.env?.CHANGES_CI).toBe("${{ needs.changes.outputs.ci }}");
  });

  test.skipIf(cannotRunGate)("gates every ordinary job by name, excluding the standalone diagnostic", () => {
    const { gatedJobs } = runGate(PR_WITHOUT_NATIVE, {});
    expect(gatedJobs.sort()).toEqual(Object.keys(jobs).filter(name => !["ci", "windows-native-claim"].includes(name)).sort());
  });

  test.skipIf(cannotRunGate)("treats an unselected native job as not-requested and stays green over skips", () => {
    // This is the shape the native gate must not get wrong: a src-only pull
    // request skips the three native jobs, and the gate must read that as
    // deliberate. The ci-scoped jobs stay requested, which is what keeps a
    // silent CI outage from dressing up as an out-of-scope change.
    const { expectations } = runGate(PR_WITHOUT_NATIVE, {});
    for (const name of NATIVE_GATED) expect(`${name}:${expectations[name]}`).toBe(`${name}:not-requested`);
    for (const name of ["changes", "select-windows-runner", "test", "storage-policy", "api-usage", "gates", "keyring-smoke", "docker-smoke"]) {
      expect(`${name}:${expectations[name]}`).toBe(`${name}:requested`);
    }
    // Results consistent with those expectations must pass the gate: skipped is
    // the correct outcome for a job this event never asked for.
    const consistent = Object.fromEntries(Object.keys(jobs)
      .filter(name => !["ci", "windows-native-claim"].includes(name))
      .map(name => [name, expectations[name] === "requested" ? "success" : "skipped"]));
    const { bad } = runGate(PR_WITHOUT_NATIVE, consistent);
    expect(bad).toBe("");
  });

  test.skipIf(cannotRunGate)("swaps the full shards for test changed only on a fast-lane pull request", () => {
    const fast = runGate({ ...PR_WITHOUT_NATIVE, fast: "true" }, {}).expectations;
    expect([fast.test, fast["test-changed"]]).toEqual(["not-requested", "requested"]);
    for (const name of ["storage-policy", "api-usage", "gates"]) {
      expect(`${name}:${fast[name]}`).toBe(`${name}:requested`);
    }
    // A full-lane pull request, and every other event, keeps the shards and never runs test changed.
    for (const inputs of [
      { ...PR_WITHOUT_NATIVE, fast: "false" },
      PR_WITHOUT_NATIVE,
      { ...PR_WITHOUT_NATIVE, eventName: "push", fast: "true" },
      { ...PR_WITHOUT_NATIVE, eventName: "workflow_dispatch", fast: "true" },
    ]) {
      const other = runGate(inputs, {}).expectations;
      expect(`${inputs.eventName}/${inputs.fast}:${other.test}:${other["test-changed"]}`)
        .toBe(`${inputs.eventName}/${inputs.fast}:requested:not-requested`);
    }
    // An out-of-scope pull request requests neither, even if fast were set.
    const outOfScope = runGate({ ...PR_WITHOUT_NATIVE, ci: "false", fast: "true" }, {}).expectations;
    expect([outOfScope.test, outOfScope["test-changed"]]).toEqual(["not-requested", "not-requested"]);
    // Results consistent with the fast lane pass; a shard that ran anyway fails by name.
    const consistent = Object.fromEntries(Object.keys(jobs)
      .filter(name => !["ci", "windows-native-claim"].includes(name))
      .map(name => [name, fast[name] === "requested" ? "success" : "skipped"]));
    expect(runGate({ ...PR_WITHOUT_NATIVE, fast: "true" }, consistent).bad).toBe("");
    expect(runGate({ ...PR_WITHOUT_NATIVE, fast: "true" }, { ...consistent, test: "success" }).bad).toContain("test was not requested");
  });

  test.skipIf(cannotRunGate)("never requests macOS on a native pull request, but still requests desktop-shell", () => {
    const { expectations } = runGate({ ...PR_WITHOUT_NATIVE, native: "true" }, {});
    for (const name of MACOS_JOBS) expect(`${name}:${expectations[name]}`).toBe(`${name}:not-requested`);
    expect(expectations["desktop-shell"]).toBe("requested");
  });

  test.skipIf(cannotRunGate)("still fails a requested native job that reports skipped", () => {
    const selectedNative = { ...PR_WITHOUT_NATIVE, eventName: "push", native: "true" };
    const { expectations } = runGate(selectedNative, {});
    for (const name of NATIVE_GATED) expect(`${name}:${expectations[name]}`).toBe(`${name}:requested`);
    const results: Record<string, string> = {};
    for (const [name, expectation] of Object.entries(expectations)) {
      results[name] = expectation === "requested" && !(NATIVE_GATED as readonly string[]).includes(name) ? "success" : "skipped";
    }
    const { bad } = runGate(selectedNative, results);
    for (const name of NATIVE_GATED) expect(bad).toContain(name);
  });

  test.skipIf(cannotRunGate)("requests the native jobs on push and dispatch regardless of the filter outputs", () => {
    for (const eventName of ["push", "workflow_dispatch"]) {
      const { expectations } = runGate({ ...PR_WITHOUT_NATIVE, eventName, ci: "false", native: "false" }, {});
      for (const name of NATIVE_GATED) {
        expect(`${eventName}:${name}:${expectations[name]}`).toBe(`${eventName}:${name}:requested`);
      }
    }
  });

  test.skipIf(cannotRunGate)("leaves the keyring and npm-global expectations alone", () => {
    // The smoke jobs keep running as jobs; only their matrix legs shrink. So
    // keyring-smoke still follows the shared ci scope and npm-global-smoke
    // still follows packaging, native or not.
    const { expectations } = runGate(PR_WITHOUT_NATIVE, {});
    expect(expectations["keyring-smoke"]).toBe("requested");
    expect(expectations["npm-global-smoke"]).toBe("not-requested");
    const withPackaging = runGate({ ...PR_WITHOUT_NATIVE, packaging: "true" }, {});
    expect(withPackaging.expectations["npm-global-smoke"]).toBe("requested");
    expect(withPackaging.expectations["keyring-smoke"]).toBe("requested");
  });

  test.skipIf(cannotRunGate)("drops the smoke jobs from a pull request that misses their filters, and only there", () => {
    const narrow = { ...PR_WITHOUT_NATIVE, docker: "false", keyring: "false" };
    const { expectations } = runGate(narrow, {});
    expect(expectations["docker-smoke"]).toBe("not-requested");
    expect(expectations["keyring-smoke"]).toBe("not-requested");
    for (const name of ["test", "storage-policy", "api-usage", "gates"]) {
      expect(`${name}:${expectations[name]}`).toBe(`${name}:requested`);
    }
    // Each filter selects only its own job.
    const dockerOnly = runGate({ ...narrow, docker: "true" }, {}).expectations;
    expect([dockerOnly["docker-smoke"], dockerOnly["keyring-smoke"]]).toEqual(["requested", "not-requested"]);
    const keyringOnly = runGate({ ...narrow, keyring: "true" }, {}).expectations;
    expect([keyringOnly["docker-smoke"], keyringOnly["keyring-smoke"]]).toEqual(["not-requested", "requested"]);
    // An out-of-scope pull request stays out of scope even when a smoke filter matched.
    const outOfScope = runGate({ ...narrow, ci: "false", docker: "true", keyring: "true" }, {}).expectations;
    expect([outOfScope["docker-smoke"], outOfScope["keyring-smoke"]]).toEqual(["not-requested", "not-requested"]);
    // Push, dispatch and schedule ignore the smoke filters: the release gate reads the push run.
    for (const eventName of ["push", "workflow_dispatch", "schedule"]) {
      const other = runGate({ ...narrow, eventName }, {}).expectations;
      expect(`${eventName}:${other["docker-smoke"]}:${other["keyring-smoke"]}`).toBe(`${eventName}:requested:requested`);
    }
    // Results consistent with the narrowed expectations pass; a smoke job that ran anyway fails by name.
    const consistent = Object.fromEntries(Object.keys(jobs)
      .filter(name => !["ci", "windows-native-claim"].includes(name))
      .map(name => [name, expectations[name] === "requested" ? "success" : "skipped"]));
    expect(runGate(narrow, consistent).bad).toBe("");
    expect(runGate(narrow, { ...consistent, "docker-smoke": "success" }).bad).toContain("docker-smoke");
  });
});
