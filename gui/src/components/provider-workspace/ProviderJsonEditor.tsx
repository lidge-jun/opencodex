/**
 * ProviderJsonEditor — raw JSON config editor pane for the workspace (WP091).
 * Dirty/leave/save guards are managed via the parent's jsonEditor prop contract.
 */
import { useRef, useEffect } from "react";
import { useT } from "../../i18n/shared";

export interface JsonEditorState {
  open: boolean;
  draft: string;
  isDirty: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => Promise<boolean>;
  onClose: () => void;
  onRestore?: () => void;
  /** Saved values moved under this draft; the user must choose a side before saving. */
  conflict?: boolean;
  /** Paths both sides changed; the user must edit the draft or use saved values. */
  conflicts?: string[];
  onUseSaved?: () => void;
  onKeepDraft?: () => void;
}

export default function ProviderJsonEditor({
  editor, providerName, saving, onSave, message, targetLabel,
}: {
  editor: JsonEditorState;
  providerName: string;
  saving: boolean;
  onSave: () => void;
  message?: { ok: boolean; text: string } | null;
  /** Dashboard server this editor writes to; shown so the save target is explicit. */
  targetLabel?: string;
}) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editor.open) textareaRef.current?.focus();
  }, [editor.open]);

  if (!editor.open) return null;

  return (
    <div className="pwi-json-panel">
      <div className="pwi-json-panel-header">
        <span className="pwi-json-panel-title">{t("pws.jsonEditorTitle", { name: providerName })}</span>
        <div className="pwi-json-panel-actions">
          {editor.onRestore && editor.isDirty && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={editor.onRestore}>{t("pws.jsonRestore")}</button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={editor.onClose}>{t("common.cancel")}</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={saving || !editor.isDirty || editor.conflict === true}>
            {saving ? t("pws.saving") : t("pws.jsonSave")}
          </button>
        </div>
      </div>
      <p className="pwi-json-panel-desc muted">{t("pws.jsonEditorDesc")}</p>
      {targetLabel && <p className="pwi-json-panel-target muted">{t("pws.draftTarget", { target: targetLabel })}</p>}
      {editor.conflict && (
        <div className="pwi-settings-conflict" role="alert">
          <p>{t("pws.draftConflict")}</p>
          {editor.conflicts && editor.conflicts.length > 0 && (
            <div className="pwi-settings-conflict-fields">
              <p>{t("pws.draftConflictFields")}</p>
              <ul>{editor.conflicts.map(path => <li key={path}><code>{path}</code></li>)}</ul>
            </div>
          )}
          <div className="pwi-settings-sticky-bar-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={editor.onUseSaved} disabled={saving}>{t("pws.draftConflictUseSaved")}</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={editor.onKeepDraft} disabled={saving}>{t("pws.draftConflictKeepDraft")}</button>
          </div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="input pwi-json-textarea"
        value={editor.draft}
        onChange={e => editor.onDraftChange(e.target.value)}
        spellCheck={false}
        rows={20}
        aria-label={t("pws.jsonEditorDesc")}
      />
      {message && (
        <div className={message.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>
          {message.text}
        </div>
      )}
    </div>
  );
}
