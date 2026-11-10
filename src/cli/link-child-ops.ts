import type { ChildItemState, ChildJob, ChildJobItem } from "../link/child-ops-engine";
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
export const NO_ELIGIBLE_LINKS_MESSAGE = "This Home has no Home-initiated links to operate on.";
export const RUNTIME_ROLE_CLIENT_MESSAGE = "This machine is a Child; run Child operations on its Home.";
const CONFLICT_MESSAGES: Readonly<Record<string, string>> = {
  no_eligible_links: NO_ELIGIBLE_LINKS_MESSAGE,
  runtime_role_client: RUNTIME_ROLE_CLIENT_MESSAGE,
};

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const JOB_ID = /^ljob_[0-9a-f]{16}$/;
const SUCCESS: ReadonlySet<string> = new Set<ChildItemState>(["succeeded", "up-to-date"]);
const PARTIAL: ReadonlySet<string> = new Set<ChildItemState>(["busy", "offline", "refused", "owner-action", "unsupported"]);

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

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
      item[key] = { [field]: text(nested[field], `item ${index} ${key}.${field}`),
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

/** D15: 0 every item succeeded or up-to-date; 6 any item needs the operator; 1 any failure or an unknown state. */
export function linkCheckExitCode(job: ChildJob): number {
  let code = 0;
  for (const item of job.items) {
    if (SUCCESS.has(item.state)) continue;
    if (PARTIAL.has(item.state)) code = Math.max(code, 6);
    else return 1;
  }
  return code;
}

function readJob(response: unknown): ChildJob {
  if (!isRecord(response) || Object.keys(response).length !== 1 || !("job" in response)) throw new Error("invalid link API response: job envelope");
  return validateChildJob(response.job);
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
  let job: ChildJob;
  try {
    job = readJob(await request<unknown>("/api/link/children/operations", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "observe", linkIds: all ? "all" : linkIds }),
    }, deps));
  } catch (error) {
    // A new Home answers link_not_found for a mistyped id; an older Home has no such route at all.
    if (error instanceof RuntimeApiError && error.status === 404) {
      const body = error.body as { error?: { code?: unknown } } | null;
      if (body?.error?.code !== "link_not_found") throw new RuntimeApiError(OLD_HOME_MESSAGE, 404, error.body);
    }
    // Every 409 still exits 5; the conflicts that are not "another operation holds the link" say what happened.
    if (error instanceof RuntimeApiError && error.status === 409) {
      const code = (error.body as { error?: { code?: unknown } } | null)?.error?.code;
      const message = typeof code === "string" && Object.hasOwn(CONFLICT_MESSAGES, code) ? CONFLICT_MESSAGES[code] : undefined;
      if (message) throw new RuntimeApiError(message, 409, error.body);
    }
    throw error;
  }
  if (noWait) {
    console.log(JSON.stringify(job));
    return job.state === "done" ? linkCheckExitCode(job) : 0;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + Math.ceil(job.items.length / 3) * 120_000 + 30_000;
  while (job.state !== "done") {
    if (now() >= deadline) {
      console.log(JSON.stringify(job));
      console.error(`Error: job_still_running: ${job.jobId} has not finished; read it again with GET /api/link/children/jobs/${job.jobId}.`);
      return 1;
    }
    await sleep(LINK_CHECK_POLL_MS);
    job = readJob(await request<unknown>(`/api/link/children/jobs/${encodeURIComponent(job.jobId)}`, {}, deps));
  }
  console.log(JSON.stringify(job));
  return linkCheckExitCode(job);
}
