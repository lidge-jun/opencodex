# 060 — Dashboard: Child versions, actions, Update all and the policy panel

> **Revision 2 (audit r1).** Folds M10 (the Update and Update all confirmations say a manual update ends any turn
> relayed for that Child and that automatic updates wait for idle; new key `remoteLink.child.updateConfirm`), H4 (a
> Windows Desktop Child updates through the request route once Home and Child run 080), M6 (`ChildOp` here is the GUI
> wire mirror of 010's type), A2 (restart outcome `skipped` gets a label) and L17 (the TSX component bodies and the
> page wiring are outlines, marked below, to be made diff-level at this phase's own P).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529522073 (the wire union gains `skipped`, the producer's value from 030;
> an unknown outcome renders as `<code>` text, never as `requested`, matching test 6 and H5), 4529522080 (the page
> discovers running jobs from the status rows' `activeJob` and tracks every active job, including automatic ones and
> after a reload) and 4529522094 (a 404 `job_not_found` is exposed by the hook, shown with its message, and refreshes
> status without calling the operation failed; new key `remoteLink.job.notFound`).

> **Revision 5 (wp6 P re-verification, base dev `de0914a1a83b`).** Makes the L17 residual diff-level: the API module,
> the action components and the page wiring below carry concrete bodies instead of exports with prose. Corrects claims
> against the merged tree: `ChildRestartOutcome` has **four** values (`requested | unsupported | not-run | skipped`;
> 030 ships all four and 080 has not landed), `LinkChildOpsStatus.codex` is `null` on this base, the policy panel uses
> `Select` from `gui/src/ui.tsx` (a native `<select>` fails `tests/form-controls-rule.test.ts`), the guide's operating
> section is "Operating Children from the Home" (`:225`), not "Link status" (`:66`), and `remote-link.test.tsx` is
> 1,297 lines. Folds 4533270262: the restart-protection paragraph must tell the operator to wait for active Codex
> turns to finish, because a turn running a tool has no relayed request in flight to trip the activity check.

- **Work phase:** wp6
- **Depends on:** wp3 (`POST /api/link/children/operations`, `GET /api/link/children/jobs/{jobId}`, the
  `ocx.link.child-job/1` document, `link_operation_in_progress` on DELETE; 030), wp5 (`GET/PUT
  /api/link/children/policy` answering `{ policy, warning }`; 050 §2.7), wp2 (the `child` block under
  `?children=1`; 020). It renders wp7's "Update available" and wp8's `child.codex`/`childBuild` when present;
  an absent field renders nothing.
- **Class:** C3 (GUI over existing contracts; no new server route). The screenshot and 11 locales are gates.

**Outcome.** On a Home, each Remote Link row shows the Child's version and install kind, whether it is
behind, ahead or level with the Home, whether its catalog is current, whether its Codex needs a restart,
and the last operation. Home-initiated rows get **Check**, **Sync now**, **Restart Codex** (with a scope
choice that says plainly that the app-server scope does not refresh the Codex desktop app's own
app-server) and **Update**. The list gets **Check all** and **Update all**, a progress panel for the
running job, and a policy panel for catalog fan-out, Codex restart and updates. Older Homes, which do
not send `child`, render exactly as today.

**IN:** `gui/src/remote-link-child-ops-api.ts`, `gui/src/pages/RemoteLinkChildActions.tsx`, the
`RemoteLink.tsx` wiring, six error codes plus one remapped key, every key in the locale table below in all 11 catalogs, one sibling GUI test file, the
guide section (including the 4533270262 restart wording) in English and 7 translations, the structure note.
**OUT:** server or CLI changes; Child-side (Child role) rendering beyond today's row; new design tokens.

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| `gui/src/remote-link-child-ops-api.ts` | NEW | Wire types, tolerant parsers, request helpers, pure view helpers. |
| `gui/src/pages/RemoteLinkChildActions.tsx` | NEW | `ChildRowBadges`, `ChildRowActions`, `RestartCodexDialog`, `ChildBulkBar`, `ChildJobProgress`, `ChildPolicyPanel`, `useChildJob`. |
| `gui/src/remote-link-api.ts` | MODIFY :1-46, :69-79, :140-160 | Six error codes, `link_not_home_initiated` gets its own key; `LinkRowWire.child`; parse `item.child`; export `isRecord` (:118). |
| `gui/src/pages/RemoteLink.tsx` | MODIFY :48-94, :156, :209, :438-441, :525-548, :565-570 | `ERROR_TKEY` entries, `children=1` query, `childJobs` state and recovery, row badges/actions, bulk bar, progress, policy panel, Disconnect disabled while a job holds the row. |
| `gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr,vi,pt}.ts` | MODIFY | New `remoteLink.child.*`, `remoteLink.job.*`, `remoteLink.policy.*`, `remoteLink.error.*` keys. |
| `gui/tests/remote-link-child-ops.test.tsx` | NEW | Behaviour tests (sibling of the 1,297-line `remote-link.test.tsx`). |
| `gui/tests/remote-link.test.tsx` | MODIFY :60-73 | Scan `link-child-ops-routes` and the `refusal()` switch (030 deviation 5). |
| `docs-site/src/content/docs/guides/remote-link.md` + `fr/ ja/ ko/ ru/ tr/ zh-cn/ zh-tw/` copies | MODIFY at the end of "Operating Children from the Home" (:225-237), plus :233 in all eight | "Child versions and actions" section; 4533270262 restart wording; replace "the dashboard has no controls" (:235). |
| `structure/remote-link.md` | MODIFY :49 "Dashboard presentation" | Badges, actions, policy panel, `?children=1`. |

## Changes

