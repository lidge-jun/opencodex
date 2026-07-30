/**
 * Runs the `enforce-pr-target.yml` inline script against a fake GitHub client.
 *
 * Four rounds of adversarial audit killed every attempt to pin this script by
 * text. The script is JavaScript, and JavaScript has infinitely many spellings
 * for the same effect: `const upd = github.rest.pulls.update`,
 * `github.rest["pulls"]["update"]`, `github.request("PATCH …")`, a `...spread`
 * that injects `base: "main"`, `Object.assign(pr.base, …)` instead of a dotted
 * assignment, `if (false) { … }` around the whole body. Each one defeats a
 * regex while preserving every string the regex looks for.
 *
 * So stop reading the script and run it. Hand it a recording client, drive it
 * through the scenarios that matter, and assert on the calls that come out. A
 * rewrite can spell itself any way it likes; the observed calls are the same
 * either way.
 */

import { createRequire } from "node:module";
import path from "node:path";

export type RecordedCall = { method: string; args: unknown };

export type HarnessResult = {
  calls: RecordedCall[];
  logs: string[];
  warnings: string[];
  /**
   * What the script body returned. The real action captures this too
   * (`const result = await callAsyncFunction(...)`, then `core.setOutput`), so
   * modelling it costs nothing and lets a probe script report back.
   */
  returnValue: unknown;
  /**
   * The method names the fake `core` exposed for this run. A test compares it
   * against the real `@actions/core` export list — round eight got in through
   * a method production has and the fake did not.
   */
  coreSurface: string[];
};

export type PullRequestState = {
  number?: number;
  node_id?: string;
  title?: string;
  body?: string;
  draft?: boolean;
  base?: { ref: string };
  user?: { login: string };
};

export type Comment = { id: number; user?: { login: string }; body?: string };

export type RunOptions = {
  /** The PR as `pulls.get` will report it — the live, authoritative state. */
  pr: PullRequestState;
  /**
   * What the webhook delivered, if it differs from `pr`.
   *
   * Real events go stale: the PR is retargeted, edited, or drafted between the
   * webhook firing and the job starting. An audit round exploited a harness
   * that made these the same object — `Object.assign(pr, context.payload.pull_request)`
   * silently overwrote the fetched state with the event's, and every scenario
   * still passed because the two were aliases. They are independent here.
   */
  eventPayload?: PullRequestState;
  /**
   * Comments as `listComments` returns them, PAGE BY PAGE. Pass more than one
   * page to prove the script paginates: an audit round replaced `paginate` with
   * a single `listComments` call, which loses a bot comment that has scrolled
   * onto page two — the workflow then posts a duplicate and forgets what it had
   * changed.
   */
  commentPages?: Comment[][];
  /** Shorthand for a single page. */
  comments?: Comment[];
  /** Method names that should reject, to exercise partial-failure paths. */
  failOn?: string[];
  /**
   * HTTP status the simulated failure carries. Octokit throws `RequestError`
   * with a `.status`, and an audit round used that to swallow exactly one code:
   * `catch (error) { if (error.status === 404) return; throw error; }` turned a
   * failed draft conversion into a green workflow. A plain `Error` cannot
   * exercise that branch.
   */
  failStatus?: number;
  /** Collaborator permission returned by `getCollaboratorPermissionLevel`. */
  authorPermission?: string;
  /** When true, permission lookup rejects like a transient API failure. */
  failPermissionLookup?: boolean;
  /** Overrides for `compareCommitsWithBasehead` keyed by `basehead`. */
  compareByBasehead?: Record<string, { ahead_by: number; behind_by: number }>;
};

/**
 * A PR as the API returns it.
 *
 * The script reads `number`, `node_id`, `title`, `draft`, `base.ref`, and
 * `user.login`, but the object it gets carries far more, and round ten used
 * `context.payload.pull_request.head.sha` to tell the two apart. The extra
 * fields are inert to the logic and load-bearing for fidelity.
 */
const DEFAULT_BODY = [
  "## Summary",
  "",
  "This change adds enough substantive detail for reviewers to understand the motivation and approach taken.",
  "",
  "## Test plan",
  "",
  "- [x] Run `bun test tests/ci-workflows.test.ts`",
  "- [x] Confirm enforce-pr-target behaviour locally",
].join("\n");

