import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { useDataSurface } from "../../data-surface";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import ClientMark from "../../components/ClientMark";
import { markFor } from "../../components/integration-marks";
import { Notice, Switch } from "../../ui";
import IntegrationStateBadge from "./IntegrationStateBadge";
import FileIntegrationPage from "./FileIntegrationPage";
import ConsequenceDialog, { type ConsequenceCopy } from "./ConsequenceDialog";
import { describeRefusal, describeAsideProfileOutcome } from "./refusal-copy";
import type { AsideProfileOutcome } from "./aside-profile-contract";
import {
  bindingFor,
  IntegrationApiError,
  isIntegrationPreviewUnavailable,
  previewIntegrationMutation,
  toggleIntegration,
  type IntegrationMutationPlan,
} from "./integration-api";
import { loadAsideProfiles, syncAsideProfiles, type AsideProfileStatus } from "./aside-profile-api";

const PROFILE_APPLY_COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.apply.title", changesKey: "integrations.dialog.apply.changes",
  breakageKey: "integrations.dialog.apply.breakage", undoKey: "integrations.dialog.apply.undo",
  confirmKey: "integrations.dialog.apply.confirm",
};
const PROFILE_DISABLE_COPY: ConsequenceCopy = {
  titleKey: "integrations.dialog.disable.title", changesKey: "integrations.dialog.disable.changes",
  breakageKey: "integrations.dialog.disable.breakage", undoKey: "integrations.dialog.disable.undo",
  confirmKey: "integrations.dialog.disable.confirm",
};

