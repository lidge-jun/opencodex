import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconLock } from "../icons";
import { useDataSurface } from "../data-surface";
import { ToastNotice } from "../ui";
import { useT, type TKey } from "../i18n/shared";
import ConsequenceDialog from "./integrations/ConsequenceDialog";
import { GuardrailsActivityPanel } from "./guardrails/activity-panel";
import {
  GUARDRAILS_CONSEQUENCE_COPY,
  type GuardrailsConsequenceKind,
} from "./guardrails/consequence-copy";
import {
  deleteGuardrailsCustomRule,
  fetchGuardrailsExport,
  fetchGuardrailsActivity,
  fetchGuardrailsOverview,
  fetchGuardrailsRules,
  GuardrailsApiError,
  importGuardrailsBundle,
  previewGuardrailsBundle,
  saveGuardrailsCustomRule,
  toggleGuardrailsRule,
  updateGuardrailsSettings,
} from "./guardrails/guardrails-api";
import {
  guardrailsPanelDomId,
  guardrailsTabDomId,
  readGuardrailsTab,
  selectGuardrailsTab,
  type GuardrailsTab,
} from "./guardrails/guardrails-tab";
import { GuardrailsTabStrip } from "./guardrails/guardrails-tab-strip";
import { GuardrailsOverviewPanel } from "./guardrails/overview-panel";
import { GuardrailsRulesPanel } from "./guardrails/rules-panel";
import { GuardrailsSettingsPanel } from "./guardrails/settings-panel";
import { guardrailsTrafficProtectionStatus } from "./guardrails/protection-status";
import { GuardrailsStatusBadges } from "./guardrails/status-badges";
import { SurfaceFrame } from "./guardrails/surface-frame";
import { GuardrailsTesterPanel } from "./guardrails/tester-panel";
import type {
  GuardrailsActivity,
  GuardrailsActivityFilters,
  GuardrailsCustomRule,
  GuardrailsImportPreview,
  GuardrailsOverview,
  GuardrailsRules,
  GuardrailsSettingsPatch,
} from "./guardrails/types";