const DEFAULT_PR = {
  number: 42,
  node_id: "PR_kwDOnode42",
  id: 1122334455,
  title: "Add a thing",
  body: DEFAULT_BODY,
  draft: false,
  state: "open",
  merged: false,
  locked: false,
  html_url: "https://github.com/lidge-jun/opencodex/pull/42",
  base: { ref: "dev", sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", label: "lidge-jun:dev" },
  head: { ref: "feature", sha: "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b", label: "contributor:feature" },
  user: { login: "contributor", id: 67890, type: "User" },
  labels: [] as unknown[],
};

/**
 * Extract the inline `script:` body from the workflow and compile it into an
 * async function with the same free variables `actions/github-script` provides.
 *
 * `github-script` wraps the body in an async function and calls it with
 * `github`, `context`, `core`, `exec`, `glob`, `io`, `fetch`, and `require` in
 * scope. Bare `return` in the body is legal there, which is why the script uses
 * it — so the harness has to compile it the same way for the early-return paths
 * to behave.
 */
export function compileScript(script: string): (scope: Record<string, unknown>) => Promise<unknown> {
  const names = [...SCRIPT_BINDINGS, ...RUNTIME_SHADOWS];
  const factory = new Function(
    ...names,
    `return (async () => {\n${script}\n})();`,
  ) as (...args: unknown[]) => Promise<unknown>;
  return scope => factory(...names.map(name => scope[name]));
}

/**
 * What `actions/github-script` actually puts in scope.
 *
 * This is not a guess. The pinned action builds the script's scope in
 * `src/main.ts`, which hands `callAsyncFunction` an object whose keys become
 * the compiled function's parameters:
 *
 *   { require, __original_require__, github, octokit, getOctokit,
 *     context, core, exec, glob, io }
 *
 * Round eight got in through the gap between that list and this one. Three
 * mutations probed for a binding the real runtime has and the harness did not
 * — `typeof getOctokit === "function"` among them — and returned early. In
 * production the gate does nothing; here the probe was falsy so all thirty
 * tests stayed green.
 *
 * The lesson generalises past those three names: any binding present in
 * production and absent here is a detection vector. So the list is copied from
 * the action's source rather than assembled from the names this script happens
 * to use. `fetch` is a Node 24 global rather than an injected binding, and it
 * is kept shadowed so the script cannot reach the network directly.
 */
export const SCRIPT_BINDINGS = [
  "github",
  "octokit",
  "getOctokit",
  "context",
  "core",
  "exec",
  "glob",
  "io",
  "fetch",
  "require",
  "__original_require__",
] as const;

/**
 * Names the script must not be able to use to look past the fakes.
 *
 * `new Function` compiles in global scope, so without these the body can reach
 * the real runtime. Round six proved it three ways — `typeof Bun === "undefined"`,
 * `globalThis.process.versions.bun`, and `Function("return process")()` all
 * detected the test runner and returned early, which is a green suite and a
 * dead workflow in production.
 *
 * Shadowing them as parameters closes the escape: inside the compiled body
 * these resolve to the harness's values, not the runtime's.
 */
const RUNTIME_SHADOWS = [
  "process",
  "globalThis",
  "Bun",
  "Deno",
  "Function",
  "eval",
  "global",
  "module",
  "import_meta",
  // Deferred work escapes an `await`. A round-seven mutation dropped a
  // `setTimeout(() => github.request("POST /repos/attacker/other/issues"), 0)`
  // into the script: the harness awaited only the script body, so the write
  // landed after the assertions had already run and every scenario passed.
  // Under Node the timer fires with the write-capable client still in hand.
  //
  // These are captured rather than blocked, so the run can drain them and the
  // recording includes whatever they did.
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
] as const;

/**
 * A `process` that reports Node, not Bun.
 *
 * `actions/github-script` executes under Node, so any script that branches on
 * the runtime takes the Node path in production. A harness that leaks Bun lets
 * a mutation run one program in the test and another one for real.
 */
/**
 * A rejection shaped like Octokit's `RequestError`: `.status`, `.name`, and a
 * `.response` with the status on it too. Anything that branches on an HTTP
 * code sees the same thing it would see in production.
 */
function octokitError(method: string, status: number): Error & { status: number } {
  const error = new Error(`simulated failure: ${method}`) as Error & {
    status: number;
    name: string;
    response?: unknown;
    request?: unknown;
  };
  error.name = "HttpError";
  error.status = status;
  error.response = { status, url: `https://api.github.com/${method}`, headers: {}, data: {} };
  error.request = { method: "POST", url: `https://api.github.com/${method}` };
  return error;
}

function nodeLikeProcess(): Record<string, unknown> {
  const workspace = process.cwd();
  return {
    platform: "linux",
    arch: "x64",
    // The pinned action declares `using: node24` in its `action.yml`, so the
    // runner executes the script under Node 24 — not the Node 20 this harness
    // reported for fourteen rounds. A gate spelled
    // `if (process.versions.node.startsWith("24")) return;` was dead code here
    // and a disabled workflow in production.
    version: "v24.10.0",
    versions: { node: "24.10.0", v8: "13.6.233.10-node.18" },
    // The variables a real ubuntu-latest runner exports. Round nine probed
    // four of them — `RUNNER_TEMP`, `GITHUB_SHA`, `GITHUB_WORKSPACE`,
    // `ACTIONS_RUNTIME_TOKEN` — each present on the runner and absent here, so
    // `if (process.env.X) return;` was a no-op in the suite and a dead gate in
    // production.
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_ACTION: "__run",
      GITHUB_ACTOR: "contributor",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_BASE_REF: "dev",
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_EVENT_PATH: "/home/runner/work/_temp/_github_workflow/event.json",
      GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
      GITHUB_HEAD_REF: "feature",
      GITHUB_JOB: "enforce-target",
      GITHUB_REF: "refs/pull/42/merge",
      GITHUB_REPOSITORY: "lidge-jun/opencodex",
      GITHUB_REPOSITORY_OWNER: "lidge-jun",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "1234567890",
      GITHUB_RUN_NUMBER: "87",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_SHA: "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b",
      GITHUB_WORKFLOW: "Enforce PR target branch",
      GITHUB_WORKSPACE: workspace,
      HOME: "/home/runner",
      RUNNER_ARCH: "X64",
      RUNNER_NAME: "GitHub Actions 1",
      RUNNER_OS: "Linux",
      RUNNER_TEMP: "/home/runner/work/_temp",
      RUNNER_TOOL_CACHE: "/opt/hostedtoolcache",
      ACTIONS_RUNTIME_TOKEN: "***",
      ACTIONS_RUNTIME_URL: "https://pipelines.actions.githubusercontent.com/",
    },
    argv: ["/usr/bin/node", "/home/runner/work/_actions/actions/github-script/dist/index.js"],
    cwd: () => workspace,
    exit: () => { throw new Error("the script must not call process.exit"); },
  };
}

