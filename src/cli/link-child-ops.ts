import type { ChildItemState, ChildJob, ChildJobItem, ChildOp } from "../link/child-ops-types";
import { CliUsageError, RuntimeApiError, rejectArgs, takeFlag, takeJsonFlag, takeOption } from "./runtime-api";
import type { LinkCliDeps } from "./link";

type LinkRequest = <T>(path: string, init: RequestInit, deps: LinkCliDeps) => Promise<T>;

export interface LinkCheckDeps extends LinkCliDeps {
  /** Test seams for the job poll. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const LINK_CHECK_POLL_MS = 2_000;
export const OLD_HOME_MESSAGE = "This Home does not support Child operations; update the Home.";
export const NO_ELIGIBLE_LINKS_MESSAGE = "This Home has no links.";
export const RUNTIME_ROLE_CLIENT_MESSAGE = "This machine is a Child; run Child operations on its Home.";
export const LINK_NOT_HOME_INITIATED_MESSAGE = "This link was started from the Child, so the Home cannot run operations on it.";
export const LINK_OPERATION_IN_PROGRESS_MESSAGE = "Another operation is running on this link; wait for it to finish, then try again.";
export const LOOPBACK_REQUIRED_MESSAGE = "Child operations from the CLI need a Home bound to loopback; on this Home they are not available, and the dashboard has no controls for them.";
const CONFLICT_MESSAGES: Readonly<Record<string, string>> = {
  no_eligible_links: NO_ELIGIBLE_LINKS_MESSAGE,
  runtime_role_client: RUNTIME_ROLE_CLIENT_MESSAGE,
  link_not_home_initiated: LINK_NOT_HOME_INITIATED_MESSAGE,
  link_operation_in_progress: LINK_OPERATION_IN_PROGRESS_MESSAGE,
};

/** How long one item may run once it has started: the sum of its runner's own SSH bounds plus a margin. */
export const CHILD_ITEM_WAIT_MS: Readonly<Record<ChildOp, number>> = {
  observe: 120_000,                 // wp2's value: one 60 s plan probe, one read-only inspection
  sync: 420_000,                    // platform probe 30 s + two pinned syncs of 180 s
  "restart-codex": 420_000,
  update: 2_100_000,                // probe 30 s + identity sync 180 s + plan 60 s + apply 900 s + 120 s grace
                                    // + post-update sync with retry 2 × 360 s + 30 s
};
/** Never poll longer than this from submission, queued or not; the Home keeps a finished job one hour. */
export const CHILD_JOB_WAIT_CAP_MS = 10_800_000;

export type LinkChildVerb = "update" | "sync" | "restart-codex";
export const LINK_CHILD_OPS_USAGE = [
  "  ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]",
  "  ocx link sync (--link-id <id> | --all) [--no-wait] [--json]",
  "  ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]",
  "  ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]",
] as const;

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const JOB_ID = /^ljob_[0-9a-f]{16}$/;
const SUCCESS: ReadonlySet<string> = new Set<ChildItemState>(["succeeded", "up-to-date"]);
const PARTIAL: ReadonlySet<string> = new Set<ChildItemState>(["busy", "offline", "refused", "owner-action", "unsupported"]);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const errorCode = (error: RuntimeApiError): unknown => (error.body as { error?: { code?: unknown } } | null)?.error?.code;

/**
 * Read an `ocx.link.child-job/1` document. Tolerant from its first release (G1, audit H5): known keys are type-checked,
 * unknown keys at job, item, `sync` and `restart` level are dropped, and an unknown string in an enum field is kept
 * for display, so this CLI keeps polling a later Home whose items carry more. A known key of the wrong type throws.
 */
export function validateChildJob(value: unknown): ChildJob {
  const fail = (field: string): never => { throw new Error(`invalid link API response: job ${field}`); };
  const text = (target: unknown, field: string): string => typeof target === "string" && target.length <= 256 ? target : fail(field);
  const nullableText = (target: unknown, field: string): string | null => target === null ? null : text(target, field);
  if (!isRecord(value)) return fail("object");
  if (value.schema !== "ocx.link.child-job/1") fail("schema");
  if (!Array.isArray(value.items)) fail("items");
  const jobId = text(value.jobId, "jobId");
  if (!JOB_ID.test(jobId)) fail("jobId");
  const items = (value.items as unknown[]).map((raw, index): ChildJobItem => {
    if (!isRecord(raw)) return fail(`item ${index}`);
    const item: ChildJobItem & Record<string, unknown> = {
      linkId: text(raw.linkId, `item ${index} linkId`), alias: text(raw.alias, `item ${index} alias`),
      state: text(raw.state, `item ${index} state`) as ChildItemState, reason: nullableText(raw.reason, `item ${index} reason`),
      startedAt: nullableText(raw.startedAt, `item ${index} startedAt`), finishedAt: nullableText(raw.finishedAt, `item ${index} finishedAt`),
    };
    if (raw.hint !== undefined) item.hint = text(raw.hint, `item ${index} hint`);
    if (raw.fromVersion !== undefined) item.fromVersion = text(raw.fromVersion, `item ${index} fromVersion`);
    if (raw.toVersion !== undefined) item.toVersion = text(raw.toVersion, `item ${index} toVersion`);
    for (const key of ["sync", "restart"] as const) {
      if (raw[key] === undefined || raw[key] === null) continue;
      const nested = raw[key];
      if (!isRecord(nested)) return fail(`item ${index} ${key}`);
      const field = key === "sync" ? "state" : "outcome";
      // Open enum strings are kept for display, so the nested shape is only checked for strings here.
      (item as Record<string, unknown>)[key] = { [field]: text(nested[field], `item ${index} ${key}.${field}`),
        // A wp3 Home always sends restart.requested; an older document may not.
        ...(key === "restart" && nested.requested !== undefined ? { requested: text(nested.requested, `item ${index} restart.requested`) } : {}),
        ...(nested.reason === undefined ? {} : { reason: nullableText(nested.reason, `item ${index} ${key}.reason`) }) };
    }
    return item;
  });
  return {
    schema: "ocx.link.child-job/1", jobId, op: text(value.op, "op") as ChildJob["op"], trigger: text(value.trigger, "trigger") as ChildJob["trigger"],
    restart: text(value.restart, "restart") as ChildJob["restart"], state: text(value.state, "state") as ChildJob["state"],
    createdAt: text(value.createdAt, "createdAt"), finishedAt: nullableText(value.finishedAt, "finishedAt"), items,
  };
}

/**
 * D15: 0 every item succeeded or up-to-date with nothing withheld; 6 any item needs the operator; 1 any failure or an
 * unknown state. A success that carries a reason (restart-skipped:link-active, post-update-sync-failed,
 * restart-result-unknown) or whose requested restart did not go out is partial.
 */
export function linkCheckExitCode(job: ChildJob): number {
  let code = 0;
  for (const item of job.items) {
    if (SUCCESS.has(item.state)) {
      if (item.reason !== null || (item.restart !== undefined && item.restart.outcome !== "requested")) code = Math.max(code, 6);
      continue;
    }
    if (PARTIAL.has(item.state)) code = Math.max(code, 6);
    else return 1;
  }
  return code;
}

function readJob(response: unknown): ChildJob {
  if (!isRecord(response) || Object.keys(response).length !== 1 || !("job" in response)) throw new Error("invalid link API response: job envelope");
  return validateChildJob(response.job);
}

async function waitForChildJob(job: ChildJob, deps: LinkCheckDeps, request: LinkRequest): Promise<{ job: ChildJob; done: boolean }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const cap = now() + CHILD_JOB_WAIT_CAP_MS;
  const perItem = Object.hasOwn(CHILD_ITEM_WAIT_MS, job.op) ? CHILD_ITEM_WAIT_MS[job.op] : CHILD_ITEM_WAIT_MS.update;
  const lanes = job.op === "update" ? 1 : 3;
  const budget = (current: ChildJob): number =>
    Math.ceil(current.items.filter(item => item.finishedAt === null).length / lanes) * perItem + 30_000;
  let deadline = now() + budget(job);
  while (job.state !== "done") {
    // A queued item has not started its SSH work: while one waits behind another job, the deadline moves with it.
    if (job.items.some(item => item.state === "queued")) deadline = Math.max(deadline, now() + budget(job));
    if (now() >= Math.min(deadline, cap)) return { job, done: false };
    await sleep(LINK_CHECK_POLL_MS);
    job = readJob(await request<unknown>(`/api/link/children/jobs/${encodeURIComponent(job.jobId)}`, {}, deps));
  }
  return { job, done: true };
}

