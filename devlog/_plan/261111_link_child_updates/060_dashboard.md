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
`RemoteLink.tsx` wiring, five error codes, ~50 keys in all 11 catalogs, one sibling GUI test file, the
guide section in English and 7 translations, the structure note.
**OUT:** server or CLI changes; Child-side (Child role) rendering beyond today's row; new design tokens.

## File change map

| Path | Kind | Purpose |
| --- | --- | --- |
| `gui/src/remote-link-child-ops-api.ts` | NEW | Wire types, tolerant parsers, request helpers, pure view helpers. |
| `gui/src/pages/RemoteLinkChildActions.tsx` | NEW | `ChildRowBadges`, `ChildRowActions`, `RestartCodexDialog`, `ChildBulkBar`, `ChildJobProgress`, `ChildPolicyPanel`, `useChildJob`. |
| `gui/src/remote-link-api.ts` | MODIFY :1-46, :69-79, :141-160 | Error codes; `LinkRowWire.child`; parse `item.child`. |
| `gui/src/pages/RemoteLink.tsx` | MODIFY :45-60, :153, :206, :522-546 | `ERROR_TKEY` entries, query, row badges/actions, bulk bar, policy panel, Disconnect disabled while a job holds the row. |
| `gui/src/i18n/{en,de,fr,ko,zh,zh-TW,ru,ja,tr,vi,pt}.ts` | MODIFY | New `remoteLink.child.*`, `remoteLink.job.*`, `remoteLink.policy.*`, `remoteLink.error.*` keys. |
| `gui/tests/remote-link-child-ops.test.tsx` | NEW | Behaviour tests (sibling of the 1283-line `remote-link.test.tsx`). |
| `gui/tests/remote-link.test.tsx` | MODIFY :60-73 | Scan `link-child-ops-routes` and the `refusal()` switch (030 deviation 5). |
| `docs-site/src/content/docs/guides/remote-link.md` + `fr/ ja/ ko/ ru/ tr/ zh-cn/ zh-tw/` copies | MODIFY after "Link status" (:66-83) | "Child versions and actions" section. |
| `structure/remote-link.md` | MODIFY :47-51 "Dashboard presentation" | Badges, actions, policy panel, `?children=1`. |

## Changes

