import { useState, useId, useCallback, useEffect } from "react";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import { IconDownload, IconX } from "../icons";
import { readJsonOrThrow } from "../fetch-json";

interface ImportProviderJsonModalProps {
  open: boolean;
  apiBase: string;
  onClose: () => void;
  onImported: (providerNames: string[]) => void;
}

export function ImportProviderJsonModal({
  open,
  apiBase,
  onClose,
  onImported,
}: ImportProviderJsonModalProps) {
  const t = useT();
  const tr = (k: string, fb: string) => (t as unknown as (key: string) => string)(k) || fb;
  const titleId = useId();
  const [jsonText, setJsonText] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ kind: string; count: number; names: string[] } | null>(null);

  useEffect(() => {
    if (!open) {
      setJsonText("");
      setError(null);
      setPreview(null);
    }
  }, [open]);

  const inspectJson = useCallback((text: string) => {
    setJsonText(text);
    setError(null);
    const trimmed = text.trim();
    if (!trimmed) {
      setPreview(null);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) {
        setPreview(null);
        return;
      }
      const isCodexBatch = Array.isArray(parsed)
        ? parsed.some((item) => item?.accessToken || item?.tokens?.access_token || item?.credentials?.access_token || (typeof item === "string" && item.startsWith("eyJ")))
        : Array.isArray((parsed as Record<string, unknown>).accounts);

      if (isCodexBatch) {
        const items: unknown[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as Record<string, unknown>).accounts)
            ? ((parsed as Record<string, unknown>).accounts as unknown[])
            : [];
        const names: string[] = items.map((item, idx) => {
          if (typeof item === "object" && item) {
            const rec = item as Record<string, unknown>;
            return String(rec.email || rec.id || `account-${idx + 1}`);
          }
          return `token-${idx + 1}`;
        });
        setPreview({ kind: "Codex Accounts Batch (Cockpit / 9router / Sub2API)", count: items.length, names: names.slice(0, 5) });
      } else if (Array.isArray(parsed)) {
        const names = parsed.map((item, idx) => item?.name || item?.provider || `provider-${idx + 1}`);
        setPreview({ kind: "Array of items (9router / list)", count: parsed.length, names: names.slice(0, 5) });
      } else if (Array.isArray((parsed as Record<string, unknown>).connections)) {
        const conns = (parsed as { connections: Array<Record<string, unknown>> }).connections;
        const names = conns.map((item, idx) => (item?.name as string) || (item?.provider as string) || `conn-${idx + 1}`);
        setPreview({ kind: "9router Connections export", count: conns.length, names: names.slice(0, 5) });
      } else if (typeof (parsed as Record<string, unknown>).providers === "object") {
        const keys = Object.keys((parsed as { providers: Record<string, unknown> }).providers || {});
        setPreview({ kind: "OpenCodex Providers block", count: keys.length, names: keys.slice(0, 5) });
      } else {
        const keys = Object.keys(parsed);
        setPreview({ kind: "JSON dictionary", count: keys.length, names: keys.slice(0, 5) });
      }
    } catch {
      setPreview(null);
    }
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (content) inspectJson(content);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!jsonText.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const parsed = JSON.parse(jsonText);
      const res = await fetch(`${apiBase}/api/providers/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: parsed,
          overwrite,
        }),
      });
      const data = await readJsonOrThrow(res) as { success?: boolean; imported?: string[]; count?: number; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to import providers");
      }
      onImported(data.imported || []);
    } catch (err: unknown) {
      setError((err as Error).message || "Import failed. Please check JSON format.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="modal-overlay">
      <div className="modal-card" style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3 id={titleId}>{tr("prov.importJsonTitle", "Import Provider JSON")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={tr("common.close", "Close")} onClick={onClose}>
            <IconX />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 4px" }}>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {tr("prov.importJsonDesc", "Paste 9router connection exports, bulk account JSON, or OpenCodex provider configurations.")}
          </p>

          {error && <Notice tone="err">{error}</Notice>}

          <div>
            <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 500, marginBottom: 6 }}>
              {tr("prov.jsonPayload", "JSON Content")}
            </label>
            <textarea
              className="input"
              rows={8}
              style={{ width: "100%", fontFamily: "monospace", fontSize: "0.82rem", resize: "vertical" }}
              placeholder={`{\n  "connections": [\n    { "provider": "deepseek", "apiKey": "sk-...", "baseUrl": "..." }\n  ]\n}`}
              value={jsonText}
              onChange={(e) => inspectJson(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <IconDownload width={14} height={14} />
              {tr("prov.chooseJsonFile", "Upload .json file")}
              <input type="file" accept=".json" style={{ display: "none" }} onChange={handleFileUpload} />
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.82rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              {tr("prov.overwriteExisting", "Overwrite existing providers")}
            </label>
          </div>

          {preview && (
            <div style={{ padding: "8px 12px", background: "var(--raised)", borderRadius: 6, fontSize: "0.82rem", border: "1px solid var(--border)" }}>
              <div style={{ fontWeight: 600, color: "var(--accent)" }}>
                {preview.kind}: {preview.count} {preview.count === 1 ? "provider" : "providers"} found
              </div>
              <div className="muted" style={{ marginTop: 2 }}>
                {preview.names.join(", ")}{preview.count > 5 ? ` + ${preview.count - 5} more` : ""}
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
              {tr("modal.cancel", "Cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleImport}
              disabled={submitting || !jsonText.trim() || preview === null}
            >
              {submitting ? tr("modal.saving", "Importing...") : tr("prov.importNow", `Import ${preview ? `(${preview.count})` : ""}`)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