### `gui/src/remote-link-child-ops-api.ts` (NEW)
```ts
import { isRecord, requestLinkJson } from "./remote-link-api";   // `isRecord` becomes an export of remote-link-api.ts

export type ChildInstallKind = "npm" | "pnpm" | "bun" | "source" | "mise" | "desktop-app" | "goat" | "standalone" | "ocx-child" | "unknown";
export const CHILD_INSTALL_KINDS: readonly ChildInstallKind[] = ["npm", "pnpm", "bun", "source", "mise", "desktop-app", "goat", "standalone", "ocx-child", "unknown"];
export type ChildUpdateRoute = "orchestrated" | "desktop-request" | "owner-action" | "replant" | "none";
/** Wire mirror of src/link/child-observations.ts `ChildOp` (000 "Canonical names"); gui/ cannot import src/. */
export const CHILD_OPS = ["observe", "sync", "restart-codex", "update"] as const;
export type ChildOp = typeof CHILD_OPS[number];
/** src/link/child-ops-types.ts `CHILD_ITEM_STATES` (11). */
export const CHILD_ITEM_STATES = ["queued", "running", "succeeded", "up-to-date", "busy", "offline", "refused",
  "owner-action", "unsupported", "failed", "uncertain"] as const;
export type ChildItemState = typeof CHILD_ITEM_STATES[number];
/** 030 ships exactly these four (child-ops-types.ts:24). 080 may widen it; an unknown value renders as <code>. */
export const CHILD_RESTART_OUTCOMES = ["requested", "unsupported", "not-run", "skipped"] as const;
export type ChildRestartOutcome = typeof CHILD_RESTART_OUTCOMES[number];

export interface ChildCodexView { appServers: "fresh" | "stale" | "not_running" | "unknown"; staleCount: number;
  catalogMatchesHome: boolean | null; catalogSyncedAt: number | null; reportedAt: number }
export interface ChildOpsRowView {
  homeVersion: string; runningVersion: string | null; installedVersion: string | null; installKind: ChildInstallKind | null;
  versionSkew: "same" | "behind" | "ahead" | "unknown";
  update: { route: ChildUpdateRoute | null; reason: string | null; observedAt: string | null };
  catalog: { state: "current" | "behind" | "unknown"; pulledAt: number | null; homeChangedAt: number | null };
  /** Always null on this base (status-projection.ts `LinkChildOpsStatus.codex` is typed `null`); 080 fills it. */
  codex: ChildCodexView | null; childBuild: string | null;
  activity: { idle: boolean; inFlight: number; lastDataEndAt: number | null };
  activeJob: { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
  lastOperation: { op: ChildOp; jobId: string; state: string; reason: string | null;
    fromVersion: string | null; toVersion: string | null; finishedAt: string | null } | null;
}
export interface ChildJobItemView { linkId: string; alias: string; state: string; reason: string | null; hint: string | null;
  fromVersion: string | null; toVersion: string | null;
  sync: { state: string; reason: string | null } | null;
  restart: { requested: string; outcome: string } | null }
export interface ChildJobView { jobId: string; op: ChildOp; trigger: "manual" | "auto"; restart: "none" | "app-server" | "codex";
  state: "queued" | "running" | "done"; items: ChildJobItemView[] }
export interface ChildPolicyView { catalogFanout: "auto" | "manual"; childCodexRestart: "never" | "app-server-when-idle";
  updates: "off" | "notify" | "auto-when-idle"; idleAfterMs: number }
export interface ChildPolicyReadView { policy: ChildPolicyView; warning: "policy-file-invalid" | null }
export interface ChildOperationBody { op: ChildOp; linkIds: string[] | "all"; restart?: "app-server" | "codex" }

const text = (v: unknown): string | null => typeof v === "string" && v.length > 0 && v.length <= 256 ? v : null;
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;
const member = <T extends string>(all: readonly T[], v: unknown): T | null => (all as readonly unknown[]).includes(v) ? v as T : null;

/** Tolerant: absent, or any key this build cannot type, yields null so the row renders exactly as today. */
export function parseChildOps(value: unknown): ChildOpsRowView | null {
  if (!isRecord(value)) return null;
  const homeVersion = text(value.homeVersion);
  const update = isRecord(value.update) ? value.update : null;
  const catalog = isRecord(value.catalog) ? value.catalog : null;
  const activity = isRecord(value.activity) ? value.activity : null;
  const job = isRecord(value.activeJob) ? value.activeJob : null;
  const last = isRecord(value.lastOperation) ? value.lastOperation : null;
  const codex = isRecord(value.codex) ? {
    appServers: member(["fresh", "stale", "not_running", "unknown"] as const, value.codex.appServers) ?? "unknown",
    staleCount: num(value.codex.staleCount) ?? 0,
    catalogMatchesHome: bool(value.codex.catalogMatchesHome),
    catalogSyncedAt: num(value.codex.catalogSyncedAt), reportedAt: num(value.codex.reportedAt) ?? 0,
  } : null;
  if (!homeVersion || !update || !catalog || !activity) return null;
  const op = member(CHILD_OPS, last?.op);
  return {
    homeVersion,
    runningVersion: text(value.runningVersion), installedVersion: text(value.installedVersion),
    installKind: member(CHILD_INSTALL_KINDS, value.installKind),
    versionSkew: member(["same", "behind", "ahead", "unknown"] as const, value.versionSkew) ?? "unknown",
    update: { route: member(["orchestrated", "desktop-request", "owner-action", "replant", "none"] as const, update.route),
      reason: text(update.reason), observedAt: text(update.observedAt) },
    catalog: { state: member(["current", "behind", "unknown"] as const, catalog.state) ?? "unknown",
      pulledAt: num(catalog.pulledAt), homeChangedAt: num(catalog.homeChangedAt) },
    codex, childBuild: text(value.childBuild),
    activity: { idle: activity.idle === true, inFlight: num(activity.inFlight) ?? 0, lastDataEndAt: num(activity.lastDataEndAt) },
    activeJob: job && text(job.jobId) && job.state !== "done" && member(CHILD_OPS, job.op)
      ? { jobId: text(job.jobId)!, op: member(CHILD_OPS, job.op)!, state: job.state === "queued" ? "queued" : "running" } : null,
    lastOperation: last && op && text(last.jobId) ? { op, jobId: text(last.jobId)!, state: text(last.state) ?? "failed",
      reason: text(last.reason), fromVersion: text(last.fromVersion), toVersion: text(last.toVersion), finishedAt: text(last.finishedAt) } : null,
  };
}

/** Strict on the fields it renders, open on the enum strings: an unknown state or outcome is kept and shown as <code>. */
export function parseChildJob(value: unknown): ChildJobView {
  if (!isRecord(value) || value.schema !== "ocx.link.child-job/1" || !text(value.jobId) || !Array.isArray(value.items)) throw new Error("invalid job");
  const op = member(CHILD_OPS, value.op);
  if (!op) throw new Error("invalid job op");
  return {
    jobId: text(value.jobId)!, op,
    trigger: value.trigger === "auto" ? "auto" : "manual",
    restart: member(["none", "app-server", "codex"] as const, value.restart) ?? "none",
    state: member(["queued", "running", "done"] as const, value.state) ?? "running",
    items: value.items.filter(isRecord).map(raw => {
      const sync = isRecord(raw.sync) ? { state: text(raw.sync.state) ?? "failed", reason: text(raw.sync.reason) } : null;
      const restart = isRecord(raw.restart) ? { requested: text(raw.restart.requested) ?? "app-server", outcome: text(raw.restart.outcome) ?? "" } : null;
      return { linkId: text(raw.linkId) ?? "", alias: text(raw.alias) ?? "", state: text(raw.state) ?? "failed",
        reason: text(raw.reason), hint: text(raw.hint), fromVersion: text(raw.fromVersion), toVersion: text(raw.toVersion), sync, restart };
    }),
  };
}

export function parseChildPolicyRead(value: unknown): ChildPolicyReadView {
  const policy = isRecord(value) && isRecord(value.policy) ? value.policy : null;
  const idle = policy ? num(policy.idleAfterMs) : null;
  if (!policy || idle === null) throw new Error("invalid policy");
  return {
    policy: {
      catalogFanout: member(["auto", "manual"] as const, policy.catalogFanout) ?? "manual",
      childCodexRestart: member(["never", "app-server-when-idle"] as const, policy.childCodexRestart) ?? "never",
      updates: member(["off", "notify", "auto-when-idle"] as const, policy.updates) ?? "off",
      idleAfterMs: idle,
    },
    warning: value !== null && isRecord(value) && value.warning === "policy-file-invalid" ? "policy-file-invalid" : null,
  };
}

const json = { "content-type": "application/json" };
export async function postChildOperation(apiBase: string, body: ChildOperationBody): Promise<ChildJobView> {
  const out = await requestLinkJson<{ job?: unknown }>(apiBase, "/api/link/children/operations", { method: "POST", headers: json, body: JSON.stringify(body) });
  return parseChildJob(out.job);
}
export async function getChildJob(apiBase: string, jobId: string, signal?: AbortSignal): Promise<ChildJobView> {
  const out = await requestLinkJson<{ job?: unknown }>(apiBase, `/api/link/children/jobs/${encodeURIComponent(jobId)}`, { signal });
  return parseChildJob(out.job);
}
export async function getChildPolicy(apiBase: string, signal?: AbortSignal): Promise<ChildPolicyReadView> {
  return parseChildPolicyRead(await requestLinkJson<unknown>(apiBase, "/api/link/children/policy", { signal }));
}
export async function putChildPolicy(apiBase: string, patch: Partial<ChildPolicyView>): Promise<ChildPolicyReadView> {
  return parseChildPolicyRead(await requestLinkJson<unknown>(apiBase, "/api/link/children/policy", { method: "PUT", headers: json, body: JSON.stringify(patch) }));
}

/** Pure view helpers (unit-tested directly). */
export function updateAvailable(row: ChildOpsRowView): boolean {
  return row.versionSkew === "behind" && (row.update.route === "orchestrated" || row.update.route === "desktop-request");
}
export function codexRestartNeeded(row: ChildOpsRowView): boolean {
  return row.codex !== null && (row.codex.appServers === "stale" || row.codex.catalogMatchesHome === false);
}
/** Badges and actions exist only where the Home can reach the Child: a Home-initiated link with its row. */
export function rowOperable(direction: "hub-initiated" | "client-initiated", row: ChildOpsRowView | null): boolean {
  return direction === "hub-initiated" && row !== null;
}
/** "Restart held: a turn was running" is the server's only withheld outcome, so it owns the one warning tone. */
export function restartWithheld(outcome: string): boolean { return outcome === "skipped"; }
export const CHILD_JOB_POLL_MS = 2_000;
```
CSRF and session headers come from the global fetch wrapper (`gui/src/api.ts:729-731` classifies `/api/**` as the shared
plane and adds them), as for every existing link POST; nothing here adds credentials. `LinkApiError` keeps the route's
code and status, which is what `ERROR_TKEY` and the job hook switch on.

### `gui/src/remote-link-api.ts`

`LINK_ERROR_CODES` (:1-46) is the closed list. Insert into its sorted position:
`"invalid_job_id"`, `"job_not_found"`, `"link_operation_in_progress"`, `"no_eligible_links"`, `"policy_write_failed"`
and `"runtime_role_client"`. `"link_not_home_initiated"` is already listed but `ERROR_TKEY` maps it to
`remoteLink.error.generic`; this phase gives it its own key. `"invalid_body"` and `"link_unavailable"` are already
there. The route's `not_found` fallback (:181) is a generic 404, not a child-operation code, and is not added.

`isRecord` (:116) becomes `export function isRecord`. `parseRemoteLinkStatus` (:140-160) adds a new import and one
line in the row mapper:
```ts
import { parseChildOps } from "./remote-link-child-ops-api";   // one-way: the child module imports back only isRecord/requestLinkJson
// inside .map(item => …), after appliedCodexSettingsDigest:
child: parseChildOps(item.child),
```
`LinkRowWire` (:69-79) gains `child?: ChildOpsRowView | null;` (as `import type { ChildOpsRowView } from
"./remote-link-child-ops-api"`). The value import `parseChildOps` and the type import in the other direction form the
usual ESM cycle Bun and Vite both handle here — `parseChildOps` is referenced inside a function body, never at module
top level.

### `gui/src/pages/RemoteLink.tsx`

Four edits, each a small diff; the page stays under the 2,000-line ratchet (610 today).

**Imports and state.** Add to the `./remote-link-child-ops-api` import the types `ChildJobView`; add
`import { ChildBulkBar, ChildJobProgress, ChildPolicyPanel, ChildRowActions, ChildRowBadges } from "./RemoteLinkChildActions";`
and `getChildJob` from the API module. `ERROR_TKEY` (:48-94) adds the six new codes:
`invalid_job_id`, `job_not_found`, `link_operation_in_progress`, `no_eligible_links`, `policy_write_failed`,
`runtime_role_client` → `remoteLink.error.<code>`, and `link_not_home_initiated` → `remoteLink.error.link_not_home_initiated`
(today it points at `generic`). The `busy` union (:156) gains `"child-op"` and `"policy"` so no two child requests race.

