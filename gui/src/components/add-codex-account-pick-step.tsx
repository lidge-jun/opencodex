import { IconGlobe, IconLink, IconDownload } from "../icons";
import { useT } from "../i18n/shared";

export function AddCodexAccountPickStep({
  id,
  error,
  onIdChange,
  onStartOAuth,
  onStartDeviceOAuth,
  onBulkImport,
  onClose,
}: {
  id: string;
  error: string;
  onIdChange: (value: string) => void;
  onStartOAuth: () => void;
  onStartDeviceOAuth: () => void;
  onBulkImport?: () => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <>
      <h3 style={{ marginBottom: 4 }}>{t("codexAuth.addTitle")}</h3>
      <p className="modal-desc">{t("codexAuth.addPickDesc")}</p>

      <label className="field-label" htmlFor="codex-account-id-input">{t("codexAuth.addIdLabel")}</label>
      <input
        id="codex-account-id-input"
        className="input"
        placeholder={t("codexAuth.addIdPlaceholder")}
        value={id}
        onChange={e => onIdChange(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <button type="button" className="list-row" onClick={onStartOAuth} style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <IconGlobe width={20} />
          <div>
            <div className="title">{t("codexAuth.oauthLogin")}</div>
            <div className="sub">{t("codexAuth.oauthDesc")}</div>
          </div>
        </div>
      </button>

      <button type="button" className="list-row" onClick={onStartDeviceOAuth} style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <IconLink width={20} />
          <div>
            <div className="title">{t("codexAuth.deviceLogin")}</div>
            <div className="sub">{t("codexAuth.deviceDesc")}</div>
          </div>
        </div>
      </button>

      {onBulkImport && (
        <button type="button" className="list-row" onClick={onBulkImport} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <IconDownload width={20} />
            <div>
              <div className="title">{"Import JSON / Bulk Accounts"}</div>
              <div className="sub">{"Paste Cockpit, 9router, Sub2API, auth.json, or tokens"}</div>
            </div>
          </div>
        </button>
      )}

      {error && <div className="notice notice-err" style={{ marginTop: 8 }}>{error}</div>}

      <button type="button" className="btn btn-ghost" onClick={onClose} style={{ width: "100%" }}>
        {t("codexAuth.cancel")}
      </button>
    </>
  );
}
