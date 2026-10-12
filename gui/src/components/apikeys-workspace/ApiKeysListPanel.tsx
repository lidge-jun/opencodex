/**
 * The key list, as a table (devlog 260802/020, revised after the maintainer asked
 * for a top strip instead of a side rail).
 *
 * This replaces the workspace rail. A rail and a content pane were two vertical
 * bands competing for the same width; a table is also the better surface for what
 * these rows are, which is comparative — requests and last-used sort, a rail does
 * not. Selecting a row opens the existing detail pane.
 *
 * Every row carries its own delete control, visible at rest. When the table
 * replaced the rail, delete survived only inside the detail pane, behind a name
 * that did not read as a link — operators hovered the row, found nothing, and
 * concluded a key could not be removed. A hover-only control would repeat that on
 * touch screens, so it stays on screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconTrash } from "../../icons";
import { useT } from "../../i18n/shared";
import { formatCreatedDate, type ApiKeyEntry, type RevealKeyResult } from "../../pages/api-keys-utils";
import type { UsageReadMetadata } from "../../usage-summary-resource";
import { UsageIncompleteNotice } from "../usage-incomplete-notice";
import { Notice } from "../../ui";
import { isStandaloneRuntime, standaloneApiTargets } from "../../api-targets";
import { ConnectPairingForm } from "../../connect-pairing";
import { useKeyDisclosure, type DisclosureResetReason } from "../../use-key-disclosure";

export default function ApiKeysListPanel({
  keys,
  keysLoading,
  keysLoadFailed,
  attributionSince,
  usageMetadata,
  localeTag,
  apiBase,
  active = true,
  onPairingStart,
  busy,
  onSelect,
  onDelete,
  onReveal,
}: {
  keys: ApiKeyEntry[];
  keysLoading: boolean;
  keysLoadFailed: boolean;
  /** Absent means nothing is attributable yet — different from a counter reading zero. */
  attributionSince?: string;
  usageMetadata?: UsageReadMetadata;
  localeTag?: string;
  /** Management API origin a reveal denial pairs this dashboard against. */
  apiBase: string;
  active?: boolean;
  onPairingStart?: () => void;
  /** A mutation is in flight; its result is bound to one key, so navigation waits. */
  busy: boolean;
  onSelect: (id: string) => void;
  /** Resolves true only when the key is really gone. */
  onDelete?: (id: string) => Promise<boolean>;
  /** The reveal outcome: the full key, a standing refusal, or a transient failure. */
  onReveal?: (id: string) => Promise<RevealKeyResult>;
}) {
  const t = useT();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealPendingId, setRevealPendingId] = useState<string | null>(null);
  const [revealFailedId, setRevealFailedId] = useState<string | null>(null);
  /** A refused row offers pairing; success still needs a fresh reveal click. */
  const [revealDeniedId, setRevealDeniedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteFailedId, setDeleteFailedId] = useState<string | null>(null);
  const pendingReveal = useRef<string | null>(null);
  const clearDisclosure = useCallback((reason: DisclosureResetReason) => {
    const interrupted = pendingReveal.current;
    pendingReveal.current = null;
    setRevealed({});
    setRevealPendingId(null);
    setRevealFailedId(null);
    setRevealDeniedId(current => reason === "session" ? interrupted ?? current : reason === "pairing" ? current : null);
    setCopiedId(null);
    setCopyFailedId(null);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = null;
  }, []);
  const disclosure = useKeyDisclosure(apiBase, active, clearDisclosure);

  // Same 300ms fuse as the detail pane: the click that opened the confirmation
  // must not be able to land on the button that replaced it.
  useEffect(() => {
    if (!confirmId) return;
    const timer = window.setTimeout(() => setConfirmArmed(true), 300);
    return () => window.clearTimeout(timer);
  }, [confirmId]);

  // A revealed value belongs to one version of a row. Rotation keeps the id and
  // changes the key, so a value is shown only while it still extends the prefix
  // the server currently lists; a key deleted while its reveal was in flight
  // never gets its value back.
  const deletedIds = useRef(new Set<string>());
  const currentReveal = (k: ApiKeyEntry): string | undefined => {
    const value = revealed[k.id];
    return value !== undefined && value.startsWith(k.prefix.replace(/\.\.\.$/, "")) ? value : undefined;
  };

  const rowLocked = busy || deletingId !== null;

  // The same gate RemoteLink applies to its local-pairing offer: only the
  // literal same-origin loopback transport the standalone grant mint accepts.
  // An alias URL does not reveal the configured bind host, so never invent
  // a recovery URL from it; keep the generic denial guidance.
  const localPairingTarget = standaloneApiTargets(apiBase).shared;
  const canPairLocally = isStandaloneRuntime()
    && window.location.protocol === "http:"
    && ["127.0.0.1", "[::1]"].includes(window.location.hostname)
    && localPairingTarget.serverOrigin === window.location.origin;

  const toggleReveal = async (k: ApiKeyEntry) => {
    const generation = disclosure.generation.current;
    if (!disclosure.current(generation)) return;
    const id = k.id;
    setRevealFailedId(null);
    setRevealDeniedId(null);
    if (currentReveal(k) !== undefined) {
      setRevealed(({ [id]: _hidden, ...rest }) => rest);
      return;
    }
    if (!onReveal || revealPendingId) return;
    pendingReveal.current = id;
    setRevealPendingId(id);
    try {
      const result = await onReveal(id);
      if (!disclosure.current(generation) || deletedIds.current.has(id)) return;
      if (result.ok) setRevealed(prev => ({ ...prev, [id]: result.key }));
      else if (result.kind === "denied") {
        disclosure.invalidate();
        onPairingStart?.();
        setRevealDeniedId(id);
      }
      else setRevealFailedId(id);
    } catch {
      if (disclosure.current(generation)) setRevealFailedId(id);
    } finally {
      if (disclosure.current(generation)) {
        pendingReveal.current = null;
        setRevealPendingId(null);
      }
    }
  };

  const copyFailed = (id: string) => {
    setCopiedId(current => current === id ? null : current);
    setCopyFailedId(id);
  };

  const copyKey = (id: string, value: string) => {
    const generation = disclosure.generation.current;
    if (!disclosure.current(generation)) return;
    setCopyFailedId(null);
    let write: Promise<void> | undefined;
    try {
      write = navigator.clipboard?.writeText?.(value);
    } catch {
      write = undefined;
    }
    if (!write) {
      copyFailed(id);
      return;
    }
    write.then(() => {
      if (!disclosure.current(generation) || deletedIds.current.has(id)) return;
      setCopiedId(id);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        setCopiedId(current => current === id ? null : current);
        copiedTimer.current = null;
      }, 2000);
    }, () => { if (disclosure.current(generation)) copyFailed(id); });
  };

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const confirmDelete = async (id: string) => {
    if (!onDelete || !confirmArmed || deletingId) return;
    setDeletingId(id);
    setDeleteFailedId(null);
    try {
      if (await onDelete(id)) {
        deletedIds.current.add(id);
        setConfirmId(null);
        setConfirmArmed(false);
        setRevealed(({ [id]: _gone, ...rest }) => rest);
      } else {
        setDeleteFailedId(id);
      }
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="panel api-panel awi-keylist-panel" aria-busy={keysLoading}>
      <div className="api-panel-head">
        <h3 className="panel-title">
          {keysLoading ? t("api.activeKeysLoading") : t("api.activeKeys", { count: keys.length })}
        </h3>
      </div>

      <UsageIncompleteNotice data={usageMetadata} />
      {revealDeniedId !== null && (
        <>
          <Notice tone="warn">{t("api.key.revealDenied")}</Notice>
          {/* Pairing authorizes the browser, but never discloses a value itself. */}
          {canPairLocally && (
            <ConnectPairingForm
              local
              target={localPairingTarget}
              onPairingStart={() => {
                disclosure.invalidate();
                onPairingStart?.();
              }}
              onConnected={() => {
                disclosure.invalidate();
                onPairingStart?.();
                setRevealDeniedId(null);
              }}
            />
          )}
        </>
      )}
      {keysLoading ? (
        <div className="api-active-keys-skeleton" role="status" aria-label={t("common.loading")} />
      ) : keys.length === 0 ? (
        // Two different sentences: a catalog we could not read is not an empty one.
        <p className="muted small">{keysLoadFailed ? t("api.keysLoadFailed") : t("api.noKeys")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl awi-keylist-table">
            <thead>
              <tr>
                <th>{t("api.colName")}</th>
                <th>{t("api.colKey")}</th>
                <th>{t("api.attribution.requests7d")}</th>
                <th>{t("api.attribution.lastUsed")}</th>
                {onDelete && <th className="awi-keylist-actions-col"><span className="sr-only">{t("api.colActions")}</span></th>}
              </tr>
            </thead>
            <tbody>
              {keys.map(k => {
                const full = currentReveal(k);
                const confirming = confirmId === k.id;
                return (
                  <tr key={k.id} className={confirming ? "awi-keylist-row is-confirming" : "awi-keylist-row"}>
                    <td>
                      {/* A real button, not a clickable row: a `<tr>` with onClick is
                          unreachable by keyboard. */}
                      <button
                        type="button"
                        className="awi-keylist-name"
                        disabled={rowLocked}
                        onClick={() => onSelect(k.id)}
                      >
                        {k.name}
                      </button>
                    </td>
                    <td className="awi-keylist-keycell">
                      {onReveal ? (
                        <span className="awi-keylist-keywrap">
                          <button
                            type="button"
                            className={full ? "awi-keylist-key is-revealed" : "awi-keylist-key"}
                            aria-expanded={full !== undefined}
                            aria-label={t(full ? "api.key.hideAria" : "api.key.revealAria", { name: k.name })}
                            title={t(full ? "api.key.hideHint" : "api.key.revealHint")}
                            disabled={revealPendingId === k.id}
                            onClick={() => { void toggleReveal(k); }}
                          >
                            <code>{full ?? k.prefix}</code>
                          </button>
                          {full && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm awi-keylist-copy"
                              onClick={() => copyKey(k.id, full)}
                            >
                              {copiedId === k.id ? t("api.copied") : t("api.copy")}
                            </button>
                          )}
                          {copyFailedId === k.id && (
                            <span className="awi-delete-error awi-keylist-inline-error" role="alert">{t("api.key.copyFailedShort")}</span>
                          )}
                          {revealFailedId === k.id && (
                            <span className="awi-delete-error awi-keylist-inline-error" role="alert">{t("api.key.revealFailed")}</span>
                          )}
                        </span>
                      ) : (
                        <code>{k.prefix}</code>
                      )}
                    </td>
                    <td>
                      {!attributionSince
                        ? t("api.attribution.unavailable")
                        : k.usage.ambiguous
                          ? t("api.attribution.railAmbiguous")
                          : k.usage.requests7d.toLocaleString(localeTag)}
                    </td>
                    <td>
                      {!attributionSince || k.usage.ambiguous
                        ? "—"
                        : k.usage.lastUsedAt
                          ? formatCreatedDate(k.usage.lastUsedAt, localeTag)
                          : t(usageMetadata?.usageIncomplete ? "api.attribution.noRecordedUse" : "api.attribution.neverUsed")}
                    </td>
                    {onDelete && (
                      <td className="awi-keylist-actions">
                        {confirming ? (
                          <span className="awi-keylist-confirm">
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              aria-label={t("api.key.deleteRowAria", { name: k.name })}
                              disabled={!confirmArmed || deletingId !== null}
                              onClick={() => { void confirmDelete(k.id); }}
                            >
                              {deletingId === k.id ? t("api.key.deleting") : t("api.key.deleteShort")}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={deletingId !== null}
                              onClick={() => { setConfirmId(null); setConfirmArmed(false); setDeleteFailedId(null); }}
                            >
                              {t("common.cancel")}
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="awi-keylist-delete"
                            aria-label={t("api.key.deleteRowAria", { name: k.name })}
                            title={t("api.workspace.deleteKey")}
                            disabled={rowLocked}
                            onClick={() => { setDeleteFailedId(null); setConfirmArmed(false); setConfirmId(k.id); }}
                          >
                            <IconTrash width={16} height={16} aria-hidden="true" />
                          </button>
                        )}
                        {deleteFailedId === k.id && (
                          <span className="awi-delete-error awi-keylist-inline-error" role="alert">{t("api.deleteFailed")}</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