**`?children=1`** (:209): the URL becomes `"/api/link/status?children=1"`. `link-routes.ts:335` attaches rows only for
`role === "home"`; every other role, and a Home that predates wp2, answers the unchanged DTO, so `row.child` is
`undefined` and the page renders as today.

**Job tracking** — new state and a recovery effect, both keyed on what the status read reports:
```tsx
const [childJobs, setChildJobs] = useState<ChildJobView[]>([]);
const childJobIds = useRef(new Set<string>());

const trackJob = useCallback((job: ChildJobView) => {
  if (childJobIds.current.has(job.jobId)) return;
  childJobIds.current.add(job.jobId);
  setChildJobs(current => [...current, job]);
}, []);

const finishJob = useCallback((jobId: string) => {
  setChildJobs(current => current.filter(job => job.jobId !== jobId));
  void refreshStatus();                    // the rows now carry the observed result
}, [refreshStatus]);

// Revision 4 (4529522080): a job started before a reload, in another tab, or by the scheduler
// (trigger "auto") is still running; the status row names it, so adopt it once.
useEffect(() => {
  for (const row of status?.links ?? []) {
    const active = row.child?.activeJob;
    if (!active || childJobIds.current.has(active.jobId)) continue;
    childJobIds.current.add(active.jobId);
    getChildJob(apiBase, active.jobId)
      .then(job => setChildJobs(current => current.some(j => j.jobId === job.jobId) ? current : [...current, job]))
      .catch(() => { childJobIds.current.delete(active.jobId); });   // gone since the read; the next status poll retries
  }
}, [apiBase, status]);
```
`finishJob` runs once per job from `ChildJobProgress`'s `onDone`; `childJobIds` is not cleared on finish, so a stale
`activeJob` in an in-flight status response cannot resurrect the panel. Clearing it on a successful refresh is not
needed: a job id is never reused.

**Row and panel wiring.** In the row body (:525-548), after the parity badge and inside the same wrap flex:

```tsx
{row.child && <ChildRowBadges row={row.child} />}
```

and immediately before the Disconnect `<Button>`:
```tsx
{row.child && row.direction === "hub-initiated" && (
  <ChildRowActions apiBase={apiBase} link={row} disabled={busy !== null}
    onJob={trackJob} onError={setActionError} onDialog={open => setBusy(open ? "child-op" : null)} />
)}
```
Disconnect (:544) becomes `disabled={busy !== null || row.child?.activeJob != null}` with
`title={row.child?.activeJob ? t("remoteLink.child.disconnectBlocked") : undefined}` — the server answers 409 anyway
(`link-routes.ts:212`); the disabled state only avoids a needless request.

Between the list heading and the `<ul>` (:500-526), when `status?.role === "home" && statusRows.some(row => row.child)`:
```tsx
<ChildBulkBar apiBase={apiBase} rows={statusRows} onJob={trackJob} onError={setActionError} onRun={setChildOpBusy} />
{childJobs.map(job => <ChildJobProgress key={job.jobId} apiBase={apiBase} job={job} onDone={() => finishJob(job.jobId)} />)}
```
The policy panel sits with the other panels below the list, immediately before `FallbackPanel` (`:569`):
`<ChildPolicyPanel apiBase={apiBase} busy={busy === "policy"} onBusy={on => setBusy(on ? "policy" : null)}
onError={setActionError} />`, rendered under the same `status?.role === "home" && statusRows.some(row => row.child)`
condition. The bulk bar and job progress sit directly above the row list because they act on it.

### `gui/src/pages/RemoteLinkChildActions.tsx` (NEW)

The module owns every child control. It imports only `./../remote-link-api` (types, `LinkApiError`),
`./../remote-link-child-ops-api` (parsers, requests, helpers), `./../ui` (`Select`), `@/components/ui-v2/button`
(`Button`), `./../components/v2-startup/primitives` (`Banner`, `StateBadge`), `./../i18n/shared` (`TKey`, `useT`) and
`./RemoteLinkSheet` (`LinkActionErrorView`). `linkActionError` is module-local in `RemoteLink.tsx` today; copy those four
lines here (`{ key: errorKey(error), hint: error instanceof LinkApiError ? error.hint : null }`) and export them from this
file, leaving `RemoteLink.tsx`'s copy untouched.

```tsx
export function ChildRowBadges({ row }: { row: ChildOpsRowView }): ReactElement {
  const t = useT();
  const version = row.installedVersion ?? row.runningVersion;
  const owner = row.update.route === "owner-action" ? row.update.reason : null;
  const ownerKey: TKey | null = owner !== null ? OWNER_ACTION_KEYS[owner] ?? null : null;
  return (
    <span className="remote-link-child-badges flex min-w-0 flex-wrap items-center gap-1.5">
      {version && <StateBadge tone="neutral">v{version}</StateBadge>}
      {row.installKind === "desktop-app" && <StateBadge tone="neutral">{t("remoteLink.child.kind.desktopApp")}</StateBadge>}
      {row.installKind === "goat" && <StateBadge tone="neutral">{t("remoteLink.child.kind.goat")}</StateBadge>}
      {row.installKind === "source" && <StateBadge tone="neutral">{t("remoteLink.child.kind.source")}</StateBadge>}
      {row.installKind !== null && !["desktop-app", "goat", "source"].includes(row.installKind)
        && <StateBadge tone="neutral"><code className="font-mono">{row.installKind}</code></StateBadge>}
      {row.childBuild && <StateBadge tone="neutral"><code className="font-mono">ocx-child {row.childBuild}</code></StateBadge>}
      {row.versionSkew === "same" && <StateBadge tone="ok">{t("remoteLink.child.skew.same")}</StateBadge>}
      {row.versionSkew === "behind" && <StateBadge tone="warn">{t("remoteLink.child.skew.behind", { version: row.homeVersion })}</StateBadge>}
      {row.versionSkew === "ahead" && <StateBadge tone="warn">{t("remoteLink.child.skew.ahead")}</StateBadge>}
      {updateAvailable(row) && <StateBadge tone="warn">{t("remoteLink.child.updateAvailable", { version: row.homeVersion })}</StateBadge>}
      {row.catalog.state === "behind" && <StateBadge tone="warn">{t("remoteLink.child.catalog.behind")}</StateBadge>}
      {row.catalog.state === "current" && <StateBadge tone="ok">{t("remoteLink.child.catalog.current")}</StateBadge>}
      {codexRestartNeeded(row) && <StateBadge tone="warn">{t("remoteLink.child.codex.restartNeeded", { count: row.codex?.staleCount ?? 0 })}</StateBadge>}
      {row.codex?.appServers === "not_running" && <StateBadge tone="neutral">{t("remoteLink.child.codex.notRunning")}</StateBadge>}
      {ownerKey && <StateBadge tone="neutral">{t(ownerKey)}</StateBadge>}
      {owner && !ownerKey && <code className="font-mono text-[12px] text-fg-muted">{owner}</code>}
      {row.activeJob && <StateBadge tone="neutral">{t(ACTIVE_KEY[row.activeJob.op])}</StateBadge>}
      {row.lastOperation && (
        <span className="text-[12px] leading-5 text-fg-muted">
          {t("remoteLink.job.last", { op: t(ACTIVE_KEY[row.lastOperation.op]).replace("…", ""), state: row.lastOperation.state })}
          {row.lastOperation.reason && <> <code className="font-mono">{row.lastOperation.reason}</code></>}
        </span>
      )}
    </span>
  );
}
```
`ACTIVE_KEY: Record<ChildOp, TKey>` maps `observe | sync | restart-codex | update` to `remoteLink.job.active.<op>`.
`OWNER_ACTION_KEYS: Record<string, TKey>` covers the eight reasons 020 can carry on an `owner-action` route
(`child-update-contract.ts:130-144`, `child-observe.ts:115`, `child-gated-ocx.ts:129`): `legacy-ocx`,
`desktop-app-owned`, `goat`, `launcher-node-missing`, `launcher-bypassed`, `mise-managed`, `source-checkout`,
`installer-unknown`. Any other reason keeps the neutral "needs an update on the Child" badge absent and prints the
token in `<code>` instead, so no reason is guessed into the wrong sentence.
`StateBadge` accepts only `Tone`; `info` is not a tone there, so the active-job badge uses `neutral` and the badge
text already says what is running.

