import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ComboItem,
  type ProviderQuotaStates,
  comboQuotaState,
  comboModelId,
  comboPublicModelId,
  draftEquals,
  intersectComboEfforts,
  updateComboAliasDraft,
  validateComboDraft,
} from "../combo-workspace-data";
import { IconChevron, IconTrash } from "../icons";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { ComboCapabilities, EffortSelect, StrategySeg, TargetEditor } from "./combo-workspace-controls";
import { COMBO_STRATEGY_HINT_KEYS, COMBO_TARGETS_HINT_KEYS } from "../combo-workspace-data";
import { clampedNumberInput } from "./combo-workspace-utils";

type DetailTab = "config" | "about";

const DETAIL_TABS: readonly DetailTab[] = ["config", "about"];

/*
 * A combo id can be any string, so it cannot go in a DOM id without escaping. These
 * ids only have to be unique within one mounted DetailPanel — the workspace renders a
 * single detail at a time, keyed by combo id — so the tab name alone is enough.
 */
const detailTabDomId = (tab: DetailTab) => `cws-detail-tab-${tab}`;
const detailPanelDomId = (tab: DetailTab) => `cws-detail-panel-${tab}`;

export function DetailPanel({
  baseline,
  isCreate = false,
  otherIds,
  otherAliases,
  providerMap,
  providerQuotaStates,
  providers,
  models,
  onBack,
  onSaved,
  onRequestRemove,
  onSave,
  onDirtyChange,
}: {
  baseline: ComboItem;
  isCreate?: boolean;
  /** Ids of all OTHER combos — rename collisions validate against these. */
  otherIds: string[];
  /** Aliases of all OTHER combos — alias uniqueness validates against these. */
  otherAliases: string[];
  providerMap: Readonly<Record<string, { disabled?: boolean }>>;
  providerQuotaStates: ProviderQuotaStates;
  providers: ProviderOption[];
  models: ModelOption[];
  onBack?: () => void;
  onSaved: (item: ComboItem) => void;
  onRequestRemove?: () => void;
  onSave: (item: ComboItem, isCreate: boolean, renameFrom?: string) => Promise<{ ok: boolean; error?: string }>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>("config");

  /*
   * Arrow/Home/End traversal, matching ProviderDetails. Without it the tablist is two
   * ordinary tab stops, which is not what a `tablist` role promises.
   */
  const onDetailTabKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % DETAIL_TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = DETAIL_TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(DETAIL_TABS[next]!);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]
      ?.focus();
  }, []);
  const [draft, setDraft] = useState<ComboItem>(baseline);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const dirty = !draftEquals(draft, baseline);
  const allTargetsExhausted = comboQuotaState(draft.targets, providerQuotaStates, providerMap) === "exhausted";
  const baselineSyncKey = `${baseline.id}:${baseline.alias ?? ""}:${baseline.nativeAlias}:${baseline.displayName ?? ""}:${baseline.strategy}:${baseline.stickyLimit}:${baseline.defaultEffort}:${baseline.imageInput ?? "auto"}:${baseline.targets.map((t) => `${t.provider}/${t.model}:${t.weight ?? 1}`).join(",")}`;
  const effortMap = useMemo(() => {
    const map = new Map<string, string[] | undefined>();
    for (const model of models) {
      map.set(`${model.provider}/${model.id}`, model.reasoningEfforts);
    }
    return map;
  }, [models]);
  const allowedEfforts = useMemo(
    () => intersectComboEfforts(draft.targets, effortMap),
    [draft.targets, effortMap],
  );

  const updateDraft = useCallback((updater: (prev: ComboItem) => ComboItem) => {
    const next = updater(draft);
    setDraft(next);
    onDirtyChange(!draftEquals(next, baseline));
  }, [draft, baseline, onDirtyChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDraft(baseline);
      setMsg(null);
      setTab("config");
      onDirtyChange(false);
    }, 0);
    return () => window.clearTimeout(timer);
    // oxlint-disable-next-line react/react-compiler -- existing exhaustive-deps exception is intentional
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: key captures baseline payload
  }, [baselineSyncKey]);

  const copyModel = async () => {
    try {
      await navigator.clipboard.writeText(baseline.model);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const save = async () => {
    const code = validateComboDraft(draft, {
      existingIds: otherIds,
      existingAliases: otherAliases,
      isCreate,
      providers: providerMap,
    });
    if (code) {
      setMsg({ ok: false, text: t(`cws.err.${code}`) });
      return;
    }
    setBusy(true);
    const trimmedId = draft.id.trim();
    const alias = draft.alias?.trim() || null;
    const displayName = draft.displayName?.trim() || null;
    const item = {
      ...draft,
      id: trimmedId,
      alias,
      displayName,
      model: comboPublicModelId(trimmedId, alias),
    };
    const renameFrom = !isCreate && trimmedId !== baseline.id ? baseline.id : undefined;
    try {
      const res = await onSave(item, isCreate, renameFrom);
      if (!res.ok) {
        setMsg({ ok: false, text: res.error || t("cws.saveFailed") });
        return;
      }
      setMsg({
        ok: true,
        text: isCreate ? t("cws.created", { model: item.model }) : t("cws.saved"),
      });
      onSaved(item);
    } finally {
      setBusy(false);
    }
  };

  const headerModel = isCreate
    ? (draft.id.trim() ? comboPublicModelId(draft.id, draft.alias) : t("cws.addTitle"))
    : baseline.model;

  return (
    <div className="combos-workspace-detail">
      <div className="combos-workspace-detail-head">
        {onBack && (
          <button type="button" className="btn btn-ghost btn-sm pwi-back-overview" onClick={onBack} aria-label={t("cws.backToAll")}>
            <IconChevron style={{ width: 14, height: 14, transform: "rotate(180deg)" }} aria-hidden="true" />
            {t("cws.allCombos")}
          </button>
        )}
        <h2 className="combos-workspace-detail-title">{headerModel}</h2>
        {!isCreate && (
          <button type="button" className="chip cwi-copy-chip" onClick={() => { void copyModel(); }} title={t("cws.copyModel")}>
            {copied ? t("cws.copied") : t("cws.copyModel")}
          </button>
        )}
        <div className="combos-workspace-detail-actions">
          {!isCreate && onRequestRemove && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRequestRemove}>
              <IconTrash width={14} height={14} /> {t("common.remove")}
            </button>
          )}
          <button id={isCreate ? "cwi-edit-create" : "cwi-edit-save"} type="button" className="btn btn-primary btn-sm" disabled={(!isCreate && !dirty) || busy || allTargetsExhausted} onClick={() => { void save(); }}>
            {busy ? t("common.saving") : t(isCreate ? "cws.create" : "common.save")}
          </button>
        </div>
      </div>

      {msg && <Notice tone={msg.ok ? "ok" : "err"}>{msg.text}</Notice>}
      {allTargetsExhausted && (
        <div className="cwi-quota-banner" role="status" aria-live="polite">
          {t("cws.quota.allExhausted")}
        </div>
      )}

      {/*
        Pills, not an underline row. Combos is a tab of the Models page now, so an
        underline strip here would sit directly under the page strip — two rows of the
        same visual language stacked, which reads as two navigation levels rather than
        one page's facets.

        The roles stay `tablist`/`tab`/`aria-selected`: these control a real tabpanel
        below, so this is a tab set wearing pill styling, not a filter. The
        `radiogroup` shape used by `.models-segmented` would misdescribe the widget.
      */}
      <div className="segmented combos-workspace-segmented" role="tablist" aria-label={t("cws.tabsLabel")}>
        {DETAIL_TABS.map((candidate, index) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            id={detailTabDomId(candidate)}
            aria-selected={tab === candidate}
            aria-controls={detailPanelDomId(candidate)}
            // Roving tabindex: the tablist is one tab stop, and arrows move within it.
            tabIndex={tab === candidate ? 0 : -1}
            className={`btn btn-sm ${tab === candidate ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setTab(candidate)}
            onKeyDown={event => onDetailTabKeyDown(event, index)}
          >
            {t(candidate === "config" ? "cws.tab.config" : "cws.tab.about")}
          </button>
        ))}
      </div>

      {/*
        Both panels stay in the tree, the inactive one `hidden`. A single panel whose id
        followed the active tab left the OTHER tab's `aria-controls` pointing at an
        element that did not exist — a broken IDREF on whichever tab was not selected.
      */}
      <div
        className="combos-workspace-tab-content"
        role="tabpanel"
        id={detailPanelDomId("config")}
        aria-labelledby={detailTabDomId("config")}
        hidden={tab !== "config"}
      >
        {(
          <div className="cwi-form-grid">
            <div className="cwi-field">
              <label htmlFor="cwi-edit-id">{t("cws.field.id")}</label>
              <input
                id="cwi-edit-id"
                className="input mono"
                value={draft.id}
                disabled={busy}
                onChange={(e) => updateDraft((d) => ({
                  ...d,
                  id: e.target.value,
                  model: comboPublicModelId(e.target.value, d.alias),
                }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {isCreate
                  ? t("cws.field.idInternalHint")
                  : t("cws.field.idHintEdit", { model: comboPublicModelId(draft.id, draft.alias) })}
              </p>
            </div>
            <div className="cwi-field">
              <label htmlFor="cwi-edit-alias">{t("cws.field.alias")}</label>
              <input
                id="cwi-edit-alias"
                className="input mono"
                value={draft.alias ?? ""}
                placeholder={comboModelId(draft.id.trim() || "…")}
                disabled={busy}
                onChange={(e) => updateDraft((d) => updateComboAliasDraft(d, e.target.value))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {t("cws.field.aliasHint")}
              </p>
            </div>
            <div className="cwi-field">
              <label htmlFor="cwi-edit-native-alias">
                <input
                  id="cwi-edit-native-alias"
                  type="checkbox"
                  checked={draft.nativeAlias}
                  disabled={busy}
                  onChange={(e) => updateDraft((d) => ({ ...d, nativeAlias: e.target.checked }))}
                /> {t("cws.field.nativeAlias")}
              </label>
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {t("cws.field.nativeAliasHint")}
              </p>
            </div>
            <div className="cwi-field">
              <label htmlFor="cwi-edit-display-name">{t("cws.field.displayName")}</label>
              <input
                id="cwi-edit-display-name"
                className="input"
                value={draft.displayName ?? ""}
                maxLength={128}
                disabled={busy}
                onChange={(e) => updateDraft((d) => ({ ...d, displayName: e.target.value || null }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {t("cws.field.displayNameHint")}
              </p>
            </div>
            <div className="cwi-field">
              <span className="field-label">{t("cws.strategy")}</span>
              <StrategySeg
                value={draft.strategy}
                disabled={busy}
                onChange={(strategy) => updateDraft((d) => ({ ...d, strategy }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {t(COMBO_STRATEGY_HINT_KEYS[draft.strategy])}
              </p>
            </div>
            <div className="cwi-field">
              <label htmlFor="cwi-effort">{t("cws.field.defaultEffort")}</label>
              <EffortSelect
                id="cwi-effort"
                value={draft.defaultEffort}
                disabled={busy}
                allowedEfforts={allowedEfforts}
                onChange={(defaultEffort) => updateDraft((d) => ({ ...d, defaultEffort }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {t("cws.field.defaultEffortHint")}
              </p>
            </div>
            {draft.strategy === "round-robin" && (
              <div className="cwi-field">
                <label htmlFor="cwi-sticky">{t("cws.field.stickyLimit")}</label>
                <input
                  id="cwi-sticky"
                  className="input mono"
                  type="number"
                  min={1}
                  max={100}
                  value={draft.stickyLimit}
                  disabled={busy}
                  onChange={(e) => {
                    const stickyLimit = clampedNumberInput(e.target.value, 1, 100);
                    if (stickyLimit === undefined) return;
                    updateDraft((d) => ({ ...d, stickyLimit }));
                  }}
                />
              </div>
            )}
            <div className="cwi-field">
              <span className="field-label">{t("cws.targets")}</span>
              <TargetEditor
                targets={draft.targets}
                strategy={draft.strategy}
                providers={providers}
                models={models}
                providerQuotaStates={providerQuotaStates}
                onChange={(targets) => updateDraft((d) => ({ ...d, targets }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                {t(COMBO_TARGETS_HINT_KEYS[draft.strategy])}
              </p>
            </div>
            <ComboCapabilities
              targets={draft.targets}
              models={models}
              imageInput={draft.imageInput ?? "auto"}
              disabled={busy}
              onChange={(patch) => updateDraft((d) => ({ ...d, ...patch }))}
            />
          </div>
        )}
      </div>

      {/*
        `tabIndex={0}` because this panel holds no focusable descendants: without it,
        Tab out of the tablist would skip the content the tab just revealed.
      */}
      <div
        className="combos-workspace-tab-content"
        role="tabpanel"
        id={detailPanelDomId("about")}
        aria-labelledby={detailTabDomId("about")}
        hidden={tab !== "about"}
        tabIndex={0}
      >
        <section className="pwi-section">
          <h3 className="pwi-section-title">{t("cws.aboutTitle")}</h3>
          <p className="muted" style={{ margin: 0, maxWidth: "70ch", overflowWrap: "anywhere" }}>{t("cws.aboutBody")}</p>
        </section>
      </div>
    </div>
  );
}
