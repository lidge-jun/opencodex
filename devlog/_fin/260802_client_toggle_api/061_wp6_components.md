# 061 — WP6 paste-ready integration component bodies

> **Status: verified by `tools/check-blocks.ts` (see `007_execution_method.md`).**
> The bodies below are compiled as self-contained units by the block checker.
> They remain the paste source; the checker guarantees they parse and are
> internally consistent, while cross-module resolution is settled by the
> repository's own `bun run typecheck` during the implementing phase.



Implementation-only overflow for `060_wp6_gui_surfaces.md`. This document is
part of the same merged GUI work-phase. `006_module_contracts.md` remains the
shared-type authority and `040_wp4_management_api.md` remains the HTTP authority.

## 1. File map

| Operation | Path | Responsibility |
|---|---|---|
| NEW | `gui/src/pages/integrations/integration-api.ts` | WP4 browser contract, mutation transport, error mapping |
| NEW | `gui/src/pages/integrations/integration-meta.ts` | closed client metadata and operation label keys |
| NEW | `gui/src/pages/integrations/IntegrationStateBadge.tsx` | five-state plus not-installed visual badge |
| NEW | `gui/src/pages/integrations/RestoreDialog.tsx` | restore and drift-confirm flow |
| NEW | `gui/src/pages/integrations/OperationRows.tsx` | canonical undo/restore/expired row actions |
| NEW | `gui/src/pages/integrations/BulkDisableDialog.tsx` | deterministic bulk-disable confirmation |
| NEW | `gui/src/pages/integrations/FileIntegrationCard.tsx` | one file-toggle overview card |
| NEW | `gui/src/pages/integrations/NativeIntegrationCards.tsx` | four capability-exception cards |
| NEW | `gui/src/pages/integrations/IntegrationSummary.tsx` | compact overview facts and bulk entry point |
| NEW | `gui/src/pages/integrations/IntegrationsOverview.tsx` | summary, grid, onboarding, rollback composition |
| NEW | `gui/src/pages/integrations/FileIntegrationHeader.tsx` | shared client identity and mutation controls |
| NEW | `gui/src/pages/integrations/FileIntegrationPage.tsx` | shared six-client page |

No global store, query dependency, new route, new backend type, or alternate
CSRF implementation is introduced.

## 2. `integration-api.ts` — complete body

```ts
import type { TKey } from "../../i18n/shared";

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
export type IntegrationReason = "unparseable" | "not-regular-file" | "foreign-edit" | "unowned-key";

export interface IntegrationStatus {
  clientId: FileIntegrationClientId;
  state: IntegrationState;
  installed: boolean;
  configPath: string;
  appliedAt?: string;
  lastOpId?: string;
  reason?: IntegrationReason;
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
}

export type IntegrationErrorCode =
  | "invalid_integration_client"
  | "invalid_json_body"
  | "invalid_enabled"
  | "invalid_op_id"
  | "invalid_confirm_drift"
  | "integration_operation_not_found"
  | "integration_snapshot_expired"
  | "integration_mutation_busy"
  | "integration_unsafe"
  | "integration_conflict"
  | "integration_drift_confirmation_required"
  | "integration_mutation_failed"
  | "integration_internal_error";

export interface IntegrationErrorBody {
  error?: string;
  code?: IntegrationErrorCode;
  clientId?: FileIntegrationClientId;
  state?: IntegrationState | string;
  reason?: string;
  opId?: string;
  snapshotPath?: string;
  residual?: boolean;
  validClients?: readonly FileIntegrationClientId[];
}

export class IntegrationApiError extends Error {
  constructor(readonly status: number, readonly body: IntegrationErrorBody) {
    super(body.error ?? `HTTP ${status}`);
    this.name = "IntegrationApiError";
  }
}

export interface IntegrationErrorView {
  kind: "message" | "drift-confirmation" | "manual-recovery";
  key: TKey;
  vars?: Record<string, string | number>;
  code?: string;
  snapshotPath?: string;
  residual: boolean;
}

const INVALID_REQUEST_CODES: readonly IntegrationErrorCode[] = [
  "invalid_integration_client",
  "invalid_json_body",
  "invalid_enabled",
  "invalid_op_id",
  "invalid_confirm_drift",
];

export function mapIntegrationError(
  cause: unknown,
  fallback: "load" | "mutation" = "mutation",
): IntegrationErrorView {
  if (!(cause instanceof IntegrationApiError)) {
    return { kind: "message", key: fallback === "load" ? "integrations.error.load" : "integrations.error.generic", residual: false };
  }
  const { body } = cause;
  const code = body.code;
  const base = { code, snapshotPath: body.snapshotPath, residual: body.residual === true };
  if (body.residual) {
    return {
      ...base,
      kind: body.snapshotPath ? "manual-recovery" : "message",
      key: body.snapshotPath ? "integrations.restore.residualManual" : "integrations.error.residual",
      vars: body.snapshotPath ? { path: body.snapshotPath, reason: body.reason ?? body.error ?? code ?? String(cause.status) } : undefined,
    };
  }
  if (code && INVALID_REQUEST_CODES.includes(code)) {
    return { ...base, kind: "message", key: "integrations.error.invalidRequest" };
  }
  switch (code) {
    case "integration_operation_not_found":
      return { ...base, kind: "message", key: "integrations.error.operationNotFound" };
    case "integration_snapshot_expired":
      return { ...base, kind: "message", key: "integrations.error.snapshotExpired" };
    case "integration_mutation_busy":
      return { ...base, kind: "message", key: "integrations.error.busy" };
    case "integration_conflict":
      return { ...base, kind: "message", key: "integrations.error.conflict" };
    case "integration_drift_confirmation_required":
      return { ...base, kind: "drift-confirmation", key: "integrations.restore.driftBody" };
    case "integration_unsafe":
    case "integration_mutation_failed":
      if (body.snapshotPath) {
        return {
          ...base,
          kind: "manual-recovery",
          key: "integrations.restore.manual",
          vars: { path: body.snapshotPath, reason: body.reason ?? body.error ?? code },
        };
      }
      return { ...base, kind: "message", key: code === "integration_unsafe" ? "integrations.error.unsafe" : "integrations.error.generic" };
    case "integration_internal_error":
    default:
      return { ...base, kind: "message", key: fallback === "load" ? "integrations.error.load" : "integrations.error.generic" };
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & IntegrationErrorBody;
  if (!response.ok) throw new IntegrationApiError(response.status, body);
  return body;
}

// App.tsx installs installApiAuthFetch() before render. That wrapper adds the
// session API key, GUI origin, and X-OpenCodex-CSRF-Token to non-GET /api calls.
// Callers supply only the payload content header; token material stays private.
const JSON_MUTATION_HEADERS = { "Content-Type": "application/json" } as const;

export async function loadIntegrationStates(apiBase: string, signal?: AbortSignal) {
  return readResponse<IntegrationStateListEnvelope>(await fetch(`${apiBase}/api/client-integrations`, { signal }));
}

export async function loadIntegrationState(apiBase: string, client: FileIntegrationClientId, signal?: AbortSignal) {
  return readResponse<IntegrationStatus>(await fetch(`${apiBase}/api/client-integrations/${encodeURIComponent(client)}`, { signal }));
}

export async function loadIntegrationJournal(apiBase: string, client?: FileIntegrationClientId, signal?: AbortSignal) {
  const query = client ? `?client=${encodeURIComponent(client)}` : "";
  return readResponse<IntegrationJournalEnvelope>(await fetch(`${apiBase}/api/client-integrations/journal${query}`, { signal }));
}

export async function toggleIntegration(apiBase: string, client: FileIntegrationClientId, enabled: boolean) {
  return readResponse<IntegrationMutationEnvelope>(await fetch(`${apiBase}/api/client-integrations/${encodeURIComponent(client)}`, {
    method: "PUT",
    headers: JSON_MUTATION_HEADERS,
    body: JSON.stringify({ enabled }),
  }));
}

export async function restoreIntegration(apiBase: string, opId: string, confirmDrift = false) {
  return readResponse<IntegrationMutationEnvelope>(await fetch(`${apiBase}/api/client-integrations/restore`, {
    method: "POST",
    headers: JSON_MUTATION_HEADERS,
    body: JSON.stringify({ opId, confirmDrift }),
  }));
}
```

