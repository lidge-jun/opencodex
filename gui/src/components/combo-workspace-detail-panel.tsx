import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ComboItem,
  comboModelId,
  comboPublicModelId,
  draftEquals,
  intersectComboEfforts,
  validateComboDraft,
} from "../combo-workspace-data";
import { IconChevron, IconTrash } from "../icons";
import { useT } from "../i18n/shared";
import { Notice } from "../ui";
import type { ModelOption, ProviderOption } from "./combo-workspace-types";
import { EffortSelect, StrategySeg, TargetEditor } from "./combo-workspace-controls";
import { clampedNumberInput } from "./combo-workspace-utils";

type DetailTab = "config" | "about";

export function DetailPanel({
  baseline,
  isCreate = false,
  otherIds,
  otherAliases,
  providerMap,
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
  const [draft, setDraft] = useState<ComboItem>(baseline);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const dirty = !draftEquals(draft, baseline);
  const baselineSyncKey = `${baseline.id}:${baseline.alias ?? ""}:${baseline.strategy}:${baseline.stickyLimit}:${baseline.defaultEffort}:${baseline.targets.map((t) => `${t.provider}/${t.model}:${t.weight ?? 1}`).join(",")}`;
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
    const item = {
      ...draft,
      id: trimmedId,
      alias,
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
          <button type="button" className="btn btn-primary btn-sm" disabled={(!isCreate && !dirty) || busy} onClick={() => { void save(); }}>
            {busy ? t("common.saving") : t(isCreate ? "cws.create" : "common.save")}
          </button>
        </div>
      </div>

      {msg && <Notice tone={msg.ok ? "ok" : "err"}>{msg.text}</Notice>}

      <div className="combos-workspace-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "config"} className={`combos-workspace-tab${tab === "config" ? " combos-workspace-tab--active" : ""}`} onClick={() => setTab("config")}>
          {t("cws.tab.config")}
        </button>
        <button type="button" role="tab" aria-selected={tab === "about"} className={`combos-workspace-tab${tab === "about" ? " combos-workspace-tab--active" : ""}`} onClick={() => setTab("about")}>
          {t("cws.tab.about")}
        </button>
      </div>

      <div className="combos-workspace-tab-content" role="tabpanel">
        {tab === "config" ? (
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
              <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
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
                onChange={(e) => updateDraft((d) => ({
                  ...d,
                  alias: e.target.value.trim() ? e.target.value : null,
                  model: comboPublicModelId(d.id, e.target.value),
                }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                {t("cws.field.aliasHint")}
              </p>
            </div>
            <div className="cwi-field">
              <span className="field-label">{t("cws.strategy")}</span>
              <StrategySeg
                value={draft.strategy}
                disabled={busy}
                onChange={(strategy) => updateDraft((d) => ({ ...d, strategy }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
                {draft.strategy === "failover" ? t("cws.strategy.failoverHint") : t("cws.strategy.roundRobinHint")}
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
              <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
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
              <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
                {draft.strategy === "failover" ? t("cws.targets.failoverHint") : t("cws.targets.roundRobinHint")}
              </p>
              <TargetEditor
                targets={draft.targets}
                strategy={draft.strategy}
                providers={providers}
                models={models}
                onChange={(targets) => updateDraft((d) => ({ ...d, targets }))}
              />
            </div>
          </div>
        ) : (
          <section className="pwi-section">
            <h3 className="pwi-section-title">{t("cws.aboutTitle")}</h3>
            <p className="muted" style={{ margin: 0 }}>{t("cws.aboutBody")}</p>
          </section>
        )}
      </div>
    </div>
  );
}
