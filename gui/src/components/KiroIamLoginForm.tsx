import { useId, useState } from "react";
import { useT } from "../i18n/shared";
import { validKiroIamOptions, type KiroIamOptions, type KiroIamProfile } from "../kiro-device-login-helpers";

export function KiroIamLoginForm({ disabled, onStart, onBack }: {
  disabled: boolean; onStart: (options: KiroIamOptions) => void; onBack: () => void;
}) {
  const t = useT();
  const id = useId();
  const [startUrl, setStartUrl] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [invalid, setInvalid] = useState(false);
  return <form className="kiro-iam-form" onSubmit={event => {
    event.preventDefault();
    const options = { startUrl: startUrl.trim(), region: region.trim() };
    if (!validKiroIamOptions(options)) { setInvalid(true); return; }
    setInvalid(false); onStart(options);
  }}>
    <p className="muted">{t("kiroLogin.iamDescription")}</p>
    <label className="field-label" htmlFor={`${id}-portal`}>{t("kiroLogin.startUrl")}</label>
    <input className="input" id={`${id}-portal`} type="url" required maxLength={2048} value={startUrl} disabled={disabled}
      placeholder="https://example.awsapps.com/start" autoComplete="url" aria-describedby={invalid ? `${id}-error` : undefined}
      aria-invalid={invalid || undefined} onChange={event => { setStartUrl(event.target.value); setInvalid(false); }} />
    <label className="field-label" htmlFor={`${id}-region`}>{t("kiroLogin.region")}</label>
    <input className="input" id={`${id}-region`} required maxLength={32} value={region} disabled={disabled}
      placeholder="us-east-1" autoComplete="off" aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${id}-error` : undefined}
      onChange={event => { setRegion(event.target.value); setInvalid(false); }} />
    {invalid && <p id={`${id}-error`} role="alert" className="notice-warn">{t("kiroLogin.invalidIam")}</p>}
    <div className="kiro-device-actions">
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={onBack}>{t("kiroLogin.back")}</button>
      <button type="submit" className="btn btn-primary" disabled={disabled}>{t("kiroLogin.continue")}</button>
    </div>
  </form>;
}

export function KiroIamProfilePicker({ profiles, disabled, onSelect }: {
  profiles: KiroIamProfile[]; disabled: boolean; onSelect: (arn: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [arn, setArn] = useState("");
  return <form className="kiro-iam-form" onSubmit={event => {
    event.preventDefault();
    if (profiles.some(profile => profile.arn === arn)) onSelect(arn);
  }}>
    <p>{t("kiroLogin.selectProfile")}</p>
    <label className="field-label" htmlFor={id}>{t("kiroLogin.profile")}</label>
    <select className="input" id={id} value={arn} required disabled={disabled} onChange={event => setArn(event.target.value)}>
      <option value="">{t("kiroLogin.selectProfile")}</option>
      {profiles.map(profile => <option key={profile.arn} value={profile.arn}>{profile.name} ({profile.region})</option>)}
    </select>
    {arn && <code className="kiro-device-destination">{arn}</code>}
    <div className="kiro-device-actions"><button type="submit" className="btn btn-primary" disabled={disabled || !arn}>{t("kiroLogin.saveAccount")}</button></div>
  </form>;
}
