import { useT } from "../i18n/shared";
import type { KiroDeviceMethod } from "../kiro-device-login-helpers";

export default function KiroLoginChooser({ disabled, onCli, onMethod }: {
  disabled: boolean;
  onCli: () => void;
  onMethod: (method: KiroDeviceMethod) => void;
}) {
  const t = useT();
  return (
    <div className="kiro-login-choices" role="group" aria-label={t("kiroLogin.chooseMethod")}>
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onCli}>{t("kiroLogin.cli")}</button>
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onMethod("builder-id")}>{t("kiroLogin.builderId")}</button>
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onMethod("google")}>{t("kiroLogin.google")}</button>
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onMethod("github")}>{t("kiroLogin.github")}</button>
    </div>
  );
}
