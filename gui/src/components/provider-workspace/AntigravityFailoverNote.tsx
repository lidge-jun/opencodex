/**
 * Informational note for Antigravity multi-account routing (failover-only, no pool toggle).
 */
import { useT } from "../../i18n/shared";

export default function AntigravityFailoverNote() {
  const t = useT();
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <strong>{t("antigravityRouting.failoverOnlyTitle")}</strong>
      <div className="card-sub" style={{ marginTop: 4 }}>
        {t("antigravityRouting.failoverOnlyDesc")}
      </div>
    </div>
  );
}
