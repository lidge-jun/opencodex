import { useState, useId, useCallback, useEffect } from "react";
import { Notice } from "../ui";
import { useT } from "../i18n/shared";
import { IconDownload, IconX, IconCheck } from "../icons";
import { readJsonOrThrow } from "../fetch-json";

interface BulkImportCodexModalProps {
  open: boolean;
  apiBase: string;
  onClose: () => void;
  onImported: (count: number) => void;
}

interface DetectedAccountPreview {
  email?: string;
  plan?: string;
  chatgptAccountId?: string;
  id?: string;
  hasAccess: boolean;
  hasRefresh: boolean;
}

function parseJwtSimple(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function inspectCandidates(text: string): DetectedAccountPreview[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  let parsed: unknown = null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // line fallback below
    }
  }

  const rawItems: unknown[] = [];
  if (Array.isArray(parsed)) {
    rawItems.push(...parsed);
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.accounts)) {
      rawItems.push(...obj.accounts);
    } else {
      rawItems.push(obj);
    }
  } else {
    const lines = trimmed.split(/[\r\n]+/);
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      try {
        rawItems.push(JSON.parse(l));
      } catch {
        rawItems.push(l);
      }
    }
  }

  const previews: DetectedAccountPreview[] = [];
  for (const item of rawItems) {
    if (typeof item === "string") {
      const str = item.trim();
      if (str.startsWith("eyJ")) {
        const claims = parseJwtSimple(str);
        const email = (claims?.email as string) || undefined;
        const plan = (claims?.chatgpt_plan_type as string) || undefined;
        previews.push({
          email,
          plan: plan || "plus",
          hasAccess: true,
          hasRefresh: false,
        });
      } else if (str.startsWith("rt_")) {
        previews.push({
          hasAccess: false,
          hasRefresh: true,
          plan: "oauth",
        });
      }
      continue;
    }

    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const tokens = (obj.tokens && typeof obj.tokens === "object" ? obj.tokens : {}) as Record<string, unknown>;
      const creds = (obj.credentials && typeof obj.credentials === "object" ? obj.credentials : {}) as Record<string, unknown>;

      const accessToken = (
        tokens.access_token ||
        tokens.accessToken ||
        creds.access_token ||
        creds.accessToken ||
        obj.access_token ||
        obj.accessToken ||
        obj.token
      ) as string | undefined;

      const refreshToken = (
        tokens.refresh_token ||
        tokens.refreshToken ||
        creds.refresh_token ||
        creds.refreshToken ||
        obj.refresh_token ||
        obj.refreshToken
      ) as string | undefined;

      const idToken = (
        tokens.id_token ||
        tokens.idToken ||
        creds.id_token ||
        creds.idToken ||
        obj.id_token ||
        obj.idToken
      ) as string | undefined;

      if (!accessToken && !refreshToken) continue;

      const claims = (idToken ? parseJwtSimple(idToken) : null) || (accessToken ? parseJwtSimple(accessToken) : null);

      const email = (
        obj.email ||
        tokens.email ||
        creds.email ||
        (claims?.email as string)
      ) as string | undefined;

      const plan = (
        obj.plan ||
        obj.planType ||
        obj.plan_type ||
        obj.chatgptPlanType ||
        obj.chatgpt_plan_type ||
        obj.auth_file_plan_type ||
        (claims?.chatgpt_plan_type as string)
      ) as string | undefined;

      const chatgptAccountId = (
        obj.chatgptAccountId ||
        obj.chatgpt_account_id ||
        obj.accountId ||
        obj.account_id ||
        tokens.account_id ||
        tokens.accountId ||
        creds.account_id ||
        creds.accountId ||
        (claims?.chatgpt_account_id as string)
      ) as string | undefined;

      const id = (obj.id || obj.name || obj.alias) as string | undefined;

      previews.push({
        id,
        email,
        plan: plan || "plus",
        chatgptAccountId,
        hasAccess: Boolean(accessToken),
        hasRefresh: Boolean(refreshToken),
      });
    }
  }

  return previews;
}

