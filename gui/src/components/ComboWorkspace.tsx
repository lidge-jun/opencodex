import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ComboEffort,
  type ComboItem,
  type ComboStrategy,
  type ComboTarget,
  COMBO_EFFORTS,
  buildComboAttention,
  comboModelId,
  draftEquals,
  emptyDraft,
  filterCombos,
  groupCombos,
  validateComboDraft,
} from "../combo-workspace-data";
import {
  IconAlert,
  IconChevron,
  IconGrip,
  IconPlus,
  IconSearch,
  IconShuffle,
  IconTrash,
  IconX,
} from "../icons";
import { useT } from "../i18n";
import { Notice } from "../ui";

export type ProviderOption = {
  name: string;
  disabled?: boolean;
  authMode?: string;
  adapter?: string;
  baseUrl?: string;
};
export type ModelOption = { provider: string; id: string; namespaced?: string };

type DetailTab = "config" | "about";

export interface ComboWorkspaceProps {
  combos: ComboItem[];
  providers: ProviderOption[];
  models: ModelOption[];
  loading?: boolean;
  onRefresh: () => void;
  onSave: (item: ComboItem, isCreate: boolean) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onAdd: () => void;
  adding: boolean;
  onCloseAdd: () => void;
  onCreated: (id: string) => void;
  apiBase: string;
}

function enabledProviders(providers: ProviderOption[]): ProviderOption[] {
  return providers.filter((p) => !p.disabled).sort((a, b) => a.name.localeCompare(b.name));
}

/** ChatGPT passthrough has no /models catalog — GPT slugs are listed under provider "openai". */
function isChatGptForwardOption(p: ProviderOption | undefined): boolean {
  if (!p) return false;
  const id = p.name.toLowerCase();
  if (id !== "openai" && id !== "chatgpt") return false;
  if ((p.authMode ?? "").toLowerCase() !== "forward") return false;
  if ((p.adapter ?? "").toLowerCase() !== "openai-responses") return false;
  const base = (p.baseUrl ?? "").replace(/\/+$/, "");
  return !base || base.includes("chatgpt.com/backend-api/codex");
}

