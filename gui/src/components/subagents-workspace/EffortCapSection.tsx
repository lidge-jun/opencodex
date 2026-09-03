/**
 * Effort caps for the main model and for subagents (`/api/effort-caps`).
 *
 * This was a dashboard card. It only means something once multi-agent mode is on, and
 * it is a delegation setting, so it lives with the other delegation settings on the
 * Subagents page. The read goes through the shared client-resource layer; a save is an
 * optimistic override until the server answers.
 */
import { useCallback, useState } from "react";
import { useKeyedClientResource } from "../../client-resource";
import { useT } from "../../i18n/shared";
import { Select } from "../../ui";
import { EFFORT_CAP_LEVELS, requireJson } from "../../pages/dashboard-shared";

type Caps = { effortCap: string; subagentEffortCap: string };

async function readCaps(apiBase: string, signal: AbortSignal): Promise<Caps> {
  const res = await fetch(`${apiBase}/api/effort-caps`, { signal });
  const data = await requireJson<{ effortCap?: string | null; subagentEffortCap?: string | null }>(res);
  return { effortCap: data.effortCap ?? "", subagentEffortCap: data.subagentEffortCap ?? "" };
}

export function EffortCapSection({ apiBase }: { apiBase: string }) {
  const t = useT();
  const read = useKeyedClientResource(`effort-caps:${apiBase}`, [apiBase], (signal) => readCaps(apiBase, signal));
  const [override, setOverride] = useState<Caps | null>(null);
  const [saving, setSaving] = useState(false);
  const caps: Caps = override ?? read.data ?? { effortCap: "", subagentEffortCap: "" };

  const save = useCallback(async (patch: { effortCap?: string | null; subagentEffortCap?: string | null }) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/effort-caps`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await requireJson<{ ok: boolean; effortCap?: string | null; subagentEffortCap?: string | null }>(res);
      setOverride({ effortCap: data.effortCap ?? "", subagentEffortCap: data.subagentEffortCap ?? "" });
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }, [apiBase, saving]);

  const options = [
    { value: "", label: t("dash.effortCapNone") },
    ...EFFORT_CAP_LEVELS.map(e => ({ value: e, label: e })),
  ];

  return (
    <section className="panel swi-effort-caps" aria-busy={read.data === undefined || undefined}>
      <div className="setting-row">
        <div className="setting-label">
          <span className="title">{t("dash.effortCapLabel")}</span>
          <span className="desc">{t("dash.effortCapHelp")}</span>
        </div>
        <div className="setting-controls" style={{ display: "flex", gap: 8 }}>
          <Select
            value={caps.effortCap}
            options={options}
            onChange={v => { void save({ effortCap: v || null }); }}
            disabled={saving}
            label={t("dash.effortCapLabel")}
            align="right"
          />
          <Select
            value={caps.subagentEffortCap}
            options={options}
            onChange={v => { void save({ subagentEffortCap: v || null }); }}
            disabled={saving}
            label={t("dash.subagentEffortCapLabel")}
            align="right"
          />
        </div>
      </div>
    </section>
  );
}