```tsx
export function ChildRowActions(props: { apiBase: string; link: LinkRowWire; disabled: boolean;
  onJob(job: ChildJobView): void; onError(error: LinkActionErrorView | null): void;
  onDialog(open: boolean): void }): ReactElement | null {
  const t = useT();
  const [restarting, setRestarting] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const row = props.link.child ?? null;
  if (!rowOperable(props.link.direction, row)) return null;
  // A job holding the link is the only global hold. Restart and update are withheld while the link is busy
  // (030's runner refuses without SSH); observe and sync are allowed to try and report the server's own verdict.
  const held = props.disabled || row!.activeJob !== null;
  const busy = held || !row!.activity.idle;
  const run = async (body: ChildOperationBody) => {
    props.onError(null);
    try { props.onJob(await postChildOperation(props.apiBase, body)); }
    catch (error) { props.onError(linkActionError(error)); }
  };
  const single = (op: ChildOp, restart?: "app-server" | "codex") =>
    void run({ op, linkIds: [props.link.id], ...(restart ? { restart } : {}) });
  return (
    <span className="remote-link-child-actions flex shrink-0 flex-wrap items-center gap-1">
      <Button variant="ghost" size="sm" onClick={() => single("observe")} disabled={held}>{t("remoteLink.child.check")}</Button>
      <Button variant="ghost" size="sm" onClick={() => single("sync")} disabled={held}>{t("remoteLink.child.syncNow")}</Button>
      <Button variant="ghost" size="sm" onClick={() => { setRestarting(true); props.onDialog(true); }} disabled={busy}>{t("remoteLink.child.restartCodex")}</Button>
      <Button variant="primary" size="sm" onClick={() => { setConfirmUpdate(true); props.onDialog(true); }} disabled={busy || !updateAvailable(row!)}
        title={updateAvailable(row!) ? undefined : t("remoteLink.child.upToDate")}>{t("remoteLink.child.update")}</Button>
      <RestartCodexDialog alias={props.link.alias} open={restarting}
        onCancel={() => { setRestarting(false); props.onDialog(false); }}
        onConfirm={scope => { setRestarting(false); props.onDialog(false); single("restart-codex", scope); }} />
      <ChildConfirmDialog open={confirmUpdate} title={t("remoteLink.child.update")}
        body={t("remoteLink.child.updateConfirm", { alias: props.link.alias, version: row!.homeVersion })}
        confirm={t("remoteLink.child.update")}
        onCancel={() => { setConfirmUpdate(false); props.onDialog(false); }}
        onConfirm={() => { setConfirmUpdate(false); props.onDialog(false); single("update"); }} />
    </span>
  );
}
```
`busy` also requires `activity.idle`: 030's restart runner answers `busy` (`restart-skipped:link-active`) without
SSH, and the update runner refuses a busy link, so the disabled state only spares the round trip. Observe and sync
stay enabled because they are the operator's way to see and repair a busy link; the server decides their outcome.
The status row's `activity` is the shared idle verdict, so a link the Home cannot read activity for reads busy and
offers only Check and Sync now. `ChildConfirmDialog` is the same `<dialog>` shell as
`RemoteLinkDisconnectDialog` (`m-auto w-[min(440px,calc(100vw-24px))] ... backdrop:bg-black/40`, `onCancel` →
`preventDefault()` then the cancel callback, `autoFocus` on the confirm button).

```tsx
export function RestartCodexDialog(props: { alias: string; open: boolean; onCancel(): void;
  onConfirm(scope: "app-server" | "codex"): void }): ReactElement {
  const t = useT();
  const [scope, setScope] = useState<"app-server" | "codex">("app-server");
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog ref={ref} aria-labelledby="remote-link-restart-title" onCancel={event => { event.preventDefault(); props.onCancel(); }}
      className="remote-link-confirm-dialog m-auto w-[min(440px,calc(100vw-24px))] rounded-[14px] border-0 bg-surface p-1 text-fg shadow-lg ring-1 ring-line backdrop:bg-black/40">
      <div className="flex flex-col gap-2 rounded-[10px] bg-bg px-5 py-4 ring-1 ring-line">
        <h3 id="remote-link-restart-title" className="m-0 text-[16px] leading-6 font-semibold tracking-[-0.015em]">{t("remoteLink.child.restartCodex")}</h3>
        <label className="flex items-start gap-2 text-[13px] leading-5">
          <input type="radio" name="ocx-restart-scope" checked={scope === "app-server"} onChange={() => setScope("app-server")} className="mt-1" />
          <span><strong>{t("remoteLink.restart.scope.appServer")}</strong><span className="mt-0.5 block text-fg-muted">{t("remoteLink.restart.scope.appServerBody")}</span></span>
        </label>
        <label className="flex items-start gap-2 text-[13px] leading-5">
          <input type="radio" name="ocx-restart-scope" checked={scope === "codex"} onChange={() => setScope("codex")} className="mt-1" />
          <span><strong>{t("remoteLink.restart.scope.codex")}</strong><span className="mt-0.5 block text-fg-muted">{t("remoteLink.restart.scope.codexBody", { alias: props.alias })}</span></span>
        </label>
      </div>
      <div className="flex justify-end gap-2 px-2 py-2">
        <Button variant="ghost" onClick={props.onCancel}>{t("link.cancel")}</Button>
        <Button variant="danger" onClick={() => props.onConfirm(scope)}>{t("remoteLink.restart.confirm")}</Button>
      </div>
    </dialog>
  );
}
```
The dialog resets `scope` per mount (the action bar mounts it fresh on each open), so the choice is per click and never
remembered; there is no policy coupling (deviation 3).