function modelsForProvider(
  models: ModelOption[],
  provider: string,
  providers: ProviderOption[],
): string[] {
  const keys = new Set<string>([provider]);
  const meta = providers.find((p) => p.name === provider);
  // Alias chatgpt → openai native GPT rows (forward providers don't publish their own catalog).
  if (provider.toLowerCase() === "chatgpt" || isChatGptForwardOption(meta)) {
    keys.add("openai");
  }
  const ids = models
    .filter((m) => keys.has(m.provider))
    .map((m) => m.id)
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function StrategySeg({
  value,
  onChange,
  disabled,
}: {
  value: ComboStrategy;
  onChange: (next: ComboStrategy) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="cwi-strategy-seg" role="radiogroup" aria-label={t("cws.strategy")}>
      {([
        ["failover", "cws.strategy.failover"],
        ["round-robin", "cws.strategy.roundRobin"],
      ] as const).map(([id, key]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          className={`btn btn-sm${value === id ? " btn-primary" : " btn-ghost"}`}
          disabled={disabled}
          onClick={() => onChange(id)}
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

function EffortSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: ComboEffort;
  onChange: (next: ComboEffort) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <select
      id={id}
      className="input"
      value={value}
      disabled={disabled}
      aria-label={t("cws.field.defaultEffort")}
      onChange={(e) => onChange(e.target.value as ComboEffort)}
    >
      {COMBO_EFFORTS.map((effort) => (
        <option key={effort} value={effort}>{effort}</option>
      ))}
    </select>
  );
}

function TargetEditor({
  targets,
  strategy,
  providers,
  models,
  onChange,
}: {
  targets: ComboTarget[];
  strategy: ComboStrategy;
  providers: ProviderOption[];
  models: ModelOption[];
  onChange: (next: ComboTarget[]) => void;
}) {
  const t = useT();
  const provs = enabledProviders(providers);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const update = (index: number, patch: Partial<ComboTarget>) => {
    onChange(targets.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= targets.length || to >= targets.length) return;
    const copy = [...targets];
    const [moved] = copy.splice(from, 1);
    copy.splice(to, 0, moved!);
    onChange(copy);
  };

  return (
    <div className="cwi-target-list">
      {targets.map((row, index) => {
        const modelIds = modelsForProvider(models, row.provider, providers);
        const options = row.model && !modelIds.includes(row.model)
          ? [row.model, ...modelIds]
          : modelIds;
        const modelSelectDisabled = !row.provider;
        const dragging = dragIndex === index;
        const dropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
        return (
          <div
            key={index}
            className={[
              "cwi-target-row",
              strategy === "failover" ? "cwi-target-row--failover" : "",
              dragging ? "cwi-target-row--dragging" : "",
              dropTarget ? "cwi-target-row--drop" : "",
            ].filter(Boolean).join(" ")}
            onDragOver={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              if (overIndex !== index) setOverIndex(index);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) reorder(dragIndex, index);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
            <button
              type="button"
              className="cwi-target-grip"
              draggable
              aria-label={t("cws.target.drag")}
              title={t("cws.target.drag")}
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(index));
              }}
            >
              <IconGrip width={14} height={14} aria-hidden="true" />
            </button>
            <select
              className="input"
              value={row.provider}
              aria-label={t("cws.target.provider")}
              onChange={(e) => {
                const provider = e.target.value;
                const first = modelsForProvider(models, provider, providers)[0] ?? "";
                update(index, { provider, model: first });
              }}
            >
              <option value="">{t("cws.target.pickProvider")}</option>
              {provs.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
            <select
              className="input"
              value={row.model}
              disabled={modelSelectDisabled}
              aria-label={t("cws.target.model")}
              onChange={(e) => update(index, { model: e.target.value })}
            >
              <option value="">
                {modelSelectDisabled
                  ? t("cws.target.pickProviderFirst")
                  : options.length === 0
                    ? t("cws.target.noModels")
                    : t("cws.target.pickModel")}
              </option>
              {options.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            {strategy === "round-robin" && (
              <input
                className="input mono"
                type="number"
                min={1}
                max={10000}
                value={row.weight ?? 1}
                aria-label={t("cws.target.weight")}
                onChange={(e) => update(index, { weight: Number(e.target.value) || 1 })}
              />
            )}
            <div className="cwi-target-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={targets.length <= 1}
                onClick={() => onChange(targets.filter((_, i) => i !== index))}
                aria-label={t("common.remove")}
              >
                <IconTrash width={14} height={14} />
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ alignSelf: "flex-start" }}
        onClick={() => onChange([...targets, { provider: "", model: "" }])}
      >
        <IconPlus width={14} height={14} /> {t("cws.target.add")}
      </button>
    </div>
  );
}

function RemoveComboDialog({
  model,
  onCancel,
  onConfirm,
}: {
  model: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cwi-remove-title" onClick={onCancel}>
      <div className="modal-card pwi-remove-confirm-card" onClick={(e) => e.stopPropagation()}>
        <h3 id="cwi-remove-title" className="pwi-remove-confirm-title">
          {t("cws.removeConfirmTitle", { model })}
        </h3>
        <p className="muted pwi-remove-confirm-desc">{t("cws.removeConfirmDesc")}</p>
        <div className="pwi-remove-confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn pwi-remove-confirm-danger" onClick={onConfirm}>{t("common.remove")}</button>
        </div>
      </div>
    </div>
  );
}

function UnsavedLeaveDialog({
  onKeep,
  onDiscard,
}: {
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const t = useT();
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cwi-unsaved-title" onClick={onKeep}>
      <div className="modal-card pwi-json-unsaved-card" onClick={(e) => e.stopPropagation()}>
        <h3 id="cwi-unsaved-title" className="pwi-json-unsaved-title">{t("cws.unsavedTitle")}</h3>
        <p className="muted pwi-json-unsaved-desc">{t("cws.unsavedDesc")}</p>
        <div className="pwi-json-unsaved-actions">
          <button type="button" className="btn btn-ghost" onClick={onKeep}>{t("cws.keepEditing")}</button>
          <button type="button" className="btn btn-danger" onClick={onDiscard}>{t("common.discard")}</button>
        </div>
      </div>
    </div>
  );
}

export function AddComboModal({
  existingIds,
  providers,
  models,
  onClose,
  onSubmit,
}: {
  existingIds: string[];
  providers: ProviderOption[];
  models: ModelOption[];
  onClose: () => void;
  onSubmit: (item: ComboItem) => Promise<{ ok: boolean; error?: string }>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ComboItem>(() => emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const submit = async () => {
    const code = validateComboDraft(draft, existingIds, true);
    if (code) {
      setError(t(`cws.err.${code}`));
      return;
    }
    setBusy(true);
    setError("");
    const res = await onSubmit({ ...draft, id: draft.id.trim(), model: comboModelId(draft.id.trim()) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error || t("cws.saveFailed"));
      return;
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cwi-add-title" onClick={() => { if (!busy) onClose(); }}>
      <div className="modal-card" style={{ width: "min(560px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h3 id="cwi-add-title" style={{ margin: 0 }}>{t("cws.addTitle")}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy} aria-label={t("common.close")}>
            <IconX width={16} height={16} />
          </button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>{t("cws.addSubtitle")}</p>
        {error && <Notice tone="err">{error}</Notice>}
        <div className="cwi-modal-form">
          <div className="cwi-field">
            <label htmlFor="cwi-new-id">{t("cws.field.id")}</label>
            <input
              id="cwi-new-id"
              className="input mono"
              value={draft.id}
              placeholder={t("cws.field.idPlaceholder")}
              disabled={busy}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value, model: comboModelId(e.target.value) }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
              {t("cws.field.idHint", { model: draft.id.trim() ? comboModelId(draft.id.trim()) : "combo/…" })}
            </p>
          </div>
          <div className="cwi-field">
            <label>{t("cws.strategy")}</label>
            <StrategySeg
              value={draft.strategy}
              disabled={busy}
              onChange={(strategy) => setDraft((d) => ({ ...d, strategy }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>
              {draft.strategy === "failover" ? t("cws.strategy.failoverHint") : t("cws.strategy.roundRobinHint")}
            </p>
          </div>
          <div className="cwi-field">
            <label htmlFor="cwi-new-effort">{t("cws.field.defaultEffort")}</label>
            <EffortSelect
              id="cwi-new-effort"
              value={draft.defaultEffort}
              disabled={busy}
              onChange={(defaultEffort) => setDraft((d) => ({ ...d, defaultEffort }))}
            />
            <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
              {t("cws.field.defaultEffortHint")}
            </p>
          </div>
          {draft.strategy === "round-robin" && (
            <div className="cwi-field">
              <label htmlFor="cwi-new-sticky">{t("cws.field.stickyLimit")}</label>
              <input
                id="cwi-new-sticky"
                className="input mono"
                type="number"
                min={1}
                max={100}
                value={draft.stickyLimit}
                disabled={busy}
                onChange={(e) => setDraft((d) => ({ ...d, stickyLimit: Number(e.target.value) || 1 }))}
              />
              <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>
                {t("cws.field.stickyLimitHint")}
              </p>
            </div>
          )}
          <div className="cwi-field">
            <label>{t("cws.targets")}</label>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
              {draft.strategy === "failover" ? t("cws.targets.failoverHint") : t("cws.targets.roundRobinHint")}
            </p>
            <TargetEditor
              targets={draft.targets}
              strategy={draft.strategy}
              providers={providers}
              models={models}
              onChange={(targets) => setDraft((d) => ({ ...d, targets }))}
            />
          </div>
        </div>
        <div className="cwi-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => { void submit(); }} disabled={busy}>
            {busy ? t("common.saving") : t("cws.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

function OverviewPanel({
  combos,
  onSelect,
  onAdd,
}: {
  combos: ComboItem[];
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const sections = groupCombos(combos);
  const attention = buildComboAttention(combos);

  return (
    <div className="combos-workspace-overview">
      <div className="combos-workspace-overview-head">
        <h2 className="combos-workspace-overview-title">{t("cws.overviewTitle")}</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
          <IconPlus width={14} height={14} /> {t("cws.add")}
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0, maxWidth: "62ch" }}>{t("cws.overviewBlurb")}</p>
      <div className="cwi-count-strip">
        <div className="cwi-count-pill"><strong>{combos.length}</strong><span>{t("cws.count.total")}</span></div>
        <div className="cwi-count-pill"><strong>{sections.failover.length}</strong><span>{t("cws.count.failover")}</span></div>
        <div className="cwi-count-pill"><strong>{sections.roundRobin.length}</strong><span>{t("cws.count.roundRobin")}</span></div>
      </div>

      <section className="pwi-section" aria-label={t("cws.howTitle")}>
        <h3 className="pwi-section-title">{t("cws.howTitle")}</h3>
        <p className="muted" style={{ margin: 0 }}>{t("cws.howBody")}</p>
      </section>

      {attention.length > 0 && (
        <section className="pwi-section" aria-label={t("cws.attentionTitle")}>
          <h3 className="pwi-section-title">{t("cws.attentionTitle")}</h3>
          <div className="cwi-attention-list">
            {attention.map((item) => (
              <button key={item.id} type="button" className="cwi-attention-row" onClick={() => onSelect(item.id)}>
                <IconAlert width={14} height={14} aria-hidden="true" />
                <code className="chip">{item.model}</code>
                <span className="muted">
                  {item.reason === "empty-targets" ? t("cws.attention.empty") : t("cws.attention.few")}
                </span>
                <IconChevron width={14} height={14} style={{ marginLeft: "auto" }} aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const t = useT();
  return (
    <div className="combos-workspace-empty-root">
      <button type="button" className="cwi-empty-cta" onClick={onAdd}>
        <span className="pwi-empty-right-icon" aria-hidden="true">
          <IconShuffle style={{ width: 64, height: 64 }} />
        </span>
        <span className="cwi-empty-cta-title">{t("cws.emptyTitle")}</span>
        <span className="pwi-empty-right-sub">{t("cws.empty.createDesc")}</span>
      </button>
    </div>
  );
}

function DetailPanel({
  baseline,
  providers,
  models,
  onBack,
  onSaved,
  onRequestRemove,
  onSave,
  onDirtyChange,
}: {
  baseline: ComboItem;
  providers: ProviderOption[];
  models: ModelOption[];
  onBack: () => void;
  onSaved: (item: ComboItem) => void;
  onRequestRemove: () => void;
  onSave: (item: ComboItem, isCreate: boolean) => Promise<{ ok: boolean; error?: string }>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>("config");
  const [draft, setDraft] = useState<ComboItem>(baseline);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const dirty = !draftEquals(draft, baseline);
  const baselineSyncKey = `${baseline.id}:${baseline.strategy}:${baseline.stickyLimit}:${baseline.defaultEffort}:${baseline.targets.map((t) => `${t.provider}/${t.model}:${t.weight ?? 1}`).join(",")}`;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDraft(baseline);
      setMsg(null);
      setTab("config");
    }, 0);
    return () => window.clearTimeout(timer);
    // Sync when server/local baseline content changes for this combo (same id after save/refresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: key captures baseline payload
  }, [baselineSyncKey]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

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
    const code = validateComboDraft(draft, [], false);
    if (code) {
      setMsg({ ok: false, text: t(`cws.err.${code}`) });
      return;
    }
    setBusy(true);
    const res = await onSave(draft, false);
    setBusy(false);
    if (!res.ok) {
      setMsg({ ok: false, text: res.error || t("cws.saveFailed") });
      return;
    }
    setMsg({ ok: true, text: t("cws.saved") });
    onSaved(draft);
  };

  return (
    <div className="combos-workspace-detail">
      <div className="combos-workspace-detail-head">
        <button type="button" className="btn btn-ghost btn-sm pwi-back-overview" onClick={onBack} aria-label={t("cws.backToAll")}>
          <IconChevron style={{ width: 14, height: 14, transform: "rotate(180deg)" }} aria-hidden="true" />
          {t("cws.allCombos")}
        </button>
        <h2 className="combos-workspace-detail-title">{baseline.model}</h2>
        <button type="button" className="chip cwi-copy-chip" onClick={() => { void copyModel(); }} title={t("cws.copyModel")}>
          {copied ? t("cws.copied") : t("cws.copyModel")}
        </button>
        <div className="combos-workspace-detail-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRequestRemove}>
            <IconTrash width={14} height={14} /> {t("common.remove")}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={() => { void save(); }}>
            {busy ? t("common.saving") : t("common.save")}
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
              <label>{t("cws.strategy")}</label>
              <StrategySeg
                value={draft.strategy}
                disabled={busy}
                onChange={(strategy) => setDraft((d) => ({ ...d, strategy }))}
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
                onChange={(defaultEffort) => setDraft((d) => ({ ...d, defaultEffort }))}
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
                  onChange={(e) => setDraft((d) => ({ ...d, stickyLimit: Number(e.target.value) || 1 }))}
                />
              </div>
            )}
            <div className="cwi-field">
              <label>{t("cws.targets")}</label>
              <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
                {draft.strategy === "failover" ? t("cws.targets.failoverHint") : t("cws.targets.roundRobinHint")}
              </p>
              <TargetEditor
                targets={draft.targets}
                strategy={draft.strategy}
                providers={providers}
                models={models}
                onChange={(targets) => setDraft((d) => ({ ...d, targets }))}
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

export default function ComboWorkspace({
  combos,
  providers,
  models,
  loading,
  onRefresh,
  onSave,
  onRemove,
  onAdd,
  adding,
  onCloseAdd,
  onCreated,
}: ComboWorkspaceProps) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null | undefined>(undefined);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [localBaseline, setLocalBaseline] = useState<ComboItem | null>(null);

  const filtered = useMemo(() => filterCombos(combos, query), [combos, query]);
  const sections = useMemo(() => groupCombos(filtered), [filtered]);
  const activeId = selectedId && combos.some((c) => c.id === selectedId) ? selectedId : null;
  const selected = combos.find((c) => c.id === activeId) ?? null;
  const baseline = selected && localBaseline?.id === selected.id ? localBaseline : selected;

  const [detailDirty, setDetailDirty] = useState(false);

  const trySelect = useCallback((id: string | null) => {
    if (id === activeId) return;
    if (!detailDirty) {
      setSelectedId(id);
      setLocalBaseline(null);
      return;
    }
    setPendingSelect(id);
  }, [activeId, detailDirty]);

  const confirmDiscard = () => {
    if (pendingSelect === undefined) return;
    setSelectedId(pendingSelect);
    setLocalBaseline(null);
    setDetailDirty(false);
    setPendingSelect(undefined);
  };

  const cancelPending = () => setPendingSelect(undefined);

  const showUnsaved = pendingSelect !== undefined && detailDirty;

  if (!loading && combos.length === 0) {
    return (
      <>
        <EmptyState onAdd={onAdd} />
        {adding && (
          <AddComboModal
            existingIds={combos.map((c) => c.id)}
            providers={providers}
            models={models}
            onClose={onCloseAdd}
            onSubmit={async (item) => {
              const res = await onSave(item, true);
              if (res.ok) {
                onCloseAdd();
                onCreated(item.id);
                setSelectedId(item.id);
              }
              return res;
            }}
          />
        )}
      </>
    );
  }

  return (
    <div className="combos-workspace-root">
      <aside className="combos-workspace-rail" aria-label={t("cws.railAria")}>
        <div className="combos-workspace-rail-header">
          <div>
            <div className="combos-workspace-rail-title">{t("nav.combos")}</div>
            <div className="combos-workspace-rail-count">{combos.length}</div>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={onAdd} aria-label={t("cws.add")}>
            <IconPlus width={14} height={14} /> {t("cws.add")}
          </button>
        </div>
        <div className="cwi-search-row">
          <div className="cwi-search-wrap">
            <IconSearch className="cwi-search-icon" aria-hidden="true" />
            <input
              className="input cwi-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("cws.searchPlaceholder")}
              aria-label={t("cws.searchPlaceholder")}
            />
          </div>
        </div>
        <div className="combos-workspace-rail-list">
          {filtered.length === 0 ? (
            <p className="muted" style={{ padding: "16px" }}>{t("cws.noSearchResults")}</p>
          ) : (
            <>
              {([
                ["failover", sections.failover, "cws.group.failover"],
                ["round-robin", sections.roundRobin, "cws.group.roundRobin"],
              ] as const).map(([key, items, labelKey]) => (
                items.length > 0 ? (
                  <div key={key} className="combos-workspace-rail-group">
                    <div className="combos-workspace-rail-group-head">
                      <span className="pwi-dot" aria-hidden="true" />
                      {t(labelKey)}
                      <span className="combos-workspace-rail-count">{items.length}</span>
                    </div>
                    {items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`combos-workspace-rail-row${activeId === item.id ? " combos-workspace-rail-row--selected" : ""}`}
                        onClick={() => trySelect(item.id)}
                        aria-current={activeId === item.id ? "true" : undefined}
                      >
                        <span className="combos-workspace-rail-icon" aria-hidden="true">
                          <IconShuffle width={16} height={16} />
                        </span>
                        <span className="combos-workspace-rail-name">{item.model}</span>
                        <span className="combos-workspace-rail-meta">
                          {item.targets.length === 1
                            ? t("cws.targetCountOne")
                            : t("cws.targetCount", { count: item.targets.length })}
                        </span>
                        <IconChevron className="combos-workspace-rail-chevron" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : null
              ))}
            </>
          )}
        </div>
      </aside>

      <div className="combos-workspace-main">
        {baseline ? (
          <DetailPanel
            key={baseline.id}
            baseline={baseline}
            providers={providers}
            models={models}
            onBack={() => trySelect(null)}
            onSaved={(item) => {
              setLocalBaseline(item);
              setDetailDirty(false);
              onRefresh();
            }}
            onRequestRemove={() => setRemoveId(baseline.id)}
            onSave={onSave}
            onDirtyChange={setDetailDirty}
          />
        ) : (
          <OverviewPanel combos={combos} onSelect={(id) => trySelect(id)} onAdd={onAdd} />
        )}
      </div>

      {adding && (
        <AddComboModal
          existingIds={combos.map((c) => c.id)}
          providers={providers}
          models={models}
          onClose={onCloseAdd}
          onSubmit={async (item) => {
            const res = await onSave(item, true);
            if (res.ok) {
              onCloseAdd();
              onCreated(item.id);
              setSelectedId(item.id);
              setLocalBaseline(null);
            }
            return res;
          }}
        />
      )}

      {removeId && (
        <RemoveComboDialog
          model={comboModelId(removeId)}
          onCancel={() => setRemoveId(null)}
          onConfirm={() => {
            void (async () => {
              const res = await onRemove(removeId);
              setRemoveId(null);
              if (res.ok) {
                if (activeId === removeId) {
                  setSelectedId(null);
                  setLocalBaseline(null);
                }
                onRefresh();
              }
            })();
          }}
        />
      )}

      {showUnsaved && (
        <UnsavedLeaveDialog onKeep={cancelPending} onDiscard={confirmDiscard} />
      )}
    </div>
  );
}
