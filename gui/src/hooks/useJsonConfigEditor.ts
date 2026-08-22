import { useCallback, useEffect, useRef, useState } from "react";

export interface Config {
  port: number;
  defaultProvider: string;
  providers: Record<string, { adapter: string; baseUrl: string; hasApiKey?: boolean; hasHeaders?: boolean; defaultModel?: string; models?: string[]; liveModels?: boolean; upstreamHttpVersion?: "auto" | "http1.1" | "h1" | "http2" | "h2"; reasoningWireFormat?: "gateway-object"; authMode?: string; keyOptional?: boolean; disabled?: boolean; note?: string; codexAccountMode?: "direct" | "pool" }>;
}

export function useJsonConfigEditor(deps: {
  apiBase: string;
  config: Config | null;
  notify: (msg: string, ok?: boolean) => void;
  fetchConfig: () => Promise<void>;
  fetchProviderQuotas: (refresh?: boolean) => Promise<void>;
  onSaved: () => void;
  t: (key: string, values?: Record<string, string>) => string;
}) {
  const { apiBase, config, notify, fetchConfig, fetchProviderQuotas, onSaved, t } = deps;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonBaseline, setJsonBaseline] = useState("");
  const [jsonSaving, setJsonSaving] = useState(false);
  const [jsonLeaveOpen, setJsonLeaveOpen] = useState(false);
  const jsonEditorOpenRef = useRef(false);

  useEffect(() => {
    if (config && !jsonEditorOpenRef.current) setDraft(JSON.stringify(config, null, 2));
  }, [config]);

  const saveConfig = useCallback(async (): Promise<boolean> => {
    setJsonSaving(true);
    try {
      const parsed = JSON.parse(draft);
      const res = await fetch(`${apiBase}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        notify(data.error || t("prov.saveFailed"), false);
        return false;
      }
      notify(t("prov.saved"), true);
      setEditing(false);
      setJsonEditorOpen(false);
      jsonEditorOpenRef.current = false;
      setJsonLeaveOpen(false);
      setJsonBaseline(JSON.stringify(parsed, null, 2));
      fetchConfig();
      fetchProviderQuotas(true);
      onSaved();
      return true;
    } catch {
      notify(t("prov.invalidJson"), false);
      return false;
    } finally {
      setJsonSaving(false);
    }
  }, [apiBase, draft, fetchConfig, fetchProviderQuotas, notify, onSaved, t]);

  const openJsonEditor = useCallback(() => {
    const baseline = config ? JSON.stringify(config, null, 2) : draft;
    setJsonBaseline(baseline);
    setDraft(baseline);
    setJsonLeaveOpen(false);
    setJsonEditorOpen(true);
    jsonEditorOpenRef.current = true;
  }, [config, draft]);

  const discardJsonEditor = useCallback(() => {
    setJsonLeaveOpen(false);
    setJsonEditorOpen(false);
    jsonEditorOpenRef.current = false;
    const baseline = config ? JSON.stringify(config, null, 2) : jsonBaseline;
    setJsonBaseline(baseline);
    setDraft(baseline);
  }, [config, jsonBaseline]);

  const requestCloseJsonEditor = useCallback(() => {
    if (jsonEditorOpen && draft !== jsonBaseline) {
      setJsonLeaveOpen(true);
      return;
    }
    discardJsonEditor();
  }, [discardJsonEditor, draft, jsonBaseline, jsonEditorOpen]);

  const restoreJsonEditor = useCallback(() => {
    setDraft(jsonBaseline);
  }, [jsonBaseline]);

  const jsonIsDirty = jsonEditorOpen && draft !== jsonBaseline;

  return {
    editing, setEditing, draft, setDraft, jsonEditorOpen, jsonBaseline, jsonSaving, jsonLeaveOpen,
    jsonEditorOpenRef, saveConfig, openJsonEditor, discardJsonEditor, requestCloseJsonEditor,
    restoreJsonEditor, jsonIsDirty, setJsonLeaveOpen,
  };
}
