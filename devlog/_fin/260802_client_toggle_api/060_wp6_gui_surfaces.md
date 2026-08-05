# 060 — WP6: Integrations overview, client pages, and rollback surfaces

**A-gate amendments (round 1).** This document and `050` are ONE work-phase
(see 050's header); they are built and verified together.

**A-gate amendment (round 2) — native capability cards are deferred.** The
audit was right that a follow-up cannot be declared by silence while this
document remains authoritative, so the scope moves here explicitly.

SHIPPED in this phase: the six file-toggle clients end to end — summary strip
with counts and last change, capability card grid for the six with a state
badge and a working per-card switch, bulk disable that sequences single-client
PUTs and confirms the result against the server, per-client pages with switch,
stale Update, apply-semantics, path, retention warning and history, the
rollback centre, and the restore/drift dialog.

DEFERRED to a follow-up unit: the four NATIVE exception cards (Codex CLI,
Claude Code, Claude Desktop, Grok Build) on the Overview, their status reads
against `/healthz`, `/api/claude-code`, `/api/claude-desktop/status` and
`/api/grok`, the reusable `ClientConfigPanel` under each file-client page, and
the Advanced disclosure.

The reason is a dependency, not effort. Each native client keeps its own
semantics (004 §5.0) and its own page inside the tab strip, which is where
those controls already live and work; a card that mirrors them is a second
read of the same state, and mirroring a state whose write path this unit does
not own is how the two surfaces start disagreeing. The file-toggle clients
carry no such problem because this unit owns their whole contract. Nothing
deferred here blocks a user from applying, disabling, updating or rolling back
any of the six.

Acceptance for the phase is amended to match: the four native cards, native
status reads, `ClientConfigPanel` reuse, and the Advanced disclosure are NOT
phase-closing criteria. The `Component and data tree` in §3 keeps the full
target shape; the deferred rows are marked there.

Shared types come from `006_module_contracts.md` and resolve the open
questions this document raised:

- The journal row is `IntegrationJournalRow` (006 §6). Action eligibility is
  **`undoable`**, and snapshot availability is the tag
  `snapshot === "expired"`. Every reference here uses those canonical fields.
- `snapshotPath` IS emitted by WP4 on `integration_unsafe` and
  `integration_mutation_failed` envelopes (006 §4, 040 amendment), so the
  manual-recovery Notice is reachable and must be implemented rather than
  flagged as blocked.
- Any surface branch that still cannot be reached through the final API
  contract must be deleted rather than shipped as dead UI
  (C-ACTIVATION-GROUNDING-01).

Implementation plan. Depends on WP1–WP5, especially the exact HTTP contract in
`040_wp4_management_api.md`. This package implements `004_ux_design.md`
§§4–10 without adding a second state model in the browser.

## 1. Scope boundary

### IN

- `gui/src/pages/integrations/integration-api.ts` — new browser-side types and
  exact WP4 fetch adapter.
- `gui/src/pages/integrations/IntegrationStateBadge.tsx` — new state badge.
- `gui/src/pages/integrations/IntegrationsOverview.tsx` — new summary strip,
  capability-aware card grid, onboarding, bulk-disable flow, and rollback
  center.
- `gui/src/pages/integrations/FileIntegrationPage.tsx` — new shared page for
  OpenCode, Pi, Hermes, OpenClaw, Kimi, and Gajae.
- `gui/src/pages/integrations/RestoreDialog.tsx` — new restore/drift dialog.
- **[DEFERRED — round-2 amendment]**
  `gui/src/components/apikeys-workspace/ClientConfigPanel.tsx` and
  `ClientConfigDialog.tsx` — make the existing export surface reusable for one
  client without asserting whether an API key exists.
- `gui/src/ui.tsx` — extend `Switch` with `aria-describedby`.
- `gui/src/styles-integrations.css` and `gui/src/styles.css` — new layout
  classes using only existing tokens; one import in `styles.css`.
- `gui/src/i18n/{en,ko,de,zh,ru,ja}.ts` — all visible copy.
- `gui/tests/integrations-surfaces.test.tsx` — state, action, error, and a11y
  branch tests.

### OUT

- No changes to WP4 routes, state names, journal storage, snapshot retention,
  ownership policy, or writer behavior.
- No takeover mutation: WP4 deliberately exposes no takeover endpoint.
- No bulk API: `모두 해제` sequences the exact single-client `PUT` route.
- No switches for Codex CLI, Claude Desktop, or Grok Build.
- No invented version probe, raw on-disk config endpoint, model-setting
  mutation, or snapshot-byte response.
- No new color token, icon package, query library, or state store.

## 2. Contract boundaries and remaining open questions

These are contract gaps, not GUI details. Do not infer the missing facts from
paths or stale client state.

**OPEN QUESTION — advanced/settings data.** WP4 toggle accepts only
`{ enabled: boolean }`; state does not expose model selection, default-model
pointer, raw managed content, or ownership fingerprints. WP6 can ship path,
state, reason, applied time, and history; export ships with the deferred
per-client panel (round-2 amendment), not in this phase. The model picker, default-model
control, raw-file preview, and fingerprint detail from `004` §5.4 require a
later contract. Keep an explicit unavailable note; do not create inert inputs.

**OPEN QUESTION — detection version.** WP4 exposes `installed` but no version.
Cards say installed/not installed and omit version. Add version only after a
server-owned field exists.

These questions do not block any specified WP6 branch; unavailable settings
and version UI remains omitted rather than rendered as inert controls.

Deleted branch: the disabled “No file to restore” row was unreachable because
`snapshot: "none"` is a valid restore-to-absence operation under 006 §3/§6.

## 3. Component and data tree

```text
Integrations (WP5 hash owner)
├─ IntegrationsOverview(active)
│  ├─ GET /api/client-integrations
│  ├─ GET /api/client-integrations/journal
│  ├─ native status reads: /healthz, /api/claude-code,        [DEFERRED]
│  │  /api/claude-desktop/status, /api/grok
│  ├─ IntegrationSummary
│  │  ├─ counts + last operation
│  │  ├─ onboarding line
│  │  └─ BulkDisableDialog -> six possible PUTs
│  ├─ CapabilityCardGrid
│  │  ├─ four native exception cards                          [DEFERRED]
│  │  └─ six FileClientCard -> IntegrationStateBadge + Switch
│  └─ RollbackCenter
│     └─ RestoreDialog -> POST /api/client-integrations/restore
├─ ApiKeys(active)                         existing, migrated in WP5
├─ Codex informational page                WP5 inline
├─ Claude(active)                          existing native flow
├─ Grok(active)                            existing native flow
└─ FileIntegrationPage(client, active) × 6
   ├─ GET /api/client-integrations/:clientId
   ├─ GET /api/client-integrations/journal?client=:clientId
   ├─ IntegrationStateBadge
   ├─ Switch / refresh / restore actions
   ├─ status + apply-semantics facts
   ├─ ClientConfigPanel(clients=[client])                     [DEFERRED]
   ├─ Advanced disclosure (contract-backed facts only)        [DEFERRED]
   └─ RestoreDialog
```

State ownership:

- Hash/navigation: WP5 router.
- Server state/cache: existing `useDataSurface` + keyed client resource.
- Dialog/open/pending/error: nearest Overview or client page.
- Derived counts, badge tone, disabled reason, newest-row grouping: render
  calculation; do not mirror with effects.
- Onboarding dismissal only: `localStorage` key
  `ocx-integrations-onboarding-v1`, written after the first successful apply.

## 4. `gui/src/pages/integrations/integration-api.ts` — paste-ready

```ts
export const FILE_INTEGRATION_CLIENTS = [
  "opencode",
  "pi",
  "hermes",
  "openclaw",
  "kimi",
  "gajae",
] as const;

export type FileIntegrationClientId = (typeof FILE_INTEGRATION_CLIENTS)[number];
export type IntegrationClientId = FileIntegrationClientId;
export type IntegrationState = "absent" | "current" | "stale" | "conflict" | "unsafe";
export type IntegrationReason =
  | "unparseable"
  | "not-regular-file"
  | "foreign-edit"
  | "unowned-key";

export interface IntegrationStatus {
  clientId: FileIntegrationClientId;
  state: IntegrationState;
  installed: boolean;
  configPath: string;
  appliedAt?: string;
  lastOpId?: string;
  reason?: IntegrationReason;
  /** Snapshot files retained for this client (006 §5). */
  snapshotCount: number;
  /**
   * Pruning is behind, so old snapshots may still exist. Rendered as a line on
   * the client page's status row, never as a state badge — it is a maintenance
   * condition, not an integration state.
   */
  retentionDegraded: boolean;
}

export interface IntegrationStateListEnvelope {
  clients: IntegrationStatus[];
}

export interface IntegrationJournalRow {
  opId: string;
  clientId: IntegrationClientId;
  kind: "apply" | "disable" | "refresh" | "restore";
  at: string;
  configPath: string;
  snapshot: "none" | "stored" | "expired";
  undoable: boolean;
}

export interface IntegrationJournalEnvelope {
  operations: IntegrationJournalRow[];
}

export interface IntegrationMutationEnvelope {
  clientId: FileIntegrationClientId;
  ok: true;
  changed: boolean;
  state: IntegrationState;
  opId?: string;
  message?: string;
  reason?: string;
}

export interface IntegrationErrorBody {
  error?: string;
  code?: string;
  clientId?: FileIntegrationClientId;
  state?: string;
  reason?: string;
  opId?: string;
  snapshotPath?: string;
}

export class IntegrationApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: IntegrationErrorBody,
  ) {
    super(body.error ?? `HTTP ${status}`);
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & IntegrationErrorBody;
  if (!response.ok) throw new IntegrationApiError(response.status, body);
  return body;
}

export async function loadIntegrationStates(apiBase: string, signal?: AbortSignal) {
  return readResponse<IntegrationStateListEnvelope>(
    await fetch(`${apiBase}/api/client-integrations`, { signal }),
  );
}

export async function loadIntegrationState(
  apiBase: string,
  client: FileIntegrationClientId,
  signal?: AbortSignal,
) {
  return readResponse<IntegrationStatus>(
    await fetch(`${apiBase}/api/client-integrations/${encodeURIComponent(client)}`, { signal }),
  );
}

export async function loadIntegrationJournal(
  apiBase: string,
  client?: FileIntegrationClientId,
  signal?: AbortSignal,
) {
  const query = client ? `?client=${encodeURIComponent(client)}` : "";
  return readResponse<IntegrationJournalEnvelope>(
    await fetch(`${apiBase}/api/client-integrations/journal${query}`, { signal }),
  );
}

export async function toggleIntegration(
  apiBase: string,
  client: FileIntegrationClientId,
  enabled: boolean,
) {
  return readResponse<IntegrationMutationEnvelope>(
    await fetch(`${apiBase}/api/client-integrations/${encodeURIComponent(client)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  );
}

