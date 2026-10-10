import ClaudeInterceptStart from "../components/ClaudeInterceptStart";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useClaudeConnection } from "./use-claude-connection";
import { Notice, Switch } from "../ui";
import { useI18n, useT, LOCALES, type TKey } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { backgroundHelperOptions } from "./claude-code-helper-options";
import { reconcileAutoConnectState } from "./claude-autoconnect";
import { buildManualEnv } from "./claude-manual-env";
import {
  ClaudeCodeAliasesSection,
  ClaudeCodeModelMapSection,
  ClaudeCodeQuickstartSection,
  ClaudeCodeSettingsCard,
} from "./claude-code-sections";
import { AUTO_COMPACT_WINDOW_DEFAULT, formatCompactWindow, newClientId, normalizeContextAccounting, type ClaudeCodeState, type MapRow } from "./claude-code-types";
import { SmallFastModelSetting } from "./claude-code-settings";
import { interceptReasonKey, normalizeSharedProxy, selectFirstPartyNotice, type FirstPartyNotice } from "./claude-code-first-party";
import {
  acknowledgeSave,
  applyServerRead,
  claudeCodeSaveBody,
  isClaudeCodeDraftDirty,
  revertEditable,
  savedCopy,
  type ClaudeCodeEditState,
} from "./claude-code-save";

export { AutoConnectSetting, SmallFastModelSetting } from "./claude-code-settings";

/** `superseded`: a write landed while this read was out, so it must not reach any draft. */
type CachedClaudeCode = { state: ClaudeCodeState; rows: MapRow[]; superseded?: boolean };

function normalizeFirstPartyState(state: ClaudeCodeState): ClaudeCodeState {
  return {
    ...state,
    cliFirstParty: state.cliFirstParty === true,
    cliFirstPartyApplied: state.cliFirstPartyApplied === true,
    desktopFirstParty: state.desktopFirstParty === true,
    interceptRunning: state.interceptRunning === true,
    interceptEligible: state.interceptEligible === undefined ? true : state.interceptEligible === true,
    sharedProxy: normalizeSharedProxy(state.sharedProxy),
    // Shared by the session cache and the GET read, so a state cached by an older proxy (no
    // field) and an older server both read as the default.
    contextAccounting: normalizeContextAccounting(state.contextAccounting),
    // The GET has no separate field: the env on this read was built under the accounting it reports.
    servedContextAccounting: normalizeContextAccounting(state.servedContextAccounting ?? state.contextAccounting),
  };
}

/*
 * Bumped by every successful write, per session-cache key and shared by every mount. A read
 * remembers the epoch it started in and is dropped if a write landed meanwhile: the 1P switch
 * reads through its own controller, so a GET it began before a Save (even from a page that
 * has since unmounted) could otherwise finish afterwards and put the old values back into the
 * draft, the baseline and the session cache.
 */
const writeEpochs = new Map<string, number>();
const writeEpoch = (key: string) => writeEpochs.get(key) ?? 0;
const bumpWriteEpoch = (key: string) => { writeEpochs.set(key, writeEpoch(key) + 1); };

/*
 * Confirmed writes, per session-cache key. A switch or a Save can be confirmed after the page
 * that started it unmounted, and the refresh after it can fail; publishing every confirmation
 * here lets whichever page is on screen take it. `source` lets the writing page skip its own
 * event, since it already applied the write with its own rules.
 */
type LiveFields = Partial<Pick<ClaudeCodeState, "enabled" | "cliFirstParty">>;
type Confirmation = { kind: "live"; fields: LiveFields } | { kind: "saved"; copy: { state: ClaudeCodeState; rows: MapRow[] } };
const liveSource = Symbol("claude-code-live");
const confirmationListeners = new Map<string, Set<(event: Confirmation, source: symbol) => void>>();
function publishConfirmation(key: string, event: Confirmation, source: symbol) {
  for (const listener of confirmationListeners.get(key) ?? []) listener(event, source);
}

const firstPartyNoticeKeys: Record<Exclude<FirstPartyNotice, null>, TKey> = {
  unknown: "claude.firstParty.unknown",
  foreign: "claude.firstParty.foreign",
  local: "claude.firstParty.local",
  residual: "claude.firstParty.residual",
  disabled: "claude.firstParty.disabled",
  routingOff: "claude.firstParty.routingOff",
  stopped: "claude.firstParty.deadProxy",
  broken: "claude.firstParty.brokenProxy",
  notApplied: "claude.firstParty.notApplied",
  shared: "claude.firstParty.shared",
};

