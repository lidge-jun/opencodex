import { useT } from "../../i18n/shared";
import type { WorkspaceItem } from "./types";

export type KeyPacingDraft = Pick<NonNullable<WorkspaceItem["requestPacing"]>, "keySelection" | "keys">;
export type KeyPacingStatus = { id: string; starts: number; inFlight: number; queued: number; nextSlotInMs: number; cooldownUntil?: number | null };

export function ProviderKeyPacing({ value, onChange, status = [] }: {
  value: KeyPacingDraft; onChange: (value: KeyPacingDraft) => void; status?: KeyPacingStatus[];
}) {
  const t = useT();
  const numberField = (field: "requestsPerMinute" | "minIntervalMs" | "maxConcurrentRequests", raw: string) => {
    const keys = { ...value.keys };
    if (!raw.trim()) delete keys[field];
    else keys[field] = Number(raw);
    onChange({ ...value, keys: Object.keys(keys).length ? keys : undefined });
  };
  return <>
    <label className="pwi-settings-field"><span className="pwi-settings-label">{t("pws.keySelection")}</span>
      <select className="input" value={value.keySelection ?? "active"} onChange={event => onChange({ ...value, keySelection: event.target.value as "active" | "round-robin" })}>
        <option value="active">{t("pws.keyActive")}</option><option value="round-robin">{t("pws.keyRoundRobin")}</option>
      </select>
    </label>
    <h4>{t("pws.keyLimits")}</h4>
    <div className="pwi-key-limits" style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
      {(["requestsPerMinute", "minIntervalMs", "maxConcurrentRequests"] as const).map((field, index) => <label key={field} className="pwi-settings-field" style={{ flex: "1 1 160px", minWidth: 0 }}>
        <span className="pwi-settings-label">{t((["pws.pacingRpm", "pws.pacingDelay", "pws.pacingConcurrency"] as const)[index]!)}</span>
        <input className="input" type="number" min={field === "requestsPerMinute" ? 1 / 60 : 1} step={field === "requestsPerMinute" ? "any" : 1}
          value={value.keys?.[field] ?? ""} onChange={event => numberField(field, event.target.value)} />
      </label>)}
    </div>
    <p className="pwi-settings-hint">{t("pws.keySharedQuota")}</p>
    {status.length > 0 && <table style={{ width: "100%", tableLayout: "fixed", overflowWrap: "anywhere" }}><thead><tr>
      <th>{t("pws.keyHandle")}</th><th>{t("pws.keyStarts")}</th><th>{t("pws.keyInFlight")}</th><th>{t("pws.pacingQueued")}</th><th>{t("pws.keyWait")}</th>
    </tr></thead><tbody>{status.map(row => <tr key={row.id}><td><code>{row.id}</code></td><td>{row.starts}</td><td>{row.inFlight}</td><td>{row.queued}</td>
      <td>{row.cooldownUntil ? t("pws.keyCooldown") : `${row.nextSlotInMs} ms`}</td></tr>)}</tbody></table>}
  </>;
}