### `gui/src/remote-link-child-ops-api.ts` (NEW, full exported API)
```ts
import { isRecord, requestLinkJson } from "./remote-link-api";   // isRecord is exported by this phase (today module-local)

export type ChildInstallKind = "npm" | "pnpm" | "bun" | "source" | "mise" | "desktop-app" | "goat" | "standalone" | "ocx-child" | "unknown";
export type ChildUpdateRoute = "orchestrated" | "desktop-request" | "owner-action" | "replant" | "none";
export type ChildOp = "observe" | "sync" | "restart-codex" | "update";   // wire mirror of src/link/child-observations.ts (000 "Canonical names"); gui cannot import src/
export type ChildItemState = "queued" | "running" | "succeeded" | "up-to-date" | "busy" | "offline" | "refused"
  | "owner-action" | "unsupported" | "failed" | "uncertain";
/** 030 produces requested/unsupported/not-run/skipped; 080 adds done/refused/failed. Seven values (Revision 4). */
export type ChildRestartOutcome = "requested" | "unsupported" | "not-run" | "skipped" | "done" | "refused" | "failed";
export interface ChildCodexView { appServers: "fresh" | "stale" | "not_running" | "unknown"; staleCount: number;
  catalogMatchesHome: boolean | null; catalogSyncedAt: number | null; reportedAt: number }
export interface ChildOpsRowView {
  homeVersion: string; runningVersion: string | null; installedVersion: string | null; installKind: ChildInstallKind | null;
  versionSkew: "same" | "behind" | "ahead" | "unknown";
  update: { route: ChildUpdateRoute | null; reason: string | null; observedAt: string | null };
  catalog: { state: "current" | "behind" | "unknown"; pulledAt: number | null; homeChangedAt: number | null };
  codex: ChildCodexView | null; childBuild: string | null;
  activity: { idle: boolean; inFlight: number; lastDataEndAt: number | null };
  activeJob: { jobId: string; op: ChildOp; state: "queued" | "running" } | null;
  lastOperation: { op: ChildOp; jobId: string; state: ChildItemState; reason: string | null;
    fromVersion?: string; toVersion?: string; finishedAt: string | null } | null;
}
export interface ChildJobItemView { linkId: string; alias: string; state: ChildItemState; reason: string | null; hint: string | null;
  fromVersion: string | null; toVersion: string | null;
  sync: { state: "synced" | "skipped" | "failed" | "timed-out"; reason: string | null } | null;
  restart: { requested: "app-server" | "codex"; outcome: ChildRestartOutcome } | null }
export interface ChildJobView { jobId: string; op: ChildOp; trigger: "manual" | "auto"; restart: "none" | "app-server" | "codex";
  state: "queued" | "running" | "done"; items: ChildJobItemView[] }
export interface ChildPolicyView { catalogFanout: "auto" | "manual"; childCodexRestart: "never" | "app-server-when-idle";
  updates: "off" | "notify" | "auto-when-idle"; idleAfterMs: number }
export interface ChildPolicyReadView { policy: ChildPolicyView; warning: "policy-file-invalid" | null }
export interface ChildOperationBody { op: ChildOp; linkIds: string[] | "all"; restart?: "app-server" | "codex" }

/** Tolerant: an absent or malformed block is null (older Home, or a field this build does not know). */
export function parseChildOps(value: unknown): ChildOpsRowView | null;
/** Strict on the keys it renders; unknown item states map to "failed" with the raw value dropped. */
export function parseChildJob(value: unknown): ChildJobView;
export function parseChildPolicyRead(value: unknown): ChildPolicyReadView;

export async function postChildOperation(apiBase: string, body: ChildOperationBody): Promise<ChildJobView> {
  const out = await requestLinkJson<{ job: unknown }>(apiBase, "/api/link/children/operations",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return parseChildJob(out.job);
}
export async function getChildJob(apiBase: string, jobId: string, signal?: AbortSignal): Promise<ChildJobView>;
// requestLinkJson(apiBase, `/api/link/children/jobs/${encodeURIComponent(jobId)}`, { signal })
export async function getChildPolicy(apiBase: string, signal?: AbortSignal): Promise<ChildPolicyReadView>;
export async function putChildPolicy(apiBase: string, patch: Partial<ChildPolicyView>): Promise<ChildPolicyReadView>;

/** Pure view helpers (tested directly). */
export function updateAvailable(row: ChildOpsRowView): boolean {
  return row.versionSkew === "behind" && (row.update.route === "orchestrated" || row.update.route === "desktop-request");
}
export function codexRestartNeeded(row: ChildOpsRowView): boolean {
  return row.codex?.appServers === "stale" || row.codex?.catalogMatchesHome === false;
}
export function rowOperable(direction: "hub-initiated" | "client-initiated", row: ChildOpsRowView | null): boolean {
  return direction === "hub-initiated" && row !== null && row.activeJob === null;
}
export const CHILD_JOB_POLL_MS = 2_000;
```
CSRF and session headers come from the global fetch wrapper (`gui/src/api.ts:729-731`), as for every
existing link POST; nothing here adds credentials.

### `gui/src/remote-link-api.ts`

Before (:1-46) `LINK_ERROR_CODES` is a closed list. After it gains `"invalid_job_id"`, `"job_not_found"`,
`"link_operation_in_progress"`, `"no_eligible_links"`, `"policy_write_failed"` (sorted position). Each needs an
`ERROR_TKEY` entry, which the `Record<LinkErrorCode, TKey>` type enforces at compile time.
Before (:69-79) `LinkRowWire` ends with `appliedCodexSettingsDigest?: string | null;`; after it also has
`child?: ChildOpsRowView | null;`. In `parseRemoteLinkStatus` (:151) the returned row object gains
`child: parseChildOps(item.child)`; `isRecord` becomes exported for the new module.

### `gui/src/pages/RemoteLink.tsx`

**Outline (accepted residual, audit L17): to be made diff-level at the phase's own P.**


- :206 before `requestLinkJson<unknown>(apiBase, "/api/link/status", { signal: controller.signal })`,
  after `requestLinkJson<unknown>(apiBase, "/api/link/status?children=1", { signal: controller.signal })`.
  A Home that predates wp2 ignores the query (`link-routes.ts:307-314` reads named flags only); rows then
  carry no `child` and render as today.
- :45-60 `ERROR_TKEY` adds the five codes → `remoteLink.error.<code>`.
- :153 `busy` union gains `"child-op"`; the policy save uses it so the page cannot submit twice.
- :522-546 row: after the parity badge,
  `{row.child && <ChildRowBadges row={row.child} t={t} />}`; before the Disconnect button,
  `{row.child && <ChildRowActions apiBase={apiBase} link={row} onJob={setChildJob} onError={setActionError} disabled={busy !== null} />}`;
  Disconnect gets `disabled={busy !== null || row.child?.activeJob != null}` with title
  `t("remoteLink.child.disconnectBlocked")` (the server answers 409 anyway; 030).