/**
 * One titled block of the single-page layout. The page used to show one of these at a time
 * behind an inner section rail; inside Connect that made a second sidebar next to the app's.
 */
function CcwSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="ccw-section" aria-labelledby={headingId}>
      <h3 className="ccw-section-title" id={headingId}>
        {title}
        {count != null ? <span className="count">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

export default function ClaudeCode({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang ?? "en";
  const cacheKey = `ocx.claude-code.v1:${apiBase}`;
  const resourceKey = `claude-code:${apiBase}`;
  const cachedEntry = useMemo(() => readSessionListCacheEntry<CachedClaudeCode>(cacheKey), [cacheKey]);
  const cached = useMemo(() => {
    if (!cachedEntry?.data) return null;
    return {
      ...cachedEntry.data,
      state: normalizeFirstPartyState(cachedEntry.data.state),
    };
  }, [cachedEntry]);
  /*
   * Draft and the server copy it is compared against live in ONE state object, so a read can
   * never update one without the other. A read replaces a clean draft and only refreshes the
   * server-owned fields of a dirty one (applyServerRead): the 1P toggle and the post-Save
   * refresh both re-read, and neither may throw away an edit the user has not saved.
   */
  const [edit, setEdit] = useState<ClaudeCodeEditState | null>(
    () => cached ? { draft: cached, baseline: cached, adoptNextRead: false } : null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [status, setStatus] = useState("");
  const [ok, setOk] = useState(false);
  /*
   * The connection switch moved here from the sidebar's Claude nav row, which
   * had made a navigation entry the owner of a mutation — and left it homeless
   * once the three integration pages collapsed into one.
   *
   * It keeps the sidebar's IMMEDIATE semantics rather than becoming another
   * draft: the Settings card below commits on Save, and quietly changing this
   * control's meaning would be worse than moving it. The in-flight ref
   * serializes rapid clicks so three taps cannot become three PUTs.
   */
  const { pending: connectionPending, change: changeConnection } = useClaudeConnection(apiBase);
  const [firstPartyPending, setFirstPartyPending] = useState(false);
  const firstPartyInFlight = useRef(false);

  const fetchCode = useCallback(async (signal: AbortSignal): Promise<CachedClaudeCode> => {
    const epoch = writeEpoch(cacheKey);
    const res = await fetch(`${apiBase}/api/claude-code`, { signal });
    const r = await readJsonOrThrow<ClaudeCodeState & { modelMap?: Record<string, string> }>(
      res,
      t("claude.loadFail"),
    );
    if (!r) throw new Error(t("claude.loadFail"));
    const nextState = normalizeFirstPartyState({
      ...r,
      // No coercion: an absent config key is AUTO, and coercing it to subscription is
      // what silently converted an untouched auto config on every save.
      authMode: r.authMode === "proxy" || r.authMode === "subscription" ? r.authMode : "auto",
      ...reconcileAutoConnectState(r),
      fastMode: r.fastMode ?? null,
      maxContextTokens: r.maxContextTokens ?? null,
      autoContext: r.autoContext !== false,
      autoCompactWindow: r.autoCompactWindow ?? null,
      injectAgents: r.injectAgents !== false,
      effectiveModelEnv: r.effectiveModelEnv ?? {},
    });
    const nextRows = Object.entries(r.modelMap ?? {}).map(([from, to]) => ({ id: newClientId(), from, to: String(to) }));
    const next = { state: nextState, rows: nextRows };
    if (signal.aborted) throw new Error("Claude Code request aborted");
    // Superseded by a write: hand it to the resource marked, so no mount folds it into a draft.
    if (epoch !== writeEpoch(cacheKey)) return { ...next, superseded: true };
    writeSessionListCacheEntry(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t]);

  const codeResource = useDataSurface<CachedClaudeCode>(
    resourceKey,
    [apiBase],
    fetchCode,
    {
      isEmpty: () => false,
      enabled: active,
      initialData: cached ?? undefined,
      initialDataCachedAt: cachedEntry?.cachedAt ?? null,
      staleAfterMs: 60_000,
    },
  );
  const loadState = codeResource.state;
  /*
   * Every mount folds each new server read into its own draft here, during render, instead of
   * the fetcher doing it: the resource is shared, so a refresh another (possibly unmounted)
   * page started must still reach the page on screen.
   */
  const [seenRead, setSeenRead] = useState(loadState.data);
  if (loadState.data !== seenRead) {
    setSeenRead(loadState.data);
    const read = loadState.data;
    if (read && !read.superseded) setEdit(current => applyServerRead(current, { state: read.state, rows: read.rows }));
  }
  const data = loadState.data ?? cached;
  const state = edit?.draft.state ?? data?.state ?? null;
  const rows = edit?.draft.rows ?? data?.rows ?? [];
  const dirty = edit !== null && isClaudeCodeDraftDirty(edit.draft, edit.baseline);

  const setState = (nextState: ClaudeCodeState) => {
    setEdit(current => current && { ...current, draft: { ...current.draft, state: nextState }, adoptNextRead: false });
  };
  const setRows = (nextRows: MapRow[]) => {
    setEdit(current => current && { ...current, draft: { ...current.draft, rows: nextRows }, adoptNextRead: false });
  };
  /**
   * Fields committed by their own control land in draft AND baseline, since they are not
   * edits, and in the confirmed state and session copy right away, so a reread that fails
   * afterwards cannot leave the page or a revisit showing the old value.
   */
  const applyLive = (fields: LiveFields) => {
    const stored = readSessionListCacheEntry<CachedClaudeCode>(cacheKey)?.data;
    if (stored) writeSessionListCacheEntry(cacheKey, { ...stored, state: { ...stored.state, ...fields } });
    // Live fields are not edits, so every page (this one included) takes them as-is.
    publishConfirmation(cacheKey, { kind: "live", fields }, liveSource);
  };
  const [pageSource] = useState(() => Symbol("claude-code-page"));
  useEffect(() => {
    const listener = (event: Confirmation, source: symbol) => {
      if (event.kind === "live") {
        const { fields } = event;
        setEdit(current => current && {
          ...current,
          draft: { ...current.draft, state: { ...current.draft.state, ...fields } },
          baseline: { ...current.baseline, state: { ...current.baseline.state, ...fields } },
        });
      } else if (source !== pageSource) {
        // Another page's Save: fold it like a server read, so unsaved edits here survive.
        const { copy } = event;
        setEdit(current => applyServerRead(current, copy));
      }
    };
    const listeners = confirmationListeners.get(cacheKey) ?? new Set();
    listeners.add(listener);
    confirmationListeners.set(cacheKey, listeners);
    return () => { listeners.delete(listener); };
  }, [cacheKey, pageSource]);

  const modelOptions = useMemo(
    () => backgroundHelperOptions(state?.available, t("claude.smallFastModelUnsetOption")),
    [state?.available, t],
  );

  // Auto-compact window presets (devlog 020 + user request): dropdown like the model
  // pickers. "" means "use the runtime default"; a saved off-ladder value is surfaced as
  // its own option. The default itself is on the ladder so the empty choice and the
  // explicit one are visibly the same number.
  const autoCompactOptions = useMemo(() => {
    const ladder = [
      100_000, 200_000, 250_000, 300_000, 350_000, 400_000, 500_000, 600_000, 750_000,
      AUTO_COMPACT_WINDOW_DEFAULT, 900_000, 1_000_000,
    ].sort((a, b) => a - b);
    // Compact SI-style units (1M / 350k) — technical number format, not prose.
    const current = state?.autoCompactWindow ?? null;
    const values = current !== null && !ladder.includes(current) ? [...ladder, current].sort((a, b) => a - b) : ladder;
    return [
      // The label carries the number instead of hardcoding it in nine locale files, which
      // is how "350k (default)" survived a default change.
      { value: "", label: t("claude.autoCompactDefault", { value: formatCompactWindow(AUTO_COMPACT_WINDOW_DEFAULT, localeTag) }) },
      ...values.map(value => ({ value: String(value), label: formatCompactWindow(value, localeTag) })),
    ];
  }, [state?.autoCompactWindow, t, localeTag]);

  /**
   * Immediate connection toggle. Waits for the response instead of flipping
   * optimistically: this writes the user's Claude settings file, so a switch
   * that showed "on" after a failed PUT would be lying about their config.
   */
  const toggleConnection = async () => {
    if (!state) return;
    setStatus("");
    await changeConnection(!state.enabled, enabled => {
      bumpWriteEpoch(cacheKey);
      applyLive({ enabled });
      codeResource.refresh();
    }, error => {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("claude.networkError"));
    });
  };

  const toggleFirstParty = async () => {
    if (!state || firstPartyInFlight.current) return;
    firstPartyInFlight.current = true;
    setFirstPartyPending(true);
    setStatus("");
    const requested = !state.cliFirstParty;
    try {
      const response = await fetch(`${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cliFirstParty: requested }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { code?: string; port?: number; bound?: number; configured?: number } | null;
        const refusalKeys = {
          intercept_disabled: "claude.firstParty.refusal.interceptDisabled",
          intercept_unavailable: "claude.firstParty.refusal.interceptUnavailable",
          foreign_env: "claude.firstParty.refusal.foreignEnv",
          ca_unavailable: "claude.firstParty.refusal.caUnavailable",
          unreadable: "claude.firstParty.refusal.unreadable",
          write_failed: "claude.firstParty.refusal.writeFailed",
        } as const;
        const key = payload?.code && payload.code in refusalKeys
          ? refusalKeys[payload.code as keyof typeof refusalKeys]
          : "claude.saveFailed";
        throw new Error(payload?.code && ["disabled", "client_role", "ephemeral_port", "port_in_use", "port_mismatch", "stopped", "failed"].includes(payload.code)
          ? t(interceptReasonKey(payload.code), { port: payload.port ?? "", bound: payload.bound ?? "", configured: payload.configured ?? "" }) : t(key));
      }
      await readJsonOrThrow(response, t("claude.saveFailed"));
      bumpWriteEpoch(cacheKey);
      // The PUT is the commit: show it now. The refresh only updates derived diagnostics
      // (applied state, notices), and its failure must not leave the switch showing the old value.
      applyLive({ cliFirstParty: requested });
      codeResource.refresh();
    } catch (error) {
      setOk(false);
      setStatus(error instanceof Error && error.message ? error.message : t("claude.networkError"));
    } finally {
      firstPartyInFlight.current = false;
      setFirstPartyPending(false);
    }
  };

  const save = async () => {
    if (!state || !edit || saving) return;
    const submitted = edit.draft;
    setStatus("");
    setSaveError("");
    setSaving(true);
    setEdit(current => current && { ...current, savePending: true });
    // Reads already in flight predate this Save; none of them may reach the draft or cache.
    bumpWriteEpoch(cacheKey);
    try {
      const r = await fetch(`${apiBase}/api/claude-code`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // Built from the captured draft, so the request and its acknowledgement can never diverge.
        body: JSON.stringify(claudeCodeSaveBody(submitted.state, submitted.rows)),
      });
      await readJsonOrThrow(r, t("claude.saveFailed"));
      bumpWriteEpoch(cacheKey);
      /*
       * Replace the session copy now, so a failed refresh cannot leave pre-Save values to reseed
       * a revisit. The session copy is the one record every mount shares of what the server has
       * confirmed (accepted reads and immediate switches write it), so the switch values come
       * from it, not from this page: another mount may have confirmed newer ones while this PUT
       * was out. Only the fields this Save submitted are laid on top.
       */
      const stored = readSessionListCacheEntry<CachedClaudeCode>(cacheKey)?.data;
      const copy = savedCopy(stored?.state ?? submitted.state, submitted);
      writeSessionListCacheEntry(cacheKey, copy);
      publishConfirmation(cacheKey, { kind: "saved", copy }, pageSource);
      // The submitted draft is what the server now holds; edits made meanwhile stay dirty.
      setEdit(current => acknowledgeSave(current, submitted));
      setOk(true);
      setSaveError("");
      setStatus(t("claude.saved"));
      codeResource.refresh();
    } catch (error) {
      setEdit(current => current && { ...current, savePending: false });
      setOk(false);
      setSaveError(error instanceof Error && error.message ? error.message : t("claude.networkError"));
    } finally {
      setSaving(false);
    }
  };

  const revert = () => {
    setStatus("");
    setSaveError("");
    setEdit(current => current && {
      draft: { state: revertEditable(current.draft.state, current.baseline.state), rows: current.baseline.rows },
      baseline: current.baseline,
      adoptNextRead: false,
    });
  };

  // A hidden Code tab remains mounted for draft preservation, but must not advertise a
  // disabled fetch as loading before the user ever opens it.
  if (loadState.kind === "disabled" && !data) return null;
  if (loadState.showSkeleton && !data) {
    return <DataSurfaceSkeleton label={t("claude.loading")} rows={3} />;
  }
  if (loadState.kind === "failed-cold") {
    const reason = loadState.error instanceof Error ? loadState.error.message : t("claude.loadFail");
    return (
      <div className="claudecode-workspace-shell">
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => codeResource.refresh()}>{t("common.retry")}</button>
      </div>
    );
  }
  if (!state) return null;

  /*
   * The master switch is the last control on the page. It is the same claudeCode.enabled the
   * Claude card on the Connect overview toggles (default on), so turning Claude on there
   * already routes ocx claude through OpenCodex; this row is where you turn it all off. It
   * commits immediately, so it sits outside every section the Save bar owns.
   */
  const connectionRow = (
    <div className="setting-row claudecode-connection-row">
      <div className="setting-label">
        <span className="title" id="claudecode-connection-label">{t("claude.enabledLabel")}</span>
        <span className="desc">{t("claude.subtitle")}</span>
      </div>
      <Switch
        on={state.enabled}
        onClick={() => void toggleConnection()}
        disabled={connectionPending}
        label={t("claude.toggleAria")}
      />
    </div>
  );

  return (
    <div className="claudecode-workspace-shell claudecode-doc">
      {status && <Notice tone={ok ? "ok" : "err"}>{status}</Notice>}
      {loadState.showError && <Notice tone="err">{t("claude.loadFail")}</Notice>}
      <div className="card claudecode-connection-card">
        <div className="setting-row">
          <div className="setting-label">
            <span className="title" id="claudecode-first-party-label">{t("claude.firstParty.label")}</span>
            <span className="desc">{t("claude.firstParty.desc")}</span>
          </div>
          <Switch
            on={state.cliFirstParty}
            onClick={() => void toggleFirstParty()}
            disabled={firstPartyPending}
            label={t("claude.firstParty.aria")}
          />
        </div>
      </div>
      {!state.interceptRunning && <ClaudeInterceptStart apiBase={apiBase} reason={state.interceptReason} port={state.interceptFailurePort} onStarted={() => codeResource.refresh()} />}
      {state.cliFirstParty && (
        <Notice tone="warn">{t("claude.firstParty.risk")}</Notice>
      )}
      {(() => {
        const notice = selectFirstPartyNotice(state);
        const key = notice && firstPartyNoticeKeys[notice];
        return key ? <Notice tone="warn">{t(key)}</Notice> : null;
      })()}

      <CcwSection title={t("claude.quickstart")}>
        <ClaudeCodeQuickstartSection manualEnv={buildManualEnv(state)} />
      </CcwSection>

      <CcwSection title={t("claude.workspace.settings")}>
        <ClaudeCodeSettingsCard
          state={state}
          autoCompactOptions={autoCompactOptions}
          availableModels={state.available ?? []}
          onStateChange={setState}
        />
      </CcwSection>

      <CcwSection title={t("claude.smallFastModel")}>
        <SmallFastModelSetting
          value={state.smallFastModel}
          tierHaikuModel={state.tierModels?.haiku}
          options={modelOptions}
          onChange={smallFastModel => setState({ ...state, smallFastModel })}
        />
      </CcwSection>

      <CcwSection title={t("claude.modelMap")} count={rows.length}>
        <ClaudeCodeModelMapSection rows={rows} onRowsChange={setRows} />
      </CcwSection>

      <CcwSection title={t("claude.aliases")} count={state.aliases.length}>
        <ClaudeCodeAliasesSection aliases={state.aliases} />
      </CcwSection>

      <div className="card claudecode-master-card">
        {connectionRow}
      </div>

      <div className="ccw-savebar" role="region" aria-label={t("claude.saveBar.label")}>
        {saveError && <span className="ccw-savebar-error" role="alert">{saveError}</span>}
        <span className={`ccw-savebar-state${dirty ? " dirty" : ""}`} aria-live="polite" aria-atomic="true">
          {dirty ? t("claude.saveBar.dirty") : t("claude.saveBar.clean")}
        </span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!dirty || saving} onClick={revert}>
          {t("claude.saveBar.revert")}
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={() => { void save(); }}>
          {t("common.save")}
        </button>
      </div>
    </div>
  );
}
