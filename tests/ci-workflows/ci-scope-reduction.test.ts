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
  on?: { push?: { branches?: string[] } };
  jobs?: Record<string, {
    if?: string;
    needs?: string | string[];
    "runs-on"?: string;
    outputs?: Record<string, string>;
    strategy?: { matrix?: Record<string, unknown> };
    steps?: Array<{
      name?: string;
      id?: string;
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
/** The two smoke jobs whose matrix legs shrink with the native selection. */
const MATRIX_JOBS = ["keyring-smoke", "npm-global-smoke"] as const;

type SelectionInputs = { event_name: string; ci: string; native: string };

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
  const output = /^needs\.changes\.outputs\.([a-z-]+)$/.exec(text);
  if (output) {
    if (output[1] === "ci") return inputs.ci;
    if (output[1] === "native") return inputs.native;
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

/** Every way an event can combine with the two filter outputs, and what must happen. */
const SELECTION_SCENARIOS = [
  // The filter outputs are deliberately false for push and dispatch: selection
  // there must not depend on them at all, or the event guard has been lost.
  { name: "a push", inputs: { event_name: "push", ci: "false", native: "false" }, selected: true },
  { name: "a workflow_dispatch", inputs: { event_name: "workflow_dispatch", ci: "false", native: "false" }, selected: true },
  { name: "a pull request that touches native paths", inputs: { event_name: "pull_request", ci: "true", native: "true" }, selected: true },
  { name: "a pull request that touches no native path", inputs: { event_name: "pull_request", ci: "true", native: "false" }, selected: false },
  { name: "an out-of-scope pull request", inputs: { event_name: "pull_request", ci: "false", native: "false" }, selected: false },
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

function renderFilterOutputs(text: string, inputs: { ci: string; native: string }): string {
  const rendered = text.replace(/\$\{\{\s*steps\.filter\.outputs\.([a-z-]+)\s*\}\}/g, (_match, name: string) => {
    if (name === "ci") return inputs.ci;
    if (name === "native") return inputs.native;
    throw new Error(`unsupported filter output in emitter: ${name}`);
  });
  const leftover = rendered.indexOf("${{");
  if (leftover >= 0) throw new Error(`unrendered expression in emitter: ${rendered.slice(leftover, leftover + 80)}`);
  return rendered;
}

/** Run the emitter step the way Actions would, and parse what it wrote to GITHUB_OUTPUT. */
function emittedOutputs(jobName: string, ci: string, native: string): { exitCode: number; values: Record<string, string> } {
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
    for (const [key, value] of Object.entries(step.env ?? {})) env[key] = renderFilterOutputs(String(value), { ci, native });
    const run = renderFilterOutputs(String(step.run ?? ""), { ci, native });
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

function legsFor(jobName: string, ci: "true" | "false", native: "true" | "false"): string[] {
  const outputName = matrixOutputName(jobName);
  const { exitCode, values } = emittedOutputs(jobName, ci, native);
  expect(exitCode, `${jobName} emitter failed under ci=${ci} native=${native}`).toBe(0);
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
};

const PR_WITHOUT_NATIVE: GateInputs = {
  eventName: "pull_request",
  ci: "true",
  native: "false",
  packaging: "false",
  docs: "false",
  structure: "false",
  lane: "",
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

describe("the push trigger", () => {
  test("carries main and preview, and no longer dev", () => {
    // main and preview must stay: release.yml requires a successful push-event
    // run for the exact release SHA and states that a pull_request run does not
    // qualify, so removing either breaks publication. dev is the deliberate
    // removal — its integration evidence is the pull_request run, and
    // workflow_dispatch covers anything else — so the push run stopped doubling
    // the full matrix behind a merge that was just verified as a PR.
    expect([...(workflow.on?.push?.branches ?? [])].sort()).toEqual(["main", "preview"]);
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
      "src/cli/index.ts",
      "src/lib/bun-runtime.ts",
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
  const condition = jobs["platform-macos"]?.if ?? "";

  test("are exactly platform-macos, widget and desktop-shell on one shared condition", () => {
    for (const name of NATIVE_GATED) {
      expect(`${name}:${jobs[name]?.if}`).toBe(`${name}:${condition}`);
    }
    // A fourth job carrying the native output would silently join the gate, and
    // a gate the aggregate does not know about is the failure this file exists
    // for — so name the full set rather than sampling it.
    const carrying = Object.entries(jobs)
      .filter(([, job]) => (job?.if ?? "").includes("needs.changes.outputs.native"))
      .map(([name]) => name)
      .sort();
    expect(carrying).toEqual([...NATIVE_GATED].sort());
  });

  for (const scenario of SELECTION_SCENARIOS) {
    test(`${scenario.name} ${scenario.selected ? "selects" : "does not select"} them`, () => {
      for (const name of NATIVE_GATED) {
        expect(`${name}:${evaluate(jobs[name]?.if ?? "", { ...scenario.inputs })}`)
          .toBe(`${name}:${scenario.selected}`);
      }
    });
  }
});

describe("the smoke matrices", () => {
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

  test.skipIf(emittersNeedJq && !hostHasJq)("keep ubuntu and windows unconditionally and macos only under the native selection", () => {
    for (const jobName of MATRIX_JOBS) {
      expect(legsFor(jobName, "true", "false").sort()).toEqual(["ubuntu-latest", "windows-latest"]);
      expect(legsFor(jobName, "true", "true").sort()).toEqual(["macos-latest", "ubuntu-latest", "windows-latest"]);
    }
  });

  test.skipIf(emittersNeedJq && !hostHasJq)("keep the keyring legs shaped as name/runner pairs", () => {
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

  test.skipIf(!hostHasJq)("gates every job by name, with the aggregate itself excepted", () => {
    const { gatedJobs } = runGate(PR_WITHOUT_NATIVE, {});
    expect(gatedJobs.sort()).toEqual(Object.keys(jobs).filter(name => name !== "ci").sort());
  });

  test.skipIf(!hostHasJq)("treats an unselected native job as not-requested and stays green over skips", () => {
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
      .filter(name => name !== "ci")
      .map(name => [name, expectations[name] === "requested" ? "success" : "skipped"]));
    const { bad } = runGate(PR_WITHOUT_NATIVE, consistent);
    expect(bad).toBe("");
  });

  test.skipIf(!hostHasJq)("still fails a requested native job that reports skipped", () => {
    const selectedNative = { ...PR_WITHOUT_NATIVE, native: "true" } as const;
    const { expectations } = runGate(selectedNative, {});
    for (const name of NATIVE_GATED) expect(`${name}:${expectations[name]}`).toBe(`${name}:requested`);
    const results: Record<string, string> = {};
    for (const [name, expectation] of Object.entries(expectations)) {
      results[name] = expectation === "requested" && !(NATIVE_GATED as readonly string[]).includes(name) ? "success" : "skipped";
    }
    const { bad } = runGate(selectedNative, results);
    for (const name of NATIVE_GATED) expect(bad).toContain(name);
  });

  test.skipIf(!hostHasJq)("requests the native jobs on push and dispatch regardless of the filter outputs", () => {
    for (const eventName of ["push", "workflow_dispatch"]) {
      const { expectations } = runGate({ ...PR_WITHOUT_NATIVE, eventName, ci: "false", native: "false" }, {});
      for (const name of NATIVE_GATED) {
        expect(`${eventName}:${name}:${expectations[name]}`).toBe(`${eventName}:${name}:requested`);
      }
    }
  });

  test.skipIf(!hostHasJq)("leaves the keyring and npm-global expectations alone", () => {
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
});