```tsx
export function ChildBulkBar(props: { apiBase: string; rows: readonly LinkRowWire[];
  onJob(job: ChildJobView): void; onError(error: LinkActionErrorView | null): void;
  onRun(running: { linkId: "all"; op: ChildOp } | null): void }): ReactElement | null {
  const t = useT();
  const [confirming, setConfirming] = useState<null | "all">(null);
  const operable = props.rows.filter(row => rowOperable(row.direction, row.child ?? null));
  const updatable = operable.filter(row => updateAvailable(row.child!));
  if (operable.length === 0) return null;
  const homeVersion = updatable[0]?.child?.homeVersion ?? operable[0]?.child?.homeVersion ?? "";
  const run = async (op: ChildOp, ids: readonly string[]) => {
    props.onError(null);
    props.onRun({ linkId: "all", op });
    try {
      const results = await Promise.allSettled(chunkLinkIds(ids).map(group => postChildOperation(props.apiBase, { op, linkIds: group })));
      for (const result of results) if (result.status === "fulfilled") props.onJob(result.value);
      const refused = results.find(result => result.status === "rejected");
      if (refused) props.onError(linkActionError(refused.reason));
    }
    finally { props.onRun(null); }
  };
  return (
    <div className="remote-link-child-bulk flex flex-wrap items-center gap-2 px-1 py-2">
      <Button variant="ghost" size="sm" onClick={() => void run("observe", linkIds(operable))}>{t("remoteLink.child.checkAll")}</Button>
      <Button variant="outline" size="sm" disabled={updatable.length === 0}
        onClick={() => setConfirming("all")}>{t("remoteLink.child.updateAll")}</Button>
      <ChildConfirmDialog open={confirming === "all"} title={t("remoteLink.child.updateAll")}
        body={t("remoteLink.child.updateAllConfirm", { count: updatable.length, version: homeVersion })}
        confirm={t("remoteLink.child.updateAll")} onCancel={() => setConfirming(null)}
        onConfirm={() => { setConfirming(null); void run("update", linkIds(updatable)); }} />
    </div>
  );
}
```
Both bulk actions post explicit link ids, never `"all"` (Revision 7, #8581 review): the server expands `"all"` to
every stored link and runs a pinned sync before it decides currency, so a link outside the confirmation could be
reached. Check all names the operable rows; Update all names exactly the updatable rows its confirmation counts, and
is offered only when at least one row is updatable. The route accepts at most 64 ids per body (`MAX_LINK_IDS`), so
`run` posts one job per even group of at most 64 at once (`chunkLinkIds`, `Promise.allSettled`); each accepted group is tracked as its own job and the first refusal shows its error.

```tsx
export function useChildJob(apiBase: string, job: ChildJobView): { job: ChildJobView; missing: boolean } {
  const [snapshot, setSnapshot] = useState(job);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setSnapshot(job);
    setMissing(false);
    if (job.state === "done") return;
    let stopped = false;
    const controller = new AbortController();
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const next = await getChildJob(apiBase, job.jobId, controller.signal);
        if (!stopped) setSnapshot(next);
      } catch (error) {
        if (stopped) return;
        if (error instanceof LinkApiError && (error.code === "job_not_found" || error.status === 404)) {
          stopped = true;                       // the Home restarted (retention is 1 h / 32 jobs)
          controller.abort();
          setMissing(true);
        }
      }
    };
    const timer = window.setInterval(() => void tick(), CHILD_JOB_POLL_MS);
    const onVisibility = () => { if (document.visibilityState !== "hidden") void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [apiBase, job.jobId, job.state]);
  return { job: snapshot, missing };
}
```
Polling stops on a `done` snapshot, on unmount, on a job-id change, and on `job_not_found`; it skips hidden tabs and
resumes on visibility (`RemoteLink.tsx` uses the same pattern for status, `:238-241`).

```tsx
export function ChildJobProgress(props: { apiBase: string; job: ChildJobView; onDone(): void }): ReactElement {
  const t = useT();
  const { job, missing } = useChildJob(props.apiBase, props.job);
  const done = job.state === "done" || missing;
  const fired = useRef(false);
  useEffect(() => { if (done && !fired.current) { fired.current = true; props.onDone(); } }, [done, props]);
  return (
    <section className="remote-link-job flex min-w-0 flex-col gap-1 rounded-[12px] bg-surface px-4 py-3 ring-1 ring-line" aria-live="polite">
      <h4 className="m-0 text-[13px] font-semibold">
        {t(ACTIVE_KEY[job.op])}{job.trigger === "auto" && <> · {t("remoteLink.job.automatic")}</>}
      </h4>
      {missing && <Banner tone="info">{t("remoteLink.job.notFound")}</Banner>}
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] leading-5">
        {job.items.map(item => {
          const state = missing && (item.state === "queued" || item.state === "running") ? "uncertain" : item.state;
          return (
            <li key={item.linkId} className="flex min-w-0 flex-wrap items-center gap-x-2">
              <span className="font-semibold">{item.alias}</span>
              <span>{state in JOB_STATE_KEYS ? t(JOB_STATE_KEYS[state]!) : <code className="font-mono">{state}</code>}</span>
              {(item.fromVersion || item.toVersion) && <code className="font-mono">{item.fromVersion ?? "?"} → {item.toVersion ?? "?"}</code>}
              {item.reason && <code className="font-mono text-fg-muted">{item.reason}</code>}
              {item.sync && <span className="text-fg-muted">{item.sync.state in SYNC_KEYS ? t(SYNC_KEYS[item.sync.state]!) : <code className="font-mono">{item.sync.state}</code>}</span>}
              {item.restart && <span className={restartWithheld(item.restart.outcome) ? "text-warning" : "text-fg-muted"}>
                {item.restart.outcome in RESTART_KEYS ? t(RESTART_KEYS[item.restart.outcome]!) : <code className="font-mono">{item.restart.outcome}</code>}
              </span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```
`JOB_STATE_KEYS`, `SYNC_KEYS` and `RESTART_KEYS` are `Record<string, TKey>` maps over the enumerations this build knows;
an unmapped value (a newer Home, or 080 widening `ChildRestartOutcome`) renders as `<code>` text and is never coerced
to `requested`. When polling fails with `job_not_found`, still-running items read `remoteLink.job.state.uncertain` — the
row cannot claim the Child failed — and `onDone` refreshes status once.

```tsx
export function ChildPolicyPanel(props: { apiBase: string; busy: boolean; onBusy(on: boolean): void;
  onError(error: LinkActionErrorView | null): void }): ReactElement {
  const t = useT();
  const [read, setRead] = useState<ChildPolicyReadView | null>(null);
  const [draft, setDraft] = useState<ChildPolicyView | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await getChildPolicy(props.apiBase, signal);
      setRead(value); setDraft(value.policy);
    } catch (error) { if (!signal?.aborted) props.onError(linkActionError(error)); }
  }, [props]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  if (!draft || !read) return <></>;
  const changed = changedPolicyKeys(read.policy, draft);          // Partial<ChildPolicyView> of differing keys only
  const save = async () => {
    props.onBusy(true); props.onError(null); setSaved(false);
    try {
      const value = await putChildPolicy(props.apiBase, changed);
      setRead(value); setDraft(value.policy); setSaved(true);
    } catch (error) { props.onError(linkActionError(error)); }
    finally { props.onBusy(false); }
  };
  const minutes = Math.round(draft.idleAfterMs / 60_000);
  const set = <K extends keyof ChildPolicyView>(key: K, value: ChildPolicyView[K]) => { setSaved(false); setDraft({ ...draft, [key]: value }); };
  return (
    <section className="remote-link-policy flex min-w-0 flex-col gap-2 rounded-[12px] bg-surface p-4 ring-1 ring-line" aria-labelledby="remote-link-policy-title">
      <h3 id="remote-link-policy-title" className="m-0 text-[14px] font-semibold">{t("remoteLink.policy.title")}</h3>
      {read.warning === "policy-file-invalid" && <Banner tone="warn">{t("remoteLink.policy.invalid")}</Banner>}
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span>{t("remoteLink.policy.catalogFanout")}</span>
        <Select value={draft.catalogFanout} disabled={props.busy} onChange={value => set("catalogFanout", value as ChildPolicyView["catalogFanout"])}
          options={[{ value: "auto", label: t("remoteLink.policy.catalogFanout.auto") }, { value: "manual", label: t("remoteLink.policy.catalogFanout.manual") }]} />
      </label>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span>{t("remoteLink.policy.childCodexRestart")}</span>
        <Select value={draft.childCodexRestart} disabled={props.busy} onChange={value => set("childCodexRestart", value as ChildPolicyView["childCodexRestart"])}
          options={[{ value: "never", label: t("remoteLink.policy.childCodexRestart.never") }, { value: "app-server-when-idle", label: t("remoteLink.policy.childCodexRestart.whenIdle") }]} />
      </label>
      <label className="flex flex-col gap-1 text-[13px]">
        <span className="flex items-center justify-between gap-3"><span>{t("remoteLink.policy.updates")}</span>
          <Select value={draft.updates} disabled={props.busy} onChange={value => set("updates", value as ChildPolicyView["updates"])}
            options={[{ value: "off", label: t("remoteLink.policy.updates.off") }, { value: "notify", label: t("remoteLink.policy.updates.notify") },
              { value: "auto-when-idle", label: t("remoteLink.policy.updates.autoWhenIdle") }]} />
        </span>
        <span className="text-[12px] leading-5 text-fg-muted">{t("remoteLink.policy.updatesInactive")}</span>
      </label>
      <label className="flex items-center justify-between gap-3 text-[13px]">
        <span>{t("remoteLink.policy.idleMinutes")}</span>
        <input type="number" className="input w-[88px]" min={1} max={60} value={minutes} disabled={props.busy}
          onChange={event => { const next = Number(event.target.value); if (Number.isSafeInteger(next) && next >= 1 && next <= 60) set("idleAfterMs", next * 60_000); }} />
      </label>
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-[12px] text-success" role="status">{t("remoteLink.policy.saved")}</span>}
        <Button variant="primary" size="sm" disabled={props.busy || Object.keys(changed).length === 0} onClick={() => void save()}>
          {t("remoteLink.policy.save")}
        </Button>
      </div>
    </section>
  );
}
```
Three knobs plus the idle threshold; the control is `Select` from `gui/src/ui.tsx` (`gui/AGENTS.md` forbids a native
`<select>`, and `tests/form-controls-rule.test.ts` enforces it). `updateChildPolicy` merges a partial patch, so
`changedPolicyKeys` returns only the keys the operator actually moved — a save never rewrites a mode they left alone.
Over an invalid file the server merges onto `FAIL_CLOSED_CHILD_POLICY` (`manual / never / off / 600000`), so the banner
text says the defaults are in effect and that saving is what replaces them; the panel shows the fail-closed values the
GET returned, not the ideal defaults. The `updates` row carries its own muted line because the setting is stored but
nothing sweeps yet (wp7): the copy must not imply automatic updates are running. The idle input is bounded by the
server's 60,000–3,600,000 ms range, so an out-of-range value is never sent.

No new colour, spacing or component: `StateBadge`, `Button`, `Banner` (`components/v2-startup/primitives.tsx:15,25,95`),
`Select` (`ui.tsx:124`) and the dialog shell already in `RemoteLinkDialogs.tsx`, so `gui/design-system/` needs no update.

### Locale keys (all 11 catalogs)

English is the source (`en.ts` ends with `export type TKey = keyof typeof en` at :4397); every other catalog is typed `Record<TKey, string>`, so a
missing key fails typecheck. Each of `de fr ko zh zh-TW ru ja tr vi pt` gets a real translation, never the English
string. English and Korean values below; product names (Codex, GOAT, OpenCodex Desktop) stay untranslated.

| Key | en | ko |
| --- | --- | --- |
| `remoteLink.child.skew.same` | Same version as Home | Home과 같은 버전 |
| `remoteLink.child.skew.behind` | Behind Home ({version}) | Home({version})보다 이전 |
| `remoteLink.child.skew.ahead` | Newer than Home | Home보다 최신 |
| `remoteLink.child.kind.desktopApp` | Desktop app | 데스크톱 앱 |
| `remoteLink.child.kind.goat` | GOAT | GOAT |
| `remoteLink.child.kind.source` | Source checkout | 소스 체크아웃 |
| `remoteLink.child.updateAvailable` | Update available: {version} | 업데이트 가능: {version} |
| `remoteLink.child.catalog.current` | Catalog current | 카탈로그 최신 |
| `remoteLink.child.catalog.behind` | Catalog out of date | 카탈로그 오래됨 |
| `remoteLink.child.codex.restartNeeded` | Codex restart needed ({count}) | Codex 재시작 필요 ({count}) |
| `remoteLink.child.codex.notRunning` | Codex not running | Codex 실행 안 함 |
| `remoteLink.child.ownerAction.legacy-ocx` | Update OpenCodex on this Child by hand | 이 Child의 OpenCodex를 직접 업데이트하세요 |
| `remoteLink.child.ownerAction.desktop-app-owned` | Use Check for Updates in OpenCodex Desktop on this Child | 이 Child의 OpenCodex Desktop에서 업데이트 확인을 사용하세요 |
| `remoteLink.child.ownerAction.goat` | GOAT keeps this Child updated | GOAT가 이 Child를 업데이트합니다 |
| `remoteLink.child.ownerAction.launcher-node-missing` | Node.js is missing on this Child; install it, then update there | 이 Child에 Node.js가 없습니다. 설치한 뒤 그곳에서 업데이트하세요 |
| `remoteLink.child.ownerAction.launcher-bypassed` | This Child's launcher bypasses OpenCodex's updater; update it by hand | 이 Child의 실행 경로가 OpenCodex 업데이트를 거치지 않습니다. 직접 업데이트하세요 |
| `remoteLink.child.ownerAction.mise-managed` | mise manages OpenCodex on this Child; update it through mise | 이 Child의 OpenCodex는 mise가 관리합니다. mise로 업데이트하세요 |
| `remoteLink.child.ownerAction.source-checkout` | This Child runs from a source checkout; update it by hand | 이 Child는 소스 체크아웃에서 실행됩니다. 직접 업데이트하세요 |
| `remoteLink.child.ownerAction.installer-unknown` | This Child's install method is unknown; update it there | 이 Child의 설치 방식을 알 수 없습니다. 그곳에서 업데이트하세요 |
| `remoteLink.child.check` / `.checkAll` | Check / Check all | 확인 / 모두 확인 |
| `remoteLink.child.syncNow` | Sync now | 지금 동기화 |
| `remoteLink.child.restartCodex` | Restart Codex | Codex 재시작 |
| `remoteLink.child.update` / `.updateAll` | Update / Update all | 업데이트 / 모두 업데이트 |
| `remoteLink.child.updateConfirm` | Update {alias} to {version}? OpenCodex on that Child restarts, which ends any turn currently relayed for it. Automatic updates wait until a Child is idle. | {alias}을(를) {version}(으)로 업데이트할까요? 해당 Child의 OpenCodex가 재시작되어 지금 중계 중인 작업이 끝납니다. 자동 업데이트는 Child가 유휴 상태일 때까지 기다립니다. |
| `remoteLink.child.updateAllConfirm` | Update {count} Children to {version}, one at a time. Each Child's OpenCodex restarts, which ends any turn currently relayed for it. Automatic updates wait until a Child is idle. | Child {count}대를 {version}(으)로 한 대씩 업데이트합니다. 각 Child의 OpenCodex가 재시작되어 지금 중계 중인 작업이 끝납니다. 자동 업데이트는 Child가 유휴 상태일 때까지 기다립니다. |
| `remoteLink.child.upToDate` | Up to date | 최신 상태 |
| `remoteLink.child.disconnectBlocked` | Wait for the running operation to finish | 진행 중인 작업이 끝날 때까지 기다리세요 |
| `remoteLink.restart.scope.appServer` | Codex app-servers | Codex 앱 서버 |
| `remoteLink.restart.scope.appServerBody` | Restarts Codex background app-servers so they load the new catalog. The Codex desktop app's own app-server is not refreshed; restart the desktop app for that. | Codex 백그라운드 앱 서버를 재시작해 새 카탈로그를 읽게 합니다. Codex 데스크톱 앱 자체의 앱 서버는 새로 고쳐지지 않으므로, 그쪽은 데스크톱 앱을 재시작하세요. |
| `remoteLink.restart.scope.codex` | Codex desktop app | Codex 데스크톱 앱 |
| `remoteLink.restart.scope.codexBody` | Quits and relaunches the Codex desktop app on {alias}. Open conversations end. It needs a signed-in desktop session on that computer. | {alias}에서 Codex 데스크톱 앱을 종료하고 다시 실행합니다. 열린 대화는 끝납니다. 해당 컴퓨터에 로그인된 데스크톱 세션이 필요합니다. |
| `remoteLink.restart.confirm` | Restart | 재시작 |
| `remoteLink.job.active.observe/sync/restart-codex/update` (4) | Checking… / Syncing… / Restarting Codex… / Updating… | 확인 중… / 동기화 중… / Codex 재시작 중… / 업데이트 중… |
| `remoteLink.job.state.<11 states>` (11) | Queued, Running, Succeeded, Up to date, Busy, Offline, Refused, Needs owner action, Not supported, Failed, Outcome unknown | 대기 중, 실행 중, 성공, 최신 상태, 사용 중, 오프라인, 거부됨, 소유자 조치 필요, 지원 안 함, 실패, 결과 불확실 |
| `remoteLink.job.restart.<4 outcomes>` (4) | Restart requested, Restart not supported, Restart not run, Restart withheld: a turn was running | 재시작 요청됨, 재시작 미지원, 재시작 안 함, 재시작 보류: 작업 진행 중 |
| `remoteLink.job.last` | Last {op}: {state} | 마지막 {op}: {state} |
| `remoteLink.job.notFound` (Revision 4) | This Home restarted, so the job's progress is gone. The rows below show each Child's current state. | 이 Home이 다시 시작되어 작업 진행 상황이 사라졌습니다. 아래 행에 각 Child의 현재 상태가 표시됩니다. |
| `remoteLink.job.automatic` | Automatic | 자동 |
| `remoteLink.policy.title` | Child automation | Child 자동화 |
| `remoteLink.policy.catalogFanout` + `.auto` `.manual` | Catalog fan-out: Automatic / Manual | 카탈로그 전파: 자동 / 수동 |
| `remoteLink.policy.childCodexRestart` + `.never` `.whenIdle` | Codex restart: Never / App-servers when idle | Codex 재시작: 안 함 / 유휴 시 앱 서버 |
| `remoteLink.policy.updates` + `.off` `.notify` `.autoWhenIdle` | Updates: Off / Notify only / Automatic when idle | 업데이트: 끔 / 알림만 / 유휴 시 자동 |
| `remoteLink.policy.idleMinutes` | Idle after (minutes) | 유휴 판단 시간(분) |
| `remoteLink.policy.save` / `.saved` | Save / Saved | 저장 / 저장됨 |
| `remoteLink.policy.updatesInactive` | Stored now; automatic updates start when the update sweep ships, so nothing updates on its own yet. | 지금은 설정만 저장됩니다. 자동 업데이트는 업데이트 일괄 처리가 출시된 뒤에 시작되므로 아직 스스로 업데이트하지 않습니다. |
| `remoteLink.policy.invalid` | The saved policy file is damaged; defaults are in effect until you save. | 저장된 정책 파일이 손상되어 저장할 때까지 기본값이 적용됩니다. |
| `remoteLink.error.invalid_job_id` | The operation id is invalid. | 작업 ID가 올바르지 않습니다. |
| `remoteLink.error.job_not_found` | The operation is no longer known; the Home may have restarted. | 작업을 찾을 수 없습니다. Home이 재시작되었을 수 있습니다. |
| `remoteLink.error.link_operation_in_progress` | Another operation is running on this Child. | 이 Child에서 다른 작업이 진행 중입니다. |
| `remoteLink.error.no_eligible_links` | No Home-initiated Child is available for this. | 이 작업에 사용할 수 있는 Home 시작 Child가 없습니다. |
| `remoteLink.error.policy_write_failed` | The Child policy could not be saved. | Child 정책을 저장하지 못했습니다. |
| `remoteLink.error.runtime_role_client` | This computer is a Child; only a Home can operate Children. | 이 컴퓨터는 Child이므로 Home만 Child를 조작할 수 있습니다. |
| `remoteLink.error.link_not_home_initiated` | This Child linked itself, so operate it from its own computer. | 이 Child가 직접 연결했으므로 해당 Child 컴퓨터에서 조작하세요. |

The four restart keys are exactly `ChildRestartOutcome` (`requested | unsupported | not-run | skipped`); 080 may add
`done | refused | failed`, and until then any other string renders as `<code>` text, so a newer Home never produces a
missing-key `t()` or a wrong label. Reason codes (`rolled-back`, `link-active`, …) render inside `<code>` as machine
text (gui/AGENTS.md allowlist); only the reasons named by `OWNER_ACTION_KEYS` get sentences.

## Field chains

| Field | Created (server) | Serialized | GUI parse | GUI consumer |
| --- | --- | --- | --- | --- |
| `links[].child` (all keys) | `attachLinkChildOps` (020; 080 widens `codex`, adds `childBuild`) | `GET /api/link/status?children=1` | `parseChildOps` (absent ⇒ null) | `ChildRowBadges`, `ChildRowActions`, Disconnect disabled |
| `versionSkew` + `update.route` | 020 projection | same | same | skew badge, `updateAvailable()`, Update / Update all enablement |
| `catalog.state` | 020 (D6) | same | same | catalog badge |
| `codex` | 080 store | same | same (null ⇒ no badge) | `codexRestartNeeded()` badge |
| `activeJob` | engine (020/030) | same | same | active badge, buttons disabled |
| `lastOperation` | observation cache (010 D4) | same | same | "Last …" line |
| `ChildJob` | 030 engine | 202 `{job}`, 200 `{job}` | `parseChildJob` | `ChildJobProgress` |
| `restart.outcome` (4 values on this base) | 030 (`skipped` included) | job document | enum, unknown ⇒ `<code>` text, never `requested` | progress sub-line |
| `{policy, warning}` | 050 policy routes | GET/PUT JSON | `parseChildPolicyRead` | `ChildPolicyPanel` |
| `ChildOperationBody` | `ChildRowActions`, `ChildBulkBar`, dialog | POST JSON, exactly `{op, linkIds, restart?}` | 030 route parser | engine |
| the six new error codes | 030/050 routes | `{error:{code}}` | `readLinkJson` → `LinkApiError` | `ERROR_TKEY` → banner |

## Tests

`gui/tests` is not in the root test layout (003 §4), so nothing is registered. `gui/tests/remote-link-child-ops.test.tsx`
(NEW, same happy-dom harness as `remote-link.test.tsx:1-57`; fetch stubbed per path). It fails before
implementation because `../src/pages/RemoteLinkChildActions` does not exist.

1. *status is requested with children=1* — assert the first fetch URL ends `/api/link/status?children=1`.
2. *older Home renders today's row* — status without `child` (a Home that predates wp2, or a `child` role):
   no version badge, no child buttons, no bulk bar and no policy panel, Disconnect enabled. Only the
   `?children=1` parameter differs from today's request; an old Home ignores it and answers the same DTO.
3. *badges* — row with `versionSkew:"behind"`, `route:"orchestrated"`, `catalog.state:"behind"`,
   `codex:{appServers:"stale",staleCount:2,…}`: shows skew, "Update available", "Catalog out of date",
   "Codex restart needed (2)"; with `route:"owner-action"`, `reason:"desktop-app"` shows the Desktop sentence.
4. *Check / Sync now / Update post exact bodies* — click each; assert POST bodies `{op:"observe",linkIds:[id]}` etc.
5. *Restart Codex dialog* — opens with app-server selected and the scope text present (the "not refreshed"
   sentence); confirm posts `restart:"app-server"`; choosing the desktop scope shows `codexBody` with the alias and posts `restart:"codex"`.
6. *Update and Update all* — the row Update confirm names alias and version and contains the "ends any turn currently
   relayed" and "Automatic updates wait" sentences (English catalog), then posts `{op:"update",linkIds:[id]}`; Update all's
   confirm names count and version with the same two sentences and posts `{op:"update",linkIds:[<updatable ids>]}`; disabled when no
   row has an update. An unknown `restart.outcome` string renders as `<code>` text, not a crash (H5).
7. *job progress* — POST returns a running job; the stub answers `jobs/<id>` running then done; the panel
   shows each item state and the restart outcome `done`, polls stop after done, and status refreshes once.
8. *409 link_operation_in_progress* renders its translated text; *404 job_not_found* stops polling, shows
   `remoteLink.job.notFound`, renders a still-running item as "Outcome unknown" and refreshes status once (Revision 4).
9. *active job* — row with `activeJob`: action buttons and Disconnect disabled; on first load the page fetches
   `jobs/<activeJob.jobId>` and shows its progress (Revision 4, 4529522080); two rows with two different active jobs ⇒
   two progress panels, one fetch each.
10. *client-initiated row* — no action buttons, badges still shown.
11. *policy panel* — loads, shows the invalid-file banner for `warning`, saving one changed select sends a PUT with only that key.
12. *withheld restart* (Revision 4, 4529522073) — a job item with `restart.outcome: "skipped"` renders
   "Restart withheld: a turn was running", never "Restart requested".
13. *parsers* — `parseChildOps` returns null for a malformed block; `parseChildJob` maps an unknown state to `failed`.

`gui/tests/remote-link.test.tsx:60-73` changes: the scanned list adds `"link-child-ops-routes"` and the
regex adds a second pattern `/case "([a-z_]+)": return fail\(code/g` so the `refusal()` switch (030 :689-695)
counts. Locale coverage is `gui/tests/locale-parity.test.ts` and `i18n-locales.test.ts`, unchanged.

## Docs and source-of-truth sync

- `docs-site/src/content/docs/guides/remote-link.md`: new "### Child versions and actions" at the end of
  "### Operating Children from the Home" (:225-237): what each badge means, the four actions, Check all and
  Update all (one at a time, Home version only), the Restart Codex scopes with the app-server caveat, the policy
  panel and its defaults (catalog fan-out automatic, Codex restart never, updates automatic when idle, A1), and
  "do not link a machine you do not own" (D20).
  Same section in `fr/ ja/ ko/ ru/ tr/ zh-cn/ zh-tw/guides/remote-link.md` (English is canonical; docs-site/AGENTS.md).
  wp8's paragraph in "Home and Child versions" (:196) is separate; the second PR rebases.
- **Carried from wp3 (4533270262), all eight files.** The restart-protection paragraph (:233, English; the same
  paragraph in each translation) keeps "pause new requests on that Child when its turns must survive" and adds the
  turn-level rule. English: "The Home also cannot tell whether Codex is in the middle of a turn that is running a
  tool rather than a model request, so let active Codex turns on that Child finish before restarting Codex or
  updating OpenCodex there. A manual update restarts that Child's OpenCodex and ends any turn still relayed for
  it; automatic updates wait until the Child is idle." The section's last sentence, "the dashboard has no
  controls for them" (:235), becomes "the dashboard's Remote Link page offers the same actions for a
  Home-initiated Child."
- `structure/remote-link.md:49` "Dashboard presentation": rows request `?children=1`; badges and actions are
  rendered from `child` only; actions post `/api/link/children/operations`; the policy panel reads and writes
  `/api/link/children/policy`. No new owned file outside `gui/` (structure has no gui ownership change).
- No CLI, capability or skill change (`skill:surface` unaffected).
- PR description: one screenshot of a Home with three rows (behind with update, current, ocx-child), the bulk bar,
  one running job and the policy panel; uploaded to the `pr-assets` branch and linked by commit SHA, never committed
  to the PR branch (AGENTS.md; `tests/ci-workflows/repo-hygiene.test.ts` rejects asset folders).
  Capture recipe (lead, GOAT browser): write a scratch harness under `.tmp/wp6-shot/` (gitignored) with a Vite config
  whose `root` is that directory, the repo's `react()`/`tailwindcss()` plugins, `@` → `gui/src` and
  `fs.allow: [repoRoot]`; its entry imports `gui/src/design/theme.css` and renders
  `<LanguageProvider><RemoteLink apiBase="http://fixture" diagnosticsApiBase="http://fixture" sessionReady /></LanguageProvider>`.
  Install a `globalThis.fetch` stub before render that answers `/api/link/status?children=1` with
  `{role:"home",listener:{state:"listening",port:8788},child:null,joinAvailable:true,links:[…]}` — one row
  `versionSkew:"behind"` + `installKind:"npm"` + `update.route:"orchestrated"` + `catalog.state:"behind"` +
  `codex:{appServers:"stale",staleCount:2,…}`, one `versionSkew:"same"` row, one `installKind:"ocx-child"` row with
  `versionSkew:"unknown"`, and the first row's `activeJob` set — plus `/api/link/children/jobs/<id>` (running, two
  items, one `restart.outcome:"requested"`), `/api/link/children/policy` (`warning:null`, the four defaults) and
  `/api/link/children/policy` PUT. Run `cd gui && bun install` once, then
  `bunx vite --config ../.tmp/wp6-shot/vite.config.ts --port 5199` with `cd .tmp/wp6-shot`; the page needs no
  server session because the stub answers every request. Capture at 1280×900 in the GOAT browser, then commit the PNG
  on `pr-assets`, copy its raw link with `?raw=true`-free blob URL pinned to that commit SHA, and delete the scratch
  directory.