## 3. `RestoreDialog.tsx` — complete body

```tsx
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  mapIntegrationError,
  restoreIntegration,
  type IntegrationErrorView,
  type IntegrationJournalRow,
} from "./integration-api";

export default function RestoreDialog({
  apiBase,
  operation,
  mode,
  onClose,
  onRestored,
}: {
  apiBase: string;
  operation: IntegrationJournalRow;
  mode: "undo" | "restore";
  onClose: () => void;
  onRestored: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false);
  const [drift, setDrift] = useState(false);
  const [error, setError] = useState<IntegrationErrorView | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, []);

  const close = () => {
    if (!pending) onClose();
  };

  const submit = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await restoreIntegration(apiBase, operation.opId, drift);
      onRestored();
      onClose();
    } catch (cause) {
      const view = mapIntegrationError(cause);
      if (view.kind === "drift-confirmation") setDrift(true);
      else setError(view);
    } finally {
      setPending(false);
    }
  };

  const titleKey = drift
    ? "integrations.restore.driftTitle"
    : mode === "undo"
      ? "integrations.restore.undoTitle"
      : "integrations.restore.title";
  const bodyKey = drift
    ? "integrations.restore.driftBody"
    : mode === "undo"
      ? "integrations.restore.undoBody"
      : "integrations.restore.body";

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="integration-restore-title"
      aria-describedby="integration-restore-description"
      onCancel={event => {
        event.preventDefault();
        close();
      }}
    >
      <div className="modal-card integration-restore-dialog" aria-busy={pending || undefined}>
        <h3 id="integration-restore-title">{t(titleKey)}</h3>
        <p id="integration-restore-description" className="modal-desc">{t(bodyKey)}</p>
        <p className="integration-restore-target">
          <code>{operation.configPath}</code>
        </p>
        {error && (
          <div className="alert alert-err" role="alert">
            {t(error.key, error.vars)}
            {error.code && <code className="integration-error-code">{error.code}</code>}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={pending}>
            {t(pending
              ? "integrations.restore.pending"
              : drift
                ? "integrations.restore.confirmDrift"
                : mode === "undo"
                  ? "integrations.restore.confirmUndo"
                  : "integrations.restore.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
```

## 4. `OperationRows.tsx` — complete body

```tsx
import { useI18n, type TKey } from "../../i18n/shared";
import { FILE_CLIENT_META, OPERATION_KIND_KEYS } from "./integration-meta";
import type { IntegrationJournalRow } from "./integration-api";

export interface RestoreSelection {
  operation: IntegrationJournalRow;
  mode: "undo" | "restore";
}

export default function OperationRows({
  operations,
  onSelect,
  emptyTitleKey = "integrations.rollback.empty",
}: {
  operations: readonly IntegrationJournalRow[];
  onSelect: (selection: RestoreSelection) => void;
  emptyTitleKey?: TKey;
}) {
  const { t, locale } = useI18n();
  if (operations.length === 0) {
    return (
      <div className="empty rollback-empty">
        <div className="title">{t(emptyTitleKey)}</div>
        <div className="text-control">{t("integrations.rollback.emptyBody")}</div>
      </div>
    );
  }

  return (
    <ul className="rollback-list">
      {operations.map(operation => {
        const expired = operation.snapshot === "expired";
        const mode: RestoreSelection["mode"] = operation.undoable ? "undo" : "restore";
        const actionKey = expired
          ? "integrations.action.snapshotExpired"
          : mode === "undo"
            ? "integrations.action.undo"
            : "integrations.action.restorePoint";
        return (
          <li key={operation.opId} className="rollback-row">
            <span className="rollback-row__facts">
              <strong>{t(FILE_CLIENT_META[operation.clientId].labelKey)}</strong>
              <span>{t(OPERATION_KIND_KEYS[operation.kind])}</span>
              <time dateTime={operation.at}>{new Date(operation.at).toLocaleString(locale)}</time>
              <code>{operation.configPath}</code>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={expired}
              onClick={() => {
                if (!expired) onSelect({ operation, mode });
              }}
            >
              {t(actionKey)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

## 5. `BulkDisableDialog.tsx` — complete body

```tsx
import { useEffect, useRef } from "react";
import { useT } from "../../i18n/shared";
import { FILE_CLIENT_META } from "./integration-meta";
import type { IntegrationStatus } from "./integration-api";