export function BulkImportCodexModal({
  open,
  apiBase,
  onClose,
  onImported,
}: BulkImportCodexModalProps) {
  const t = useT();
  const tr = (k: string, fb: string) => (t as unknown as (key: string) => string)(k) || fb;
  const titleId = useId();
  const [jsonText, setJsonText] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DetectedAccountPreview[]>([]);

  useEffect(() => {
    if (!open) {
      setJsonText("");
      setError(null);
      setCandidates([]);
    }
  }, [open]);

  const inspectText = useCallback((text: string) => {
    setJsonText(text);
    setError(null);
    const parsedCandidates = inspectCandidates(text);
    setCandidates(parsedCandidates);
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (content) inspectText(content);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!jsonText.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      let payload: unknown = jsonText;
      try {
        payload = JSON.parse(jsonText);
      } catch {
        // String line-based is supported by server
      }

      const res = await fetch(`${apiBase}/api/codex-auth/bulk-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: payload,
          overwrite,
        }),
      });
      const data = await readJsonOrThrow(res) as { success?: boolean; count?: number; errors?: string[]; error?: string };
      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to import accounts");
      }
      onImported(data.count ?? 0);
    } catch (err: unknown) {
      setError((err as Error).message || "Import failed. Please check your data.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="modal-overlay">
      <div className="modal-card" style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3 id={titleId}>{tr("codexAuth.bulkImportTitle", "Bulk Import Codex Accounts")}</h3>
          <button type="button" className="btn btn-ghost btn-icon" aria-label={tr("common.close", "Close")} onClick={onClose}>
            <IconX />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "0 4px" }}>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
            {tr(
              "codexAuth.bulkImportDesc",
              "Import accounts from Cockpit, 9router, Sub2API, ~/.codex/auth.json, or a list of OAuth tokens."
            )}
          </p>

          {error && <Notice tone="err">{error}</Notice>}

          <div>
            <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 500, marginBottom: 6 }}>
              {tr("codexAuth.jsonPayload", "Codex JSON or Token Lines")}
            </label>
            <textarea
              className="input"
              rows={8}
              style={{ width: "100%", fontFamily: "monospace", fontSize: "0.82rem", resize: "vertical" }}
              placeholder={`[\n  {\n    "accessToken": "eyJhbGciOi...",\n    "refreshToken": "rt_...",\n    "email": "user@example.com",\n    "plan": "plus"\n  }\n]`}
              value={jsonText}
              onChange={(e) => inspectText(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <IconDownload width={14} height={14} />
              {tr("codexAuth.chooseJsonFile", "Upload .json file")}
              <input type="file" accept=".json,.txt" style={{ display: "none" }} onChange={handleFileUpload} />
            </label>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.82rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              {tr("codexAuth.overwriteExisting", "Overwrite existing accounts")}
            </label>
          </div>

          {candidates.length > 0 && (
            <div
              style={{
                backgroundColor: "var(--bg-card, rgba(255,255,255,0.03))",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "10px 14px",
                fontSize: "0.82rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--green)" }}>
                <IconCheck width={14} height={14} />
                <span>
                  {candidates.length} {candidates.length === 1 ? "account detected" : "accounts detected"}
                </span>
              </div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {candidates.slice(0, 5).map((cand, idx) => (
                  <div key={idx} style={{ display: "flex", justifyContent: "space-between", color: "var(--text-muted)", fontSize: "0.78rem" }}>
                    <span>
                      {cand.email || cand.id || cand.chatgptAccountId || `Account #${idx + 1}`}
                    </span>
                    <span style={{ textTransform: "uppercase", fontSize: "0.72rem", opacity: 0.8 }}>
                      {cand.plan || "plus"} {cand.hasRefresh ? "• OAuth" : "• Token"}
                    </span>
                  </div>
                ))}
                {candidates.length > 5 && (
                  <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontStyle: "italic", marginTop: 2 }}>
                    ...and {candidates.length - 5} more
                  </span>
                )}
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
              {tr("common.cancel", "Cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={submitting || candidates.length === 0}
              onClick={handleImport}
            >
              {submitting
                ? tr("common.importing", "Importing...")
                : `${tr("common.import", "Import")} ${candidates.length > 0 ? `(${candidates.length})` : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
