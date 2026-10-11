import { useCallback, useState } from "react";
import { useDataSurface } from "../../data-surface";
import { readJsonOrThrow } from "../../fetch-json";
import { useT, type TKey } from "../../i18n/shared";
import { Notice, Select, type SelectOption } from "../../ui";
import LazyCodexRoleAutoAssign from "./LazyCodexRoleAutoAssign";

interface RoleRow {
  role: string;
  model: string | null;
  effort: string | null;
  omoJsoncModel: string | null;
}

type OmoFileState = "absent" | "comments" | "invalid" | "present";
type OmoWriteStatus = "written" | "unchanged" | "absent" | "skipped_comments" | "invalid" | "write_failed";

interface RoleModels {
  detected: boolean;
  roles: RoleRow[];
  omoJsonc: { state: OmoFileState } | null;
  available: string[];
  efforts: string[];
}

const OMO_WRITE_NOTICE: Partial<Record<OmoWriteStatus, TKey>> = {
  absent: "integrations.lazycodexRoles.omoAbsent",
  skipped_comments: "integrations.lazycodexRoles.omoComments",
  invalid: "integrations.lazycodexRoles.omoInvalid",
  write_failed: "integrations.lazycodexRoles.omoFailed",
};

export default function LazyCodexRoleModels({ apiBase, active }: { apiBase: string; active: boolean }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [effortDrafts, setEffortDrafts] = useState<Record<string, string>>({});
  const [mirrorRetries, setMirrorRetries] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<RoleModels> => {
    const roles = await readJsonOrThrow<{ lazycodex?: { detected?: boolean }; roles?: RoleRow[]; omoJsonc?: { state: OmoFileState } | null }>(
      await fetch(`${apiBase}/api/codex-agent-roles`, { signal }),
      t("integrations.lazycodexRoles.loadFailed"),
    );
    if (roles?.lazycodex?.detected !== true) return { detected: false, roles: [], omoJsonc: null, available: [], efforts: [] };
    // The effort list is the one the Subagents page offers for its delegation model.
    const [models, delegation] = await Promise.all([
      fetch(`${apiBase}/api/subagent-models`, { signal })
        .then(response => readJsonOrThrow<{ available?: string[] }>(response, t("integrations.lazycodexRoles.loadFailed"))),
      fetch(`${apiBase}/api/injection-model`, { signal })
        .then(response => readJsonOrThrow<{ efforts?: string[] }>(response, t("integrations.lazycodexRoles.loadFailed"))),
    ]);
    return {
      detected: true,
      roles: roles.roles ?? [],
      omoJsonc: roles.omoJsonc ?? null,
      available: models?.available ?? [],
      efforts: delegation?.efforts ?? [],
    };
  }, [apiBase, t]);

  const resource = useDataSurface<RoleModels>(`lazycodex-role-models:${apiBase}`, [apiBase], load, {
    isEmpty: data => data.roles.length === 0,
    enabled: active,
  });
  const data = resource.state.data;

  const save = async (role: string, model: string, effort: string | null = null): Promise<boolean> => {
    if (pending !== null) return false;
    setPending(role);
    setResult(null);
    try {
      const response = await fetch(`${apiBase}/api/codex-agent-roles/${encodeURIComponent(role)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(effort ? { model, effort } : { model }),
      });
      const payload = await readJsonOrThrow<{ omoJsonc?: { status?: OmoWriteStatus } }>(
        response,
        t("integrations.lazycodexRoles.saveFailed", { role }),
      );
      const omoStatus = payload?.omoJsonc?.status;
      const notice = omoStatus ? OMO_WRITE_NOTICE[omoStatus] : undefined;
      const picked = effort ? `${model} · ${effort}` : model;
      setResult(notice
        ? { tone: "warn", text: t(notice, { role, model: picked }) }
        : { tone: "ok", text: t("integrations.lazycodexRoles.saved", { role, model: picked }) });
      setDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== role)));
      setEffortDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== role)));
      setMirrorRetries(current => {
        const { [role]: _previous, ...rest } = current;
        return omoStatus === "write_failed" ? { ...rest, [role]: model } : rest;
      });
      await resource.refresh();
      return true;
    } catch {
      setResult({ tone: "err", text: t("integrations.lazycodexRoles.saveFailed", { role }) });
      return false;
    } finally {
      setPending(null);
    }
  };

  const optionsFor = (row: RoleRow, draft: string): SelectOption[] => {
    const values = [...new Set([...(row.model ? [row.model] : []), ...(data?.available ?? [])])];
    return [
      ...(draft === "" ? [{ value: "", label: t("integrations.lazycodexRoles.choose") }] : []),
      ...values.map(value => ({ value, label: value })),
    ];
  };

  if (resource.state.kind === "failed-cold") {
    return (
      <Notice tone="err">
        {t("integrations.lazycodexRoles.loadFailed")}{" "}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resource.refresh()}>
          {t("common.retry")}
        </button>
      </Notice>
    );
  }
  if (!data?.detected) return null;

  return (
    <section id="lazycodex-role-models" className="lazycodex-role-models" aria-labelledby="lazycodex-role-models-title">
      <h4 id="lazycodex-role-models-title">{t("integrations.lazycodexRoles.title")}</h4>
      <p className="page-sub">{t("integrations.lazycodexRoles.hint")}</p>
      {data.omoJsonc?.state === "comments" && <Notice tone="warn">{t("integrations.lazycodexRoles.omoCommentsState")}</Notice>}
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      {data.roles.length === 0 ? (
        <p className="page-sub">{t("integrations.lazycodexRoles.empty")}</p>
      ) : (
        <>
        <LazyCodexRoleAutoAssign apiBase={apiBase} busy={pending !== null} apply={save} />
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("integrations.lazycodexRoles.role")}</th>
                <th>{t("integrations.lazycodexRoles.current")}</th>
                <th>{t("integrations.lazycodexRoles.model")}</th>
                <th>{t("integrations.lazycodexRoles.effort")}</th>
                <th><span className="sr-only">{t("common.save")}</span></th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map(row => {
                const draft = drafts[row.role] ?? row.model ?? "";
                const effortDraft = effortDrafts[row.role] ?? row.effort ?? "";
                const changed = draft !== "" && (draft !== row.model || effortDraft !== (row.effort ?? ""));
                const retryMirror = !changed && draft !== "" && mirrorRetries[row.role] === draft;
                return (
                  <tr key={row.role}>
                    <td><code>{row.role}</code></td>
                    <td>
                      {row.model
                        ? <code>{row.effort ? `${row.model} · ${row.effort}` : row.model}</code>
                        : <span className="integration-meta">{t("integrations.lazycodexRoles.none")}</span>}
                    </td>
                    <td>
                      <Select
                        value={draft}
                        options={optionsFor(row, draft)}
                        label={t("integrations.lazycodexRoles.modelFor", { role: row.role })}
                        disabled={pending !== null}
                        onChange={value => setDrafts(current => ({ ...current, [row.role]: value }))}
                      />
                    </td>
                    <td>
                      <Select
                        value={effortDraft}
                        options={[
                          ...(row.effort === null ? [{ value: "", label: t("integrations.lazycodexRoles.effortDefault") }] : []),
                          ...[...new Set([...(row.effort ? [row.effort] : []), ...data.efforts])].map(value => ({ value, label: value })),
                        ]}
                        label={t("integrations.lazycodexRoles.effortFor", { role: row.role })}
                        disabled={pending !== null}
                        onChange={value => setEffortDrafts(current => ({ ...current, [row.role]: value }))}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!(changed || retryMirror) || pending !== null}
                        onClick={() => void save(row.role, draft, effortDraft || null)}
                      >
                        {pending === row.role
                          ? t("common.saving")
                          : retryMirror ? t("integrations.lazycodexRoles.retryMirror") : t("common.save")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  );
}
