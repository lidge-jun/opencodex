import { useCallback, useState } from "react";
import { DataSurfaceSkeleton } from "../../components/data-surface";
import { useDataSurface } from "../../data-surface";
import { readJsonOrThrow } from "../../fetch-json";
import { useT, type TKey } from "../../i18n/shared";
import { Notice, Select, type SelectOption } from "../../ui";

interface RoleRow {
  role: string;
  model: string | null;
  omoModel: string | null;
}

type OmoFileState = "absent" | "comments" | "invalid" | "present";
type OmoWriteStatus = "written" | "unchanged" | "absent" | "skipped_comments" | "invalid" | "write_failed";

interface RoleModels {
  roles: RoleRow[];
  omo: { state: OmoFileState };
  available: string[];
}

const OMO_WRITE_NOTICE: Partial<Record<OmoWriteStatus, TKey>> = {
  absent: "integrations.omoRoles.omoAbsent",
  skipped_comments: "integrations.omoRoles.omoComments",
  invalid: "integrations.omoRoles.omoInvalid",
  write_failed: "integrations.omoRoles.omoFailed",
};

export default function OmoRoleModels({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mirrorRetries, setMirrorRetries] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<RoleModels> => {
    const [rolesResponse, modelsResponse] = await Promise.all([
      fetch(`${apiBase}/api/codex-agent-roles`, { signal }),
      fetch(`${apiBase}/api/subagent-models`, { signal }),
    ]);
    const roles = await readJsonOrThrow<{ roles?: RoleRow[]; omo?: { state: OmoFileState } }>(
      rolesResponse,
      t("integrations.omoRoles.loadFailed"),
    );
    const models = await readJsonOrThrow<{ available?: string[] }>(modelsResponse, t("integrations.omoRoles.loadFailed"));
    return { roles: roles?.roles ?? [], omo: roles?.omo ?? { state: "absent" }, available: models?.available ?? [] };
  }, [apiBase, t]);

  const resource = useDataSurface<RoleModels>(`omo-role-models:${apiBase}`, [apiBase], load, {
    isEmpty: data => data.roles.length === 0,
    enabled: active,
  });
  const data = resource.state.data;

  const save = async (role: string, model: string) => {
    if (pending !== null) return;
    setPending(role);
    setResult(null);
    try {
      const response = await fetch(`${apiBase}/api/codex-agent-roles/${encodeURIComponent(role)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const payload = await readJsonOrThrow<{ omo?: { status?: OmoWriteStatus } }>(
        response,
        t("integrations.omoRoles.saveFailed", { role }),
      );
      const omoStatus = payload?.omo?.status;
      const notice = omoStatus ? OMO_WRITE_NOTICE[omoStatus] : undefined;
      setResult(notice
        ? { tone: "warn", text: t(notice, { role, model }) }
        : { tone: "ok", text: t("integrations.omoRoles.saved", { role, model }) });
      setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== role)));
      setMirrorRetries(current => {
        const { [role]: _previous, ...rest } = current;
        return omoStatus === "write_failed" ? { ...rest, [role]: model } : rest;
      });
      await resource.refresh();
    } catch {
      setResult({ tone: "err", text: t("integrations.omoRoles.saveFailed", { role }) });
    } finally {
      setPending(null);
    }
  };

  const optionsFor = (row: RoleRow, draft: string): SelectOption[] => {
    const values = [...new Set([...(row.model ? [row.model] : []), ...(data?.available ?? [])])];
    return [
      ...(draft === "" ? [{ value: "", label: t("integrations.omoRoles.choose") }] : []),
      ...values.map(value => ({ value, label: value })),
    ];
  };

  return (
    <section className="omo-role-models" aria-labelledby="omo-role-models-title">
      <h4 id="omo-role-models-title">{t("integrations.omoRoles.title")}</h4>
      <p className="page-sub">{t("integrations.omoRoles.hint")}</p>
      {data?.omo.state === "comments" && <Notice tone="warn">{t("integrations.omoRoles.omoCommentsState")}</Notice>}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      {resource.state.showSkeleton ? (
        <DataSurfaceSkeleton label={t("integrations.omoRoles.title")} rows={3} />
      ) : resource.state.kind === "failed-cold" ? (
        <Notice tone="err">
          {t("integrations.omoRoles.loadFailed")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resource.refresh()}>
            {t("common.retry")}
          </button>
        </Notice>
      ) : !data || data.roles.length === 0 ? (
        <p className="page-sub">{t("integrations.omoRoles.empty")}</p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("integrations.omoRoles.role")}</th>
                <th>{t("integrations.omoRoles.current")}</th>
                <th>{t("integrations.omoRoles.model")}</th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map(row => {
                const draft = drafts[row.role] ?? row.model ?? "";
                const changed = draft !== "" && draft !== row.model;
                const retryMirror = !changed && draft !== "" && mirrorRetries[row.role] === draft;
                return (
                  <tr key={row.role}>
                    <td><code>{row.role}</code></td>
                    <td>
                      {row.model
                        ? <code>{row.model}</code>
                        : <span className="integration-meta">{t("integrations.omoRoles.none")}</span>}
                    </td>
                    <td>
                      <div className="omo-role-models-edit">
                        <Select
                          value={draft}
                          options={optionsFor(row, draft)}
                          label={t("integrations.omoRoles.modelFor", { role: row.role })}
                          disabled={pending !== null}
                          onChange={value => setDrafts(current => ({ ...current, [row.role]: value }))}
                        />
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={!(changed || retryMirror) || pending !== null}
                          onClick={() => void save(row.role, draft)}
                        >
                          {pending === row.role
                            ? t("common.saving")
                            : retryMirror ? t("integrations.omoRoles.retryMirror") : t("common.save")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