export async function restoreIntegration(
  apiBase: string,
  opId: string,
  confirmDrift = false,
) {
  return readResponse<IntegrationMutationEnvelope>(
    await fetch(`${apiBase}/api/client-integrations/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ opId, confirmDrift }),
    }),
  );
}
```

`snapshot` and `undoable` are derived by WP4 for every request. The GUI never
infers either value from row order, paths, or a failed restore.

## 5. `IntegrationStateBadge.tsx` — paste-ready

```tsx
import { useT, type TKey } from "../../i18n/shared";
import type { IntegrationState } from "./integration-api";

export type VisualIntegrationState = "not-installed" | IntegrationState;

const LABEL_KEYS: Record<VisualIntegrationState, TKey> = {
  "not-installed": "integrations.state.notInstalled",
  absent: "integrations.state.absent",
  current: "integrations.state.current",
  stale: "integrations.state.stale",
  conflict: "integrations.state.conflict",
  unsafe: "integrations.state.unsafe",
};

const CLASSES: Record<VisualIntegrationState, string> = {
  "not-installed": "badge badge-muted",
  absent: "badge badge-muted",
  current: "badge badge-green",
  stale: "badge badge-amber",
  conflict: "badge integration-badge--danger",
  unsafe: "badge integration-badge--danger-outline",
};

export default function IntegrationStateBadge({
  state,
  installed,
  id,
}: {
  state: IntegrationState;
  installed: boolean;
  id?: string;
}) {
  const t = useT();
  const visual: VisualIntegrationState = installed ? state : "not-installed";
  return (
    <span id={id} className={CLASSES[visual]} data-integration-state={visual}>
      {t(LABEL_KEYS[visual])}
    </span>
  );
}
```

Branch activation and proof:

| Branch | Activation | Observable proof |
|---|---|---|
| not installed | `installed === false`, regardless of backend `state` | text is `미설치`, `data-integration-state="not-installed"`, muted class |
| absent | installed + `state === "absent"` | `미적용`, muted class, switch off |
| current | installed + `current` | `적용됨`, green class, switch on |
| stale | installed + `stale` | `업데이트 필요`, amber class, switch on + refresh action |
| conflict | installed + `conflict` | `충돌`, filled red class, locked switch described by badge |
| unsafe | installed + `unsafe` | `확인 불가`, red outline class, locked switch described by badge |

Text and shape accompany color in every branch.

## 6. `IntegrationsOverview.tsx` — structural implementation spec

This file will exceed 120 lines. Implement exactly the following public and
local types; do not split state ownership into a new global store.

```ts
export interface IntegrationsOverviewProps { apiBase: string; active?: boolean }
type Message = { tone: "ok" | "err"; key: TKey; vars?: Record<string, string | number> };
type NativeStatus = {
  codexOnline: boolean | null;
  claudeEnabled: boolean | null;
  desktopApplied: boolean | null;
  desktopStale: boolean | null;
  grokPresent: boolean | null;
};
type RestoreSelection = { operation: IntegrationJournalRow; mode: "undo" | "restore" };
```

### 6.1 Resource loading

- State resource key: `integrations-state-list:${apiBase}`; loader calls exact
  `GET /api/client-integrations`; `enabled: active`; empty means
  `clients.every(client => !client.installed)` only for rendering, not for
  resource classification (the six-row response itself is populated).
- Journal resource key: `integrations-journal:${apiBase}`; exact
  `GET /api/client-integrations/journal`; `enabled: active`; `isEmpty` means
  `operations.length === 0`.
- **[DEFERRED — round-2 amendment]** Native resource key:
  `integrations-native:${apiBase}`; one loader uses
  `Promise.allSettled` for exact existing reads:
  `GET /healthz`, `GET /api/claude-code`,
  `GET /api/claude-desktop/status`, `GET /api/grok`. A failed child maps only
  its fields to `null`; it does not erase the six file-client cards.
- Pass each loader's `AbortSignal` to every fetch. No polling is introduced on
  Overview; explicit refresh after mutations plus remount/cache is enough.

### 6.2 Derived summary

Compute during render:

```ts
const detected = clients.filter(client => client.installed).length;
const applied = clients.filter(client => client.installed
  && (client.state === "current" || client.state === "stale")).length;
const stale = clients.filter(client => client.installed && client.state === "stale").length;
const disableCandidates = clients.filter(client => client.installed
  && (client.state === "current" || client.state === "stale"));
const recentOperations = operations.slice(0, 5);
const lastChangedAt = operations[0]?.at;
```

Do not count `conflict` as applied: the entry may exist, but the GUI cannot
assert that the edited file still routes correctly. Unsafe is also excluded.

### 6.3 Exact markup order

1. `<section className="integrations-summary" aria-labelledby="integrations-summary-title">`
   with visually hidden `h3`, a `<dl>` containing detected/applied/stale/last
   change facts, and a quiet `모두 해제…` button.
2. Onboarding `<p className="integrations-onboarding">` immediately after the
   summary when journal is settled-empty and localStorage is not dismissed.
3. Cold error `Notice tone="err"` + retry button; do not also render empty.
4. Known-structure skeleton grid when state list is cold-loading.
5. Empty `EmptyState` when all six report `installed: false`; include a list of
   supported client names and deep links, not a bare grid.
6. Otherwise `<ul className="integration-card-grid">` in stable order.
   SHIPPED: the six file clients — OpenCode, Pi, Hermes, OpenClaw, Kimi,
   Gajae. **[DEFERRED — round-2 amendment]** the four native cards that would
   precede them: Codex, Claude Code, Claude Desktop, Grok.
7. `<section className="rollback-center">` with heading and newest five rows.

The summary is compact ops chrome, not a marketing hero: no oversized display
type, gradient, illustration, trust strip, or animation.

### 6.4 File-client card

Each `<li className="integration-card">` contains:

- mark from `CLIENT_MARKS`; monogram fallback; empty `alt` because adjacent
  text names the client;
- `h3` client name + `IntegrationStateBadge`;
- detection text and `<code>{configPath}</code>`;
- switch and optional refresh button;
- bottom fact line from `appliedAt` and whether retained backup is known;
- a real anchor/button that calls `navigateHash("integrations/<id>")`.

Switch derivation:

```ts
const on = state === "current" || state === "stale";
const locked = !installed || state === "conflict" || state === "unsafe" || pending;
```

- `absent` click -> PUT `{ enabled: true }`.
- `current`/`stale` switch click -> PUT `{ enabled: false }`.
- `stale` also renders `업데이트` -> PUT `{ enabled: true }` (WP3 interprets
  apply-from-stale as refresh).
- success refreshes state + journal, emits success Notice/live announcement,
  and writes the onboarding dismissal key only for successful enable/refresh.
- any failure retains the old card state and maps the server error code to an
  error Notice; never optimistically flip a file mutation.

### 6.5 Native exception cards — **[DEFERRED — round-2 amendment]**

This whole section is target state, not phase-closing scope. The four native
clients keep their own semantics and each already owns a working page inside
the tab strip.

- Codex: `/healthz` liveness text; no switch; action deep-links `#startup`.
- Claude Code: native enabled status and `Switch`; mutation remains exact
  `PUT /api/claude-code { enabled }`, then refresh native status. It does not
  enter the file journal.
- Claude Desktop: applied/stale fingerprint status from its existing status
  response; no switch; action deep-links
  `#integrations/claude/desktop`.
- Grok: `present` from `GET /api/grok`; no switch; action deep-links
  `#integrations/grok`.

If one native read is null, that card says status unavailable and retains its
deep link; it never borrows a five-state badge.

### 6.6 Bulk disable

- Show the button only when `disableCandidates.length > 0`.
- Dialog lists exactly those clients and states that each PUT removes only the
  opencodex-owned block and stores a pre-write snapshot.
- On confirm, run sequentially in stable client order with
  `toggleIntegration(apiBase, clientId, false)`. Sequential execution makes
  the partial outcome list deterministic; WP4 has no transaction/bulk route.
- Continue after one failure, collect client labels, refresh state + journal,
  and show either success or a partial-failure Notice naming failed clients.
- Conflict/unsafe/not-installed/absent clients never enter the confirm list.

### 6.7 Rollback center

- Empty: `<EmptyState title={t("integrations.rollback.empty")}>` plus the
  backup promise sentence.
- Row: `<li>` with localized kind, client, formatted `at`, and one action.
- `undoable === true` -> `되돌리기`; opens undo-mode `RestoreDialog`.
- `undoable === false && snapshot !== "expired"` -> `이 시점으로 복원…`;
  this includes `snapshot === "none"`, whose restore target is file absence.
- `snapshot === "expired"` -> disabled `백업 만료됨`; it takes precedence
  over `undoable` and never opens a dialog or sends a request.
- Restore opens `RestoreDialog`; no direct write on row click.

## 7. `FileIntegrationPage.tsx` — structural implementation spec

Public contract:

```ts
export type { FileIntegrationClientId } from "./integration-api";
export interface FileIntegrationPageProps {
  apiBase: string;
  client: FileIntegrationClientId;
  active?: boolean;
}
```

Static metadata is compile-time complete:

```ts
const CLIENT_META: Record<FileIntegrationClientId, {
  labelKey: TKey;
  semanticsKey: TKey;
}> = {
  opencode: { labelKey: "integrations.tab.opencode", semanticsKey: "integrations.semantics.opencode" },
  pi: { labelKey: "integrations.tab.pi", semanticsKey: "integrations.semantics.pi" },
  hermes: { labelKey: "integrations.tab.hermes", semanticsKey: "integrations.semantics.hermes" },
  openclaw: { labelKey: "integrations.tab.openclaw", semanticsKey: "integrations.semantics.openclaw" },
  kimi: { labelKey: "integrations.tab.kimi", semanticsKey: "integrations.semantics.kimi" },
  gajae: { labelKey: "integrations.tab.gajae", semanticsKey: "integrations.semantics.gajae" },
};
```

### 7.1 Data/API

- Status: exact `GET /api/client-integrations/:clientId`, resource key
  `integration-state:${apiBase}:${client}`, `enabled: active`.
- History: exact
  `GET /api/client-integrations/journal?client=:clientId`, resource key
  `integration-journal:${apiBase}:${client}`, `enabled: active`.
- Toggle/refresh: exact PUT with boolean only.
- Restore: exact POST with `{ opId, confirmDrift }` only.
- Export **[DEFERRED — round-2 amendment]**: existing exact
  `GET /api/client-config?client=:clientId` through `ClientConfigRow`; no
  duplicate serializer in the browser. Ships with the per-client export panel
  in the follow-up unit.

### 7.2 Markup anatomy

1. Cold skeleton: one header skeleton, three fact-line skeletons, one panel.
2. Cold error: `Notice tone="err"` + retry; no switch and no empty state.
3. Header `<header className="integration-client-head">`:
   mark/name, badge (stable id), switch, stale-only refresh button, and restore
   button when at least one non-expired journal row exists.
4. Status `<dl className="integration-status-line">`: applied time, latest
   operation time, config path. Unknown facts render translated `—` labels,
   not fabricated dates.
4b. Retention notice, rendered **only** when `status.retentionDegraded` is
   true, immediately after the status list:

   ```tsx
   {status.retentionDegraded && (
     <p className="integration-retention" role="status">
       {t("integrations.retention.degraded")}
     </p>
   )}
   ```

   It is a line, never a state badge — pruning being behind is a maintenance
   condition, not an integration state (006 §5). i18n key
   `integrations.retention.degraded`: en "Backup cleanup is behind; older
   backups may still be on disk." / ko "백업 정리가 밀려 있습니다 — 오래된
   백업이 남아 있을 수 있습니다."

   | Activation | Observable proof |
   |---|---|
   | state response carries `retentionDegraded: true` | the paragraph renders with `role="status"`; with `false` it is absent from the DOM |

   Test (`gui/tests/integrations-surfaces.test.tsx`):
   `renders the retention notice only when degraded`.
5. Semantics note `<p className="integration-semantics">`.
6. Error Notice adjacent to the header action that failed.
7. **[DEFERRED — round-2 amendment]** Export/settings panel:
   `<ClientConfigPanel clients={[client]} apiBase={apiBase} />` after §9
   refactor.
8. **[DEFERRED — round-2 amendment]** `<details className="integration-advanced">`:
   config path, state reason, last operation id, and an explicit note that raw
   file/fingerprint data is unavailable until §2 is resolved. Do not display
   generated export text as if it were current on-disk content.
9. Per-client history list using the same row helper as Overview; extract a
   local shared `OperationRows` component only if implementation proves both
   call sites have identical props and branches.

### 7.3 Header action branches

- not installed: switch disabled; restore remains available from any
  non-expired history row, including `snapshot === "none"`; install guidance
  visible.
- absent: switch off/enabled; click applies.
- current: switch on/enabled; click disables.
- stale: switch on/enabled; click disables; separate Update button reapplies.
- conflict: switch on only if backend semantics explicitly say managed block
  exists; current contract does not, so render `on={false}` but locked and let
  the badge carry truth. Restore remains reachable from non-expired history.
- unsafe: switch off + locked; restore remains reachable from non-expired
  history; config-path action visible.
- pending: all mutation controls disabled; current badge remains visible;
  `aria-busy="true"` on page section.

Do not derive conflict's binary switch position from the state name. The
five-state contract says ownership is untrusted, not whether bytes currently
contain a working block.

## 8. `RestoreDialog.tsx` — paste-ready

```tsx
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { IntegrationApiError, restoreIntegration, type IntegrationJournalRow } from "./integration-api";

export default function RestoreDialog({
  apiBase,
  operation,
  onClose,
  onRestored,
}: {
  apiBase: string;
  operation: IntegrationJournalRow;
  onClose: () => void;
  onRestored: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const [pending, setPending] = useState(false);
  const [drift, setDrift] = useState(false);
  const [error, setError] = useState<IntegrationApiError | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
      triggerRef.current?.focus();
    };
  }, []);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await restoreIntegration(apiBase, operation.opId, drift);
      onRestored();
      onClose();
    } catch (cause) {
      if (cause instanceof IntegrationApiError
        && cause.body.code === "integration_drift_confirmation_required") {
        setDrift(true);
      } else {
        setError(cause instanceof IntegrationApiError
          ? cause
          : new IntegrationApiError(0, { error: t("integrations.error.generic") }));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="integration-restore-title"
      aria-describedby="integration-restore-description"
      onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    >
      <div className="modal-card integration-restore-dialog">
        <h3 id="integration-restore-title">
          {t(drift ? "integrations.restore.driftTitle" : "integrations.restore.title")}
        </h3>
        <p id="integration-restore-description" className="modal-desc">
          {t(drift ? "integrations.restore.driftBody" : "integrations.restore.body")}
        </p>
        {error && (
          <div className="alert alert-err" role="alert">
            {error.body.snapshotPath
              ? t("integrations.restore.manual", { path: error.body.snapshotPath, reason: error.body.reason ?? error.message })
              : error.message}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={pending}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={pending}>
            {t(pending ? "integrations.restore.pending" : drift ? "integrations.restore.confirmDrift" : "integrations.restore.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
```

The initial submit is the plain confirm. Drift mode activates only after the
exact WP4 409 code; its second submit sends `confirmDrift: true`. The dialog
does not guess drift from timestamps. When either `integration_unsafe` or
`integration_mutation_failed` carries `snapshotPath`, the error branch renders
`integrations.restore.manual` with the exact path and refusal reason, keeps the
dialog open, and leaves retry/cancel available.

## 9. Reuse the existing export surface — **[DEFERRED — round-2 amendment]**

The `ClientConfigPanel` refactor lands with the deferred per-client
export/settings panel, not in this phase.

Change `ClientConfigPanel` props to:

```ts
{
  apiBase: string;
  clients?: readonly ExportClientId[]; // default CLIENTS
  baseUrl?: string;
  hasKeys?: boolean;                   // unknown when omitted
}
```

- map `clients ?? CLIENTS` instead of `CLIENTS`;
- render the base-URL line only when `baseUrl !== undefined`;
- pass `hasKeys` through to `ClientConfigDialog`;
- change dialog no-key branch from `!hasKeys` to `hasKeys === false`;
- Keys page no longer calls this panel after WP5; file pages call it with one
  client and omit key knowledge.

Activation proof:

- API Keys legacy caller (if temporarily retained during stacked work) passes
  explicit `hasKeys` and preserves current no-key copy.
- File page omits `hasKeys`; no false “you have no key” warning renders.
- `clients={[client]}` makes exactly one request and one export row.
- OpenCode/Pi and the four WP1 formats use server-provided `text`, `format`,
  and filename; the WP1 GUI consumer maps the closed `format` union to its
  download media type. The GUI does not `JSON.stringify` non-JSON files or
  infer format from a filename.

## 10. `Switch` a11y contract — exact diff

```diff
-export function Switch({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
+export interface SwitchProps {
+  on: boolean;
+  onClick: () => void;
+  disabled?: boolean;
+  label?: string;
+  "aria-describedby"?: string;
+}
+
+export function Switch({
+  on,
+  onClick,
+  disabled,
+  label,
+  "aria-describedby": ariaDescribedBy,
+}: SwitchProps) {
   return (
     <button type="button" className={`switch${on ? " on" : ""}`} onClick={onClick} disabled={disabled}
-      aria-pressed={on} aria-label={label ?? (on ? "enabled" : "disabled")}>
+      aria-pressed={on} aria-label={label ?? (on ? "enabled" : "disabled")}
+      aria-describedby={ariaDescribedBy}>
```

For conflict/unsafe, pass the badge id. For not-installed, pass the install
guidance id. Pending alone does not change the description; retain the state
description. Proof: the disabled button's accessible description names why it
cannot be toggled.

## 11. State-to-visual mapping using existing CSS tokens

| Visual state | Badge class | Existing tokens | Switch/action |
|---|---|---|---|
| not installed | `badge badge-muted` | `--raised`, `--muted`, `--border` | disabled/off; install guidance |
| absent | `badge badge-muted` | same | enabled/off; apply |
| current | `badge badge-green` | `--green-soft`, `--green` | enabled/on; disable + restore |
| stale | `badge badge-amber` | `--amber-soft`, `--amber` | enabled/on; refresh + disable + restore |
| conflict | `integration-badge--danger` | `--red-soft`, `--red` | locked; restore from non-expired history + inspect |
| unsafe | `integration-badge--danger-outline` | transparent, `--red`, `--border` | locked; restore from non-expired history + path |

Create `gui/src/styles-integrations.css` with these required rules (responsive
values may be tuned during browser QA, but no token substitutions):

```css
.integrations-summary {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  padding: var(--space-4); margin-bottom: var(--space-4);
  background: var(--glass-panel); border: 1px solid var(--border); border-radius: var(--radius);
}
.integrations-summary dl { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin: 0; }
.integrations-summary dt { color: var(--muted); font-size: var(--text-label); }
.integrations-summary dd { margin: 0; font-family: var(--font-code); font-size: var(--text-control); }
.integrations-onboarding { padding: var(--space-3); border-left: 3px solid var(--accent); background: var(--accent-soft); }
.integration-card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); padding: 0; list-style: none; }
.integration-card { display: grid; gap: var(--space-3); min-width: 0; padding: var(--space-4); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.integration-card__head, .integration-client-head { display: flex; align-items: center; gap: var(--space-3); }
.integration-card__head .badge { margin-left: auto; }
.integration-card__path { overflow-wrap: anywhere; font-family: var(--font-code); color: var(--muted); }
.integration-card__actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-2); }
.integration-badge--danger { background: var(--red-soft); color: var(--red); }
.integration-badge--danger-outline { background: transparent; color: var(--red); border-color: var(--red); }
.integration-status-line { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); font-family: var(--font-code); }
.integration-status-line dt { color: var(--muted); font-family: var(--font-ui); font-size: var(--text-label); }
.integration-status-line dd { margin: 0; overflow-wrap: anywhere; }
.rollback-center { margin-top: var(--space-6); }
.rollback-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); }
.rollback-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-soft); }
.rollback-row:last-child { border-bottom: 0; }
.integration-skeleton-card { min-height: 170px; background: var(--raised); border: 1px solid var(--border-soft); border-radius: var(--radius); }
@media (max-width: 720px) {
  .integrations-summary { align-items: stretch; flex-direction: column; }
  .integration-card-grid { grid-template-columns: minmax(0, 1fr); }
  .integration-status-line { grid-template-columns: minmax(0, 1fr); }
  .rollback-row { grid-template-columns: minmax(0, 1fr); }
}
```

Add `@import "./styles-integrations.css";` beside the other workspace imports
at the top of `styles.css`. Do not modify `.page-tabs`; its wrapping contract
already exists.

## 12. Every UX state — concrete markup

| State | Activation | Markup | Observable proof |
|---|---|---|---|
| loading | active page has no held data and request is in flight | `<div className="integration-card-grid" role="status" aria-label={t("common.loading")}>` with one `.integration-skeleton-card` child per rendered card (six in this phase; ten once the deferred native cards land); client page uses header/fact/panel skeletons | stable card geometry; no empty message or enabled action |
| empty | state list settled and all six `installed === false` | `<EmptyState title=...><ul>` containing six install/client links; rollback renders its separate empty state | no bare grid; each supported client remains discoverable |
| failed cold | list/status request failed with no held data | `<Notice tone="err">` + Retry; return before empty/grid | error and empty never coexist; retry calls resource refresh |
| failed with stale | refresh failed while held data exists | keep cards/history, prepend `<Notice tone="err">` with stale wording + Retry | old data remains visible but is not presented as fresh |
| onboarding | journal settled empty and local key absent | `<p className="integrations-onboarding">` explains one owned block, backup first, surgical removal, restore | disappears only after successful apply/refresh and stays dismissed on reload |
| mutation busy | WP4 409 `integration_mutation_busy` | error `Notice`; controls re-enable after request settles | no optimistic state change; message says retry after current mutation |
| conflict error | WP4 409 `integration_conflict` | error `Notice`; card refreshes into conflict badge; switch locks | foreign-edited bytes remain server-owned proof; UI offers no second toggle bypass |
| unsafe error | WP4 409 `integration_unsafe` without `snapshotPath` | error `Notice` with reason and config path | locked switch is described by unsafe badge/path |
| expired journal row | `snapshot === "expired"` | disabled `<button>` labelled `백업 만료됨` | row remains in history; no dialog opens or request is sent |
| drift confirm | first restore returns exact drift-confirmation code | same dialog changes title/body and confirm label; second POST sends `confirmDrift: true` | no overwrite on first response; explicit second activation required |
| manual recovery | restore returns `integration_unsafe` or `integration_mutation_failed` with `snapshotPath` | dialog error Notice names the exact path and reason and remains open | `role="alert"` exposes both values; no path is synthesized from the journal row |
| generic error Notice | any unmapped non-2xx/network failure | `Notice tone="err"` with localized generic copy; technical code may be appended in `<code>` | state/draft remains; retry path visible |

## 13. i18n source values

Add all keys to six locales. English and Korean source values for the
non-product-name keys are fixed below; German, Chinese, Russian, and Japanese
must be naturally translated in the same diff.

| Key | English | Korean |
|---|---|---|
| `integrations.state.notInstalled` | Not installed | 미설치 |
| `integrations.state.absent` | Not applied | 미적용 |
| `integrations.state.current` | Applied | 적용됨 |
| `integrations.state.stale` | Update needed | 업데이트 필요 |
| `integrations.state.conflict` | Conflict | 충돌 |
| `integrations.state.unsafe` | Cannot verify | 확인 불가 |
| `integrations.summary.detected` | Detected | 감지됨 |
| `integrations.summary.applied` | Applied | 적용 중 |
| `integrations.summary.stale` | Update needed | 업데이트 필요 |
| `integrations.summary.lastChange` | Last change | 마지막 변경 |
| `integrations.summary.disableAll` | Disable all… | 모두 해제… |
| `integrations.onboarding` | Applying writes one opencodex provider block after saving a backup. Disable removes only that block, and a retained snapshot can be restored. | 적용하면 먼저 백업을 보관한 뒤 opencodex 제공자 블록 하나만 씁니다. 해제는 그 블록만 제거하며 보관된 스냅샷으로 복원할 수 있습니다. |
| `integrations.empty.title` | No installed clients were detected | 설치된 클라이언트가 감지되지 않았습니다 |
| `integrations.empty.body` | Install a supported client, then return here to apply opencodex. | 지원 클라이언트를 설치한 뒤 돌아와 opencodex를 적용하세요. |
| `integrations.action.apply` | Apply | 적용 |
| `integrations.action.disable` | Disable | 해제 |
| `integrations.action.refresh` | Update | 업데이트 |
| `integrations.action.settings` | Settings | 설정 |
| `integrations.action.restore` | Restore… | 복원… |
| `integrations.action.undo` | Undo | 되돌리기 |
| `integrations.action.restorePoint` | Restore this point… | 이 시점으로 복원… |
| `integrations.action.snapshotExpired` | Backup expired | 백업 만료됨 |
| `integrations.rollback.title` | Rollback center | 복원 센터 |
| `integrations.rollback.empty` | No apply history yet | 아직 적용 기록이 없습니다 |
| `integrations.rollback.emptyBody` | Every successful write keeps a pre-write snapshot first. | 모든 쓰기는 먼저 변경 전 스냅샷을 보관합니다. |
| `integrations.restore.title` | Restore this snapshot? | 이 스냅샷으로 복원할까요? |
| `integrations.restore.body` | The current file is backed up first, then the selected snapshot replaces it. | 현재 파일을 먼저 백업한 뒤 선택한 스냅샷으로 교체합니다. |
| `integrations.restore.driftTitle` | Newer edits were detected | 스냅샷 이후 변경이 감지되었습니다 |
| `integrations.restore.driftBody` | Changes made after this snapshot will be backed up, then the file will be replaced. | 스냅샷 이후의 변경이 백업으로 보관되고 파일이 교체됩니다. |
| `integrations.restore.confirm` | Restore | 복원 |
| `integrations.restore.confirmDrift` | Back up newer edits and restore | 새 변경을 백업하고 복원 |
| `integrations.restore.pending` | Restoring… | 복원 중… |
| `integrations.restore.manual` | Automatic restore failed: {reason}. Restore manually from {path}. | 자동 복원에 실패했습니다: {reason}. {path}에서 직접 복원하세요. |
| `integrations.error.load` | Could not load integration state. | 연동 상태를 불러오지 못했습니다. |
| `integrations.error.stale` | The latest refresh failed. The values below may be stale. | 최신 새로고침에 실패했습니다. 아래 값은 오래된 정보일 수 있습니다. |
| `integrations.error.busy` | Another change for this client is still running. Try again shortly. | 이 클라이언트의 다른 변경이 진행 중입니다. 잠시 후 다시 시도하세요. |
| `integrations.error.conflict` | The config changed after opencodex wrote it. Nothing was removed. | opencodex가 쓴 뒤 설정이 변경되었습니다. 아무 내용도 제거하지 않았습니다. |
| `integrations.error.unsafe` | The config cannot be changed safely. | 설정을 안전하게 변경할 수 없습니다. |
| `integrations.error.generic` | The integration change failed. Your previous state was kept. | 연동 변경에 실패했습니다. 이전 상태는 유지되었습니다. |
| `integrations.status.installed` | Installed | 설치 감지됨 |
| `integrations.status.notInstalled` | Not installed | 설치되지 않음 |
| `integrations.status.appliedAt` | Applied | 적용 |
| `integrations.status.backup` | Backup | 백업 |
| `integrations.status.lastRestore` | Last restore | 마지막 복원 |
| `integrations.status.unknown` | Unknown | 알 수 없음 |
| `integrations.bulk.title` | Disable applied client integrations? | 적용된 클라이언트 연동을 해제할까요? |
| `integrations.bulk.body` | Only the opencodex-owned block is removed. A pre-write snapshot is kept for each client. | opencodex가 소유한 블록만 제거합니다. 각 클라이언트의 변경 전 스냅샷을 보관합니다. |
| `integrations.bulk.partial` | Some clients could not be disabled: {clients} | 일부 클라이언트를 해제하지 못했습니다: {clients} |
| `integrations.bulk.success` | Applied client integrations were disabled. | 적용된 클라이언트 연동을 해제했습니다. |

Semantics keys:

- `integrations.semantics.opencode`: direct disk launches only; `ocx opencode`
  environment injection takes precedence.
- `integrations.semantics.pi`: applies to new sessions.
- `integrations.semantics.hermes`: “Applies to new sessions.” / “새 세션부터 적용됩니다.”
- `integrations.semantics.openclaw`: “Applies immediately to a running gateway.” / “실행 중인 게이트웨이에 즉시 반영됩니다.”
- `integrations.semantics.kimi`: “Restart or run /reload to apply it (v2 watches the file).” / “재시작 또는 /reload 시 적용됩니다 (v2는 파일 변경을 감지합니다).”
- `integrations.semantics.gajae`: “Applies to a new session or when opening /model.” / “새 세션 또는 /model을 열 때 적용됩니다.”

Add operation-kind labels for apply/disable/refresh/restore and native-card
status/action labels. Product names remain literal under the repository i18n
allowlist; every explanatory sentence remains keyed.

## 14. Accessibility wiring

- Outer and inner tabs follow WP5: tablist, selected state, controls/panels,
  roving tab index, Arrow/Home/End, `preventScroll`.
- Every Switch has a localized label. Locked Switches carry
  `aria-describedby` to the visible badge/guidance text via §10.
- Summary facts use `<dl>`; cards use `<ul>/<li>`; status facts use `<dl>`;
  paths use `<code>` but remain wrapping/readable.
- Mutation container sets `aria-busy`; controls disable during the exact
  request; success Notice is `role="status"`; restore failure inside dialog is
  `role="alert"`.
- Dialog uses native `<dialog>.showModal()`, labelled title/description,
  Escape suppression while pending, and focus restoration to its trigger.
- Bulk confirmation is a dialog, not `window.confirm`, because it must list
  exact clients and partial semantics.
- Marks are decorative (`alt=""`) beside visible names; monograms are
  `aria-hidden`.
- No state is color-only: badge text, switch position, disabled reason, and
  action label all agree.
- Mobile order remains DOM order; no positive tab indices; 44 px conservative
  targets for standalone card actions in the new stylesheet.

## 15. Conditional activation ledger — C-ACTIVATION-GROUNDING-01

Every implementation branch must have the named fixture and proof below.

| Branch | Activation fixture | Observable proof |
|---|---|---|
| each badge variant | six statuses from §5 table | exact text, class, `data-integration-state` |
| disabled/not-installed switch | `installed:false` | disabled/off; description points to install guidance; no PUT |
| disabled/conflict switch | installed conflict | disabled; description points to conflict badge; restore/inspect only |
| disabled/unsafe switch | installed unsafe | disabled; description points to unsafe badge/path; no PUT |
| pending switch | deferred mutation promise | disabled + page `aria-busy`; duplicate click makes one request |
| stale refresh | installed stale + click Update | PUT body exactly `{enabled:true}`; then status/journal refresh |
| current disable | installed current + switch click | PUT exactly `{enabled:false}`; no optimistic visual flip |
| absent apply | installed absent + switch click | PUT exactly `{enabled:true}`; successful response dismisses onboarding |
| expired journal row | `snapshot:"expired"` | disabled “Backup expired”; row remains; no dialog/request |
| undo row | `undoable:true` with `snapshot:"stored"` or `"none"` | “Undo”; opens plain restore dialog for exact op id |
| restore row | `undoable:false` with `snapshot:"stored"` or `"none"` | “Restore this point…”; opens dialog; `"none"` remains actionable as restore-to-absence |
| drift confirm dialog | first POST returns exact drift code | dialog changes copy; second POST includes `confirmDrift:true` |
| restore refusal/manual Notice | `integration_unsafe` or `integration_mutation_failed` carries `snapshotPath` | role alert includes exact path + reason; dialog stays open |
| generic error Notice | network/unmapped code | localized error visible; prior state and drafts retained |
| failed-cold state | state request rejects, no cache | Notice + retry only; no empty/grid/actions |
| stale-data error | held data + refresh rejects | cards remain + stale Notice |
| loading skeleton | pending cold resource | fixed skeleton count/geometry; `role=status` |
| all-undetected empty | six installed false | supported-client links + rollback empty; no bare card grid |
| onboarding | empty journal + no local key | safety line visible; first success writes key; reload hides it |
| bulk confirm | at least one current/stale client | dialog names exactly candidates; no mutation before confirm |
| bulk partial failure | second of multiple PUTs rejects | remaining clients still attempted; Notice names failures; resources refresh |
| native card unavailable **[DEFERRED]** | one native read rejects | only that card says unavailable; file cards still render |

## 16. Tests and verification

Create `gui/tests/integrations-surfaces.test.tsx` using `happy-dom`, lazy
React imports, `act`, and fetch stubs matching
`providers-hash-history.test.tsx`. Exact test names:

1. `renders all six state badges with text and non-color semantics`
2. `locks conflict and unsafe switches with an accessible description`
3. `applies absent refreshes stale and disables current with exact PUT bodies`
4. `does not optimistically flip a switch when a mutation fails`
5. `renders skeleton empty cold-error and stale-data states exclusively`
6. `dismisses onboarding only after a successful apply`
7. `bulk disable lists and mutates only current and stale clients`
8. `bulk disable reports deterministic partial failures and refreshes`
9. `rollback rows distinguish undo restore restore-to-absence and expired snapshots`
10. `restore requires a second explicit submit after drift is reported`
11. `restore refusal keeps the dialog open and names the manual snapshot path`
12. `native exception cards never receive file-toggle badges or rollback rows` **[DEFERRED]**
13. `hidden Integration panels stop their data resources without losing mounted drafts`

Fixture requirements:

- Stub exact WP4 bodies and error codes; do not branch on `error` prose.
- Assert every conditional from §15 is activated at least once.
- Use exact canonical journal fixtures: `snapshot` is `"none"`, `"stored"`,
  or `"expired"`, and every row carries `undoable`.
- Add static assertion that `styles-integrations.css` contains only existing
  token names for colors (`--green`, `--amber`, `--red`, `--accent`, neutral
  surface/border tokens) and no hex/rgb color literal.

Run:

```bash
cd gui
bun test tests/integrations-routing.test.ts tests/integrations-surfaces.test.tsx
bun run lint:i18n
bun run lint
bun run build
```

Browser QA after the automated gate:

1. Desktop and 720 px: summary, card grid (six file clients in this phase),
   wrapped tabs, rollback rows, and dialogs fit without horizontal page
   overflow.
2. Keyboard-only: outer tabs, inner Claude tabs, every switch/action, bulk
   dialog, restore/drift dialog, Escape, and trigger focus restoration.
3. Light/dark: all six badge states and disabled controls retain text and UI
   contrast; unsafe outline remains distinct from conflict fill.
4. Network: inactive tabs issue no polls; each file toggle is one PUT; restore
   is one POST plus a second only after explicit drift confirmation.
5. Korean: no clipped tab/card/action labels and no orphaned sentence fragment
   in onboarding, bulk, or restore copy.

Acceptance requires every §15 branch REACHABLE IN THIS PHASE — including
expired history, restore-to-absence, and both manual-recovery envelope codes —
to be activated by the final contract fixtures and pass with observable proof.
Branches belonging to the deferred native cards, the per-client export panel
and the Advanced disclosure move to the follow-up unit's acceptance along with
the surfaces themselves (round-2 amendment); they cannot be activated while
the surfaces that own them do not exist.
