import { DEFAULT_IDLE_AFTER_MS, isLinkIdle } from "../../link/child-activity";
import { createCatalogRevisionMonitor, type CatalogRevisionMonitor } from "../../link/child-catalog-freshness";
import { observeChild } from "../../link/child-observe";
import { patchChildObservation, readChildObservations, updateChildObservations } from "../../link/child-observations";
import { sharedChildOpsEngine, type ChildOpsEngine, type SubmitRefusal, type SubmitResult } from "../../link/child-ops-engine";
import { CHILD_OPS, type ChildOp, type ChildOpsEnv, type ChildRestart } from "../../link/child-ops-types";
import { requireRemotePlatform } from "../../link/remote-platform";
import { inspectRemoteChildRuntime } from "../../link/remote-plant";
import { attachLinkChildOps, projectLinkStatus, type LinkStatusDto } from "../../link/status-projection";
import type { LinkStore } from "../../link/store";
import { packageVersion } from "../../lib/package-version";
import { readCatalog, readCodexCatalogPath } from "../../codex/catalog";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { auth, fail, isRecord, knownHostsFile, readStoreFor, runnerFor, type LinkRouteState } from "./link-route-state";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const JOB_ID = /^ljob_[0-9a-f]{16}$/;
const MAX_LINK_IDS = 64;
const JOB_PATH = /^\/api\/link\/children\/jobs\/([^/]+)$/;
const NO_STORE = { "cache-control": "no-store" };

let revisionMonitor: CatalogRevisionMonitor | undefined;

/**
 * The production Home catalog revision: the exact bytes `/v1/catalog` serves, hashed like its etag, with the
 * revision persisted as `homeCatalog` in child-observations.json. Created lazily on the first `?children=1` read.
 */
export function catalogRevisionForRoutes(): CatalogRevisionMonitor {
  return revisionMonitor ??= createCatalogRevisionMonitor({
    catalogPath: () => readCodexCatalogPath(),
    read: path => {
      const catalog = readCatalog(path);
      return catalog ? JSON.stringify(catalog) : null;
    },
    load: () => readChildObservations().homeCatalog,
    persist: revision => { updateChildObservations(file => { file.homeCatalog = revision; }); },
  });
}

/**
 * One engine per Home process (Revision 5). wp2 kept one per route state, which link-routes.ts keys by the config
 * object, so a config reload started a second engine without the first one's locks, and the wp5 scheduler must submit
 * to the engine the routes read. state.childOps stays the seam a direct test can set.
 */
export function childOpsEngineFor(state: LinkRouteState): ChildOpsEngine {
  return state.childOps ??= sharedChildOpsEngine();
}

const errorName = (error: unknown): string => error instanceof Error ? error.name : "unknown";

/** The env captures this request's seams for the job's lifetime; every read is live. wp5 passes the policy idleAfterMs. */
export function childOpsEnvFor(ctx: ManagementContext, state: LinkRouteState, idleAfterMs = DEFAULT_IDLE_AFTER_MS): ChildOpsEnv {
  const now = ctx.deps.now ?? Date.now;
  const runner = runnerFor(ctx);
  const hosts = knownHostsFile(ctx);
  const homeVersion = packageVersion("0.0.0");
  return {
    readStore: () => readStoreFor(ctx),
    runner, knownHostsFile: hosts, homeVersion, now,
    // The wire state the status route reports, including a recorded compensation failure.
    wireState: linkId => {
      if (state.compensationFailures?.has(linkId)) return "failed";
      return projectLinkStatus(readStoreFor(ctx), state.supervisor.status(), state.listener.status(), ctx.config)
        .links.find(link => link.id === linkId)?.state ?? null;
    },
    activity: linkId => {
      const snapshot = state.listener.linkActivity?.(linkId, now());
      return snapshot ? { inFlight: snapshot.inFlight, idle: isLinkIdle(snapshot, now(), idleAfterMs) } : null;
    },
    sleep: ms => Bun.sleep(ms),
    // wp2's observe deps, unchanged: the peer and activity listeners are optional on LinkRouteListener.
    observe: record => observeChild(record, { runner, knownHostsFile: hosts, homeVersion,
      peer: linkId => state.listener.peerObservation?.(linkId) ?? { observed: null, refused: null },
      platformOf: link => requireRemotePlatform(runner, link.alias, hosts),
      inspect: inspectRemoteChildRuntime, now: () => new Date(now()) }),
    readObservation: linkId => readChildObservations().children[linkId] ?? null,
    // Never throws into a runner: a cache write failure is logged by error name (ChildOpsEnv contract).
    writeObservation: (linkId, patch) => {
      try { updateChildObservations(file => patchChildObservation(file, linkId, patch, new Date(now()))); }
      catch (error) { console.warn(`[link] child observation write failed linkId=${linkId} error=${errorName(error)}`); }
    },
    // Revision 4: wp2's monitor on LinkRouteState.catalogRevision (catalogEtag hashing); null when the catalog cannot be read.
    catalogEtag: () => {
      try { return (state.catalogRevision ??= catalogRevisionForRoutes()).current()?.etag ?? null; } catch { return null; }
    },
  };
}

