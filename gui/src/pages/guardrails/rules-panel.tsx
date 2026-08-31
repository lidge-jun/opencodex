import { Fragment, useMemo, useRef, useState } from "react";
import { EmptyState, Notice, Select, Switch } from "../../ui";
import { IconPlus, IconTrash } from "../../icons";
import { useT } from "../../i18n/shared";
import {
  GUARDRAILS_DATA_TYPES,
  GUARDRAILS_DATA_TYPE_KEYS,
  GUARDRAILS_IMPORT_MAX_BYTES,
  GUARDRAILS_VALIDATORS,
} from "./constants";
import type {
  GuardrailsCustomRule,
  GuardrailsDataType,
  GuardrailsImportPreview,
  GuardrailsRules,
} from "./types";
import { parseGuardrailsCaptureGroups } from "./rule-form-utils";

const PAGE_SIZE = 50;

function blankRule(): GuardrailsCustomRule {
  return {
    ruleId: "",
    name: "",
    dataType: 6,
    group: "CUSTOM",
    groupPriority: 0,
    displayName: "",
    description: "",
    regex: "",
    keywords: [],
    banlist: [],
    validators: [],
    masking: { captureGroups: [], placeholderType: "CUSTOM_SECRET" },
  };
}

export function GuardrailsRulesPanel({
  data,
  pending,
  onToggle,
  onBulk,
  onSave,
  onDelete,
  onExport,
  onImport,
  importPreview,
  onApplyImport,
  onCancelImport,
  onImportError,
}: {
  data: GuardrailsRules;
  pending: boolean;
  onToggle: (ruleId: string, enabled: boolean) => void;
  onBulk: (ruleIds: string[], enabled: boolean) => void;
  onSave: (rule: GuardrailsCustomRule, editingId: string | null) => void;
  onDelete: (rule: GuardrailsCustomRule) => void;
  onExport: () => void;
  onImport: (bundle: unknown, mode: "merge" | "replace") => void;
  importPreview: GuardrailsImportPreview | null;
  onApplyImport: () => void;
  onCancelImport: () => void;
  onImportError: (error: unknown) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");
  const [dataType, setDataType] = useState("");
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<GuardrailsCustomRule>(blankRule);
  const [captureGroupsText, setCaptureGroupsText] = useState("");
  const [captureGroupsError, setCaptureGroupsError] = useState(false);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.rules
      .filter(rule => !needle || `${rule.ruleId} ${rule.displayName} ${rule.group}`.toLowerCase().includes(needle))
      .filter(rule => !source || rule.source === source)
      .filter(rule => !status || (status === "enabled" ? rule.enabled : !rule.enabled))
      .filter(rule => !dataType || rule.dataType === Number(dataType));
  }, [data.rules, dataType, query, source, status]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visiblePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);
  const bulkIds = filtered.filter(rule => !rule.custom).map(rule => rule.ruleId);
  const customById = new Map(data.customRules.map(rule => [rule.ruleId, rule]));
  const securityDiff = importPreview?.securityDiff;
  const onOff = (value: boolean) => t(value ? "guardrails.valueOn" : "guardrails.valueOff");
  const providerScopeLabel = (scope: NonNullable<typeof securityDiff>["providerScope"]["before"]) =>
    scope.mode === "all"
      ? t("guardrails.providerScopeAllValue")
      : `${t("guardrails.providerScopeSelectedValue", {
          count: scope.providerIds.length,
        })}: ${scope.providerIds.join(", ")}`;
  const securityChanges = securityDiff
    ? [
        {
          key: "enabled",
          changed: securityDiff.enabled.changed,
          weakening: securityDiff.enabled.weakening,
          reviewRequired: false,
          label: t("guardrails.importSecurityEnabled", {
            before: onOff(securityDiff.enabled.before),
            after: onOff(securityDiff.enabled.after),
          }),
        },
        {
          key: "mode",
          changed: securityDiff.mode.changed,
          weakening: securityDiff.mode.weakening,
          reviewRequired: false,
          label: t("guardrails.importSecurityMode", {
            before: t(securityDiff.mode.before === "enforce" ? "guardrails.modeEnforce" : "guardrails.modeDetect"),
            after: t(securityDiff.mode.after === "enforce" ? "guardrails.modeEnforce" : "guardrails.modeDetect"),
          }),
        },
        {
          key: "failurePolicy",
          changed: securityDiff.failurePolicy.changed,
          weakening: securityDiff.failurePolicy.weakening,
          reviewRequired: false,
          label: t("guardrails.importSecurityFailure", {
            before: t(securityDiff.failurePolicy.before === "block" ? "guardrails.failureBlock" : "guardrails.failurePassthrough"),
            after: t(securityDiff.failurePolicy.after === "block" ? "guardrails.failureBlock" : "guardrails.failurePassthrough"),
          }),
        },
        {
          key: "providerScope",
          changed: securityDiff.providerScope.changed,
          weakening: securityDiff.providerScope.weakening,
          reviewRequired: false,
          label: t("guardrails.importSecurityProviderScope", {
            before: providerScopeLabel(securityDiff.providerScope.before),
            after: providerScopeLabel(securityDiff.providerScope.after),
          }),
        },
        {
          key: "enabledDataTypes",
          changed: securityDiff.enabledDataTypes.changed,
          weakening: securityDiff.enabledDataTypes.weakening,
          reviewRequired: false,
          label: t("guardrails.importSecurityDataTypes", {
            before: securityDiff.enabledDataTypes.before.length,
            after: securityDiff.enabledDataTypes.after.length,
          }),
        },
        {
          key: "disabledBuiltinRules",
          changed: securityDiff.disabledBuiltinRules.changed,
          weakening: securityDiff.disabledBuiltinRules.weakening,
          reviewRequired: false,
          label: t("guardrails.importSecurityDisabledRules", {
            before: securityDiff.disabledBuiltinRules.beforeCount,
            after: securityDiff.disabledBuiltinRules.afterCount,
            disabled: securityDiff.disabledBuiltinRules.newlyDisabledCount,
            reenabled: securityDiff.disabledBuiltinRules.reenabledCount,
          }),
        },
        {
          key: "customRules",
          changed: securityDiff.customRules.changed,
          weakening: securityDiff.customRules.weakening,
          reviewRequired: securityDiff.customRules.requiresReview,
          label: t("guardrails.importSecurityCustomRules", {
            before: securityDiff.customRules.beforeCount,
            after: securityDiff.customRules.afterCount,
            removed: securityDiff.customRules.removedCount,
            changed: securityDiff.customRules.changedDefinitionCount,
          }),
        },
        {
          key: "keywordPrefilterEnabled",
          changed: securityDiff.keywordPrefilterEnabled.changed,
          weakening: securityDiff.keywordPrefilterEnabled.weakening,
          reviewRequired: false,
          label: t("guardrails.importSecurityPrefilter", {
            before: onOff(securityDiff.keywordPrefilterEnabled.before),
            after: onOff(securityDiff.keywordPrefilterEnabled.after),
          }),
        },
      ].filter(change => change.changed)
    : [];

  const update = <K extends keyof GuardrailsCustomRule>(key: K, value: GuardrailsCustomRule[K]) => {
    setForm(current => ({ ...current, [key]: value }));
  };
  const resetForm = () => {
    setEditingId(null);
    setForm(blankRule());
    setCaptureGroupsText("");
    setCaptureGroupsError(false);
  };
  const toggleValidator = (validator: string) => {
    setForm(current => {
      const enabled = current.validators.includes(validator);
      return {
        ...current,
        validators: enabled
          ? current.validators.filter(value => value !== validator)
          : [...current.validators, validator],
        ...(validator === "entropy" && enabled ? { entropy: undefined } : {}),
        ...(validator === "banlist" && enabled ? { banlist: [] } : {}),
      };
    });
  };

  return (
    <div className="guardrails-panel-stack">
      <section className="card">
        <div className="guardrails-rules-toolbar">
          <input
            type="search"
            value={query}
            disabled={pending}
            placeholder={t("guardrails.searchRules")}
            aria-label={t("guardrails.searchRules")}
            onChange={event => { setQuery(event.target.value); setPage(0); }}
          />
          <Select value={source} disabled={pending} label={t("guardrails.source")} onChange={value => { setSource(value); setPage(0); }} options={[
            { value: "", label: t("guardrails.allSources") },
            { value: "opencodex", label: t("guardrails.sourceOpenCodex") },
            { value: "manual", label: t("guardrails.sourceManual") },
            { value: "gitleaks", label: t("guardrails.sourceGitleaks") },
            { value: "custom", label: t("guardrails.customRules") },
          ]} />
          <Select value={dataType} disabled={pending} label={t("guardrails.dataType")} onChange={value => { setDataType(value); setPage(0); }} options={[
            { value: "", label: t("guardrails.allDataTypes") },
            ...GUARDRAILS_DATA_TYPES.map(value => ({ value: String(value), label: t(GUARDRAILS_DATA_TYPE_KEYS[value]) })),
          ]} />
          <Select value={status} disabled={pending} label={t("guardrails.status")} onChange={value => { setStatus(value); setPage(0); }} options={[
            { value: "", label: t("guardrails.allStatuses") },
            { value: "enabled", label: t("guardrails.statusActive") },
            { value: "disabled", label: t("guardrails.statusDisabled") },
          ]} />
        </div>
        <div className="guardrails-bulk-row">
          <span>{t("guardrails.filteredRules", { count: filtered.length })}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending || bulkIds.length === 0} onClick={() => onBulk(bulkIds, true)}>
            {t("guardrails.bulkEnable", { count: bulkIds.length })}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending || bulkIds.length === 0} onClick={() => onBulk(bulkIds, false)}>
            {t("guardrails.bulkDisable", { count: bulkIds.length })}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={onExport}>{t("guardrails.export")}</button>
          <Select value={importMode} disabled={pending} label={t("guardrails.importMode")} onChange={value => setImportMode(value as "merge" | "replace")} options={[
            { value: "merge", label: t("guardrails.importMerge") },
            { value: "replace", label: t("guardrails.importReplace") },
          ]} />
          <input
            ref={fileRef}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            aria-label={t("guardrails.import")}
            onChange={event => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > GUARDRAILS_IMPORT_MAX_BYTES) {
                onImportError(new Error(t("guardrails.importTooLarge")));
                event.target.value = "";
                return;
              }
              void file.text()
                .then(text => onImport(JSON.parse(text) as unknown, importMode))
                .catch(onImportError);
              event.target.value = "";
            }}
          />
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => fileRef.current?.click()}>
            {t("guardrails.import")}
          </button>
        </div>
      </section>
      {importPreview && (
        <section className="card guardrails-import-preview" aria-live="polite">
          <div className="card-head">
            <strong>{t("guardrails.importPreviewTitle")}</strong>
            <span className="badge badge-muted">
              {t(importPreview.mode === "merge" ? "guardrails.importMerge" : "guardrails.importReplace")}
            </span>
          </div>
          <div className="guardrails-import-summary">
            <span>{t("guardrails.importCreateCount", { count: importPreview.createCount })}</span>
            <span>{t("guardrails.importReplaceCount", { count: importPreview.replaceCount })}</span>
            <span>{t("guardrails.importUnchangedCount", { count: importPreview.unchangedCount })}</span>
          </div>
          {securityDiff && (
            <div className="guardrails-import-security">
              <strong>{t("guardrails.importSecurityTitle")}</strong>
              {securityDiff.weakensProtection && (
                <Notice tone="warn">{t("guardrails.importSecurityWeakening")}</Notice>
              )}
              {!securityDiff.weakensProtection && securityDiff.requiresReview && (
                <Notice tone="warn">{t("guardrails.importSecurityPotential")}</Notice>
              )}
              {securityChanges.length === 0
                ? <p className="muted">{t("guardrails.importSecurityUnchanged")}</p>
                : (
                  <ul>{securityChanges.map(change => (
                    <li key={change.key}>
                      <span>{change.label}</span>
                      {change.weakening && (
                        <span className="badge badge-amber">
                          {t("guardrails.importSecurityReduced")}
                        </span>
                      )}
                      {!change.weakening && change.reviewRequired && (
                        <span className="badge badge-amber">
                          {t("guardrails.importSecurityReviewRequired")}
                        </span>
                      )}
                    </li>
                  ))}</ul>
                )}
              {securityDiff.enabledDataTypes.removed.length > 0 && (
                <p>
                  {t("guardrails.importSecurityRemovedTypes", {
                    types: securityDiff.enabledDataTypes.removed
                      .map(value => t(GUARDRAILS_DATA_TYPE_KEYS[value]))
                      .join(", "),
                  })}
                </p>
              )}
            </div>
          )}
          {importPreview.conflicts.length > 0 && (
            <Notice tone="err">
              {t("guardrails.importConflicts", { count: importPreview.conflicts.length })}
              <code>{importPreview.conflicts.join(", ")}</code>
            </Notice>
          )}
          <div className="guardrails-form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={pending || importPreview.conflicts.length > 0}
              onClick={onApplyImport}
            >
              {t("guardrails.importApply")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancelImport}>
              {t("common.cancel")}
            </button>
          </div>
        </section>
      )}
      {visible.length === 0
        ? <EmptyState title={t("guardrails.noRules")} />
        : <section className="card guardrails-rule-list">{visible.map((rule, index) => (
          <Fragment key={rule.ruleId}>
            {(index === 0 || visible[index - 1]?.group !== rule.group) && (
              <div className="guardrails-rule-group"><strong>{rule.group}</strong></div>
            )}
            <div className="guardrails-rule-row">
              <div>
                <strong>{rule.displayName}</strong>
                <code>{rule.ruleId}</code>
                <span className="muted">{rule.group} · {rule.source}</span>
              </div>
              <div className="guardrails-rule-actions">
                {rule.custom ? (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => {
                      const custom = customById.get(rule.ruleId);
                      if (custom) {
                        setEditingId(rule.ruleId);
                        setForm(structuredClone(custom));
                        setCaptureGroupsText(custom.masking.captureGroups.join(", "));
                      }
                    }}>{t("guardrails.editRule")}</button>
                    <button type="button" className="btn btn-danger btn-icon" disabled={pending} aria-label={t("guardrails.deleteRule")} onClick={() => {
                      const custom = customById.get(rule.ruleId);
                      if (custom) onDelete(custom);
                    }}><IconTrash /></button>
                  </>
                ) : (
                  <Switch
                    on={rule.enabled}
                    disabled={pending}
                    label={`${rule.displayName}: ${t(rule.enabled ? "guardrails.statusActive" : "guardrails.statusDisabled")}`}
                    onClick={() => onToggle(rule.ruleId, !rule.enabled)}
                  />
                )}
              </div>
            </div>
          </Fragment>
        ))}</section>}
      <div className="guardrails-pagination">
        <button type="button" className="btn btn-ghost btn-sm" disabled={pending || visiblePage === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>{t("guardrails.previous")}</button>
        <span>{t("guardrails.page", { current: visiblePage + 1, total: pageCount })}</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={pending || visiblePage + 1 >= pageCount} onClick={() => setPage(value => value + 1)}>{t("guardrails.next")}</button>
      </div>
      <section className="card guardrails-rule-editor">
        <div className="card-head">
          <strong>{t(editingId ? "guardrails.editRule" : "guardrails.addRule")}</strong>
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={resetForm}><IconPlus /> {t("guardrails.addRule")}</button>
        </div>
        <form onSubmit={event => {
          event.preventDefault();
          const captureGroups = parseGuardrailsCaptureGroups(captureGroupsText);
          if (captureGroups === null) {
            setCaptureGroupsError(true);
            return;
          }
          setCaptureGroupsError(false);
          onSave({
            ...form,
            masking: {
              ...form.masking,
              captureGroups,
            },
          }, editingId);
        }}>
          <div className="guardrails-form-grid">
            <label><span className="field-label">{t("guardrails.ruleId")}</span><input required value={form.ruleId} disabled={pending || editingId !== null} onChange={event => update("ruleId", event.target.value)} /></label>
            <label><span className="field-label">{t("guardrails.ruleName")}</span><input required value={form.name} disabled={pending} onChange={event => update("name", event.target.value)} /></label>
            <label><span className="field-label">{t("guardrails.displayName")}</span><input required value={form.displayName} disabled={pending} onChange={event => update("displayName", event.target.value)} /></label>
            <label><span className="field-label">{t("guardrails.dataType")}</span><Select value={String(form.dataType)} disabled={pending} label={t("guardrails.dataType")} onChange={value => update("dataType", Number(value) as GuardrailsDataType)} options={GUARDRAILS_DATA_TYPES.map(value => ({ value: String(value), label: t(GUARDRAILS_DATA_TYPE_KEYS[value]) }))} /></label>
            <label><span className="field-label">{t("guardrails.group")}</span><input required value={form.group} disabled={pending} onChange={event => update("group", event.target.value)} /></label>
            <label><span className="field-label">{t("guardrails.groupPriority")}</span><input type="number" required min={-10_000} max={10_000} value={form.groupPriority} disabled={pending} onChange={event => {
              const value = event.currentTarget.valueAsNumber;
              if (Number.isSafeInteger(value)) update("groupPriority", value);
            }} /></label>
            <label className="guardrails-span-all"><span className="field-label">{t("guardrails.description")}</span><input value={form.description} disabled={pending} onChange={event => update("description", event.target.value)} /></label>
            <label className="guardrails-span-all"><span className="field-label">{t("guardrails.regex")}</span><input className="mono" required value={form.regex} disabled={pending} onChange={event => update("regex", event.target.value)} /></label>
            <label><span className="field-label">{t("guardrails.placeholderType")}</span><input className="mono" required value={form.masking.placeholderType} disabled={pending} onChange={event => setForm(current => ({ ...current, masking: { ...current.masking, placeholderType: event.target.value } }))} /></label>
            <label>
              <span className="field-label">{t("guardrails.captureGroups")}</span>
              <input
                value={captureGroupsText}
                disabled={pending}
                aria-invalid={captureGroupsError || undefined}
                aria-describedby={captureGroupsError ? "guardrails-capture-groups-error" : undefined}
                onChange={event => {
                  setCaptureGroupsText(event.target.value);
                  if (captureGroupsError) setCaptureGroupsError(false);
                }}
              />
              {captureGroupsError && (
                <span id="guardrails-capture-groups-error" className="guardrails-field-error" role="alert">
                  {t("guardrails.captureGroupsInvalid")}
                </span>
              )}
            </label>
            <label><span className="field-label">{t("guardrails.minLength")}</span><input type="number" min={1} max={1_000_000} value={form.minLength ?? ""} disabled={pending} onChange={event => update("minLength", event.target.value === "" ? undefined : Number(event.target.value))} /></label>
            <label><span className="field-label">{t("guardrails.keywords")}</span><input value={form.keywords.join(", ")} disabled={pending} onChange={event => update("keywords", event.target.value.split(",").map(value => value.trim()).filter(Boolean))} /></label>
            {form.validators.includes("entropy") && (
              <label><span className="field-label">{t("guardrails.entropy")}</span><input type="number" required min={0} max={16} step="0.1" value={form.entropy ?? ""} disabled={pending} onChange={event => update("entropy", event.target.value === "" ? undefined : Number(event.target.value))} /></label>
            )}
            {form.validators.includes("banlist") && (
              <label className="guardrails-span-all"><span className="field-label">{t("guardrails.banlist")}</span><textarea required value={form.banlist.join("\n")} disabled={pending} onChange={event => update("banlist", event.target.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))} /></label>
            )}
            <fieldset className="guardrails-types guardrails-span-all">
              <legend>{t("guardrails.validators")}</legend>
              {GUARDRAILS_VALIDATORS.map(validator => (
                <label key={validator}>
                  <input
                    type="checkbox"
                    checked={form.validators.includes(validator)}
                    disabled={pending}
                    onChange={() => toggleValidator(validator)}
                  />
                  <code>{validator}</code>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="guardrails-form-actions">
            <button type="submit" className="btn btn-primary" disabled={pending}>{t("guardrails.saveRule")}</button>
            {editingId && <button type="button" className="btn btn-ghost" disabled={pending} onClick={resetForm}>{t("guardrails.cancelEdit")}</button>}
          </div>
        </form>
      </section>
    </div>
  );
}