/** POST one operation, then wait for it unless told not to; prints the job document and returns the verdict exit. */
async function submitChildJob(body: { op: ChildOp; linkIds: string[] | "all"; restart?: "app-server" | "codex" }, wait: boolean,
  deps: LinkCheckDeps, request: LinkRequest): Promise<number> {
  let job: ChildJob;
  try {
    job = readJob(await request<unknown>("/api/link/children/operations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }, deps));
  } catch (error) {
    if (error instanceof RuntimeApiError) {
      // A new Home answers link_not_found for a mistyped id; an older Home has no such route at all.
      if (error.status === 404 && errorCode(error) !== "link_not_found") throw new RuntimeApiError(OLD_HOME_MESSAGE, 404, error.body);
      // Revision 6 F3: a Home with observe only (wp2) refuses every other op as invalid_body; this CLI always sends a valid body.
      if (error.status === 400 && body.op !== "observe" && errorCode(error) === "invalid_body") throw new RuntimeApiError(OLD_HOME_MESSAGE, 404, error.body);
      // Every 409 still exits 5; the conflicts that are not "another operation holds the link" say what happened.
      if (error.status === 409) {
        const code = errorCode(error);
        const message = typeof code === "string" && Object.hasOwn(CONFLICT_MESSAGES, code) ? CONFLICT_MESSAGES[code] : undefined;
        if (message) throw new RuntimeApiError(message, 409, error.body);
      }
      // Revision 4 (4529521950): a Home not bound to loopback refuses the admin token on its TCP listener.
      if (error.status === 403) throw new RuntimeApiError(LOOPBACK_REQUIRED_MESSAGE, 403, error.body);
    }
    throw error;
  }
  if (!wait) {
    console.log(JSON.stringify(job));
    return job.state === "done" ? linkCheckExitCode(job) : 0;
  }
  const waited = await waitForChildJob(job, deps, request);
  console.log(JSON.stringify(waited.job));
  if (!waited.done) {
    console.error(`Error: job_still_running: ${waited.job.jobId} has not finished; read it again with GET /api/link/children/jobs/${waited.job.jobId}.`);
    return 1;
  }
  return linkCheckExitCode(waited.job);
}

/** `ocx link check (--link-id <id> | --all) [--no-wait] [--json]`: run the observe operation and return the exit code. */
export async function runLinkCheck(args: string[], deps: LinkCheckDeps, request: LinkRequest, usage: string): Promise<number> {
  takeJsonFlag(args);
  const all = takeFlag(args, "--all");
  const noWait = takeFlag(args, "--no-wait");
  const linkIds: string[] = [];
  for (let id = takeOption(args, "--link-id"); id !== undefined; id = takeOption(args, "--link-id")) {
    if (!LINK_ID.test(id)) throw new CliUsageError("check requires valid --link-id values", usage);
    if (!linkIds.includes(id)) linkIds.push(id);
  }
  rejectArgs(args, usage);
  if (all === (linkIds.length > 0)) throw new CliUsageError("check requires --link-id <id> or --all, not both", usage);
  if (linkIds.length > 64) throw new CliUsageError("check accepts at most 64 --link-id values", usage);
  return submitChildJob({ op: "observe", linkIds: all ? "all" : linkIds }, !noWait, deps, request);
}

export function parseChildOpArgs(verb: LinkChildVerb, args: string[], usage: string):
  { body: { op: LinkChildVerb; linkIds: string[] | "all"; restart?: "app-server" | "codex" }; wait: boolean } {
  takeJsonFlag(args);
  const noWait = takeFlag(args, "--no-wait");
  const all = takeFlag(args, "--all");
  const yes = takeFlag(args, "--yes");
  // Repeatable like ocx link check; a restart needs exactly one.
  const linkIds: string[] = [];
  for (let id = takeOption(args, "--link-id"); id !== undefined; id = takeOption(args, "--link-id")) {
    if (!LINK_ID.test(id)) throw new CliUsageError(`${verb} requires valid --link-id values`, usage);
    if (!linkIds.includes(id)) linkIds.push(id);
  }
  let restart: "app-server" | "codex" | undefined;
  if (verb === "sync") {
    const narrow = takeFlag(args, "--restart-app-server-only");
    const full = takeFlag(args, "--restart-codex");
    if (narrow && full) throw new CliUsageError("choose one of --restart-app-server-only and --restart-codex", usage);
    restart = narrow ? "app-server" : full ? "codex" : undefined;
  }
  if (verb === "restart-codex") {
    const scope = takeOption(args, "--scope") ?? "app-server";
    if (scope !== "app-server" && scope !== "codex") throw new CliUsageError("--scope must be app-server or codex", usage);
    if (!yes) throw new CliUsageError("restart-codex ends running Codex turns on the Child; pass --yes", usage);
    restart = scope;
  }
  rejectArgs(args, usage);
  if (all === (linkIds.length > 0)) throw new CliUsageError(`${verb} requires --link-id <id> or --all, not both`, usage);
  if (linkIds.length > 64) throw new CliUsageError(`${verb} accepts at most 64 --link-id values`, usage);
  // Revision 6 F5: an update stops the Child's runtime and ends the turns relayed for it, so it is confirmed like a restart.
  if (verb === "update" && !yes) throw new CliUsageError("update restarts OpenCodex on each Child and ends its running turns; pass --yes", usage);
  // A2 / M8: a restart names one link, and the codex scope (quit and relaunch the desktop app) needs --yes on every verb.
  if (restart !== undefined && (all || linkIds.length !== 1)) throw new CliUsageError(`${verb} with a restart needs exactly one --link-id; --all is refused`, usage);
  if (restart === "codex" && !yes) throw new CliUsageError("--restart-codex quits the Child's Codex app and ends its turns; pass --yes", usage);
  if (yes && restart === undefined && verb !== "update") throw new CliUsageError("--yes only confirms a restart or an update", usage);
  return { body: { op: verb, linkIds: all ? "all" : linkIds, ...(restart ? { restart } : {}) }, wait: !noWait };
}

/** `ocx link update|sync|restart-codex`: one job over the link's pinned SSH trust; prints it and returns the verdict exit. */
export async function runLinkChildOp(verb: LinkChildVerb, args: string[], deps: LinkCheckDeps, request: LinkRequest, usage: string): Promise<number> {
  const parsed = parseChildOpArgs(verb, args, usage);
  return submitChildJob(parsed.body, parsed.wait, deps, request);
}