- Above the list, when `status?.role === "home" && statusRows.some(r => r.child)`:
  `<ChildBulkBar apiBase={apiBase} rows={statusRows} onJob={setChildJob} onError={setActionError} />`,
  `{childJobs.map(job => <ChildJobProgress key={job.jobId} apiBase={apiBase} job={job} onDone={() => void refreshStatus()} />)}`,
  `<ChildPolicyPanel apiBase={apiBase} />`. New state (Revision 4, 4529522080): `const [childJobs, setChildJobs] =
  useState<ChildJobView[]>([]);` A started job is added by `onJob`. After every status read, each distinct
  `row.child.activeJob.jobId` that is not in the list is fetched once with `getChildJob` and added, so a job started
  before a reload, by another tab or by the scheduler (`trigger: "auto"`) gets its progress panel. A job leaves the list
  when it is `done` and its `onDone` has run, or when its snapshot is gone (404).

### `gui/src/pages/RemoteLinkChildActions.tsx` (NEW)

**Outline (accepted residual, audit L17): exported signatures are binding; the bodies are to be made diff-level at the phase's own P.**


```tsx
export function ChildRowBadges({ row, t }: { row: ChildOpsRowView; t: Translate }): ReactElement;
// Renders, in order, only what is known:
//  <code>v{installedVersion ?? runningVersion}</code>  (technical literal)  + kind label (desktop-app, goat: keys;
//  npm/pnpm/bun/ocx-child: technical literal); childBuild: <code>ocx-child {childBuild}</code>
//  skew: same→ok "remoteLink.child.skew.same", behind→warn "remoteLink.child.skew.behind" {version: homeVersion},
//        ahead→warn "remoteLink.child.skew.ahead", unknown→ nothing
//  updateAvailable(row) → warn "remoteLink.child.updateAvailable" {version: homeVersion}
//  catalog.state behind → warn "remoteLink.child.catalog.behind"; current → ok "remoteLink.child.catalog.current"
//  codexRestartNeeded(row) → warn "remoteLink.child.codex.restartNeeded" {count: staleCount}
//  codex.appServers not_running → neutral "remoteLink.child.codex.notRunning"
//  update.route owner-action → neutral "remoteLink.child.ownerAction.<reason>" for a known reason, else
//        "remoteLink.child.ownerAction.generic" + <code>{reason}</code>
//  activeJob → neutral "remoteLink.job.active.<op>"; lastOperation → muted line
//        "remoteLink.job.last" {op, state} with reason in <code>.

export function ChildRowActions(props: { apiBase: string; link: LinkRowWire; onJob(job: ChildJobView): void;
  onError(error: LinkActionErrorView | null): void; disabled: boolean }): ReactElement | null;
// null for client-initiated rows (no SSH route, 004 D3). Buttons: Check (observe), Sync now (sync),
// Restart Codex (opens RestartCodexDialog), Update (enabled when updateAvailable(row); otherwise disabled with
// a title naming the owner action or "up to date"). Every button is disabled while rowOperable() is false.
// Click → postChildOperation(apiBase, { op, linkIds: [link.id] }) → onJob(job); a LinkApiError → onError(linkActionError(error)).

export function RestartCodexDialog(props: { alias: string; open: boolean; onCancel(): void;
  onConfirm(scope: "app-server" | "codex"): void }): ReactElement;
// Two radio options with their scope text, default "app-server":
//   "remoteLink.restart.scope.appServer" + "remoteLink.restart.scope.appServerBody"
//   "remoteLink.restart.scope.codex" + "remoteLink.restart.scope.codexBody" {alias}
// Confirm posts { op: "restart-codex", linkIds: [id], restart: scope }. Uses the existing dialog shell of
// RemoteLinkDialogs.tsx (focus trap, Escape cancels).

export function ChildBulkBar(props: { apiBase: string; rows: readonly LinkRowWire[]; onJob(job: ChildJobView): void;
  onError(error: LinkActionErrorView | null): void }): ReactElement | null;
// "Check all" → { op: "observe", linkIds: "all" }; "Update" (one row) → confirm text
// "remoteLink.child.updateConfirm" {alias, version} → { op: "update", linkIds: [id] }; "Update all" → confirm text
// "remoteLink.child.updateAllConfirm" {version: homeVersion, count} → { op: "update", linkIds: "all" }.
// Hidden when no row is hub-initiated; "Update all" disabled when no row has updateAvailable().

export function useChildJob(apiBase: string, job: ChildJobView | null): { job: ChildJobView | null; missing: boolean };
// Polls getChildJob every CHILD_JOB_POLL_MS while state !== "done" and the document is visible; aborts on
// unmount or job change. Revision 4 (4529522094): a 404 job_not_found (the Home restarted) ends polling and sets
// missing: true; the last snapshot is kept for reference only.

export function ChildJobProgress(props: { apiBase: string; job: ChildJobView; onDone(): void }): ReactElement;
// aria-live="polite" list: alias, "remoteLink.job.state.<state>", reason in <code>, fromVersion→toVersion,
// sync and restart sub-lines ("remoteLink.job.restart.<outcome>"; an outcome outside the seven renders as <code>);
// calls onDone once when state becomes "done". When missing: items still queued or running render
// "remoteLink.job.state.uncertain" (never failed), a neutral Banner shows "remoteLink.job.notFound", and onDone runs
// once so the status rows show what the Child actually reports.

export function ChildPolicyPanel({ apiBase }: { apiBase: string }): ReactElement;
// Loads getChildPolicy once (and after save). Three <select>s and one minutes <input type=number min=1 max=60>;
// Save sends only changed keys through putChildPolicy (idle minutes × 60 000). warning → Banner tone warn
// "remoteLink.policy.invalid". 400 invalid_body / 503 policy_write_failed → translated error.
```
No new colour, spacing or component: `StateBadge`, `Button`, `Banner` (`components/v2-startup/primitives.tsx:25,95`)
and the dialog shell already in `RemoteLinkDialogs.tsx`, so `gui/design-system/` needs no update.

