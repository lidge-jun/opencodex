import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { LANE_PAGE, defaultCollapsedFamilies, laneView, rowStartsOpen } from "./claude-desktop-lane";
import { makeCollapseStore, toggleInSet } from "./collapse-store";
import { IconChevron } from "../icons";
import { EmptyState, Notice } from "../ui";
import { LOCALES, useI18n, type TFn, type TKey } from "../i18n/shared";
import { readJsonIfOk, readJsonOrThrow } from "../fetch-json";
import { readSessionListCacheEntry, writeSessionListCacheEntry } from "../session-list-cache";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";

const FAMILIES = ["opus", "fable", "sonnet", "haiku"] as const;
type Family = typeof FAMILIES[number];

/**
 * Family collapse lives under its own key: the Models page collapses PROVIDERS, and a
 * shared key would make folding "opus" here fold a provider of the same name there.
 */
const FAMILY_COLLAPSE = makeCollapseStore("ocx.claudeDesktop.collapsedFamilies.v2");

interface Assignment {
  family: Family;
  alias: string;
}

interface DesktopProfile {
  version: 1;
  assignments: Record<string, Assignment>;
  defaults: Record<Family, string | null>;
  /** Written by the apply route; mirrors OcxClaudeDesktopProfile so a round-trip keeps them. */
  appliedFingerprint?: string;
  appliedAt?: string;
}

interface DesktopModel {
  route: string;
  label: string;
  available: boolean;
  contextWindow?: number;
  effortSupported?: boolean;
  supports1m?: boolean;
  assignment: Assignment;
}

interface DesktopStatus {
  desiredEnabled: boolean;
  applied: boolean;
  appliedAt: string | null;
  stale: boolean;
  /**
   * Whether Desktop's _meta.json appliedId actually points at our profile.
   * Desktop serves only that one, so false means it is ignoring us even when
   * `applied` (our saved fingerprint) says otherwise. null = undeterminable.
   */
  activeProfile?: boolean | null;
  health: { lastRequestAt: string | null; requestCount: number; errorCount: number };
}

interface DesktopResponse {
  profile: DesktopProfile;
  models: DesktopModel[];
  rendered: unknown[];
  port: number;
}

type PendingAction = "save" | "apply" | null;

const FAMILY_KEYS: Record<Family, TKey> = {
  opus: "claudeDesktop.family.opus",
  fable: "claudeDesktop.family.fable",
  sonnet: "claudeDesktop.family.sonnet",
  haiku: "claudeDesktop.family.haiku",
};

function cloneProfile(profile: DesktopProfile): DesktopProfile {
  return {
    version: 1,
    assignments: Object.fromEntries(
      Object.entries(profile.assignments).map(([route, assignment]) => [route, { ...assignment }]),
    ),
    defaults: { ...profile.defaults },
    // The saved-profile clone is compared against `profile` to compute `dirty`. Dropping the
    // applied-state markers here would make a freshly loaded profile read as unsaved the moment
    // the server had ever applied it.
    ...(profile.appliedFingerprint !== undefined ? { appliedFingerprint: profile.appliedFingerprint } : {}),
    ...(profile.appliedAt !== undefined ? { appliedAt: profile.appliedAt } : {}),
  };
}

function normalizeProfile(data: DesktopResponse): DesktopProfile {
  const assignments = { ...data.profile.assignments };
  for (const model of data.models) {
    const current = assignments[model.route] ?? model.assignment;
    assignments[model.route] = {
      family: FAMILIES.includes(current?.family) ? current.family : "opus",
      alias: typeof current?.alias === "string" ? current.alias : "",
    };
  }
  return {
    version: 1,
    assignments,
    defaults: {
      opus: data.profile.defaults.opus ?? null,
      fable: data.profile.defaults.fable ?? null,
      sonnet: data.profile.defaults.sonnet ?? null,
      haiku: data.profile.defaults.haiku ?? null,
    },
  };
}

function errorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") return value.error;
  return fallback;
}