type PendingConsequence = {
  kind: GuardrailsConsequenceKind;
  run: () => Promise<void>;
  vars?: Record<string, string>;
  returnFocus: HTMLElement | null;
};
type PendingImport = {
  bundle: unknown;
  preview: GuardrailsImportPreview;
  returnFocus: HTMLElement | null;
  revision: string;
};
type GuardrailsActivitySnapshot = {
  activity: GuardrailsActivity;
  refreshedAt: number;
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isGuardrailsRevisionConflict(error: unknown): boolean {
  return error instanceof GuardrailsApiError
    && error.status === 412
    && error.code === "guardrails_revision_conflict";
}

export default function Guardrails({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [tab, setTab] = useState<GuardrailsTab>(readGuardrailsTab);
  const [mounted, setMounted] = useState<ReadonlySet<GuardrailsTab>>(() => new Set([readGuardrailsTab()]));
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [toast, setToast] = useState<{ tone: "err" | "ok"; text: string } | null>(null);
  const [consequence, setConsequence] = useState<PendingConsequence | null>(null);
  const [importPreview, setImportPreview] = useState<PendingImport | null>(null);
  const [activityFilters, setActivityFilters] = useState<GuardrailsActivityFilters>({
    category: "",
    mode: "",
    result: "",
    surface: "",
  });
  const activityFilterKey = [
    activityFilters.category,
    activityFilters.mode,
    activityFilters.result,
    activityFilters.surface,
  ].join(":");

  const overviewResource = useDataSurface<GuardrailsOverview>(
    `guardrails-overview:${apiBase}`,
    [apiBase],
    signal => fetchGuardrailsOverview(apiBase, signal, t("guardrails.loadFailed")),
    { isEmpty: () => false, pollMs: 30_000 },
  );
  const rulesResource = useDataSurface<GuardrailsRules>(
    `guardrails-rules:${apiBase}`,
    [apiBase],
    signal => fetchGuardrailsRules(apiBase, signal, t("guardrails.loadFailed")),
    { isEmpty: data => data.rules.length === 0, pauseWhenHidden: true },
  );
  const activityResource = useDataSurface<GuardrailsActivitySnapshot>(
    `guardrails-activity:${apiBase}:${activityFilterKey}`,
    [apiBase, activityFilterKey],
    async signal => {
      const activity = await fetchGuardrailsActivity(
        apiBase,
        signal,
        t("guardrails.loadFailed"),
        activityFilters,
      );
      return { activity, refreshedAt: Date.now() };
    },
    { isEmpty: data => data.activity.events.length === 0, pollMs: 15_000, pauseWhenHidden: true },
  );

  const overview = overviewResource.state.data;
  const rules = rulesResource.state.data;

  const activateTab = useCallback((next: GuardrailsTab) => {
    setTab(next);
    setMounted(current => current.has(next) ? current : new Set(current).add(next));
  }, []);
  useEffect(() => {
    const sync = () => activateTab(readGuardrailsTab());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [activateTab]);
  const selectTab = useCallback((next: GuardrailsTab) => {
    activateTab(next);
    selectGuardrailsTab(next);
  }, [activateTab]);

  const refreshOverview = overviewResource.refresh;
  const refreshRules = rulesResource.refresh;
  const refreshActivity = activityResource.refresh;
  const refreshAll = useCallback(() => {
    refreshOverview();
    refreshRules();
    refreshActivity();
  }, [refreshActivity, refreshOverview, refreshRules]);

  const runMutation = useCallback(async (work: () => Promise<void>, successKey: TKey) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setToast(null);
    try {
      await work();
      setToast({ tone: "ok", text: t(successKey) });
      refreshAll();
    } catch (error) {
      if (isGuardrailsRevisionConflict(error)) refreshAll();
      setToast({ tone: "err", text: errorText(error, t("guardrails.saveFailed")) });
      throw error;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [refreshAll, t]);

  const performSettings = useCallback(async (patch: GuardrailsSettingsPatch) => {
    if (!overview) return;
    await runMutation(async () => {
      await updateGuardrailsSettings(apiBase, patch, overview.revision, t("guardrails.saveFailed"));
    }, "guardrails.saved");
  }, [apiBase, overview, runMutation, t]);

  const requestSettings = useCallback((
    patch: GuardrailsSettingsPatch,
    kind?: GuardrailsConsequenceKind,
  ) => {
    if (!kind) {
      void performSettings(patch).catch(() => undefined);
      return;
    }
    setConsequence({
      kind,
      run: () => performSettings(patch),
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, [performSettings]);

  const closeConsequence = useCallback(() => {
    const focus = consequence?.returnFocus;
    setConsequence(null);
    window.requestAnimationFrame(() => focus?.focus({ preventScroll: true }));
  }, [consequence]);

  const applyRuleToggle = useCallback((ruleId: string, enabled: boolean) => {
    if (!rules) return;
    return runMutation(async () => {
      await toggleGuardrailsRule(apiBase, ruleId, enabled, rules.revision, t("guardrails.ruleSaveFailed"));
    }, "guardrails.ruleSaved");
  }, [apiBase, rules, runMutation, t]);

  const toggleRule = useCallback((ruleId: string, enabled: boolean) => {
    if (enabled) {
      void applyRuleToggle(ruleId, true)?.catch(() => undefined);
      return;
    }
    setConsequence({
      kind: "disableRule",
      vars: { ruleId },
      run: async () => { await applyRuleToggle(ruleId, false); },
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, [applyRuleToggle]);

  const applyBulkRules = useCallback((ids: string[], enabled: boolean) => {
    if (!overview) return;
    return runMutation(async () => {
      const selected = new Set(ids);
      const disabled = new Set(overview.disabledBuiltinRuleIds);
      for (const ruleId of selected) {
        if (enabled) disabled.delete(ruleId);
        else disabled.add(ruleId);
      }
      await updateGuardrailsSettings(
        apiBase,
        { disabledBuiltinRuleIds: [...disabled].sort() },
        overview.revision,
        t("guardrails.ruleSaveFailed"),
      );
    }, "guardrails.ruleSaved");
  }, [apiBase, overview, runMutation, t]);

  const bulkRules = useCallback((ids: string[], enabled: boolean) => {
    if (enabled) {
      void applyBulkRules(ids, true)?.catch(() => undefined);
      return;
    }
    setConsequence({
      kind: "bulkDisable",
      vars: { count: String(ids.length) },
      run: async () => { await applyBulkRules(ids, false); },
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, [applyBulkRules]);

  const saveRule = useCallback((rule: GuardrailsCustomRule, editingId: string | null) => {
    if (!rules) return;
    void runMutation(async () => {
      await saveGuardrailsCustomRule(
        apiBase,
        rule,
        editingId,
        rules.revision,
        t("guardrails.ruleSaveFailed"),
      );
    }, "guardrails.ruleSaved").catch(() => undefined);
  }, [apiBase, rules, runMutation, t]);

  const requestDelete = useCallback((rule: GuardrailsCustomRule) => {
    if (!rules) return;
    setConsequence({
      kind: "deleteRule",
      vars: { ruleId: rule.ruleId },
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      run: () => runMutation(async () => {
        await deleteGuardrailsCustomRule(
          apiBase,
          rule.ruleId,
          rules.revision,
          t("guardrails.ruleDeleteFailed"),
        );
      }, "guardrails.ruleDeleted"),
    });
  }, [apiBase, rules, runMutation, t]);

  const exportRules = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setToast(null);
    void fetchGuardrailsExport(apiBase, t("guardrails.exportFailed"))
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = objectUrl;
          anchor.download = "opencodex-guardrails.json";
          anchor.hidden = true;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
        setToast({ tone: "ok", text: t("guardrails.exported") });
      })
      .catch(error => {
        setToast({ tone: "err", text: errorText(error, t("guardrails.exportFailed")) });
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }, [apiBase, t]);

  const requestImport = useCallback((bundle: unknown, mode: "merge" | "replace") => {
    if (!rules || pendingRef.current) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    pendingRef.current = true;
    setPending(true);
    setToast(null);
    void previewGuardrailsBundle(apiBase, bundle, mode, rules.revision, t("guardrails.importFailed"))
      .then(preview => setImportPreview({
        bundle,
        preview,
        returnFocus,
        revision: rules.revision,
      }))
      .catch(error => {
        if (isGuardrailsRevisionConflict(error)) refreshAll();
        setToast({ tone: "err", text: errorText(error, t("guardrails.importFailed")) });
      })
      .finally(() => {
        pendingRef.current = false;
        setPending(false);
      });
  }, [apiBase, refreshAll, rules, t]);

  const closeImportPreview = useCallback(() => {
    const focus = importPreview?.returnFocus;
    setImportPreview(null);
    window.requestAnimationFrame(() => focus?.focus({ preventScroll: true }));
  }, [importPreview]);

  const applyImportPreview = useCallback(() => {
    if (!importPreview || importPreview.preview.conflicts.length > 0) return;
    const apply = async () => {
      await runMutation(async () => {
        await importGuardrailsBundle(
          apiBase,
          importPreview.bundle,
          importPreview.preview.mode,
          false,
          importPreview.revision,
          t("guardrails.importFailed"),
        );
      }, "guardrails.imported");
      setImportPreview(null);
    };
    if (importPreview.preview.mode === "replace") {
      setConsequence({
        kind: importPreview.preview.securityDiff.requiresReview
          ? "replaceImportWeakening"
          : "replaceImport",
        run: apply,
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
      return;
    }
    void apply().catch(() => undefined);
  }, [apiBase, importPreview, runMutation, t]);

  const meta = useMemo(() => ({
    rules: rules ? String(rules.rules.length) : undefined,
    activity: activityResource.state.data
      ? String(activityResource.state.data.activity.events.length)
      : undefined,
  }), [activityResource.state.data, rules]);
  return (
    <div className="guardrails-page">
      <div className="page-head">
        <h2><IconLock /> {t("guardrails.title")}</h2>
        {overview && <GuardrailsStatusBadges overview={overview} />}
      </div>
      <p className="page-sub">{t("guardrails.subtitle")}</p>
      {toast && <ToastNotice tone={toast.tone} onDismiss={() => setToast(null)} dismissLabel={t("common.close")}>{toast.text}</ToastNotice>}
      <GuardrailsTabStrip tab={tab} onSelect={selectTab} meta={meta} />

      {mounted.has("overview") && (
        <section hidden={tab !== "overview"} role="tabpanel" id={guardrailsPanelDomId("overview")} aria-labelledby={guardrailsTabDomId("overview")}>
          <SurfaceFrame
            state={overviewResource.state}
            loading={t("guardrails.loading")}
            failed={t("guardrails.loadFailed")}
            onRetry={refreshOverview}
            retryLabel={t("common.retry")}
          >
            {overview && <GuardrailsOverviewPanel data={overview} pending={pending} onSettings={requestSettings} />}
          </SurfaceFrame>
        </section>
      )}
      {mounted.has("rules") && (
        <section hidden={tab !== "rules"} role="tabpanel" id={guardrailsPanelDomId("rules")} aria-labelledby={guardrailsTabDomId("rules")}>
          <SurfaceFrame
            state={rulesResource.state}
            loading={t("guardrails.loading")}
            failed={t("guardrails.loadFailed")}
            empty={rules?.rules.length === 0}
            emptyTitle={t("guardrails.noRules")}
            onRetry={refreshRules}
            retryLabel={t("common.retry")}
          >
            {rules && (
              <GuardrailsRulesPanel
                data={rules}
                pending={pending}
                onToggle={toggleRule}
                onBulk={bulkRules}
                onSave={saveRule}
                onDelete={requestDelete}
                onExport={exportRules}
                onImport={requestImport}
                importPreview={importPreview?.preview ?? null}
                onApplyImport={applyImportPreview}
                onCancelImport={closeImportPreview}
                onImportError={error => setToast({
                  tone: "err",
                  text: errorText(error, t("guardrails.importFailed")),
                })}
              />
            )}
          </SurfaceFrame>
        </section>
      )}
      {mounted.has("tester") && (
        <section hidden={tab !== "tester"} role="tabpanel" id={guardrailsPanelDomId("tester")} aria-labelledby={guardrailsTabDomId("tester")}>
          <GuardrailsTesterPanel
            apiBase={apiBase}
            trafficProtection={guardrailsTrafficProtectionStatus(overview)}
          />
        </section>
      )}
      {mounted.has("activity") && (
        <section hidden={tab !== "activity"} role="tabpanel" id={guardrailsPanelDomId("activity")} aria-labelledby={guardrailsTabDomId("activity")}>
          <SurfaceFrame
            state={activityResource.state}
            loading={t("guardrails.loading")}
            failed={t("guardrails.loadFailed")}
            onRetry={refreshActivity}
            retryLabel={t("common.retry")}
          >
            {activityResource.state.data && (
              <GuardrailsActivityPanel
                activity={activityResource.state.data.activity}
                filters={activityFilters}
                refreshing={activityResource.state.refreshing}
                lastRefreshAt={activityResource.state.data.refreshedAt}
                onFiltersChange={setActivityFilters}
                onRefresh={() => refreshActivity({ forceLoading: true })}
              />
            )}
          </SurfaceFrame>
        </section>
      )}
      {mounted.has("settings") && (
        <section hidden={tab !== "settings"} role="tabpanel" id={guardrailsPanelDomId("settings")} aria-labelledby={guardrailsTabDomId("settings")}>
          <SurfaceFrame
            state={overviewResource.state}
            loading={t("guardrails.loading")}
            failed={t("guardrails.loadFailed")}
            onRetry={refreshOverview}
            retryLabel={t("common.retry")}
          >
            {overview && <GuardrailsSettingsPanel settings={overview} pending={pending} onSettings={requestSettings} />}
          </SurfaceFrame>
        </section>
      )}

      {consequence && (
        <ConsequenceDialog
          titleId="guardrails-consequence-dialog-title"
          copy={{
            ...GUARDRAILS_CONSEQUENCE_COPY[consequence.kind],
            ...(consequence.vars ? { vars: consequence.vars } : {}),
          }}
          onClose={closeConsequence}
          onConfirm={async () => {
            await consequence.run();
            closeConsequence();
          }}
        />
      )}
    </div>
  );
}