export default function AsideProfilesPage({ apiBase, active = true }: { apiBase: string; active?: boolean }) {
  const t = useT();
  const [selected, setSelected] = useState<AsideProfileStatus | null>(null);
  const [pending, setPending] = useState<number | "all" | "sync" | null>(null);
  const pendingRef = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [profileFailures, setProfileFailures] = useState<Map<number, string>>(new Map());
  const [planned, setPlanned] = useState<{
    profile: AsideProfileStatus;
    enabled: boolean;
    plan: IntegrationMutationPlan | null;
    loading: boolean;
    failure: string | null;
  } | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const previewGenerationRef = useRef(0);
  useEffect(() => () => {
    previewGenerationRef.current += 1;
    previewAbortRef.current?.abort();
  }, []);
  const fetchProfiles = useCallback((signal: AbortSignal) => loadAsideProfiles(apiBase, signal), [apiBase]);
  const resource = useDataSurface(`aside-profiles:${apiBase}`, [apiBase], fetchProfiles, {
    enabled: active,
    isEmpty: value => !value.error && value.profiles.length === 0,
    sessionCacheKey: `ocx.integrations.aside-profiles.v1:${apiBase}`,
  });
  const data = resource.state.data;
  const profiles = data?.profiles ?? [];
  const loadError = resource.state.showError || Boolean(data?.error);
  const busy = pending !== null || resource.state.refreshing || planned !== null;
  const label = (profile: AsideProfileStatus) => profile.name || t("integrations.aside.profile", { id: profile.profileId });

  const reconcileOutcomes = (outcomes: AsideProfileOutcome[]) => setProfileFailures(previous => {
    const next = new Map(previous);
    for (const row of outcomes) {
      if (row.ok) next.delete(row.profileId);
      else next.set(row.profileId, describeAsideProfileOutcome(t, row));
    }
    return next;
  });
  const failed = (error: unknown, profileId?: number) => {
    if (error instanceof IntegrationApiError && "results" in error.body && error.body.results?.length) {
      reconcileOutcomes(error.body.results);
      setFailure(t("integrations.aside.partial"));
    } else if (profileId !== undefined) {
      setProfileFailures(previous => new Map(previous).set(profileId, describeRefusal(t, error)));
    } else setFailure(describeRefusal(t, error));
  };

  const mutate = async (enabled: boolean, profileId?: number, plan?: IntegrationMutationPlan) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(profileId ?? "all");
    setFailure(null);
    try {
      const result = await toggleIntegration(apiBase, "aside", {
        enabled, profileId, ...(plan ? { binding: bindingFor(plan) } : {}),
      });
      reconcileOutcomes(result.results ?? (profileId === undefined ? profiles.map(row => row.profileId) : [profileId])
        .map(id => ({ profileId: id, ok: true })));
    }
    catch (error) {
      if (plan && error instanceof IntegrationApiError && error.stalePlan) throw error;
      failed(error, profileId);
      if (plan) throw new Error(describeRefusal(t, error), { cause: error });
    }
    finally {
      // Even a refused writer may have durably saved desired sync preferences.
      resource.refresh();
      pendingRef.current = false;
      setPending(null);
    }
  };
  const requestProfileMutation = async (profile: AsideProfileStatus, enabled: boolean) => {
    if (pendingRef.current || planned) return;
    const controller = new AbortController();
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    previewAbortRef.current?.abort();
    previewAbortRef.current = controller;
    setPlanned({ profile, enabled, plan: null, loading: true, failure: null });
    try {
      const plan = await previewIntegrationMutation(apiBase, "aside", enabled ? "apply" : "disable", controller.signal, profile.profileId);
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      previewAbortRef.current = null;
      setPlanned({ profile, enabled, plan, loading: false, failure: null });
    } catch (error) {
      if (controller.signal.aborted || generation !== previewGenerationRef.current) return;
      previewAbortRef.current = null;
      if (isIntegrationPreviewUnavailable(error)) {
        setPlanned(null);
        resource.refresh();
        return;
      }
      setPlanned({ profile, enabled, plan: null, loading: false, failure: t("integrations.preview.failed") });
    }
  };
  const closePlanned = () => {
    previewGenerationRef.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPlanned(null);
  };
  const sync = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending("sync");
    setFailure(null);
    try {
      const result = await syncAsideProfiles(apiBase);
      reconcileOutcomes(result.results);
      if (!result.ok) setFailure(t("integrations.aside.partial"));
    } catch (error) { failed(error); }
    finally {
      resource.refresh();
      pendingRef.current = false;
      setPending(null);
    }
  };

  if (selected) return (
    <section className="integration-client-page">
      <button type="button" className="btn btn-ghost" autoFocus onClick={() => { setSelected(null); resource.refresh(); }}>
        {t("integrations.aside.back")}
      </button>
      {profileFailures.has(selected.profileId) && <Notice tone="err"><span className="aside-profile-failure">{profileFailures.get(selected.profileId)}</span></Notice>}
      <FileIntegrationPage key={selected.profileId} apiBase={apiBase} client="aside" active={active}
        profileId={selected.profileId} profileLabel={label(selected)} />
    </section>
  );

  return (
    <section className="integration-client-page" aria-busy={busy}>
      <div className="integration-client-head">
        <ClientMark src={markFor("aside")} label={t("integrations.tab.aside")} size={24} />
        <h3>{t("integrations.aside.profilesTitle")}</h3>
      </div>
      <p className="page-sub">{t("integrations.aside.profilesHint")}</p>
      <div className="aside-profile-toolbar">
        <Switch on={data?.allEnabled ?? false} mixed={Boolean(data && data.enabledCount > 0 && data.enabledCount < data.total)}
          onClick={() => void mutate(!data?.allEnabled)} disabled={busy || loadError || profiles.length === 0}
          label={t("integrations.aside.all")} showLabel />
        <span className="text-caption muted">{t("integrations.aside.applied", { count: data?.appliedCount ?? 0, total: data?.total ?? 0 })}</span>
        <button type="button" className="btn" disabled={busy || loadError || !data?.enabledCount} onClick={() => void sync()}>
          {t("integrations.aside.syncNow")}
        </button>
      </div>
      {failure && <Notice tone="err"><span className="aside-profile-failure">{failure}</span></Notice>}
      {[...profileFailures].filter(([id]) => !profiles.some(row => row.profileId === id)).map(([id, detail]) => (
        <Notice key={id} tone="err"><span className="aside-profile-failure">{t("integrations.aside.profile", { id })}: {detail}</span></Notice>
      ))}
      {loadError && (
        <Notice tone="err">
          <span>{t("integrations.aside.loadError")}</span>
          {data?.error && <span className="text-caption">{data.error}</span>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()} disabled={busy}>
            {t("common.retry")}
          </button>
        </Notice>
      )}
      {resource.state.showSkeleton && <DataSurfaceSkeleton label={t("common.loading")} rows={3} />}
      {!resource.state.showSkeleton && !loadError && data && profiles.length === 0 && <p className="page-sub">{t("integrations.aside.empty")}</p>}
      {profiles.length > 0 && (
        <div className="aside-profile-list">
          {profiles.map(profile => {
            const name = label(profile);
            const applied = profile.state === "current" || profile.state === "stale";
            const needsUpdate = profile.enabled !== applied || (profile.enabled && profile.state === "stale");
            const locked = (!profile.installed || profile.state === "unsafe" || profile.state === "conflict") && !profile.enabled;
            return (
              <div className="aside-profile-row" key={profile.profileId} aria-busy={pending === profile.profileId}>
                <div className="aside-profile-info">
                  <button type="button" className="btn btn-ghost aside-profile-name" aria-label={t("integrations.aside.details", { name })}
                    onClick={() => setSelected(profile)} disabled={busy || loadError}>
                    {name}
                  </button>
                  <div className="aside-profile-meta">
                    <code>{profile.profileId}</code>
                    {profile.current && <span className="text-caption muted">{t("integrations.aside.current")}</span>}
                  </div>
                  {needsUpdate && <span className="text-caption muted">{t("integrations.aside.pending")}</span>}
                  {profile.error && <span className="text-caption muted">{profile.error}</span>}
                  {profileFailures.has(profile.profileId) && <Notice tone="err"><span className="aside-profile-failure">{profileFailures.get(profile.profileId)}</span></Notice>}
                </div>
                <div className="aside-profile-controls">
                  <IntegrationStateBadge state={profile.state} installed={profile.installed} id={`aside-profile-state-${profile.profileId}`} />
                  {needsUpdate && <button type="button" className="btn btn-ghost btn-sm" disabled={busy || loadError}
                    aria-label={t("integrations.aside.retry", { name })} onClick={() => void requestProfileMutation(profile, profile.enabled)}>
                    {t("common.retry")}
                  </button>}
                  <Switch on={profile.enabled} onClick={() => void requestProfileMutation(profile, !profile.enabled)}
                    disabled={busy || loadError || locked} label={t("integrations.aside.toggle", { name })} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {planned && (
        <ConsequenceDialog
          copy={planned.enabled ? PROFILE_APPLY_COPY : PROFILE_DISABLE_COPY}
          plan={planned.plan}
          planLoading={planned.loading}
          planFailure={planned.failure}
          onClose={closePlanned}
          onConfirm={async plan => {
            if (!plan) return;
            await mutate(planned.enabled, planned.profile.profileId, plan);
            setPlanned(null);
          }}
        />
      )}
    </section>
  );
}