export default function BulkDisableDialog({
  clients,
  pending,
  onClose,
  onConfirm,
}: {
  clients: readonly IntegrationStatus[];
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
      if (triggerRef.current?.isConnected) triggerRef.current.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay"
      aria-labelledby="integration-bulk-title"
      aria-describedby="integration-bulk-description"
      onCancel={event => {
        event.preventDefault();
        if (!pending) onClose();
      }}
    >
      <div className="modal-card" aria-busy={pending || undefined}>
        <h3 id="integration-bulk-title">{t("integrations.bulk.title")}</h3>
        <p id="integration-bulk-description" className="modal-desc">{t("integrations.bulk.body")}</p>
        <ul>
          {clients.map(client => <li key={client.clientId}>{t(FILE_CLIENT_META[client.clientId].labelKey)}</li>)}
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={onConfirm}>
            {t(pending ? "integrations.bulk.pending" : "integrations.bulk.confirm")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
```

## 6. `integration-meta.ts` — complete body

```ts
import type { TKey } from "../../i18n/shared";
import { CLIENT_MARKS } from "../../components/apikeys-workspace/client-config-clients";
import type { FileIntegrationClientId, IntegrationJournalRow } from "./integration-api";

export interface FileIntegrationMeta {
  labelKey: TKey;
  semanticsKey: TKey;
  installKey: TKey;
  mark?: string;
}

const FILE_MARKS: Partial<Record<FileIntegrationClientId, string>> = CLIENT_MARKS;

export const FILE_CLIENT_META: Record<FileIntegrationClientId, FileIntegrationMeta> = {
  opencode: { labelKey: "integrations.tab.opencode", semanticsKey: "integrations.semantics.opencode", installKey: "integrations.install.opencode", mark: FILE_MARKS.opencode },
  pi: { labelKey: "integrations.tab.pi", semanticsKey: "integrations.semantics.pi", installKey: "integrations.install.pi", mark: FILE_MARKS.pi },
  hermes: { labelKey: "integrations.tab.hermes", semanticsKey: "integrations.semantics.hermes", installKey: "integrations.install.hermes", mark: FILE_MARKS.hermes },
  openclaw: { labelKey: "integrations.tab.openclaw", semanticsKey: "integrations.semantics.openclaw", installKey: "integrations.install.openclaw", mark: FILE_MARKS.openclaw },
  kimi: { labelKey: "integrations.tab.kimi", semanticsKey: "integrations.semantics.kimi", installKey: "integrations.install.kimi", mark: FILE_MARKS.kimi },
  gajae: { labelKey: "integrations.tab.gajae", semanticsKey: "integrations.semantics.gajae", installKey: "integrations.install.gajae", mark: FILE_MARKS.gajae },
};

export const OPERATION_KIND_KEYS: Record<IntegrationJournalRow["kind"], TKey> = {
  apply: "integrations.operation.apply",
  disable: "integrations.operation.disable",
  refresh: "integrations.operation.refresh",
  restore: "integrations.operation.restore",
};
```

## 7. `IntegrationStateBadge.tsx` — complete body

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

## 8. `FileIntegrationCard.tsx` — complete body

```tsx
import { useI18n } from "../../i18n/shared";
import { navigateHash } from "../../hash-routing";
import { Switch } from "../../ui";
import { FILE_CLIENT_META } from "./integration-meta";
import type { IntegrationStatus } from "./integration-api";
import IntegrationStateBadge from "./IntegrationStateBadge";

export default function FileIntegrationCard({
  status,
  pending,
  backupKnown,
  onToggle,
  onRefresh,
}: {
  status: IntegrationStatus;
  pending: boolean;
  backupKnown: boolean;
  onToggle: (enabled: boolean) => void;
  onRefresh: () => void;
}) {
  const { t, locale } = useI18n();
  const meta = FILE_CLIENT_META[status.clientId];
  const label = t(meta.labelKey);
  const badgeId = `integration-card-badge-${status.clientId}`;
  const guidanceId = `integration-card-guidance-${status.clientId}`;
  const on = status.state === "current" || status.state === "stale";
  const locked = !status.installed
    || status.state === "conflict"
    || status.state === "unsafe"
    || pending;
  const describedBy = !status.installed
    ? guidanceId
    : status.state === "conflict" || status.state === "unsafe"
      ? badgeId
      : undefined;

  return (
    <li className="integration-card" aria-busy={pending || undefined}>
      <div className="integration-card__head">
        <span className="awi-clientconfig-mark" aria-hidden="true">
          {meta.mark
            ? <img src={meta.mark} alt="" width={24} height={24} />
            : <span className="awi-clientconfig-monogram">{label.slice(0, 1)}</span>}
        </span>
        <h3>{label}</h3>
        <IntegrationStateBadge id={badgeId} state={status.state} installed={status.installed} />
      </div>

      <p id={guidanceId} className="muted text-label">
        {t(status.installed ? "integrations.status.installed" : meta.installKey)}
      </p>
      <code className="integration-card__path">{status.configPath}</code>

      <div className="integration-card__actions">
        {status.state === "stale" && status.installed && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={onRefresh}>
            {t("integrations.action.refresh")}
          </button>
        )}
        <Switch
          on={on}
          onClick={() => onToggle(!on)}
          disabled={locked}
          label={t(on ? "integrations.switch.disableLabel" : "integrations.switch.applyLabel", { client: label })}
          aria-describedby={describedBy}
        />
      </div>

      <p className="muted text-label integration-card__facts">
        <span>{status.appliedAt
          ? t("integrations.card.appliedAt", { time: new Date(status.appliedAt).toLocaleString(locale) })
          : t("integrations.card.neverApplied")}</span>
        <span>{t(backupKnown ? "integrations.card.backupAvailable" : "integrations.card.backupUnknown")}</span>
      </p>
      <button
        type="button"
        className="btn btn-ghost btn-sm integration-card__settings"
        onClick={() => navigateHash(`#integrations/${status.clientId}`)}
      >
        {t("integrations.action.settings")}
      </button>
    </li>
  );
}
```

## 9. `NativeIntegrationCards.tsx` — complete body

```tsx
import { useState, type ReactNode } from "react";
import { navigateHash } from "../../hash-routing";
import { useT, type TKey } from "../../i18n/shared";
import { Switch } from "../../ui";

export interface NativeIntegrationStatus {
  codexOnline: boolean | null;
  claudeEnabled: boolean | null;
  desktopApplied: boolean | null;
  desktopStale: boolean | null;
  grokPresent: boolean | null;
}

async function jsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export async function loadNativeIntegrationStatus(apiBase: string, signal: AbortSignal): Promise<NativeIntegrationStatus> {
  const [health, claude, desktop, grok] = await Promise.allSettled([
    fetch(`${apiBase}/healthz`, { signal }).then(response => response.ok),
    fetch(`${apiBase}/api/claude-code`, { signal })
      .then(response => jsonOrThrow<{ enabled?: unknown }>(response))
      .then(body => typeof body.enabled === "boolean" ? body.enabled : null),
    fetch(`${apiBase}/api/claude-desktop/status`, { signal })
      .then(response => jsonOrThrow<{ applied?: unknown; stale?: unknown }>(response)),
    fetch(`${apiBase}/api/grok`, { signal })
      .then(response => jsonOrThrow<{ present?: unknown }>(response))
      .then(body => typeof body.present === "boolean" ? body.present : null),
  ]);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return {
    codexOnline: health.status === "fulfilled" ? health.value : null,
    claudeEnabled: claude.status === "fulfilled" ? claude.value : null,
    desktopApplied: desktop.status === "fulfilled" && typeof desktop.value.applied === "boolean" ? desktop.value.applied : null,
    desktopStale: desktop.status === "fulfilled" && typeof desktop.value.stale === "boolean" ? desktop.value.stale : null,
    grokPresent: grok.status === "fulfilled" ? grok.value : null,
  };
}

function NativeCard({
  titleKey,
  statusKey,
  actionKey,
  target,
  children,
}: {
  titleKey: TKey;
  statusKey: TKey;
  actionKey: TKey;
  target: string;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <li className="integration-card integration-card--native">
      <div className="integration-card__head">
        <span className="awi-clientconfig-monogram" aria-hidden="true">{t(titleKey).slice(0, 1)}</span>
        <h3>{t(titleKey)}</h3>
        <span className="muted text-label">{t(statusKey)}</span>
      </div>
      {children}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigateHash(target)}>
        {t(actionKey)}
      </button>
    </li>
  );
}

export default function NativeIntegrationCards({
  apiBase,
  status,
  onRefresh,
  onMessage,
}: {
  apiBase: string;
  status: NativeIntegrationStatus;
  onRefresh: () => void;
  onMessage: (message: { tone: "ok" | "err"; key: TKey }) => void;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const claudeStatusKey: TKey = status.claudeEnabled === null
    ? "integrations.native.unavailable"
    : status.claudeEnabled
      ? "integrations.native.enabled"
      : "integrations.native.disabled";
  const desktopStatusKey: TKey = status.desktopApplied === null || status.desktopStale === null
    ? "integrations.native.unavailable"
    : status.desktopStale
      ? "integrations.native.desktopStale"
      : status.desktopApplied
        ? "integrations.native.desktopApplied"
        : "integrations.native.desktopNotApplied";

  const toggleClaude = async () => {
    if (status.claudeEnabled === null || pending) return;
    setPending(true);
    try {
      const response = await fetch(`${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !status.claudeEnabled }),
      });
      if (!response.ok) throw new Error(String(response.status));
      onMessage({ tone: "ok", key: "integrations.native.claudeUpdated" });
      onRefresh();
    } catch {
      onMessage({ tone: "err", key: "integrations.native.claudeUpdateFailed" });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <NativeCard
        titleKey="integrations.native.codex"
        statusKey={status.codexOnline === null ? "integrations.native.unavailable" : status.codexOnline ? "integrations.native.running" : "integrations.native.stopped"}
        actionKey="integrations.native.serviceControls"
        target="#startup"
      />
      <NativeCard titleKey="integrations.native.claudeCode" statusKey={claudeStatusKey} actionKey="integrations.native.openClaude" target="#integrations/claude">
        <div className="integration-card__actions">
          <Switch
            on={status.claudeEnabled === true}
            onClick={() => void toggleClaude()}
            disabled={status.claudeEnabled === null || pending}
            label={t("integrations.native.claudeSwitchLabel")}
          />
        </div>
      </NativeCard>
      <NativeCard titleKey="integrations.native.claudeDesktop" statusKey={desktopStatusKey} actionKey="integrations.native.openDesktop" target="#integrations/claude/desktop" />
      <NativeCard
        titleKey="integrations.native.grok"
        statusKey={status.grokPresent === null ? "integrations.native.unavailable" : status.grokPresent ? "integrations.native.configured" : "integrations.native.notConfigured"}
        actionKey="integrations.native.openGrok"
        target="#integrations/grok"
      />
    </>
  );
}
```

## 10. `IntegrationSummary.tsx` — complete body

```tsx
import { useI18n } from "../../i18n/shared";
import type { IntegrationJournalRow, IntegrationStatus } from "./integration-api";

export default function IntegrationSummary({
  clients,
  operations,
  onDisableAll,
}: {
  clients: readonly IntegrationStatus[];
  operations: readonly IntegrationJournalRow[];
  onDisableAll: () => void;
}) {
  const { t, locale } = useI18n();
  const detected = clients.filter(client => client.installed).length;
  const applied = clients.filter(client => client.installed && (client.state === "current" || client.state === "stale")).length;
  const stale = clients.filter(client => client.installed && client.state === "stale").length;
  const lastChangedAt = operations[0]?.at;
  const disableCount = applied;

  return (
    <section className="integrations-summary" aria-labelledby="integrations-summary-title">
      <h3 id="integrations-summary-title" className="sr-only">{t("integrations.summary.title")}</h3>
      <dl>
        <div><dt>{t("integrations.summary.detected")}</dt><dd>{detected}</dd></div>
        <div><dt>{t("integrations.summary.applied")}</dt><dd>{applied}</dd></div>
        <div><dt>{t("integrations.summary.stale")}</dt><dd>{stale}</dd></div>
        <div>
          <dt>{t("integrations.summary.lastChange")}</dt>
          <dd>{lastChangedAt ? new Date(lastChangedAt).toLocaleString(locale) : t("integrations.status.unknown")}</dd>
        </div>
      </dl>
      {disableCount > 0 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDisableAll}>
          {t("integrations.summary.disableAll")}
        </button>
      )}
    </section>
  );
}
```

## 11. `IntegrationsOverview.tsx` — complete body

```tsx
import { useState } from "react";
import { useDataSurface } from "../../data-surface";
import { navigateHash } from "../../hash-routing";
import { useT, type TKey } from "../../i18n/shared";
import { EmptyState, Notice } from "../../ui";
import BulkDisableDialog from "./BulkDisableDialog";
import FileIntegrationCard from "./FileIntegrationCard";
import IntegrationSummary from "./IntegrationSummary";
import NativeIntegrationCards, { loadNativeIntegrationStatus, type NativeIntegrationStatus } from "./NativeIntegrationCards";
import OperationRows, { type RestoreSelection } from "./OperationRows";
import RestoreDialog from "./RestoreDialog";
import { FILE_CLIENT_META } from "./integration-meta";
import {
  FILE_INTEGRATION_CLIENTS,
  loadIntegrationJournal,
  loadIntegrationStates,
  mapIntegrationError,
  toggleIntegration,
  type IntegrationStatus,
} from "./integration-api";

const ONBOARDING_KEY = "ocx-integrations-onboarding-v1";
const NO_NATIVE_STATUS: NativeIntegrationStatus = {
  codexOnline: null,
  claudeEnabled: null,
  desktopApplied: null,
  desktopStale: null,
  grokPresent: null,
};
type Message = { tone: "ok" | "err"; key: TKey; vars?: Record<string, string | number>; code?: string };
export interface IntegrationsOverviewProps {
  apiBase: string;
  active?: boolean;
}

export default function IntegrationsOverview({ apiBase, active = true }: IntegrationsOverviewProps) {
  const t = useT();
  const [pendingClient, setPendingClient] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [restoreSelection, setRestoreSelection] = useState<RestoreSelection | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_KEY) === "1"; } catch { return false; }
  });

  const states = useDataSurface(
    `integrations-state-list:${apiBase}`,
    [apiBase],
    signal => loadIntegrationStates(apiBase, signal),
    { isEmpty: () => false, enabled: active },
  );
  const journal = useDataSurface(
    `integrations-journal:${apiBase}`,
    [apiBase],
    signal => loadIntegrationJournal(apiBase, undefined, signal),
    { isEmpty: data => data.operations.length === 0, enabled: active },
  );
  const native = useDataSurface(
    `integrations-native:${apiBase}`,
    [apiBase],
    signal => loadNativeIntegrationStatus(apiBase, signal),
    { isEmpty: () => false, enabled: active },
  );

  const clients = states.state.data?.clients ?? [];
  const operations = journal.state.data?.operations ?? [];
  const disableCandidates = clients.filter(client => client.installed && (client.state === "current" || client.state === "stale"));
  const backups = new Set(operations.filter(row => row.snapshot !== "expired").map(row => row.clientId));
  const allUndetected = clients.length === FILE_INTEGRATION_CLIENTS.length && clients.every(client => !client.installed);
  const showOnboarding = journal.state.kind === "ready-empty" && !onboardingDismissed;
  const refreshFileData = () => {
    states.refresh();
    journal.refresh();
  };

  const mutate = async (status: IntegrationStatus, enabled: boolean) => {
    if (pendingClient) return;
    setPendingClient(status.clientId);
    setMessage(null);
    try {
      await toggleIntegration(apiBase, status.clientId, enabled);
      if (enabled) {
        try { localStorage.setItem(ONBOARDING_KEY, "1"); } catch { /* non-critical preference */ }
        setOnboardingDismissed(true);
      }
      setMessage({
        tone: "ok",
        key: enabled
          ? status.state === "stale" ? "integrations.success.refreshed" : "integrations.success.applied"
          : "integrations.success.disabled",
        vars: { client: t(FILE_CLIENT_META[status.clientId].labelKey) },
      });
    } catch (cause) {
      const view = mapIntegrationError(cause);
      setMessage({ tone: "err", key: view.key, vars: view.vars, code: view.code });
    } finally {
      setPendingClient(null);
      refreshFileData();
    }
  };

  const disableAll = async () => {
    if (bulkPending) return;
    setBulkPending(true);
    const failed: string[] = [];
    for (const client of disableCandidates) {
      try { await toggleIntegration(apiBase, client.clientId, false); }
      catch { failed.push(t(FILE_CLIENT_META[client.clientId].labelKey)); }
    }
    setMessage(failed.length > 0
      ? { tone: "err", key: "integrations.bulk.partial", vars: { clients: failed.join(", ") } }
      : { tone: "ok", key: "integrations.bulk.success" });
    setBulkPending(false);
    setBulkOpen(false);
    refreshFileData();
  };

  if (!active && clients.length === 0) return null;

  return (
    <section className="integrations-overview" aria-busy={states.state.refreshing || journal.state.refreshing || native.state.refreshing || undefined}>
      <IntegrationSummary clients={clients} operations={operations} onDisableAll={() => setBulkOpen(true)} />
      {showOnboarding && <p className="integrations-onboarding">{t("integrations.onboarding")}</p>}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{message ? t(message.key, message.vars) : ""}</div>
      {message && <Notice tone={message.tone}>{t(message.key, message.vars)}{message.code && <code>{message.code}</code>}</Notice>}
      {(states.state.showError || journal.state.showError) && clients.length > 0 && (
        <div className="integrations-load-error">
          <Notice tone="err">{t("integrations.error.stale")}</Notice>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { refreshFileData(); native.refresh(); }}>
            {t("common.retry")}
          </button>
        </div>
      )}

      {states.state.kind === "failed-cold" ? (
        <div className="integrations-load-error">
          <Notice tone="err">{t("integrations.error.load")}</Notice>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => states.refresh()}>{t("common.retry")}</button>
        </div>
      ) : states.state.showSkeleton && clients.length === 0 ? (
        <div className="integration-card-grid" role="status" aria-label={t("common.loading")}>
          {Array.from({ length: 10 }, (_, index) => <div key={index} className="integration-skeleton-card" />)}
        </div>
      ) : allUndetected ? (
        <EmptyState title={t("integrations.empty.title")}>
          <p>{t("integrations.empty.body")}</p>
          <ul>
            {FILE_INTEGRATION_CLIENTS.map(client => (
              <li key={client}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigateHash(`#integrations/${client}`)}>
                  {t(FILE_CLIENT_META[client].labelKey)}
                </button>
              </li>
            ))}
          </ul>
        </EmptyState>
      ) : clients.length > 0 ? (
        <ul className="integration-card-grid">
          <NativeIntegrationCards
            apiBase={apiBase}
            status={native.state.data ?? NO_NATIVE_STATUS}
            onRefresh={() => native.refresh()}
            onMessage={setMessage}
          />
          {clients.map(status => (
            <FileIntegrationCard
              key={status.clientId}
              status={status}
              pending={pendingClient === status.clientId}
              backupKnown={backups.has(status.clientId)}
              onToggle={enabled => void mutate(status, enabled)}
              onRefresh={() => void mutate(status, true)}
            />
          ))}
        </ul>
      ) : null}

      <section className="rollback-center" aria-labelledby="rollback-center-title">
        <h3 id="rollback-center-title">{t("integrations.rollback.title")}</h3>
        <OperationRows operations={operations.slice(0, 5)} onSelect={setRestoreSelection} />
      </section>

      {bulkOpen && <BulkDisableDialog clients={disableCandidates} pending={bulkPending} onClose={() => setBulkOpen(false)} onConfirm={() => void disableAll()} />}
      {restoreSelection && (
        <RestoreDialog
          apiBase={apiBase}
          operation={restoreSelection.operation}
          mode={restoreSelection.mode}
          onClose={() => setRestoreSelection(null)}
          onRestored={() => {
            setMessage({ tone: "ok", key: "integrations.success.restored" });
            refreshFileData();
          }}
        />
      )}
    </section>
  );
}
```

## 12. `FileIntegrationHeader.tsx` — complete body

```tsx
import { useT } from "../../i18n/shared";
import { Switch } from "../../ui";
import { FILE_CLIENT_META } from "./integration-meta";
import type { IntegrationJournalRow, IntegrationStatus } from "./integration-api";
import IntegrationStateBadge from "./IntegrationStateBadge";
import type { RestoreSelection } from "./OperationRows";