### Locale keys (all 11 catalogs)

English is the source (`en.ts` defines `TKey`, :4384); every other catalog is typed `Record<TKey, string>`, so a
missing key fails typecheck. Each of `de fr ko zh zh-TW ru ja tr vi pt` gets a real translation, never the English
string. English and Korean values below; product names (Codex, GOAT, OpenCodex Desktop) stay untranslated.

| Key | en | ko |
| --- | --- | --- |
| `remoteLink.child.skew.same` | Same version as Home | Home과 같은 버전 |
| `remoteLink.child.skew.behind` | Behind Home ({version}) | Home({version})보다 이전 |
| `remoteLink.child.skew.ahead` | Newer than Home | Home보다 최신 |
| `remoteLink.child.kind.desktopApp` | Desktop app | 데스크톱 앱 |
| `remoteLink.child.kind.source` | Source checkout | 소스 체크아웃 |
| `remoteLink.child.kind.unknown` | Unknown install | 알 수 없는 설치 |
| `remoteLink.child.updateAvailable` | Update available: {version} | 업데이트 가능: {version} |
| `remoteLink.child.catalog.current` | Catalog current | 카탈로그 최신 |
| `remoteLink.child.catalog.behind` | Catalog out of date | 카탈로그 오래됨 |
| `remoteLink.child.codex.restartNeeded` | Codex restart needed ({count}) | Codex 재시작 필요 ({count}) |
| `remoteLink.child.codex.notRunning` | Codex not running | Codex 실행 안 함 |
| `remoteLink.child.ownerAction.legacy-ocx` | Update OpenCodex on this Child by hand | 이 Child의 OpenCodex를 직접 업데이트하세요 |
| `remoteLink.child.ownerAction.desktop-app` | Use Check for Updates in OpenCodex Desktop on this Child | 이 Child의 OpenCodex Desktop에서 업데이트 확인을 사용하세요 |
| `remoteLink.child.ownerAction.goat` | GOAT keeps this Child updated | GOAT가 이 Child를 업데이트합니다 |
| `remoteLink.child.ownerAction.child-initiated` | This Child linked itself; update it there | 이 Child가 직접 연결했습니다. 그곳에서 업데이트하세요 |
| `remoteLink.child.ownerAction.generic` | Needs an update on the Child itself | Child에서 직접 업데이트해야 합니다 |
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
| `remoteLink.job.restart.<7 outcomes>` (7) | Restart requested, Restart not supported, Restart not run, Restart withheld: a turn was running, Restarted, Restart refused, Restart failed | 재시작 요청됨, 재시작 미지원, 재시작 안 함, 재시작 보류: 작업 진행 중, 재시작됨, 재시작 거부됨, 재시작 실패 |
| `remoteLink.job.last` | Last {op}: {state} | 마지막 {op}: {state} |
| `remoteLink.job.notFound` (Revision 4) | This Home restarted, so the job's progress is gone. The rows below show each Child's current state. | 이 Home이 다시 시작되어 작업 진행 상황이 사라졌습니다. 아래 행에 각 Child의 현재 상태가 표시됩니다. |
| `remoteLink.job.automatic` | Automatic | 자동 |
| `remoteLink.policy.title` | Child automation | Child 자동화 |
| `remoteLink.policy.catalogFanout` + `.auto` `.manual` | Catalog fan-out: Automatic / Manual | 카탈로그 전파: 자동 / 수동 |
| `remoteLink.policy.childCodexRestart` + `.never` `.whenIdle` | Codex restart: Never / App-servers when idle | Codex 재시작: 안 함 / 유휴 시 앱 서버 |
| `remoteLink.policy.updates` + `.off` `.notify` `.autoWhenIdle` | Updates: Off / Notify only / Automatic when idle | 업데이트: 끔 / 알림만 / 유휴 시 자동 |
| `remoteLink.policy.idleMinutes` | Idle after (minutes) | 유휴 판단 시간(분) |
| `remoteLink.policy.save` / `.saved` | Save / Saved | 저장 / 저장됨 |
| `remoteLink.policy.invalid` | The saved policy file is damaged; defaults are in effect until you save. | 저장된 정책 파일이 손상되어 저장할 때까지 기본값이 적용됩니다. |
| `remoteLink.error.invalid_job_id` | The operation id is invalid. | 작업 ID가 올바르지 않습니다. |
| `remoteLink.error.job_not_found` | The operation is no longer known; the Home may have restarted. | 작업을 찾을 수 없습니다. Home이 재시작되었을 수 있습니다. |
| `remoteLink.error.link_operation_in_progress` | Another operation is running on this Child. | 이 Child에서 다른 작업이 진행 중입니다. |
| `remoteLink.error.no_eligible_links` | No Home-initiated Child is available for this. | 이 작업에 사용할 수 있는 Home 시작 Child가 없습니다. |
| `remoteLink.error.policy_write_failed` | The Child policy could not be saved. | Child 정책을 저장하지 못했습니다. |