function formatContextWindow(value: number | undefined, t: TFn): string | null {
  if (!value) return null;
  // 1 MiB and above is a whole "1M": providers report 2^20 (1048576), and
  // 1048576 / 1e6 = 1.048576 reads as a bug.
  if (value >= 1_048_576) return t("claudeDesktop.contextM", { n: Math.round(value / 1_048_576) });
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

type CachedDesktop = { data: DesktopResponse; profile: DesktopProfile };

function readDesktopCache(cacheKey: string): CachedDesktop | null {
  return readSessionListCacheEntry<CachedDesktop>(cacheKey)?.data ?? null;
}

function readDesktopCachedAt(cacheKey: string): number | null {
  return readSessionListCacheEntry<CachedDesktop>(cacheKey)?.cachedAt ?? null;
}

function seedDesktop(cacheKey: string) {
  const cached = readDesktopCache(cacheKey);
  return {
    held: cached,
    data: cached?.data ?? null,
    profile: cached?.profile ?? null,
    savedProfile: cached?.profile ? cloneProfile(cached.profile) : null,
    destinations: cached?.data
      ? Object.fromEntries(
        cached.data.models.map(model => [model.route, cached.profile.assignments[model.route]?.family ?? "opus"]),
      )
      : {} as Record<string, Family>,
  };
}

export default function ClaudeDesktop({
  apiBase,
  active = true,
  onPortChange,
}: {
  apiBase: string;
  active?: boolean;
  /** Keeps the Claude page intro subtitle in sync once /api/claude-desktop settles (port or failure). */
  onPortChange?: (port: number | null) => void;
}) {
  const { t, locale } = useI18n();
  const localeTag = LOCALES.find(l => l.code === locale)?.htmlLang;
  const cacheKey = `ocx.claude-desktop.v1:${apiBase}`;
  const resourceKey = `claude-desktop:${apiBase}`;
  const cached = useMemo(() => seedDesktop(cacheKey), [cacheKey]);
  const [draftProfile, setProfile] = useState<DesktopProfile | null>(() => cached.profile);
  const [savedDraftProfile, setSavedProfile] = useState<DesktopProfile | null>(() => cached.savedProfile);
  const [draftDestinations, setDestinations] = useState<Record<string, Family>>(() => cached.destinations);
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  // Lane density: search and paging are RENDER-ONLY. modelsByFamily and effectiveDefaults must
  // keep seeing every model — filtering the source arrays would silently change which model is
  // the effective default, turning a view filter into a data mutation.
  const [laneSearch, setLaneSearch] = useState<Record<string, string>>({});
  const [laneLimit, setLaneLimit] = useState<Record<string, number>>({});
  // Collapse is view state too. It is a plain user-owned Set rather than something
  // derived per render: modelsByFamily changes on every move, so deriving would fold a
  // section under the user's cursor the moment they moved the last model out of it.
  const [collapsedFamilies, setCollapsedFamilies] = useState<Set<string>>(() => FAMILY_COLLAPSE.read() ?? new Set(FAMILIES));
  // Which rows the user has explicitly opened or closed. Deliberately NOT persisted:
  // a family's fold is a durable preference, but which single model you were inspecting
  // is not, and restoring five open rows on reload would rebuild the wall this removes.
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const importRef = useRef<HTMLInputElement>(null);
  const fetchDesktop = useCallback(async (signal: AbortSignal): Promise<CachedDesktop> => {
    const response = await fetch(`${apiBase}/api/claude-desktop`, { signal });
    const payload = await readJsonOrThrow<DesktopResponse | { error?: string }>(
      response,
      t("claudeDesktop.loadFail"),
    );
    if (!payload || !("profile" in payload) || !("models" in payload)) {
      throw new Error(errorMessage(payload, t("claudeDesktop.loadFail")));
    }
    const normalized = normalizeProfile(payload);
    const next = { data: payload, profile: normalized };
    if (signal.aborted) throw new Error("Claude Desktop request aborted");
    // A successful read is authoritative until the user edits again. Updating drafts here keeps
    // the established save→reload contract without synchronizing resource data in an effect.
    setProfile(normalized);
    setSavedProfile(cloneProfile(normalized));
    setDestinations(Object.fromEntries(payload.models.map(model => [model.route, normalized.assignments[model.route]?.family ?? "opus"])));
    // Fold empty families on load, but only while the user has no stored preference.
    // Doing it here rather than per render means a later move or import can never
    // re-fold a section the user opened.
    if (FAMILY_COLLAPSE.read() === null) {
      const counts = Object.fromEntries(FAMILIES.map(family => [family, 0])) as Record<Family, number>;
      for (const model of payload.models) counts[normalized.assignments[model.route]?.family ?? "opus"] += 1;
      setCollapsedFamilies(defaultCollapsedFamilies(counts));
    }
    writeSessionListCacheEntry(cacheKey, next);
    return next;
  }, [apiBase, cacheKey, t, setDestinations, setProfile, setSavedProfile]);

  const desktopResource = useDataSurface<CachedDesktop>(
    resourceKey,
    [apiBase],
    fetchDesktop,
    {
      isEmpty: () => false,
      enabled: active,
      initialData: cached.held ?? undefined,
      initialDataCachedAt: readDesktopCachedAt(cacheKey),
      staleAfterMs: 60_000,
    },
  );
  const loadState = desktopResource.state;
  const resourceData = loadState.data ?? (cached.data && cached.profile ? { data: cached.data, profile: cached.profile } : null);
  const data = resourceData?.data ?? null;
  const profile = draftProfile ?? resourceData?.profile ?? null;
  const savedProfile = savedDraftProfile ?? resourceData?.profile ?? null;
  const resourceDestinations = resourceData
    ? Object.fromEntries(resourceData.data.models.map(model => [model.route, resourceData.profile.assignments[model.route]?.family ?? "opus"]))
    : {} as Record<string, Family>;
  const destinations = Object.keys(draftDestinations).length > 0 ? draftDestinations : resourceDestinations;

  useEffect(() => {
    if (!onPortChange) return;
    if (typeof data?.port === "number") {
      onPortChange(data.port);
      return;
    }
    // Cold failure with no port: stop the parent subtitle from claiming "Loading…" forever.
    if (loadState.kind === "failed-cold") onPortChange(null);
  }, [data?.port, loadState.kind, onPortChange]);

  const dirty = useMemo(
    () => profile !== null && savedProfile !== null && JSON.stringify(profile) !== JSON.stringify(savedProfile),
    [profile, savedProfile],
  );

  const modelsByFamily = useMemo(() => {
    const grouped = Object.fromEntries(FAMILIES.map(family => [family, [] as DesktopModel[]])) as Record<Family, DesktopModel[]>;
    if (!data || !profile) return grouped;
    for (const model of data.models) grouped[profile.assignments[model.route]?.family ?? "opus"].push(model);
    return grouped;
  }, [data, profile]);

  const effectiveDefaults = useMemo(() => {
    const result = {} as Record<Family, string | null>;
    for (const family of FAMILIES) {
      const active = modelsByFamily[family].filter(model => model.available).map(model => model.route).sort();
      const stored = profile?.defaults[family] ?? null;
      result[family] = stored && active.includes(stored) ? stored : (active[0] ?? null);
    }
    return result;
  }, [modelsByFamily, profile]);

  // The status poll is a separate resource: visibility pauses it without unmounting the
  // profile editor, which keeps its drafts intact across Code/Desktop tab switches.
  const statusCacheKey = `ocx.claude-desktop.status.v1:${apiBase}`;
  const statusResourceKey = `claude-desktop-status:${apiBase}`;
  const cachedStatusEntry = readSessionListCacheEntry<DesktopStatus>(statusCacheKey);
  const statusResource = useDataSurface<DesktopStatus>(
    statusResourceKey,
    [apiBase],
    async (signal) => {
      const response = await fetch(`${apiBase}/api/claude-desktop/status`, { signal });
      const next = await readJsonIfOk<DesktopStatus>(response);
      if (!next) throw new Error("Claude Desktop status unavailable");
      writeSessionListCacheEntry(statusCacheKey, next);
      return next;
    },
    // Polled, so no staleAfterMs: the cadence already keeps it fresh.
    { isEmpty: () => false, pollMs: 5000, enabled: active, initialData: cachedStatusEntry?.data ?? undefined },
  );
  const statusState = statusResource.state;
  const status = statusState.data ?? cachedStatusEntry?.data ?? null;
  const statusFailed = statusState.showError;

  const moveModel = (route: string, family: Family) => {
    if (!profile || profile.assignments[route]?.family === family) return;
    setProfile(current => {
      if (!current) return current;
      const previous = current.assignments[route];
      if (!previous || previous.family === family) return current;
      const assignments = { ...current.assignments, [route]: { ...previous, family } };
      const defaults = { ...current.defaults };
      if (defaults[previous.family] === route) {
        defaults[previous.family] = Object.keys(assignments)
          .filter(key => key !== route && assignments[key].family === previous.family)
          .sort()[0] ?? null;
      }
      if (defaults[family] === null) defaults[family] = route;
      return { ...current, assignments, defaults };
    });
    setDestinations(current => ({ ...current, [route]: family }));
    setAnnouncement(t("claudeDesktop.moved", { route, family: t(FAMILY_KEYS[family]) }));
  };

  const toggleFamily = (family: Family) => {
    // The first toggle also persists, so the load-time default becomes a real preference
    // the moment the user disagrees with it.
    const next = toggleInSet(collapsedFamilies, family);
    FAMILY_COLLAPSE.write(next);
    setCollapsedFamilies(next);
  };

  const save = async (applyAfter: boolean) => {
    if (!profile || pending) return;
    setPending("save");
    setMessage(null);
    try {
      const response = await fetch(`${apiBase}/api/claude-desktop`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile }),
      });
      await readJsonOrThrow<{ error?: string }>(response, t("claudeDesktop.saveFailed"));
      setSavedProfile(cloneProfile(profile));

      if (applyAfter) {
        setPending("apply");
        const applyResponse = await fetch(`${apiBase}/api/claude-desktop/apply`, { method: "POST" });
        const applyBody = await readJsonOrThrow<{ error?: string; saved?: boolean; warning?: string }>(
          applyResponse,
          t("claudeDesktop.applyFailed"),
        );
        // Partial success: Desktop WAS written, but the applied marker did not
        // persist, so the saved-vs-applied strip will read stale. Say so rather
        // than showing the clean success the user did not get.
        if (applyBody?.saved === false) {
          setMessage({ tone: "warn", text: t("claudeDesktop.appliedMarkerUnsaved") });
          setAnnouncement(t("claudeDesktop.appliedMarkerUnsaved"));
        } else {
          setMessage({ tone: "ok", text: t("claudeDesktop.savedApplied") });
          setAnnouncement(t("claudeDesktop.savedAppliedAnnounce"));
        }
      } else {
        setMessage({ tone: "ok", text: t("claudeDesktop.saved") });
        setAnnouncement(t("claudeDesktop.savedAnnounce"));
      }
      // Apply/save change the bar tone; do not wait for the 5s poll or the strip flips late.
      void statusResource.refresh();
    } catch (error) {
      const text = error instanceof Error ? error.message : t("claudeDesktop.updateFailed");
      setMessage({ tone: "err", text });
      setAnnouncement(text);
    } finally {
      setPending(null);
    }
  };

  const exportProfile = () => {
    if (!profile) return;
    // eslint-disable-next-line local-i18n/no-hardcoded-ui-strings -- file content newline, not UI text
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(profile, null, 2)}\n`], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "claude-desktop-profile.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setAnnouncement(t("claudeDesktop.exported"));
  };

  const importProfile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const candidate = JSON.parse(await file.text()) as Partial<DesktopProfile>;
      if (candidate.version !== 1 || !candidate.assignments || !candidate.defaults) throw new Error(t("claudeDesktop.importExpected"));
      const imported = normalizeProfile({ ...data!, profile: candidate as DesktopProfile });
      setProfile(imported);
      setMessage({ tone: "ok", text: t("claudeDesktop.importReady") });
      setAnnouncement(t("claudeDesktop.importedAnnounce"));
    } catch (error) {
      const text = error instanceof Error ? error.message : t("claudeDesktop.importInvalid");
      setMessage({ tone: "err", text });
      setAnnouncement(t("claudeDesktop.importFailed", { error: text }));
    }
  };

  const dropOnLane = (event: DragEvent<HTMLElement>, family: Family) => {
    event.preventDefault();
    const route = event.dataTransfer.getData("text/plain");
    if (route) moveModel(route, family);
  };

  if (loadState.kind === "disabled" && !resourceData) return null;
  if (loadState.showSkeleton && !resourceData) {
    return <DataSurfaceSkeleton label={t("claudeDesktop.loading")} rows={4} />;
  }
  if (loadState.kind === "failed-cold") {
    const reason = loadState.error instanceof Error ? loadState.error.message : t("claudeDesktop.loadFail");
    return (
      <div className="claude-desktop-error">
        <Notice tone="err">{reason}</Notice>
        <button type="button" className="btn btn-ghost" onClick={() => desktopResource.refresh()}>{t("claudeDesktop.retry")}</button>
      </div>
    );
  }
  if (!data || !profile) return null;

  return (
    <>
      {/* Title/subtitle live on Claude.tsx above the Code/Desktop strip. */}
      <div className="claude-desktop-toolbar">
        <div className="claude-profile-tools">
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => void importProfile(event)} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => importRef.current?.click()}>{t("claudeDesktop.importJson")}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportProfile}>{t("claudeDesktop.exportJson")}</button>
        </div>
      </div>

      {/* Always mount the bar (pending strut when status is still cold) so a late /status
          response cannot insert a full row under the title and shove the lanes down. */}
      <div
        className={`claude-status-bar ${
          statusFailed && !status
            ? "not-applied"
            : !status
              ? "pending"
              : !status.desiredEnabled
                ? "not-applied"
              : status.activeProfile === false
                ? "not-applied"
                : status.stale
                  ? "stale"
                  : status.applied
                    ? "applied"
                    : "not-applied"
        }`}
        aria-busy={(!status && !statusFailed) || undefined}
      >
        <span className="claude-status-dot" />
        {/* Desktop serving another profile outranks content drift: stale config that is
            read still works, a config that is never read does not. */}
        <span>
          {statusFailed && !status
            ? t("claudeDesktop.loadFail")
            : !status
              ? t("claudeDesktop.loading")
              : !status.desiredEnabled
                ? t("claudeDesktop.status.disabled")
              : status.activeProfile === false
                ? t("claudeDesktop.status.notActiveProfile")
                : status.stale
                  ? t("claudeDesktop.status.stale")
                  : status.applied
                    ? t("claudeDesktop.status.applied")
                    : t("claudeDesktop.status.notApplied")}
        </span>
        {status?.health.lastRequestAt && (
          <span className="claude-status-health">
            {t("claudeDesktop.health.lastRequest")}:{" "}
            {new Date(status.health.lastRequestAt).toLocaleTimeString(localeTag)}
          </span>
        )}
        {status && status.health.requestCount > 0 && (
          <span className="claude-status-health">
            {t("claudeDesktop.health.stats", { count: status.health.requestCount, errors: status.health.errorCount })}
          </span>
        )}
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {loadState.showError && <Notice tone="err">{t("claudeDesktop.loadFail")}</Notice>}
      {statusFailed && status && <Notice tone="err">{t("claudeDesktop.loadFail")}</Notice>}

      <div className="claude-profile-bar">
        <span className={`claude-dirty${dirty ? " active" : ""}`}>{dirty ? t("claudeDesktop.unsaved") : t("claudeDesktop.upToDate")}</span>
        <div className="claude-save-actions">
          <button type="button" className="btn btn-ghost" disabled={!dirty || pending !== null} onClick={() => void save(false)}>
            {pending === "save" ? t("claudeDesktop.saving") : t("common.save")}
          </button>
          <button type="button" className="btn btn-primary" disabled={pending !== null} onClick={() => void save(true)}>
            {pending === "apply" ? t("claudeDesktop.applying") : pending === "save" ? t("claudeDesktop.saving") : status?.desiredEnabled === false ? t("claudeDesktop.enableApply") : t("claudeDesktop.saveApply")}
          </button>
        </div>
      </div>

      {data.models.length === 0 && (
        <EmptyState title={t("claudeDesktop.emptyTitle")}>{t("claudeDesktop.emptyHint")}</EmptyState>
      )}

      <div className="ocx-group-stack" aria-label={t("claudeDesktop.assignmentsLabel")}>
        {FAMILIES.map(family => {
          // Render-only narrowing: the lane header, effectiveDefaults and every assignment keep
          // reading the full list, so filtering can never change what Claude Desktop resolves.
          const all = modelsByFamily[family];
          const lane = laneView(all, laneSearch[family] ?? "", laneLimit[family] ?? LANE_PAGE);
          const isCollapsed = collapsedFamilies.has(family);
          const familyDefault = effectiveDefaults[family];
          return (
          <section
            key={family}
            className={`ocx-group${isCollapsed ? " collapsed" : ""}`}
            aria-labelledby={`claude-lane-${family}`}
            onDragOver={event => event.preventDefault()}
            onDrop={event => dropOnLane(event, family)}
          >
            <header className={`ocx-group-head${isCollapsed ? "" : " open"}`}>
              {/* The button goes INSIDE the heading: a heading is not phrasing content, so
                  nesting it the other way round is invalid. This keeps the family in the
                  a11y tree and gives the toggle its name. */}
              <h3 id={`claude-lane-${family}`} className="ocx-group-heading">
                <button
                  type="button"
                  className="ocx-group-toggle"
                  aria-expanded={!isCollapsed}
                  aria-controls={`claude-lane-body-${family}`}
                  onClick={() => toggleFamily(family)}
                >
                  <IconChevron
                    className="ocx-chevron"
                    width={14}
                    height={14}
                    aria-hidden="true"
                    style={{ transform: isCollapsed ? "none" : "rotate(90deg)" }}
                  />
                  <span className="ocx-group-name">{t(FAMILY_KEYS[family])}</span>
                  <span className="ocx-group-count">
                    {t(all.length === 1 ? "claudeDesktop.modelCountOne" : "claudeDesktop.modelCountMany", { count: all.length })}
                  </span>
                  {/* Collapsed legibility: the resolved default is what a user opens a
                      family to check, so it stays readable while folded. */}
                  {familyDefault && <code className="claude-lane-default" title={familyDefault}>{familyDefault}</code>}
                </button>
              </h3>
              {/* Warnings stay outside the fold — never hide state the user must act on. */}
              {all.length > 0 && profile.defaults[family] === null && <span className="claude-default-needed">{t("claudeDesktop.chooseDefault")}</span>}
              {familyDefault && familyDefault !== profile.defaults[family] && (
                <span className="claude-default-needed" title={familyDefault}>{t("claudeDesktop.temporaryDefault")}</span>
              )}
            </header>

            {!isCollapsed && (
            <div id={`claude-lane-body-${family}`}>
            {lane.showSearch && (
              <input
                className="input claude-lane-search"
                type="search"
                placeholder={t("models.search")}
                aria-label={t("models.search")}
                value={laneSearch[family] ?? ""}
                onChange={event => {
                  const next = event.target.value;
                  setLaneSearch(current => ({ ...current, [family]: next }));
                  // A new query starts from the first page; otherwise a previously expanded lane
                  // would hide the very matches the user just searched for.
                  setLaneLimit(current => ({ ...current, [family]: LANE_PAGE }));
                }}
              />
            )}

            <div className="claude-lane-models">
              {all.length === 0 ? (
                <div className="claude-lane-empty">{t("claudeDesktop.laneEmpty")}</div>
              ) : lane.noMatch ? (
                <div className="claude-lane-empty">{t("claudeDesktop.laneNoMatch")}</div>
              ) : lane.shown.map(model => {
                const assignment = profile.assignments[model.route];
                const context = formatContextWindow(model.contextWindow, t);
                const destination = destinations[model.route] ?? "opus";
                const rowOpen = openRows[model.route] ?? rowStartsOpen(model.route, effectiveDefaults[family]);
                return (
                  <article
                    key={model.route}
                    className={`claude-model-card${rowOpen ? " open" : ""}`}
                    draggable={model.available}
                    onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", model.route); }}
                  >
                    {/* Summary: identification and triage only. Availability, context and
                        effort stay OUT of the fold because they are what you scan to pick a
                        default — only the edit affordances are hidden. */}
                    <button
                      type="button"
                      className="claude-model-summary"
                      aria-expanded={rowOpen}
                      aria-controls={`claude-model-body-${model.route}`}
                      onClick={() => setOpenRows(current => ({ ...current, [model.route]: !rowOpen }))}
                    >
                      <IconChevron
                        className="ocx-chevron"
                        width={12}
                        height={12}
                        aria-hidden="true"
                        style={{ transform: rowOpen ? "rotate(90deg)" : "none" }}
                      />
                      <span className="claude-model-names">
                        <strong title={model.label}>{model.label}</strong>
                        <code title={model.route}>{model.route}</code>
                      </span>
                      {context && <span className="claude-model-context">{context}</span>}
                      {/* Distinguish "we do not know the window" from "we know it is
                          small": a blank reads as broken. */}
                      {!context && <span className="claude-model-context claude-model-context-unknown">{t("claudeDesktop.contextUnknown")}</span>}
                      {/* Read-only view of the 1M capability the written config already
                          carries — distinct from the context number, because a 984k
                          model is below the threshold. */}
                      {model.supports1m === true && <span className="claude-1m-chip">{t("claudeDesktop.supports1m")}</span>}
                      {model.effortSupported === false && <span className="claude-effort-badge off">{t("claudeDesktop.effort.displayOnly")}</span>}
                      {model.effortSupported === true && <span className="claude-effort-badge on">{t("claudeDesktop.effort.supported")}</span>}
                      {profile.defaults[family] === model.route && (
                        <span className="claude-row-default">{t("claudeDesktop.defaultBadge")}</span>
                      )}
                      <span className={`badge ${model.available ? "badge-green" : "badge-muted"}`}>
                        {model.available ? t("claudeDesktop.available") : t("claudeDesktop.unavailable")}
                      </span>
                    </button>

                    {rowOpen && (
                    <div className="claude-model-body" id={`claude-model-body-${model.route}`}>
                    {effectiveDefaults[family] === model.route && profile.defaults[family] !== model.route && (
                      <span className="claude-effective-default">{t("claudeDesktop.temporaryDefault")}</span>
                    )}

                    <div className="claude-field">
                      <span>{t("claudeDesktop.alias")}</span>
                      <code className="claude-alias" title={assignment.alias}>{assignment.alias}</code>
                    </div>

                    <label className="claude-default-radio">
                      <input
                        type="radio"
                        name={`default-${family}`}
                        checked={profile.defaults[family] === model.route}
                        disabled={!model.available}
                        onChange={() => setProfile(current => current && ({ ...current, defaults: { ...current.defaults, [family]: model.route } }))}
                      />
                      {t("claudeDesktop.useAsDefault", { family: t(FAMILY_KEYS[family]) })}
                    </label>

                    <div className="claude-move-row">
                      <label htmlFor={`move-${model.route}`}>{t("claudeDesktop.moveTo")}</label>
                      <select
                        id={`move-${model.route}`}
                        className="input"
                        value={destination}
                        disabled={!model.available}
                        onChange={event => setDestinations(current => ({ ...current, [model.route]: event.target.value as Family }))}
                      >
                        {FAMILIES.map(option => <option key={option} value={option}>{t(FAMILY_KEYS[option])}</option>)}
                      </select>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={!model.available || destination === family}
                        onClick={() => moveModel(model.route, destination)}
                      >
                        {t("claudeDesktop.move")}
                      </button>
                    </div>
                    </div>
                    )}
                  </article>
                );
              })}
              {lane.hidden > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm claude-lane-more"
                  onClick={() => setLaneLimit(current => ({ ...current, [family]: (current[family] ?? LANE_PAGE) + LANE_PAGE }))}
                >
                  {t("models.showMore", { n: lane.hidden })}
                </button>
              )}
            </div>
            </div>
            )}
          </section>
          );
        })}
      </div>
    </>
  );
}