/**
 * Every runtime binding the compiled script sees, shadowing the real globals.
 *
 * `globalThis` gets the same Node-shaped `process`, so `globalThis.process
 * .versions.bun` is undefined here exactly as it is in production. `Bun` and
 * `Deno` are undefined for the same reason. `Function` and `eval` are blocked
 * outright — a script that needs to compile code at runtime inside a workflow
 * holding a write token is not something to characterise, it is something to
 * reject.
 */
function nodeLikeRuntime(deferred: (() => unknown)[]): Record<string, unknown> {
  const nodeProcess = nodeLikeProcess();
  const deny = (name: string) => () => {
    throw new Error(`the script must not use ${name}`);
  };
  /** Record the callback so the run can drain it, and hand back a timer id. */
  const capture = (callback: unknown) => {
    if (typeof callback === "function") {
      deferred.push(callback as () => unknown);
    }
    return { unref: () => {}, ref: () => {} };
  };

  const fakeGlobal: Record<string, unknown> = {
    process: nodeProcess,
    Bun: undefined,
    Deno: undefined,
    console,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    Error,
    Promise,
    Map,
    Set,
    Symbol,
  };
  fakeGlobal.globalThis = fakeGlobal;
  fakeGlobal.global = fakeGlobal;

  fakeGlobal.setTimeout = capture;
  fakeGlobal.setInterval = capture;
  fakeGlobal.setImmediate = capture;
  fakeGlobal.queueMicrotask = capture;

  return {
    process: nodeProcess,
    globalThis: fakeGlobal,
    global: fakeGlobal,
    Bun: undefined,
    Deno: undefined,
    Function: deny("Function"),
    eval: deny("eval"),
    module: undefined,
    import_meta: undefined,
    setTimeout: capture,
    setInterval: capture,
    setImmediate: capture,
    queueMicrotask: capture,
  };
}