## Enforcement bypass record

| Guard | Tier | Executing surface | Known bypass | Residual risk | Wording |
| --- | --- | --- | --- | --- | --- |
| Buttons disabled while a job holds the row | UI-advisory | `ChildRowActions` | Direct API call | Server refuses with 409 (030); the GUI only avoids a needless request | "wait for the running operation" |
| Restart-codex never sends "all" | UI + server | dialog per row; 030 route refuses `"all"` | none client-side | — | — |

## Verifiers

| Command | Run now? | Result (2026-11-12, base de0914a1a83b) | Reads this phase's target |
| --- | --- | --- | --- |
| `bun run typecheck` | at B | not run here (plan-only edit); exit 0 at 00680193cb | partly: root `src/**` and tests; the GUI is checked by its own build |
| `cd gui && bun run lint:i18n` | at B | exit 127 at 00680193cb: `oxlint: command not found` (gui dependencies absent in this shared checkout) | yes: `src/pages` (the new TSX) |
| `cd gui && bun ../scripts/test-with-pinned-bun.ts --isolate tests/remote-link.test.tsx tests/locale-parity.test.ts` | at B | exit 1 at 00680193cb, 2 load errors: `Cannot find package 'react'` (same cause) | yes: `gui/tests/remote-link*` |
| `cd gui && bun install && bun run lint:i18n && bun run test && bun run build` | no | NOT RUN: installs dependencies into the shared checkout; the implementing lane runs it in its own worktree | yes |
| `gui/tests/remote-link-child-ops.test.tsx` | no | new; fails before implementation | yes |
| `bun run structure:check` | at implementation | — | `structure/remote-link.md` |