export interface ParsedOperation { op: ChildOp; linkIds: string[] | "all"; restart: ChildRestart }

/**
 * Exactly {op, linkIds, restart?}. A2 / M8: any request that carries a restart (sync with restart, or restart-codex,
 * whose restart defaults to app-server) must name its links; "all" is accepted only when restart is "none".
 * Scope (audit r2 R6): this rule binds this API route and the ocx link verbs only; ocx sync --restart-children (040)
 * and the automatic restart policy (050) select links themselves and apply the same run-time activity check.
 * No body can set trigger: the route always submits manual operations.
 */
export function parseOperation(body: unknown): ParsedOperation | null {
  if (!isRecord(body) || Object.keys(body).some(key => key !== "op" && key !== "linkIds" && key !== "restart")) return null;
  if (!(CHILD_OPS as readonly unknown[]).includes(body.op)) return null;
  const op = body.op as ChildOp;
  if (body.restart !== undefined && body.restart !== "app-server" && body.restart !== "codex") return null;
  if (body.restart !== undefined && op === "observe") return null;
  const restart: ChildRestart = op === "restart-codex" ? (body.restart as ChildRestart | undefined) ?? "app-server"
    : (body.restart as ChildRestart | undefined) ?? "none";
  const ids = body.linkIds;
  let linkIds: string[] | "all";
  if (ids === "all" && restart === "none") linkIds = "all";
  else if (Array.isArray(ids) && ids.length >= 1 && ids.length <= MAX_LINK_IDS
    && ids.every(id => typeof id === "string" && LINK_ID.test(id)) && new Set(ids).size === ids.length) linkIds = [...ids as string[]];
  else return null;
  return { op, linkIds, restart };
}

function refusal(code: SubmitRefusal): Response {
  switch (code) {
    case "link_not_found": return fail(code, "The link was not found.", 404);
    case "link_not_home_initiated": return fail(code, "Only a Home-initiated link can be operated from this computer.", 409);
    case "link_operation_in_progress": return fail(code, "Another operation is running on this link.", 409);
    // Returned only when links.json has no link at all, so the message says exactly that.
    case "no_eligible_links": return fail(code, "This Home has no links.", 409);
  }
}

/** `?children=1` on a Home: attach every row's `child` block. Never fails on the cache or the revision save. */
export function attachLinkChildOpsForState(dto: LinkStatusDto, state: LinkRouteState, store: LinkStore, now: number = Date.now()): LinkStatusDto {
  // A pull inside the recorder's write window would otherwise reach the file only at the next pull or at shutdown.
  // Best effort: a lock failure is logged by the recorder and retried later; the status read never fails on it.
  state.listener.flushCatalogPulls?.();
  const revision = (state.catalogRevision ??= catalogRevisionForRoutes()).current();
  const observations = readChildObservations();
  const known = new Set(store.links.map(link => link.id));
  return attachLinkChildOps(dto, {
    homeVersion: packageVersion("0.0.0"), now, idleAfterMs: DEFAULT_IDLE_AFTER_MS, revision,
    peerVersion: linkId => state.listener.peerObservation?.(linkId).observed?.version ?? null,
    observation: linkId => known.has(linkId) ? observations.children[linkId] ?? null : null,
    activity: linkId => state.listener.linkActivity?.(linkId, now) ?? null,
    catalogPull: linkId => state.listener.catalogPull?.(linkId) ?? null,
    // The shared engine: a job the wp5 scheduler started shows on a status read that never submitted one.
    activeJob: linkId => childOpsEngineFor(state).activeJob(linkId),
  });
}

export async function handleLinkChildOpsRoutes(ctx: ManagementContext, state: LinkRouteState): Promise<Response | null> {
  const { url, req } = ctx;
  const path = url.pathname;
  const denied = auth(ctx, "either");
  if (denied) return denied;
  if (url.pathname === "/api/link/children/operations" && req.method === "POST") {
    if (ctx.config.runtimeRole === "client") return fail("runtime_role_client", "A Child runtime does not operate other Children.", 409);
    const operation = parseOperation(await readManagementJsonBodyOr(req, null));
    if (!operation) return fail("invalid_body", "The body must be exactly {op, linkIds, restart?}; restart is app-server or codex and needs explicit linkIds.", 400);
    let result: SubmitResult;
    try { result = childOpsEngineFor(state).submit({ ...operation, trigger: "manual" }, childOpsEnvFor(ctx, state)); }
    catch { return fail("link_unavailable", "The link store could not be read.", 503); }
    return result.ok ? Response.json({ job: result.job }, { status: 202, headers: NO_STORE }) : refusal(result.code);
  }
  const jobPath = req.method === "GET" ? JOB_PATH.exec(path) : null;
  if (jobPath) {
    let jobId: string;
    try { jobId = decodeURIComponent(jobPath[1]!); } catch { return fail("invalid_job_id", "The job id is invalid.", 400); }
    if (!JOB_ID.test(jobId)) return fail("invalid_job_id", "The job id is invalid.", 400);
    const job = childOpsEngineFor(state).job(jobId);
    if (!job) return fail("job_not_found", "The job was not found.", 404);
    return Response.json({ job }, { headers: NO_STORE });
  }
  return fail("not_found", "Not found.", 404);
}