/**
 * `core.summary` — a chainable builder in production, so `typeof
 * core.summary.addRaw === "function"` must hold here too. Nothing is written;
 * a job summary is not part of this workflow's contract.
 */
function summaryStub(): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  const chain = () => summary;
  for (const name of [
    "addRaw", "addEOL", "addCodeBlock", "addList", "addTable", "addDetails",
    "addImage", "addHeading", "addSeparator", "addBreak", "addQuote", "addLink",
    "emptyBuffer",
  ]) {
    summary[name] = chain;
  }
  summary.write = async () => summary;
  summary.clear = async () => summary;
  summary.stringify = () => "";
  summary.isEmptyBuffer = () => true;
  return summary;
}

export async function runEnforcePrTarget(
  script: string,
  options: RunOptions,
): Promise<HarnessResult> {
  const calls: RecordedCall[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const outputs: { name: string; value: unknown }[] = [];
  const states = new Map<string, unknown>();
  const failOn = new Set(options.failOn ?? []);
  if (options.failPermissionLookup) {
    // Route through `record` so the call appears in the recording even when it
    // rejects (same semantics as `failOn`).
    failOn.add("repos.getCollaboratorPermissionLevel");
  }
  const failStatus = options.failStatus ?? 500;

  const pr = {
    ...DEFAULT_PR,
    ...options.pr,
    base: { ...DEFAULT_PR.base, ...(options.pr.base ?? {}) },
    user: { ...DEFAULT_PR.user, ...(options.pr.user ?? {}) },
  };
  // Deep-independent from `pr`, so nothing the script does to one can reach the
  // other by aliasing. Defaults to the same values; pass `eventPayload` to make
  // it genuinely stale.
  const source = options.eventPayload ?? options.pr;
  const eventPr = {
    ...DEFAULT_PR,
    ...source,
    base: { ...DEFAULT_PR.base, ...(source.base ?? {}) },
    user: { ...DEFAULT_PR.user, ...(source.user ?? {}) },
  };
  const pages: Comment[][] = options.commentPages ?? [options.comments ?? []];

  /**
   * Record the call, then either reject or return a plausible payload. Every
   * entry point goes through here — including `github.request` and
   * `github.graphql`, which is how a rewrite that abandons `github.rest.*`
   * entirely still shows up in the recording.
   */
  function record(method: string, args: unknown, data: unknown = {}): unknown {
    calls.push({ method, args });
    if (failOn.has(method)) {
      throw octokitError(method, failStatus);
    }
    // Octokit resolves to a response object, never `undefined`. A harness that
    // returned `undefined` let a mutation branch on the result — `const update =
    // await …update(…); if (update) return;` skipped the draft conversion in
    // production while passing every test here.
    return { status: 200, url: `https://api.github.com/${method}`, headers: {}, data };
  }

  /**
   * Every client method resolves or REJECTS — it never throws synchronously.
   *
   * The methods used to be `Promise.resolve(record(…))`, which evaluates
   * `record` first, so a simulated failure escaped as a synchronous exception.
   * Real Octokit returns a promise and rejects it, and the difference is
   * visible from the script: `github.rest.pulls.get(…).catch(…)` never runs its
   * handler against a synchronous throw. A review round used exactly that to
   * turn a failed authoritative PR read into a synthetic correct-looking PR,
   * which converts an enforcement outage into a green check.
   */
  const respond = async (method: string, args: unknown, data?: unknown) =>
    record(method, args, data);

  const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
  const scriptsRoot = path.resolve(process.cwd(), ".github", "scripts");
  /** Bare modules the workflow script may load (see enforce-pr-target.yml). */
  const ALLOWED_MODULES = new Set(["path", "node:path"]);

  function scopedRequire(id: string) {
    calls.push({ method: "require", args: [id] });
    const isPathLike = id.startsWith(".") || path.isAbsolute(id);
    if (!isPathLike) {
      if (!ALLOWED_MODULES.has(id)) {
        throw new Error(`the script must not require ${id}`);
      }
      return nodeRequire(id);
    }
    const resolved = path.isAbsolute(id) ? path.resolve(id) : path.resolve(process.cwd(), id);
    if (!resolved.startsWith(scriptsRoot + path.sep) && resolved !== scriptsRoot) {
      throw new Error(`the script must not require ${id}`);
    }
    return nodeRequire(resolved);
  }

  function compareResult(basehead: string): { ahead_by: number; behind_by: number } {
    const override = options.compareByBasehead?.[basehead];
    if (override) return override;
    if (basehead.startsWith("main...")) {
      // Default: not the #644 shape (several commits ahead of main).
      return { ahead_by: 8, behind_by: 0 };
    }
    return { ahead_by: 0, behind_by: 0 };
  }

  const rest = {
    pulls: {
      get: (args: unknown) => respond("pulls.get", args, pr),
      update: (args: unknown) => respond("pulls.update", args, { ...pr }),
    },
    issues: {
      // Honours `page`, so a caller that skips `paginate` sees only page one —
      // exactly what happens against the real API.
      listComments: (args: unknown) => {
        const page = Number((args as { page?: number })?.page ?? 1);
        return respond("issues.listComments", args, pages[page - 1] ?? []);
      },
      createComment: (args: unknown) => respond("issues.createComment", args, { id: 99 }),
      updateComment: (args: unknown) => respond("issues.updateComment", args, { id: 7 }),
    },
    repos: {
      getCollaboratorPermissionLevel: (args: unknown) =>
        respond("repos.getCollaboratorPermissionLevel", args, {
          permission: options.authorPermission ?? "read",
        }),
      compareCommitsWithBasehead: (args: unknown) => {
        const basehead = String((args as { basehead?: string })?.basehead ?? "");
        return respond("repos.compareCommitsWithBasehead", args, compareResult(basehead));
      },
    },
  };

  /**
   * A class, not an object literal.
   *
   * `getOctokit()` returns an `Octokit` instance, so on the runner
   * `Object.getPrototypeOf(github) !== Object.prototype` is true. Round nine
   * used exactly that to tell the two apart: a plain literal here made the
   * check false, so `if (…) return;` skipped the whole gate in production and
   * changed nothing in the suite.
   *
   * `rest` is the same shape either way; only the identity of the wrapper
   * mattered.
   */
  class Octokit {
    rest = rest;
    graphql = (query: unknown, variables: unknown) =>
      respond("graphql", { query, variables });
    request = (route: unknown, params: unknown) =>
      respond("request", { route, params });
    /**
     * `github.paginate(fn, params)` — walk every page and concatenate, the way
     * Octokit does. A one-page fake would make dropping pagination invisible.
     */
    paginate = Object.assign(
      async (fn: (args: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
        const collected: unknown[] = [];
        for (let page = 1; page <= pages.length; page += 1) {
          const response = await fn({ ...(params as object), page });
          collected.push(...response.data);
        }
        return collected;
      },
      {
        /**
         * Octokit hangs an async-iterator form off `paginate`. It has to exist
         * (round nine probed `typeof github.paginate?.iterator === "function"`)
         * and it has to record, or a rewrite that pages with `for await` walks
         * out of the recording entirely.
         */
        iterator: (fn: (args: unknown) => Promise<{ data: unknown[] }>, params: unknown) => ({
          async *[Symbol.asyncIterator]() {
            for (let page = 1; page <= pages.length; page += 1) {
              yield await fn({ ...(params as object), page });
            }
          },
        }),
      },
    );
    /**
     * The plumbing a real client carries. None of it is something this
     * workflow should touch, but all of it answers a `typeof` probe on the
     * runner — so it answers here too, and calling it is what fails.
     *
     * `hook` matters most: `github.hook.before("request", …)` can rewrite every
     * outgoing call, which is a way to retarget writes without naming them.
     */
    hook = Object.assign(
      (...args: unknown[]) => { calls.push({ method: "hook", args }); throw new Error("the script must not install request hooks"); },
      {
        before: (...args: unknown[]) => { calls.push({ method: "hook.before", args }); throw new Error("the script must not install request hooks"); },
        after: (...args: unknown[]) => { calls.push({ method: "hook.after", args }); throw new Error("the script must not install request hooks"); },
        error: (...args: unknown[]) => { calls.push({ method: "hook.error", args }); throw new Error("the script must not install request hooks"); },
        wrap: (...args: unknown[]) => { calls.push({ method: "hook.wrap", args }); throw new Error("the script must not install request hooks"); },
      },
    );
    auth = async (...args: unknown[]) => {
      calls.push({ method: "auth", args });
      return { type: "token", token: "***" };
    };
    log = {
      debug: (message: unknown) => { logs.push(`octokit debug: ${String(message)}`); },
      info: (message: unknown) => { logs.push(`octokit info: ${String(message)}`); },
      warn: (message: unknown) => { warnings.push(`octokit warn: ${String(message)}`); },
      error: (message: unknown) => { warnings.push(`octokit error: ${String(message)}`); },
    };
  }
  const github = new Octokit();

  /**
   * `context` with every field the real `Context` class hydrates.
   *
   * Round nine walked through the four fields this used to carry. `context` is
   * a class in `@actions/github` whose constructor sets `sha`, `ref`,
   * `workflow`, `action`, `actor`, `job`, `runAttempt`, `runNumber`, `runId`,
   * `apiUrl`, `serverUrl`, and `graphqlUrl` from the environment, and exposes
   * `issue` and `repo` as getters. `typeof context.sha === "string"` is true on
   * every runner and was false here, which is the round-eight mechanism again
   * one level down: a name that answers differently is a switch.
   *
   * `apiUrl`, `serverUrl`, and `graphqlUrl` have defaults in the constructor,
   * so they are non-empty even with no environment at all.
   */
  class Context {
    /**
     * The webhook payload, not just its `pull_request`.
     *
     * Round ten carried round nine's mechanism one level further in: a real
     * `pull_request_target` event delivers `action`, `number`, `repository`,
     * `sender`, and an `organization`, and the PR object itself carries `head`,
     * `html_url`, `labels`, `state`, and `merged`. Each field present on the
     * runner and absent here is another `if (payload.x) return;`.
     */
    payload = {
      action: "opened",
      number: eventPr.number,
      pull_request: eventPr,
      repository: {
        id: 987654321,
        name: "opencodex",
        full_name: "lidge-jun/opencodex",
        default_branch: "main",
        private: false,
        owner: { login: "lidge-jun", id: 12345, type: "User" },
        html_url: "https://github.com/lidge-jun/opencodex",
      },
      sender: { login: "contributor", id: 67890, type: "User" },
      organization: undefined,
      installation: undefined,
    };
    eventName = "pull_request_target";
    sha = "3f1c0de0a6a4d0a3f9a1b2c3d4e5f60718293a4b";
    ref = "refs/pull/42/merge";
    workflow = "Enforce PR target branch";
    action = "__run";
    actor = "contributor";
    job = "enforce-target";
    runAttempt = 1;
    runNumber = 87;
    runId = 1234567890;
    apiUrl = "https://api.github.com";
    serverUrl = "https://github.com";
    graphqlUrl = "https://api.github.com/graphql";
    get repo() {
      return { owner: "lidge-jun", repo: "opencodex" };
    }
    get issue() {
      return { owner: "lidge-jun", repo: "opencodex", number: eventPr.number };
    }
  }
  const context = new Context();

  /**
   * The whole `@actions/core` surface, not the three methods this script
   * happens to call.
   *
   * Round eight walked straight through the difference. `if (core.setOutput)
   * return;` and `if (core.getInput?.("github-token")) return;` are no-ops in
   * a harness whose fake `core` lacks those methods, and a complete shutdown
   * of the gate in production, where `@actions/core` has both and
   * `github-token` carries a `${{ github.token }}` default.
   *
   * Every name below is exported by `@actions/core`. Ones the script has no
   * business calling from a workflow that holds a write token — `setSecret`,
   * `addPath`, `exportVariable`, `getIDToken` — are present but throw, so the
   * probe sees production's shape while the call is still rejected. The rest
   * behave plausibly: `getInput` returns the action's real defaults,
   * `isDebug()` is false, `group` runs its callback.
   */
  const coreDeny = (name: string) => () => {
    throw new Error(`the script must not use core.${name}`);
  };
  /** The `with:` inputs this step passes, plus the action's own defaults. */
  const actionInputs: Record<string, string> = {
    script: script,
    "github-token": "***",
    debug: "false",
    "user-agent": "actions/github-script",
    previews: "",
    "result-encoding": "json",
    retries: "0",
    "retry-exempt-status-codes": "400,401,403,404,422",
    "base-url": "",
  };
  const core = {
    info: (message: unknown) => { logs.push(String(message)); },
    warning: (message: unknown) => { warnings.push(String(message)); },
    error: (message: unknown) => { warnings.push(`error: ${String(message)}`); },
    notice: (message: unknown) => { logs.push(String(message)); },
    debug: (message: unknown) => { logs.push(`debug: ${String(message)}`); },
    setFailed: (message: unknown) => { warnings.push(`setFailed: ${String(message)}`); },
    isDebug: () => false,
    getInput: (name: unknown) => actionInputs[String(name)] ?? "",
    getMultilineInput: (name: unknown) =>
      (actionInputs[String(name)] ?? "").split("\n").filter(line => line !== ""),
    getBooleanInput: (name: unknown) => (actionInputs[String(name)] ?? "") === "true",
    setOutput: (name: unknown, value: unknown) => {
      outputs.push({ name: String(name), value });
    },
    saveState: (name: unknown, value: unknown) => {
      states.set(String(name), value);
    },
    getState: (name: unknown) => {
      const stored = states.get(String(name));
      return stored === undefined ? "" : String(stored);
    },
    startGroup: (name: unknown) => { logs.push(`::group::${String(name)}`); },
    endGroup: () => { logs.push("::endgroup::"); },
    group: async (name: unknown, fn: () => Promise<unknown>) => {
      logs.push(`::group::${String(name)}`);
      try {
        return await fn();
      } finally {
        logs.push("::endgroup::");
      }
    },
    setCommandEcho: () => {},
    toPosixPath: (input: unknown) => String(input).replaceAll("\\", "/"),
    toWin32Path: (input: unknown) => String(input).replaceAll("/", "\\"),
    toPlatformPath: (input: unknown) => String(input),
    platform: { platform: "linux", arch: "x64", isLinux: true, isMacOS: false, isWindows: false },
    summary: summaryStub(),
    markdownSummary: summaryStub(),
    // Present because production has them; throwing because a PR-hygiene
    // workflow that mutates the environment, the PATH, or the secret mask is
    // not something to characterise.
    exportVariable: coreDeny("exportVariable"),
    setSecret: coreDeny("setSecret"),
    addPath: coreDeny("addPath"),
    getIDToken: coreDeny("getIDToken"),
  };

  /**
   * Callable, like the real bindings — `github-script` passes `exec` and
   * `fetch` as functions, and an audit round used `typeof exec === "function"`
   * to detect the harness and return early, passing every test while doing
   * nothing in production. Being callable is the point; calling one still
   * throws, because this workflow has no business running a subprocess.
   */
  const forbidden = (name: string) => new Proxy(
    function forbiddenBinding() { throw new Error(`the script must not use ${name}`); },
    {
      get(target, key) {
        if (key === "name" || key === "length" || key === "prototype") {
          return Reflect.get(target, key);
        }
        throw new Error(`the script must not use ${name}`);
      },
      apply() { throw new Error(`the script must not use ${name}`); },
    },
  );

  const deferred: (() => unknown)[] = [];

  const returnValue = await compileScript(script)({
    github,
    // The pinned action passes the same client under both names. A mutation
    // that switches to `octokit.rest.pulls.update` must still be recorded.
    octokit: github,
    // Production injects a factory that mints a second, equally write-capable
    // client. It has to be callable and has to return a recording client —
    // otherwise `getOctokit(token).rest.pulls.update(...)` is an unrecorded
    // write here and a real one on the runner.
    getOctokit: (...args: unknown[]) => {
      calls.push({ method: "getOctokit", args });
      return github;
    },
    context,
    core,
    exec: forbidden("exec"),
    glob: forbidden("glob"),
    io: forbidden("io"),
    fetch: forbidden("fetch"),
    require: scopedRequire,
    __original_require__: scopedRequire,
    // `github-script` runs under Node. An audit round detected the harness with
    // `if (!process.versions.bun) return;` — a no-op in production, green here.
    // Shadow `process` with something that looks like the Node the workflow
    // actually gets, so a runtime probe cannot tell the two apart.
    ...nodeLikeRuntime(deferred),
  });

  // Run whatever the script deferred. Node would run these too, with the write
  // token still live, so their calls belong in the recording — a scenario that
  // asserts on the exact call list then sees them.
  for (const callback of deferred.splice(0)) {
    await callback();
  }

  return { calls, logs, warnings, returnValue, coreSurface: Object.keys(core).sort() };
}

/** Just the method names, in order — the usual thing to assert on. */
export function methodsOf(result: HarnessResult): string[] {
  return result.calls.map(call => call.method);
}

/** Every recorded call to one method. */
export function callsTo(result: HarnessResult, method: string): unknown[] {
  return result.calls.filter(call => call.method === method).map(call => call.args);
}