## Acceptance criteria

1. On a Home with a wp2+ runtime, each Home-initiated row shows the Child version and skew badge; with
   `versionSkew:"behind"` and an orchestrated route it shows "Update available: <Home version>" (test 3).
2. Against a Home that omits `child` in rows (older Home, or a `child` role), the page renders exactly as today
   apart from the added `?children=1` parameter, and no child endpoint is called (test 2).
3. Check, Sync now, Restart Codex and Update each post exactly one `{op, linkIds:[id], restart?}` (tests 4–5).
4. The Restart Codex dialog states that the app-server scope does not refresh the Codex desktop app's own
   app-server, and the desktop scope warns that conversations end (test 5).
5. Update all and Check all post the explicit ids of the rows they cover, at most 64 per request; Update and Update all need a confirmation that names the target
   version and says that a manual update ends the turn relayed for that Child while automatic updates wait for idle (test 6).
6. A running job shows per-Child progress until done, then the status refreshes (test 7).
7. While a job holds a row, its actions and Disconnect are disabled (test 9); a 409 from the server is shown translated (test 8).
8. The policy panel shows the current policy and the damaged-file warning and saves only changed keys (test 11).
9. All 11 catalogs carry every new key with a translated value; `lint:i18n` and the locale tests pass.
10. The PR description carries the screenshot from `pr-assets`.

