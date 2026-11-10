import { DEFAULT_IDLE_AFTER_MS } from "../../link/child-activity";
import { createCatalogRevisionMonitor, type CatalogRevisionMonitor } from "../../link/child-catalog-freshness";
import { observeChild } from "../../link/child-observe";
import { patchChildObservation, readChildObservations, updateChildObservations } from "../../link/child-observations";
import { createChildOpsEngine, type ChildOpsEngine } from "../../link/child-ops-engine";
import { requireRemotePlatform } from "../../link/remote-platform";
import { inspectRemoteChildRuntime } from "../../link/remote-plant";
import { attachLinkChildOps, type LinkStatusDto } from "../../link/status-projection";
import type { LinkStore } from "../../link/store";
import { packageVersion } from "../../lib/package-version";
import { readCatalog, readCodexCatalogPath } from "../../codex/catalog";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { auth, exactBody, fail, knownHostsFile, readStoreFor, runnerFor, type LinkRouteState } from "./link-route-state";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const JOB_ID = /^ljob_[0-9a-f]{16}$/;
const MAX_LINK_IDS = 64;
const JOB_PATH = /^\/api\/link\/children\/jobs\/([^/]+)$/;

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

/** Exactly {op:"observe", linkIds: "all" | 1..64 distinct link ids}; wp2 admits no other op or key. */
export function parseOperation(body: unknown): { op: "observe"; linkIds: readonly string[] | "all" } | null {
  const value = exactBody(body, ["op", "linkIds"]);
  if (!value || value.op !== "observe") return null;
  if (value.linkIds === "all") return { op: "observe", linkIds: "all" };
  if (!Array.isArray(value.linkIds) || value.linkIds.length === 0 || value.linkIds.length > MAX_LINK_IDS) return null;
  if (!value.linkIds.every(id => typeof id === "string" && LINK_ID.test(id))) return null;
  if (new Set(value.linkIds).size !== value.linkIds.length) return null;
  return { op: "observe", linkIds: value.linkIds as string[] };
}

/** One engine per route state: the per-link lock and the job registry are this Home process's. */
export function childOpsEngineFor(ctx: ManagementContext, state: LinkRouteState): ChildOpsEngine {
  const now = () => new Date((ctx.deps.now ?? Date.now)());
  return state.childOps ??= createChildOpsEngine({
    readStore: () => readStoreFor(ctx),
    observe: record => {
      const runner = runnerFor(ctx);
      const hosts = knownHostsFile(ctx);
      return observeChild(record, {
        runner, knownHostsFile: hosts, homeVersion: packageVersion("0.0.0"),
        peer: linkId => state.listener.peerObservation?.(linkId) ?? { observed: null, refused: null },
        platformOf: link => requireRemotePlatform(runner, link.alias, hosts),
        inspect: inspectRemoteChildRuntime, now,
      });
    },
    writeObservation: (linkId, patch) => { updateChildObservations(file => patchChildObservation(file, linkId, patch, now())); },
    now,
  });
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
    activeJob: linkId => state.childOps?.activeJob(linkId) ?? null,
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
    if (!operation) return fail("invalid_body", "The body must be exactly {op:\"observe\", linkIds}.", 400);
    let result: ReturnType<ChildOpsEngine["submit"]>;
    try {
      result = childOpsEngineFor(ctx, state).submit({ ...operation, trigger: "manual" });
    } catch { return fail("link_unavailable", "The link store could not be read.", 503); }
    if (result.ok) return Response.json({ job: result.job }, { status: 202, headers: { "cache-control": "no-store" } });
    if (result.code === "link_not_found") return fail("link_not_found", "The link was not found.", 404);
    if (result.code === "link_operation_in_progress") return fail("link_operation_in_progress", "Another operation is running on this link.", 409);
    return fail("no_eligible_links", "There is no link to operate on.", 409);
  }
  const jobPath = req.method === "GET" ? JOB_PATH.exec(path) : null;
  if (jobPath) {
    let jobId: string;
    try { jobId = decodeURIComponent(jobPath[1]!); } catch { return fail("invalid_job_id", "The job id is invalid.", 400); }
    if (!JOB_ID.test(jobId)) return fail("invalid_job_id", "The job id is invalid.", 400);
    const job = state.childOps?.job(jobId);
    if (!job) return fail("job_not_found", "The job was not found.", 404);
    return Response.json({ job }, { headers: { "cache-control": "no-store" } });
  }
  return fail("not_found", "Not found.", 404);
}
