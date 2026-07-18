/**
 * ProviderJsonEditor — raw JSON config editor pane for the workspace (WP091).
 * Dirty/leave/save guards are managed via the parent's jsonEditor prop contract.
 */
import { useRef, useEffect } from "react";
import { useT } from "../../i18n";

export interface JsonEditorState {
  open: boolean;
  draft: string;
  isDirty: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => Promise<boolean>;
  onClose: () => void;
  onRestore?: () => void;
}

export default function ProviderJsonEditor({
  editor, providerName, saving, onSave, message,
}: {
  editor: JsonEditorState;
  providerName: string;
  saving: boolean;
  onSave: () => void;
  message?: { ok: boolean; text: string } | null;
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
          <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={saving || !editor.isDirty}>
            {saving ? t("pws.saving") : t("pws.jsonSave")}
          </button>
        </div>
      </div>
      <p className="pwi-json-panel-desc muted">{t("pws.jsonEditorDesc")}</p>
      <textarea
        ref={textareaRef}
        className="input pwi-json-textarea"
        value={editor.draft}
        onChange={e => editor.onDraftChange(e.target.value)}
        spellCheck={false}
        rows={20}
      />
      {message && (
        <div className={message.ok ? "pwi-settings-msg pwi-settings-msg--ok" : "pwi-settings-msg pwi-settings-msg--err"}>
          {message.text}
        </div>
      )}
    </div>
  );
}
