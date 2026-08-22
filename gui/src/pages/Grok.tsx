import { useCallback, useMemo, useState } from "react";
import { EmptyState, Notice, Switch } from "../ui";
import { IconChevron } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { setClientResourceData } from "../client-resource";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { makeCollapseStore, toggleInSet } from "./collapse-store";
import { grokGroupView, type GrokCandidate } from "./grok-groups";

type TFn = (key: TKey, vars?: Record<string, string | number>) => string;

interface GrokStatusModel {
  alias: string;
  id: string;
  contextWindow?: number;
}

interface GrokStatus {
  configPath: string;
  present: boolean;
  baseUrl: string | null;
  models: GrokStatusModel[];
  candidates: GrokCandidate[];
  excluded: string[];
}

/** Same collapse store the Desktop page uses; Grok groups start collapsed. */
const GROUP_COLLAPSE = makeCollapseStore("ocx.grok.collapsedGroups.v2");

const GROUPS = [
  { id: "native", tkey: "grok.groupNative" as TKey },
  { id: "routed", tkey: "grok.groupRouted" as TKey },
] as const;

const DEFAULT_COLLAPSED_GROUPS = new Set(GROUPS.map((group) => group.id));

/** Same context formatting the Desktop page uses, so the two surfaces read alike. */
function formatContext(value: number | undefined, t: TFn): string {
  if (!value) return "—";
  // 1 MiB and above is a whole "1M": providers report 2^20 (1048576), and
  // 1048576 / 1e6 = 1.048576 reads as a bug.
  if (value >= 1_048_576) return t("claudeDesktop.contextM", { n: Math.round(value / 1_048_576) });
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

/**
 * Grok Build surface: per-model switches over the candidate catalog, plus save/apply.
 *
 * The page writes ONLY the selection (config.json, via /api/grok/selection) and asks the
 * proxy to re-run the guarded sync (/api/grok/apply). The fence itself is written only
 * by injectGrokConfig — the same path `ocx start`/`ensure`/`restart` use. Aliases shown
 * here come from readGrokStatus (what the writer actually wrote), never computed.
 */
/**
 * `active` gates the status resource. Grok is one panel of the Integrations
 * tab strip and stays mounted while hidden to preserve an unsaved selection,
 * so the gate is what stops a hidden panel from polling. The `signal` makes a
 * request in flight at deactivation abortable rather than orphaned.
 */
export default function Grok({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const cacheKey = `ocx.grok.status.v1:${apiBase}`;
  const cachedEntry = readSessionListCacheEntry<GrokStatus>(cacheKey);
  const cached = cachedEntry?.data ?? null;
  // Local edits are an OVERLAY on the server's selection rather than a copy of it. Copying meant
  // reconciling in an effect, which both fought the switches mid-interaction and tripped the
  // cascading-render lint; `null` here means "no unsaved edits, follow the server".
  const [draftExcluded, setDraftExcluded] = useState<Set<string> | null>(null);
  // null = no stored preference; groups start collapsed so the list opens on demand.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => GROUP_COLLAPSE.read() ?? new Set(DEFAULT_COLLAPSED_GROUPS));
  const [pending, setPending] = useState<"save" | "apply" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const fetchStatus = useCallback(async (signal: AbortSignal): Promise<GrokStatus> => {
    const response = await fetch(`${apiBase}/api/grok`, { signal });
    const payload = await readJsonOrThrow<GrokStatus & { error?: string }>(response, t("grok.loadFail"));
    if (!payload) throw new Error(t("grok.loadFail"));
    // Tolerate an older proxy that predates the selection routes: the page degrades
    // to the read-only fence view instead of crashing on a missing field.
    const next = { ...payload, candidates: payload.candidates ?? [], excluded: payload.excluded ?? [] };
    writeSessionListCacheEntry(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t]);

  // Request ownership lives in the shared resource layer, so a route change during the first
  // load cannot drop the request the way the old deferred timer did.
  const resourceKey = `grok-status:${apiBase}`;
  const resource = useDataSurface<GrokStatus>(
    resourceKey,
    [apiBase],
    fetchStatus,
    {
      isEmpty: () => false,
      initialData: cached ?? undefined,
      initialDataCachedAt: cachedEntry?.cachedAt ?? null,
      // A revisit within the window paints from cache with no request at all; past it,
      // the refetch is quiet (cached rows stay on screen).
      staleAfterMs: 60_000,
      enabled: active,
    },
  );
  const { state } = resource;
  const load = resource.refresh;
  const status = state.data ?? cached;

  const savedExcluded = useMemo(
    () => new Set(status?.excluded ?? []),
    [status],
  );
  const excluded = draftExcluded ?? savedExcluded;

  const dirty = useMemo(
    () => draftExcluded !== null
      && (draftExcluded.size !== savedExcluded.size || [...draftExcluded].some(id => !savedExcluded.has(id))),
    [draftExcluded, savedExcluded],
  );

  const aliasById = useMemo(
    () => new Map((status?.models ?? []).map(m => [m.id, m.alias])),
    [status],
  );

  const toggleGroup = (id: string) => {
    const next = toggleInSet(collapsed, id);
    GROUP_COLLAPSE.write(next);
    setCollapsed(next);
  };

  const setAllCollapsed = (nextCollapsed: boolean) => {
    const next = nextCollapsed ? new Set(GROUPS.map((group) => group.id)) : new Set<string>();
    GROUP_COLLAPSE.write(next);
    setCollapsed(next);
  };

  const toggleModel = (id: string, currentlyExcluded: boolean) => {
    setDraftExcluded(current => {
      // First toggle forks the server selection into a draft; later toggles build on the draft.
      const next = new Set(current ?? savedExcluded);
      if (currentlyExcluded) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async (applyAfter: boolean) => {
    if (pending) return;
    setPending("save");
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/grok/selection`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excluded: [...excluded] }),
      });
      await readJsonOrThrow<{ error?: string }>(response, t("grok.saveFailed"));
      // Publish the acknowledged selection into the resource store BEFORE dropping the draft.
      // Clearing the draft alone would fall back to the previous snapshot, so the switch the user
      // just saved would visibly revert while the page claimed to be up to date.
      const acknowledged = [...excluded];
      if (status) setClientResourceData(resourceKey, { ...status, excluded: acknowledged });
      setDraftExcluded(null);

      if (applyAfter) {
        setPending("apply");
        const applied = await fetch(`${apiBase}/api/grok/apply`, { method: "POST" });
        // Apply errors use `{ message, skippedReason }` (not always `error`); preserve that
        // actionable copy for orphan-marker repair and policy skips.
        if (!applied.ok) {
          const failed = await applied.json().catch(() => ({})) as { message?: string; error?: string };
          throw new Error(failed.message ?? failed.error ?? t("grok.applyFailed"));
        }
        const payload = await applied.json().catch(() => ({})) as {
          message?: string;
          skippedReason?: string;
        };
        // A policy skip is not success theatre: the Grok config did NOT change
        // (non-loopback bind, or no ~/.grok), so say that instead of "applied".
        if (payload.skippedReason) {
          setMessage({ tone: "err", text: payload.message ?? t("grok.applySkipped") });
          setAnnouncement(payload.message ?? t("grok.applySkipped"));
        } else {
          setMessage({ tone: "ok", text: t("grok.savedApplied") });
          setAnnouncement(t("grok.savedApplied"));
        }
        await load();
      } else {
        setMessage({ tone: "ok", text: t("grok.saved") });
        setAnnouncement(t("grok.saved"));
        if (status) {
          writeSessionListCacheEntry(cacheKey, { ...status, excluded: acknowledged });
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : t("grok.saveFailed");
      setMessage({ tone: "err", text });
      setAnnouncement(text);
    } finally {
      setPending(null);
    }
  };

  // The skeleton owns the live region while cold, so no status line is rendered beside it.
  if (state.showSkeleton && !status) {
    return (
      <section className="grok-page">
        <DataSurfaceSkeleton label={t("grok.loading")} rows={4} />
      </section>
    );
  }

  if (state.kind === "failed-cold") {
    const reason = state.error instanceof Error ? state.error.message : t("grok.loadFail");
    return (
      <section className="grok-page">
        <div className="alert alert-err" role="alert">{reason}</div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => load()}>{t("common.retry")}</button>
      </section>
    );
  }

  return (
    <section className="grok-page" aria-busy={state.refreshing || undefined}>
      <h2 className="page-title">{t("grok.title")}</h2>
      <p className="page-sub">{t("grok.subtitle")}</p>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      {/* A refresh that fails while cached data is on screen must say so instead of leaving the
          page looking settled; the notice then owns the live region for this transition. */}
      {state.showError && <Notice tone="err">{t("grok.loadFail")}</Notice>}

      {status && status.candidates.length > 0 && (
        <div className="claude-profile-bar">
          <span className={`claude-dirty${dirty ? " active" : ""}`}>
            {dirty ? t("grok.unsaved") : t("grok.upToDate")}
          </span>
          <div className="claude-save-actions">
            <button type="button" className="btn btn-ghost" disabled={!dirty || pending !== null} onClick={() => void save(false)}>
              {pending === "save" ? t("grok.saving") : t("common.save")}
            </button>
            <button type="button" className="btn btn-primary" disabled={!dirty || pending !== null} onClick={() => void save(true)}>
              {pending === "apply" ? t("grok.applying") : pending === "save" ? t("grok.saving") : t("grok.saveApply")}
            </button>
          </div>
        </div>
      )}

      {!status?.present ? (
        // Absent is a normal state, not a failure: Grok simply is not wired up yet. Name the
        // action that wires it rather than leaving an empty panel.
        <EmptyState title={t("grok.notConfiguredTitle")}>
          {t("grok.notConfiguredHint")}
          <br />
          <code>{status?.configPath}</code>
        </EmptyState>
      ) : (
        <>
          <div className="grok-endpoint">
            <span>{t("grok.endpoint")}</span>
            <code>{status.baseUrl ?? "—"}</code>
          </div>
          <p className="page-sub"><code>{status.configPath}</code></p>
        </>
      )}

      {status && status.candidates.length > 0 && (
        <div className="ocx-group-stack">
          <div className="row" style={{ gap: 6, margin: "2px 0 10px" }}>
            <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={() => setAllCollapsed(true)} disabled={pending !== null}>
              <IconChevron width={12} height={12} aria-hidden="true" /> {t("models.collapseAll")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm text-caption" onClick={() => setAllCollapsed(false)} disabled={pending !== null}>
              <IconChevron width={12} height={12} aria-hidden="true" style={{ transform: "rotate(90deg)" }} /> {t("models.expandAll")}
            </button>
          </div>
          {GROUPS.map(group => {
            const view = grokGroupView(status.candidates, aliasById, excluded, group.id);
            if (view.total === 0) return null;
            const isCollapsed = collapsed.has(group.id);
            return (
              <section key={group.id} className={`ocx-group${isCollapsed ? " collapsed" : ""}`} aria-labelledby={`grok-group-${group.id}`}>
                <header className={`ocx-group-head${isCollapsed ? "" : " open"}`}>
                  <h3 id={`grok-group-${group.id}`} className="ocx-group-heading">
                    <button
                      type="button"
                      className="ocx-group-toggle"
                      aria-expanded={!isCollapsed}
                      aria-controls={`grok-group-body-${group.id}`}
                      onClick={() => toggleGroup(group.id)}
                    >
                      <IconChevron
                        className="ocx-chevron"
                        width={14}
                        height={14}
                        aria-hidden="true"
                        style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }}
                      />
                      <span className="ocx-group-name">{t(group.tkey)}</span>
                      <span className="ocx-group-count">
                        {t("grok.enabledCount", { on: view.enabled, total: view.total })}
                      </span>
                    </button>
                  </h3>
                </header>
                {!isCollapsed && (
                  <div id={`grok-group-body-${group.id}`} className="grok-model-list">
                    {view.rows.map(model => (
                      <div key={model.id} className="grok-model-row">
                        <Switch
                          on={model.enabled}
                          onClick={() => toggleModel(model.id, !model.enabled)}
                          disabled={pending !== null}
                          label={t("grok.toggleModel", { id: model.id })}
                        />
                        <span className="grok-model-names">
                          <strong title={model.id}>{model.id}</strong>
                          <code title={model.alias ?? undefined}>{model.alias ?? "—"}</code>
                        </span>
                        <span className="claude-model-context">{formatContext(model.contextWindow, t)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