Reason codes (`legacy-ocx`, `rolled-back`, …) render inside `<code>` as machine text (gui/AGENTS.md
allowlist); only the five owner-action reasons above get sentences.

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
| `restart.outcome` (7 values, Revision 4) | 030 (`skipped` included) + 080 | job document | enum, unknown ⇒ `<code>` text, never `requested` | progress sub-line |
| `{policy, warning}` | 050 policy routes | GET/PUT JSON | `parseChildPolicyRead` | `ChildPolicyPanel` |
| `ChildOperationBody` | `ChildRowActions`, `ChildBulkBar`, dialog | POST JSON, exactly `{op, linkIds, restart?}` | 030 route parser | engine |
| five error codes | 030/050 routes | `{error:{code}}` | `readLinkJson` → `LinkApiError` | `ERROR_TKEY` → banner |

## Tests

`gui/tests` is not in the root test layout (003 §4), so nothing is registered. `gui/tests/remote-link-child-ops.test.tsx`
(NEW, same happy-dom harness as `remote-link.test.tsx:1-57`; fetch stubbed per path). It fails before
implementation because `../src/pages/RemoteLinkChildActions` does not exist.

1. *status is requested with children=1* — assert the first fetch URL ends `/api/link/status?children=1`.
2. *older Home renders today's row* — status without `child`: no version badge, no child buttons, Disconnect enabled.
3. *badges* — row with `versionSkew:"behind"`, `route:"orchestrated"`, `catalog.state:"behind"`,
   `codex:{appServers:"stale",staleCount:2,…}`: shows skew, "Update available", "Catalog out of date",
   "Codex restart needed (2)"; with `route:"owner-action"`, `reason:"desktop-app"` shows the Desktop sentence.
4. *Check / Sync now / Update post exact bodies* — click each; assert POST bodies `{op:"observe",linkIds:[id]}` etc.
5. *Restart Codex dialog* — opens with app-server selected and the scope text present (the "not refreshed"
   sentence); confirm posts `restart:"app-server"`; choosing the desktop scope shows `codexBody` with the alias and posts `restart:"codex"`.