## Security review notes and risks

- No new route or credential path: every request goes to wp3/wp5 routes that already enforce "either"
  auth and CSRF through the global wrapper (`gui/src/api.ts:729-731`); Tailscale identity sessions stay 403.
- No remote text is rendered as HTML: reasons appear in `<code>` as text, hints go through `boundLinkHint`.
- Update all is the most disruptive button; it is confirmed (the text says a manual update ends turns relayed for the
  Child, M10), runs one Child at a time server-side, and only
  ever targets the Home's own version (030/070). Restart-codex has no "all" path.
- Risk: the 5 s status poll plus a 2 s job poll adds requests while a job runs; both stop when the tab is hidden.

## Windows behaviour

The dashboard is platform-neutral. Windows Children show the same badges; Restart Codex and orchestrated
Update return items `unsupported` with reasons `windows-restart` / `windows-apply` (004 D20), shown as
"Not supported" with the reason in `<code>`. A Desktop Windows Child (route `desktop-request`) updates through the
request route once both the Home and the Child run the release that ships 080: 030's update runner evaluates the
Desktop branch before the Windows refusal, and 070 admits such a Child to automatic updates (A5, audit H4). Before
that it shows the `desktop-app` owner action.

## Deviations from 004 and 000

1. **Check all** is added beside Update all (004 D14 allows `"all"` for observe); it costs one SSH call per Child.
2. **Error codes**: six codes join `LINK_ERROR_CODES` (004 D11 named only `link_operation_in_progress`), and the
   GUI parity test's regex is widened for 030's `refusal()` switch, which uses `fail(code, …)`.
3. **Restart scope** is chosen per click in a dialog; the policy panel's `childCodexRestart` only governs the
   automatic restart (050), so there is no "remember scope" setting.

## Carried from wp3 review (#8513)

- Remote Link guide (English + 7 translations): the restart protection paragraph must say to wait for active Codex
  turns to finish before a restart, not only pause new requests, because a turn running a tool has no relayed request in
  flight (CodeRabbit 4533270262).

## wp6 P re-verification (base dev de0914a1a83b)

Read against the merged tree at `51c78e74e4`. Confirmed and corrected above: `LINK_ERROR_CODES` is the closed 44-entry
list at `remote-link-api.ts:1-46`, with `invalid_body`, `link_unavailable` and `link_not_home_initiated` already
present, so six codes join it and one mapping changes; `isRecord` is at :118; `parseRemoteLinkStatus` maps rows at
:140-160; the page requests `/api/link/status` at :209, maps rows at :526-548, renders Disconnect at :544 and the
panels at :569-570; `busy` is the union at :156; `ERROR_TKEY` is :48-94; `RemoteLink.tsx` is 610 lines and
`remote-link.test.tsx` 1,297, both under the 2,000 cap. Server contract: `?children=1` attaches rows only for
`role === "home"` (`link-routes.ts:335`), `LinkChildOpsStatus.codex` is `null` (`status-projection.ts`), restart
outcomes are the four values of `child-ops-types.ts:24`, `parseOperation` accepts `linkIds:"all"` only with no
restart, and the route's codes are `invalid_body | runtime_role_client | link_unavailable | policy_write_failed |
invalid_job_id | job_not_found` plus the engine's four refusals (`link-child-ops-routes.ts:110-181`). Policy defaults
`auto / never / auto-when-idle / 600000`, fail-closed on damage, idle bounded 60,000–3,600,000. `StateBadge` takes
`ok|warn|err|neutral` and only `Banner` accepts `info`. The guide's operating section is :225-237 and :233 is the
restart paragraph; `structure/remote-link.md` "# Dashboard presentation" is :49. Corrected in this pass: the
malformed locale table (stray four-backtick fence), the owner-action key set (the eight reasons 020 can emit, not
five invented ones), `ChildRowBadges`/`ChildRowActions` pseudocode that could not compile, action enablement
(observe/sync stay enabled on a busy link; only restart/update wait for idle), error-code counts (6 + 1 remap), the
`restart.outcome` field-chain row, the "no child request is sent" acceptance claim, and the docs anchors.

To verify at B (implementation lane, failing-first): the exact line numbers in this file as they land after the
implied edits; `remote-link.test.tsx:60-73`'s scan list and `refusal()` regex against
`link-child-ops-routes.ts:117-124`; `gui/tests/locale-parity.test.ts` key accounting for the new keys (`OWNER_ACTION_KEYS` has eight entries and the four `job.restart` keys are exactly the four outcomes, so the table's row count is the key count except where a row names several); that
`ChildPolicyPanel`'s `Select` is reachable inside a dialog-free section; the screenshot harness actually renders
without a session; and `bun run typecheck`, `lint:i18n`, the GUI test file and `build` all pass in a worktree with
GUI dependencies installed.


## Revision 6 (wp6 plan audit, base 51c78e74e4)

Audit verdict GO-WITH-FIXES (blockers 3). All findings accepted; binding on the implementation:

1. **Blocker.** The page keeps its existing `busy` union for `RemoteLinkSheet` unchanged (`RemoteLinkSheet.tsx:38` is closed). Child-op and
   policy activity live in separate page state (`childOpBusy: { linkId: string | "all"; op: ChildOp } | null`, `policyBusy: boolean`);
   the sheet receives only the original union, mapped to `null` when only a Child op or policy save is running.
2. **Blocker.** Define `SYNC_KEYS: Record<"synced" | "skipped" | "failed" | "timed-out", TKey>` (`child-ops-types.ts:337`) mapping to
   `remoteLink.job.sync.synced|skipped|failed|timedOut`, add those four keys to all 11 catalogs (en: "Synced", "Sync skipped",
   "Sync failed", "Sync timed out"; ko: "동기화됨", "동기화 건너뜀", "동기화 실패", "동기화 시간 초과"); unknown sync states render as `<code>`.
3. **Blocker.** The damaged-policy banner (en) reads: "The policy file was damaged, so automatic catalog fan-out and automatic
   updates are off. Choose each automatic mode again and save to turn them back on." (ko: "정책 파일이 손상되어 자동 카탈로그 배포와
   자동 업데이트가 꺼져 있습니다. 각 자동 모드를 다시 선택하고 저장해야 다시 켜집니다."). While the banner is shown, Save sends every
   knob (full PUT), not only changed keys, so the operator's visible choices are what persist. Test: with a fail-closed warning,
   saving after changing only one select sends all four keys.
4. **Major, accepted.** Manual Restart Codex and Update are disabled only while `activeJob` holds the row or `activity.inFlight > 0`;
   the idle-after window gates automatic actions only. The server stays the final verdict.
5. Minor. Test 3's fixture uses reason `desktop-app-owned`.
6. Minor. The policy panel loads once per mount and after a save (effect deps: `props.apiBase` and stable callbacks), never on each
   status poll; an in-progress edit survives polls. Test.
7. Minor. `lastOperation.state` goes through `JOB_STATE_KEYS`; unmapped values render as `<code>`.
8. Minor. `restart.outcome: "skipped"` copy (en): "Restart withheld: a request was in flight on this Child." (ko: "재시작 보류: 이
   Child에서 요청이 처리 중이었습니다."); test 12 updated to match.


## Revision 7 (fresh final review r5 on #8581)

Bulk actions post explicit ids, never `"all"`; the code sample, test 6 and acceptance item 5 above now say so. The
operations route caps a body at 64 ids (`MAX_LINK_IDS`) while a Home's link count is unbounded, so Check all and Update
all split their list with `chunkLinkIds` into the fewest groups of at most 64 whose sizes differ by at most one (65 ids go out as 33 + 32,
and 4033 as one group of 64 and 63 of 63), so no one-id tail
turns a held link into a whole-request 409 and post one job per group at once; each accepted group is tracked as its own job and the first
refusal shows its error (react-doctor async-await-in-loop rules out a sequential loop). Test: "bulk actions split more than 64 Children into requests the server accepts" (65 rows, two
requests of 33 and 32 for each action); the cap is pinned to `CHILD_OPS_MAX_LINK_IDS` in `src/link/child-ops-types.ts` by a
parity test. Submits carry a 30 s deadline (`CHILD_OPERATION_POST_TIMEOUT_MS`) and job polls a 15 s deadline each (`CHILD_JOB_POLL_TIMEOUT_MS`, CodeRabbit
4547457599).
