import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { EmptyState, Notice } from "../ui";
import { useT, type TFn, type TKey } from "../i18n";

const FAMILIES = ["opus", "fable", "sonnet", "haiku"] as const;
type Family = typeof FAMILIES[number];

interface Assignment {
  family: Family;
  alias: string;
}

interface DesktopProfile {
  version: 1;
  assignments: Record<string, Assignment>;
  defaults: Record<Family, string | null>;
}

interface DesktopModel {
  route: string;
  label: string;
  available: boolean;
  contextWindow?: number;
  assignment: Assignment;
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
  return value >= 1_000_000
    ? t("claudeDesktop.contextM", { n: value / 1_000_000 })
    : t("claudeDesktop.contextK", { n: Math.round(value / 1_000) });
}

export default function ClaudeDesktop({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [data, setData] = useState<DesktopResponse | null>(null);
  const [profile, setProfile] = useState<DesktopProfile | null>(null);
  const [savedProfile, setSavedProfile] = useState<DesktopProfile | null>(null);
  const [destinations, setDestinations] = useState<Record<string, Family>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, setPending] = useState<PendingAction>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`${apiBase}/api/claude-desktop`);
      const payload = await response.json() as DesktopResponse | { error?: string };
      if (!response.ok || !("profile" in payload) || !("models" in payload)) {
        throw new Error(errorMessage(payload, t("claudeDesktop.loadFail")));
      }
      const normalized = normalizeProfile(payload);
      setData(payload);
      setProfile(normalized);
      setSavedProfile(cloneProfile(normalized));
      setDestinations(Object.fromEntries(payload.models.map(model => [model.route, normalized.assignments[model.route]?.family ?? "opus"])));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("claudeDesktop.loadFail"));
    } finally {
      setLoading(false);
    }
  }, [apiBase, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(errorMessage(payload, t("claudeDesktop.saveFailed")));
      setSavedProfile(cloneProfile(profile));

      if (applyAfter) {
        setPending("apply");
        const applyResponse = await fetch(`${apiBase}/api/claude-desktop/apply`, { method: "POST" });
        const applyPayload = await applyResponse.json().catch(() => ({})) as { error?: string };
        if (!applyResponse.ok) throw new Error(errorMessage(applyPayload, t("claudeDesktop.applyFailed")));
        setMessage({ tone: "ok", text: t("claudeDesktop.savedApplied") });
        setAnnouncement(t("claudeDesktop.savedAppliedAnnounce"));
      } else {
        setMessage({ tone: "ok", text: t("claudeDesktop.saved") });
        setAnnouncement(t("claudeDesktop.savedAnnounce"));
      }
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

  if (loading) return <div className="claude-desktop-loading" role="status">{t("claudeDesktop.loading")}</div>;
  if (loadError || !data || !profile) {
    return (
      <div className="claude-desktop-error">
        <Notice tone="err">{loadError || t("claudeDesktop.loadFail")}</Notice>
        <button type="button" className="btn btn-ghost" onClick={() => void load()}>{t("claudeDesktop.retry")}</button>
      </div>
    );
  }

  return (
    <>
      <div className="page-head claude-desktop-head">
        <div>
          <h2>{t("claudeDesktop.title")}</h2>
          <p className="page-sub">{t("claudeDesktop.subtitle", { port: data.port })}</p>
        </div>
        <div className="claude-profile-tools">
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => void importProfile(event)} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => importRef.current?.click()}>{t("claudeDesktop.importJson")}</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportProfile}>{t("claudeDesktop.exportJson")}</button>
        </div>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}

      <div className="claude-profile-bar">
        <span className={`claude-dirty${dirty ? " active" : ""}`}>{dirty ? t("claudeDesktop.unsaved") : t("claudeDesktop.upToDate")}</span>
        <div className="claude-save-actions">
          <button type="button" className="btn btn-ghost" disabled={!dirty || pending !== null} onClick={() => void save(false)}>
            {pending === "save" ? t("claudeDesktop.saving") : t("common.save")}
          </button>
          <button type="button" className="btn btn-primary" disabled={pending !== null} onClick={() => void save(true)}>
            {pending === "apply" ? t("claudeDesktop.applying") : pending === "save" ? t("claudeDesktop.saving") : t("claudeDesktop.saveApply")}
          </button>
        </div>
      </div>

      {data.models.length === 0 && (
        <EmptyState title={t("claudeDesktop.emptyTitle")}>{t("claudeDesktop.emptyHint")}</EmptyState>
      )}

      <div className="claude-lanes" aria-label={t("claudeDesktop.assignmentsLabel")}>
        {FAMILIES.map(family => (
          <section
            key={family}
            className="claude-lane"
            aria-labelledby={`claude-lane-${family}`}
            onDragOver={event => event.preventDefault()}
            onDrop={event => dropOnLane(event, family)}
          >
            <header className="claude-lane-head">
              <div>
                <h3 id={`claude-lane-${family}`}>{t(FAMILY_KEYS[family])}</h3>
                <span>{t(modelsByFamily[family].length === 1 ? "claudeDesktop.modelCountOne" : "claudeDesktop.modelCountMany", { count: modelsByFamily[family].length })}</span>
              </div>
              {modelsByFamily[family].length > 0 && profile.defaults[family] === null && <span className="claude-default-needed">{t("claudeDesktop.chooseDefault")}</span>}
              {effectiveDefaults[family] && effectiveDefaults[family] !== profile.defaults[family] && (
                <span className="claude-default-needed" title={effectiveDefaults[family]!}>{t("claudeDesktop.temporaryDefault")}</span>
              )}
            </header>

            <div className="claude-lane-models">
              {modelsByFamily[family].length === 0 ? (
                <div className="claude-lane-empty">{t("claudeDesktop.laneEmpty")}</div>
              ) : modelsByFamily[family].map(model => {
                const assignment = profile.assignments[model.route];
                const context = formatContextWindow(model.contextWindow, t);
                const destination = destinations[model.route] ?? "opus";
                return (
                  <article
                    key={model.route}
                    className="claude-model-card"
                    draggable={model.available}
                    onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", model.route); }}
                  >
                    <div className="claude-model-title">
                      <div>
                        <strong title={model.label}>{model.label}</strong>
                        <code title={model.route}>{model.route}</code>
                      </div>
                      <span className={`badge ${model.available ? "badge-green" : "badge-muted"}`}>
                        {model.available ? t("claudeDesktop.available") : t("claudeDesktop.unavailable")}
                      </span>
                    </div>
                    {context && <span className="claude-model-context">{context}</span>}
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
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