6. *Update and Update all* — the row Update confirm names alias and version and contains the "ends any turn currently
   relayed" and "Automatic updates wait" sentences (English catalog), then posts `{op:"update",linkIds:[id]}`; Update all's
   confirm names count and version with the same two sentences and posts `{op:"update",linkIds:"all"}`; disabled when no
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

- `docs-site/src/content/docs/guides/remote-link.md`: new "### Child versions and actions" under "## Link status"
  (:66): what each badge means, the four actions, Update all (one at a time, Home version only), the Restart
  Codex scopes with the app-server caveat, the policy panel and its defaults (catalog fan-out automatic, Codex
  restart never, updates automatic when idle, A1), and "do not link a machine you do not own" (D20).
  Same section in `fr/ ja/ ko/ ru/ tr/ zh-cn/ zh-tw/guides/remote-link.md` (English is canonical; docs-site/AGENTS.md).
  wp8's paragraph in "Home and Child versions" (:162-180) is separate; the second PR rebases.
- `structure/remote-link.md:47-51` "Dashboard presentation": rows request `?children=1`; badges and actions are
  rendered from `child` only; actions post `/api/link/children/operations`; the policy panel reads and writes
  `/api/link/children/policy`. No new owned file outside `gui/` (structure has no gui ownership change).
- No CLI, capability or skill change (`skill:surface` unaffected).
- PR description: one screenshot of a Home with three rows (behind with update, current, ocx-child) and the
  progress panel, uploaded to the `pr-assets` branch and linked by commit SHA; never committed to the PR branch
  (AGENTS.md; `tests/ci-workflows/repo-hygiene.test.ts` rejects asset folders).

## Enforcement bypass record

| Guard | Tier | Executing surface | Known bypass | Residual risk | Wording |
| --- | --- | --- | --- | --- | --- |
| Buttons disabled while a job holds the row | UI-advisory | `ChildRowActions` | Direct API call | Server refuses with 409 (030); the GUI only avoids a needless request | "wait for the running operation" |
| Restart-codex never sends "all" | UI + server | dialog per row; 030 route refuses `"all"` | none client-side | — | — |

## Verifiers

| Command | Run now? | Result (2026-11-11, base 00680193cb) | Reads this phase's target |
| --- | --- | --- | --- |
| `bun run typecheck` | yes | exit 0, "No type errors in 2,379 files" | partly: root `src/**` and tests; the GUI is checked by its own build |
| `cd gui && bun run lint:i18n` | yes | exit 127: `oxlint: command not found` (gui dependencies are not installed in this shared checkout) | yes: `src/pages` (the new TSX) |
| `cd gui && bun ../scripts/test-with-pinned-bun.ts --isolate tests/remote-link.test.tsx tests/locale-parity.test.ts` | yes | exit 1, 2 load errors: `Cannot find package 'react'` (same cause) | yes: `gui/tests/remote-link*` |
| `cd gui && bun install && bun run lint:i18n && bun run test && bun run build` | no | NOT RUN: installs dependencies into the shared checkout; the implementing lane runs it in its own worktree | yes |
| `gui/tests/remote-link-child-ops.test.tsx` | no | new; fails before implementation | yes |
| `bun run structure:check` | at implementation | — | `structure/remote-link.md` |

## Acceptance criteria

1. On a Home with a wp2+ runtime, each Home-initiated row shows the Child version and skew badge; with
   `versionSkew:"behind"` and an orchestrated route it shows "Update available: <Home version>" (test 3).
2. Against a Home without `child` in rows, the page is identical to today and no child request is sent (test 2).
3. Check, Sync now, Restart Codex and Update each post exactly one `{op, linkIds:[id], restart?}` (tests 4–5).
4. The Restart Codex dialog states that the app-server scope does not refresh the Codex desktop app's own
   app-server, and the desktop scope warns that conversations end (test 5).
5. Update all and Check all post `linkIds:"all"`; Update and Update all need a confirmation that names the target
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
2. **Error codes**: five codes join `LINK_ERROR_CODES` (004 D11 named only `link_operation_in_progress`), and the
   GUI parity test's regex is widened for 030's `refusal()` switch, which uses `fail(code, …)`.
3. **Restart scope** is chosen per click in a dialog; the policy panel's `childCodexRestart` only governs the
   automatic restart (050), so there is no "remember scope" setting.

## Carried from wp3 review (#8513)

- Remote Link guide (English + 7 translations): the restart protection paragraph must say to wait for active Codex
  turns to finish before a restart, not only pause new requests, because a turn running a tool has no relayed request in
  flight (CodeRabbit 4533270262).