export default function FileIntegrationHeader({
  status,
  restoreOperation,
  pending,
  onToggle,
  onRefresh,
  onRestore,
}: {
  status: IntegrationStatus;
  restoreOperation?: IntegrationJournalRow;
  pending: boolean;
  onToggle: (enabled: boolean) => void;
  onRefresh: () => void;
  onRestore: (selection: RestoreSelection) => void;
}) {
  const t = useT();
  const meta = FILE_CLIENT_META[status.clientId];
  const label = t(meta.labelKey);
  const badgeId = `integration-client-badge-${status.clientId}`;
  const guidanceId = `integration-client-guidance-${status.clientId}`;
  const on = status.state === "current" || status.state === "stale";
  const locked = !status.installed
    || status.state === "conflict"
    || status.state === "unsafe"
    || pending;
  const describedBy = !status.installed
    ? guidanceId
    : status.state === "conflict" || status.state === "unsafe"
      ? badgeId
      : undefined;

  return (
    <header className="integration-client-head">
      <span className="awi-clientconfig-mark" aria-hidden="true">
        {meta.mark
          ? <img src={meta.mark} alt="" width={28} height={28} />
          : <span className="awi-clientconfig-monogram">{label.slice(0, 1)}</span>}
      </span>
      <div className="integration-client-head__identity">
        <h2>{label}</h2>
        <p id={guidanceId} className="muted text-label">
          {t(status.installed ? "integrations.status.installed" : meta.installKey)}
        </p>
      </div>
      <IntegrationStateBadge id={badgeId} state={status.state} installed={status.installed} />
      <div className="integration-client-head__actions">
        {status.state === "stale" && status.installed && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={onRefresh}>
            {t("integrations.action.refresh")}
          </button>
        )}
        <Switch
          on={on}
          onClick={() => onToggle(!on)}
          disabled={locked}
          label={t(on ? "integrations.switch.disableLabel" : "integrations.switch.applyLabel", { client: label })}
          aria-describedby={describedBy}
        />
        {restoreOperation && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={pending}
            onClick={() => onRestore({
              operation: restoreOperation,
              mode: restoreOperation.undoable ? "undo" : "restore",
            })}
          >
            {t("integrations.action.restore")}
          </button>
        )}
      </div>
    </header>
  );
}
```

## 13. `FileIntegrationPage.tsx` — complete body

```tsx
import { useState } from "react";
import ClientConfigPanel from "../../components/apikeys-workspace/ClientConfigPanel";
import { useDataSurface } from "../../data-surface";
import { useI18n, type TKey } from "../../i18n/shared";
import { Notice } from "../../ui";
import FileIntegrationHeader from "./FileIntegrationHeader";
import OperationRows, { type RestoreSelection } from "./OperationRows";
import RestoreDialog from "./RestoreDialog";
import { FILE_CLIENT_META } from "./integration-meta";
import {
  loadIntegrationJournal,
  loadIntegrationState,
  mapIntegrationError,
  toggleIntegration,
  type FileIntegrationClientId,
} from "./integration-api";

