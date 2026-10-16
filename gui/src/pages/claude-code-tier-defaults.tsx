import { useState } from "react";
import { IconList, IconCheck } from "../icons";
import { useT } from "../i18n/shared";
import { readJsonOrThrow } from "../fetch-json";
import { Select, type SelectOption } from "../ui";
import type { ClaudeCodeState } from "./claude-code-types";

type Preview = { fingerprint: string; changes: { key: string; before: string | null; after: string }[] };
const tiers = ["opus", "sonnet", "haiku", "fable"] as const;

export function ClaudeCodeTierDefaults({ state, options, onChange, apiBase, dirty }: {
  state: ClaudeCodeState;
  options: SelectOption[];
  onChange: (state: ClaudeCodeState) => void;
  apiBase: string;
  dirty: boolean;
}) {
  const t = useT();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [recoveryPath, setRecoveryPath] = useState("");
  const tierOptions = options.map(option => option.value === "" ? { ...option, label: t("claude.tierDefaults.unset") } : option);
  async function request(apply: boolean) {
    setBusy(true);
    setMessage("");
    setFailed(false);
    setRecoveryPath("");
    try {
      const response = await fetch(`${apiBase}/api/claude-code/model-defaults`, apply ? {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fingerprint: preview?.fingerprint }),
      } : undefined);
      if (!response.ok) {
        const error = await response.json();
        if (error.code === "settings_recovery_required") {
          setPreview(null);
          setFailed(true);
          setMessage(t("claude.tierDefaults.recovery"));
          if (typeof error.backupPath === "string") setRecoveryPath(error.backupPath);
          return;
        }
        throw new Error("apply_refused");
      }
      const result = await readJsonOrThrow(response);
      if (apply) { setPreview(null); setMessage(t("claude.tierDefaults.applied")); }
      else setPreview(result as Preview);
    } catch {
      setPreview(null);
      setFailed(true);
      setMessage(t("claude.tierDefaults.failed"));
    } finally { setBusy(false); }
  }
  return <>
    {tiers.map(tier => {
      const value = state.tierModels?.[tier] ?? "";
      const choices = value && !tierOptions.some(option => option.value === value) ? [...tierOptions, { value, label: value }] : tierOptions;
      return <div className="setting-row" key={tier}>
        <span className="setting-label">{t(`claudeDesktop.family.${tier}`)}</span>
        <Select value={value} options={choices} label={t(`claudeDesktop.family.${tier}`)}
          onChange={model => { setPreview(null); onChange({ ...state, tierModels: { ...state.tierModels, [tier]: model } }); }} />
      </div>;
    })}
    <div className="btn-row">
      <button type="button" className="btn btn-ghost" disabled={busy || dirty} onClick={() => void request(false)}>
        <IconList /> {t("claude.tierDefaults.preview")}
      </button>
      {preview && <button type="button" className="btn btn-primary" disabled={busy || dirty || !preview.changes.length} onClick={() => void request(true)}>
        <IconCheck /> {t("claude.tierDefaults.apply")}
      </button>}
    </div>
    {preview && <pre>{preview.changes.length ? preview.changes.map(change => `${change.key}\n${change.before ?? "-"} -> ${change.after}`).join("\n\n") : t("claude.tierDefaults.applied")}</pre>}
    {message && <p role={failed ? "alert" : "status"}>{message}</p>}
    {recoveryPath && <pre>{recoveryPath}</pre>}
  </>;
}