export type { FileIntegrationClientId } from "./integration-api";

export interface FileIntegrationPageProps {
  apiBase: string;
  client: FileIntegrationClientId;
  active?: boolean;
}

type Message = { tone: "ok" | "err"; key: TKey; vars?: Record<string, string | number>; code?: string };

export default function FileIntegrationPage({ apiBase, client, active = true }: FileIntegrationPageProps) {
  const { t, locale } = useI18n();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [restoreSelection, setRestoreSelection] = useState<RestoreSelection | null>(null);

  const statusResource = useDataSurface(
    `integration-state:${apiBase}:${client}`,
    [apiBase, client],
    signal => loadIntegrationState(apiBase, client, signal),
    { isEmpty: () => false, enabled: active },
  );
  const historyResource = useDataSurface(
    `integration-journal:${apiBase}:${client}`,
    [apiBase, client],
    signal => loadIntegrationJournal(apiBase, client, signal),
    { isEmpty: data => data.operations.length === 0, enabled: active },
  );
  const status = statusResource.state.data;
  const operations = historyResource.state.data?.operations ?? [];
  const restoreOperation = operations.find(operation => operation.snapshot !== "expired");
  const latestOperationAt = operations[0]?.at;

  const refresh = () => {
    statusResource.refresh();
    historyResource.refresh();
  };

  const mutate = async (enabled: boolean) => {
    if (!status || pending) return;
    setPending(true);
    setMessage(null);
    try {
      await toggleIntegration(apiBase, client, enabled);
      setMessage({
        tone: "ok",
        key: enabled
          ? status.state === "stale" ? "integrations.success.refreshed" : "integrations.success.applied"
          : "integrations.success.disabled",
        vars: { client: t(FILE_CLIENT_META[client].labelKey) },
      });
    } catch (cause) {
      const view = mapIntegrationError(cause);
      setMessage({ tone: "err", key: view.key, vars: view.vars, code: view.code });
    } finally {
      setPending(false);
      refresh();
    }
  };

  if (!active && !status) return null;
  if (statusResource.state.showSkeleton && !status) {
    return (
      <section className="integration-client-page" role="status" aria-label={t("common.loading")}>
        <div className="integration-client-head integration-skeleton-card" />
        <div className="integration-status-line integration-skeleton-card" />
        <div className="integration-skeleton-card" />
      </section>
    );
  }
  if (statusResource.state.kind === "failed-cold" || !status) {
    return (
      <section className="integration-client-page">
        <Notice tone="err">{t("integrations.error.load")}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => statusResource.refresh()}>{t("common.retry")}</button>
      </section>
    );
  }

  return (
    <section className="integration-client-page" aria-busy={pending || statusResource.state.refreshing || historyResource.state.refreshing || undefined}>
      <FileIntegrationHeader
        status={status}
        restoreOperation={restoreOperation}
        pending={pending}
        onToggle={enabled => void mutate(enabled)}
        onRefresh={() => void mutate(true)}
        onRestore={setRestoreSelection}
      />

      <dl className="integration-status-line">
        <div>
          <dt>{t("integrations.status.appliedAt")}</dt>
          <dd>{status.appliedAt ? new Date(status.appliedAt).toLocaleString(locale) : t("integrations.status.unknown")}</dd>
        </div>
        <div>
          <dt>{t("integrations.status.lastOperation")}</dt>
          <dd>{latestOperationAt ? new Date(latestOperationAt).toLocaleString(locale) : t("integrations.status.unknown")}</dd>
        </div>
        <div>
          <dt>{t("integrations.status.configPath")}</dt>
          <dd><code>{status.configPath}</code></dd>
        </div>
      </dl>

      <p className="integration-semantics">{t(FILE_CLIENT_META[client].semanticsKey)}</p>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{message ? t(message.key, message.vars) : ""}</div>
      {message && <Notice tone={message.tone}>{t(message.key, message.vars)}{message.code && <code>{message.code}</code>}</Notice>}
      {(statusResource.state.showError || historyResource.state.showError) && (
        <div className="integrations-load-error">
          <Notice tone="err">{t("integrations.error.stale")}</Notice>
          <button type="button" className="btn btn-ghost btn-sm" onClick={refresh}>{t("common.retry")}</button>
        </div>
      )}

      <section aria-labelledby={`integration-settings-${client}`}>
        <h3 id={`integration-settings-${client}`}>{t("integrations.settings.title")}</h3>
        <ClientConfigPanel apiBase={apiBase} clients={[client]} />
        <p className="muted text-label">{t("integrations.settings.contractPending")}</p>
      </section>

      <details className="integration-advanced">
        <summary>{t("integrations.advanced.title")}</summary>
        <dl>
          <div><dt>{t("integrations.status.configPath")}</dt><dd><code>{status.configPath}</code></dd></div>
          <div><dt>{t("integrations.advanced.reason")}</dt><dd>{status.reason ? <code>{status.reason}</code> : t("integrations.status.unknown")}</dd></div>
          <div><dt>{t("integrations.advanced.lastOpId")}</dt><dd>{status.lastOpId ? <code>{status.lastOpId}</code> : t("integrations.status.unknown")}</dd></div>
        </dl>
        <p>{t("integrations.advanced.unavailable")}</p>
      </details>

      <section className="rollback-center" aria-labelledby={`integration-history-${client}`}>
        <h3 id={`integration-history-${client}`}>{t("integrations.history.title")}</h3>
        <OperationRows operations={operations} onSelect={setRestoreSelection} emptyTitleKey="integrations.history.empty" />
      </section>

      {restoreSelection && (
        <RestoreDialog
          apiBase={apiBase}
          operation={restoreSelection.operation}
          mode={restoreSelection.mode}
          onClose={() => setRestoreSelection(null)}
          onRestored={() => {
            setMessage({ tone: "ok", key: "integrations.success.restored" });
            refresh();
          }}
        />
      )}
    </section>
  );
}
```

## 14. Conditional activation ledger

Every conditional UI or transport branch above has an activation fixture and
an externally observable proof. Tests must assert the proof, not the internal
state variable.

| Branch | Activation scenario | Observable proof |
|---|---|---|
| adapter success | WP4 returns 200 JSON for each of the five routes | typed body resolves; no `IntegrationApiError` |
| adapter malformed/non-JSON failure | non-2xx response body cannot be parsed | `IntegrationApiError.status` is retained and generic keyed error renders |
| invalid client | WP4 `invalid_integration_client` | `integrations.error.invalidRequest`; no mutation retry |
| invalid JSON | WP4 `invalid_json_body` | `integrations.error.invalidRequest`; prior state remains |
| invalid enabled | WP4 `invalid_enabled` | `integrations.error.invalidRequest`; prior switch remains |
| invalid operation id | WP4 `invalid_op_id` | `integrations.error.invalidRequest`; dialog remains open |
| invalid drift flag | WP4 `invalid_confirm_drift` | `integrations.error.invalidRequest`; dialog remains open |
| missing operation | WP4 `integration_operation_not_found` | `integrations.error.operationNotFound` visible |
| expired restore request | WP4 `integration_snapshot_expired` | `integrations.error.snapshotExpired` visible; no success announcement |
| busy mutation | WP4 `integration_mutation_busy` | `integrations.error.busy`; old state remains and control re-enables |
| unsafe without snapshot path | WP4 `integration_unsafe`, no `snapshotPath` | `integrations.error.unsafe`; locked state refreshes from server |
| unsafe with snapshot path | WP4 `integration_unsafe` plus `snapshotPath` | dialog `role="alert"` names exact `reason` and path |
| conflict | WP4 `integration_conflict` | `integrations.error.conflict`; refreshed badge locks switch |
| first drift refusal | WP4 `integration_drift_confirmation_required` | same dialog changes title/body/confirm label; no close |
| confirmed drift | second dialog activation | exact second POST carries `{opId, confirmDrift:true}` and success closes dialog |
| mutation failure without recovery path | WP4 `integration_mutation_failed` without `snapshotPath` | `integrations.error.generic`; previous state remains |
| mutation failure with recovery path | WP4 `integration_mutation_failed` plus `snapshotPath` | dialog remains open and exact path is announced |
| internal error | WP4 `integration_internal_error` | keyed load or mutation fallback; technical code may render in `<code>` |
| residual without snapshot path | refusal carries `residual:true` only | `integrations.error.residual`; no false rollback claim |
| residual with snapshot path | refusal carries `residual:true` and `snapshotPath` | `integrations.restore.residualManual` names intermediate state and exact path |
| network error | `fetch` rejects | localized load/mutation fallback; cached state remains |
| CSRF mutation transport | GUI session is installed and PUT/POST runs | wrapped `window.fetch` adds API key, GUI origin, and `X-OpenCodex-CSRF-Token`; adapter adds only JSON content type |
| not-installed badge | `installed:false` with any five-state value | muted `not-installed` data attribute and localized text |
| absent badge | installed `absent` | muted `absent` data attribute and off switch |
| current badge | installed `current` | green `current` data attribute and on switch |
| stale badge | installed `stale` | amber `stale` data attribute, on switch, Update button |
| conflict badge | installed `conflict` | filled danger badge, off/locked switch described by badge |
| unsafe badge | installed `unsafe` | outlined danger badge, off/locked switch described by badge |
| file-card install guidance | `installed:false` | disabled switch `aria-describedby` points to visible client-specific guidance; no PUT |
| file-card apply | installed `absent`, switch activation | one PUT with `{enabled:true}`; no optimistic flip; state/journal refresh |
| file-card disable | installed `current` or `stale`, switch activation | one PUT with `{enabled:false}`; no optimistic flip |
| stale refresh | installed `stale`, Update activation | one PUT with `{enabled:true}` and refreshed state/journal |
| mutation pending | unresolved toggle promise | matching card/page has `aria-busy`; duplicate controls disabled |
| known backup line | client has any non-expired `stored` or `none` row | retained restore-point status line; `none` is not treated as expired |
| unknown backup line | no row or every row expired | unknown-backup keyed status; no invented backup path |
| Codex online | `/healthz` returns 2xx | native running text and service-controls link; no file badge/switch |
| Codex stopped | `/healthz` resolves with non-2xx | native stopped text and service-controls link |
| Codex unavailable | `/healthz` rejects | only Codex says unavailable; other cards remain |
| Claude Code enabled/disabled | `/api/claude-code` returns boolean | native status and native switch agree |
| Claude Code unavailable | read rejects or `enabled` is not boolean | disabled native switch and unavailable text |
| Claude Code mutation | native switch activation | exact native PUT `{enabled:boolean}`, native refresh, no journal row |
| Claude Desktop applied | status `applied:true, stale:false` | native applied text and Desktop deep link; no file switch |
| Claude Desktop stale | status `stale:true` | native stale text outranks applied text |
| Claude Desktop unavailable | read rejects or booleans absent | unavailable text; Desktop deep link remains |
| Grok configured/unconfigured | `/api/grok` returns `present` boolean | native configured/not-configured text and Grok deep link |
| Grok unavailable | read rejects or `present` is not boolean | unavailable text; no binary switch is invented |
| overview inactive cold | `active:false`, no held list | component returns `null`; no request-owned loading UI |
| overview summary | any held list/journal | `<dl>` counts detected/current-or-stale/stale and latest row time |
| overview onboarding | journal `ready-empty`, local key absent | keyed safety sentence immediately after summary |
| onboarding dismissal | successful apply or refresh | local key becomes `1`; sentence disappears and stays absent after reload |
| onboarding storage unavailable | localStorage read/write throws | page still works; dismissal remains session-local only |
| overview cold failure | list rejects with no held data | error Notice + Retry; no empty state/grid/actions |
| overview stale failure | list or journal refresh fails with held data | old cards remain with stale Notice |
| overview loading | list cold request pending | exactly ten fixed skeleton cards under `role="status"` |
| overview all-undetected | all six list rows have `installed:false` | empty explanation plus six client links; no bare/native grid |
| overview populated | at least one file client installed | stable native-four then file-six `<li>` order |
| bulk button hidden | no installed current/stale clients | no disable-all control |
| bulk confirm | at least one current/stale client | dialog lists exactly those candidates before mutation |
| bulk deterministic success | all sequential PUTs succeed | success Notice; state and journal refresh |
| bulk partial failure | any sequential PUT rejects | later candidates still run; Notice names failed labels in stable order |
| rollback empty | zero rows | empty title plus backup promise sentence |
| expired row precedence | `snapshot:"expired"`, regardless of `undoable` | disabled expired action; no dialog/request |
| undo row | non-expired row with `undoable:true` | Undo action opens undo-copy dialog for exact `opId` |
| restore row | non-expired row with `undoable:false` | restore-point action opens restore dialog |
| restore-to-absence row | `snapshot:"none"` and not expired | Undo/restore stays enabled and POSTs exact `opId` |
| dialog Escape idle | native cancel event while not pending | dialog closes and trigger focus is restored |
| dialog Escape pending | native cancel event while pending | cancel prevented; dialog remains and controls stay disabled |
| client page inactive cold | `active:false`, no held status | returns `null`; mounted parent keeps other drafts |
| client page cold loading | status has no held data and is pending | header/status/panel skeletons; no enabled switch |
| client page cold failure | status rejects with no held data | error Notice + Retry only |
| client page populated | status resolves | header, status `<dl>`, semantics, settings, advanced, history in DOM order |
| client restore header hidden | no non-expired history row | no header restore button |
| client restore header shown | any non-expired `stored` or `none` row | restore button opens exact newest available row |
| client status unknown | missing `appliedAt`, operation, reason, or op id | localized unknown value; no fabricated date/id |
| client settings | status resolved | one `ClientConfigPanel clients={[client]}`; one server export row/request |
| advanced collapsed | initial render | raw/fingerprint contract note hidden behind native `<details>` summary |
| advanced opened | user toggles `<details>` | path, reason, op id, and keyed unavailable note visible |

## 15. Exact WP4 error-code mapping

| WP4 `code` | User-facing state | Recovery/action |
|---|---|---|
| `invalid_integration_client` | `integrations.error.invalidRequest` | implementation/configuration error; no retry loop |
| `invalid_json_body` | `integrations.error.invalidRequest` | preserve UI state |
| `invalid_enabled` | `integrations.error.invalidRequest` | preserve switch state |
| `invalid_op_id` | `integrations.error.invalidRequest` | keep dialog open |
| `invalid_confirm_drift` | `integrations.error.invalidRequest` | keep dialog open |
| `integration_operation_not_found` | `integrations.error.operationNotFound` | refresh journal |
| `integration_snapshot_expired` | `integrations.error.snapshotExpired` | refresh journal; row becomes disabled |
| `integration_mutation_busy` | `integrations.error.busy` | retry after current mutation |
| `integration_unsafe` | `integrations.error.unsafe` or `integrations.restore.manual` | surface exact path when present |
| `integration_conflict` | `integrations.error.conflict` | refresh into locked conflict state |
| `integration_drift_confirmation_required` | drift-confirm dialog state | require explicit second submit |
| `integration_mutation_failed` | `integrations.error.generic` or `integrations.restore.manual` | surface exact path when present |
| `integration_internal_error` | load/mutation fallback | retain prior data and expose Retry where applicable |

`residual:true` takes precedence over the code mapping because it means
compensation failed. It uses `integrations.error.residual` without a path and
`integrations.restore.residualManual` with a path.

## 16. Additional i18n keys introduced by 061

These are in addition to the keys already enumerated in `060` §13. Add each to
all six locale modules; English remains the `TKey` source. Product labels also
stay keyed in these bodies even though the repository allowlist would permit
literal product names.

```text
integrations.advanced.lastOpId
integrations.advanced.reason
integrations.advanced.title
integrations.advanced.unavailable
integrations.bulk.confirm
integrations.bulk.pending
integrations.card.appliedAt
integrations.card.backupAvailable
integrations.card.backupUnknown
integrations.card.neverApplied
integrations.error.invalidRequest
integrations.error.operationNotFound
integrations.error.residual
integrations.error.snapshotExpired
integrations.history.empty
integrations.history.title
integrations.install.gajae
integrations.install.hermes
integrations.install.kimi
integrations.install.openclaw
integrations.install.opencode
integrations.install.pi
integrations.native.claudeCode
integrations.native.claudeDesktop
integrations.native.claudeSwitchLabel
integrations.native.claudeUpdateFailed
integrations.native.claudeUpdated
integrations.native.codex
integrations.native.configured
integrations.native.desktopApplied
integrations.native.desktopNotApplied
integrations.native.desktopStale
integrations.native.disabled
integrations.native.enabled
integrations.native.grok
integrations.native.notConfigured
integrations.native.openClaude
integrations.native.openDesktop
integrations.native.openGrok
integrations.native.running
integrations.native.serviceControls
integrations.native.stopped
integrations.native.unavailable
integrations.operation.apply
integrations.operation.disable
integrations.operation.refresh
integrations.operation.restore
integrations.restore.confirmUndo
integrations.restore.residualManual
integrations.restore.undoBody
integrations.restore.undoTitle
integrations.settings.contractPending
integrations.settings.title
integrations.status.configPath
integrations.status.lastOperation
integrations.success.applied
integrations.success.disabled
integrations.success.refreshed
integrations.success.restored
integrations.summary.title
integrations.switch.applyLabel
integrations.switch.disableLabel
```

Fixed English/Korean intent for the non-client-specific additions:

| Key family | English intent | Korean intent |
|---|---|---|
| `integrations.install.<client>` | `<Client> was not detected. Install it, then retry.` | `<Client>가 감지되지 않았습니다. 설치한 뒤 다시 시도하세요.` |
| `integrations.error.residual` | The change failed and automatic rollback could not complete. The file may be in an intermediate state. | 변경에 실패했고 자동 롤백도 완료되지 않았습니다. 파일이 중간 상태일 수 있습니다. |
| `integrations.restore.residualManual` | Automatic rollback failed: `{reason}`. The file may be in an intermediate state; recover it from `{path}`. | 자동 롤백에 실패했습니다: `{reason}`. 파일이 중간 상태일 수 있으므로 `{path}`에서 복구하세요. |
| `integrations.settings.contractPending` | Model selection, default-model changes, raw file preview, and fingerprints are unavailable until the management contract exposes them. | 관리 API가 제공되기 전까지 모델 선택, 기본 모델 변경, 원본 파일 미리보기, 지문 정보는 사용할 수 없습니다. |
| `integrations.advanced.unavailable` | Raw file contents and ownership fingerprints are not available from the current management API. | 현재 관리 API에서는 원본 파일 내용과 소유권 지문을 제공하지 않습니다. |
| `integrations.restore.undoTitle` / `undoBody` | Undo this operation? / Restore this operation's pre-write snapshot. | 이 작업을 되돌릴까요? / 이 작업의 변경 전 스냅샷을 복원합니다. |

## 17. OPEN QUESTIONS

**Resolved — `residual` forwarding.** `040`'s `writerFailureResponse` now
forwards `message`, `snapshotPath`, and `residual` on both
`integration_unsafe` and `integration_mutation_failed` (A-gate round 4,
blocker 6). The two residual activation rows are reachable, and their GUI
branches are in scope for this phase's tests.

**OPEN QUESTION — advanced settings contract.** The current WP4 routes expose
no model selection, default-model pointer, raw managed content, or ownership
fingerprints. The page therefore renders only the keyed unavailable note and
no inert controls.

**OPEN QUESTION — detected version.** WP4 exposes `installed` but no version.
The cards omit version rather than deriving it from paths or client output.
