import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { setClientResourceData } from "../../client-resource";
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
  const [mirrorRetries, setMirrorRetries] = useState<Record<string, { sent: string | null | undefined }>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "err"; text: string } | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<RoleModels> => {
    const roles = await readJsonOrThrow<{ lazycodex?: { detected?: boolean }; roles?: RoleRow[]; omoJsonc?: { state: OmoFileState } | null }>(
      await fetch(`${apiBase}/api/codex-agent-roles`, { signal }),
      t("integrations.lazycodexRoles.loadFailed"),
    );
    if (roles?.lazycodex?.detected !== true) return { detected: false, roles: [], omoJsonc: null, available: [], efforts: [] };
    // The effort list is the one the Subagents page offers for its delegation model. It only adds
    // choices, so a failed lookup leaves each row with its pinned effort instead of failing the table.
    const [models, delegation] = await Promise.all([
      fetch(`${apiBase}/api/subagent-models`, { signal })
        .then(response => readJsonOrThrow<{ available?: string[] }>(response, t("integrations.lazycodexRoles.loadFailed"))),
      fetch(`${apiBase}/api/injection-model`, { signal })
        .then(response => readJsonOrThrow<{ efforts?: string[] }>(response, t("integrations.lazycodexRoles.loadFailed")))
        .catch(() => null),
    ]);
    return {
      detected: true,
      roles: roles.roles ?? [],
      omoJsonc: roles.omoJsonc ?? null,
      available: models?.available ?? [],
      efforts: delegation?.efforts ?? [],
    };
  }, [apiBase, t]);

  const resourceKey = `lazycodex-role-models:${apiBase}`;
  const resource = useDataSurface<RoleModels>(resourceKey, [apiBase], load, {
    isEmpty: data => data.roles.length === 0,
    enabled: active,
  });
  const data = resource.state.data;
  const latestData = useRef(data);
  useLayoutEffect(() => { latestData.current = data; }, [data]);

  // An undefined model saves the effort alone and leaves the role's model pin, or its inheritance,
  // as it is. Auto-assign and model picks always pass a model.
  const save = async (role: string, model: string | undefined, effort: string | null | undefined = undefined, displayedEffort?: string): Promise<boolean> => {
    if (pending !== null) return false;
    // An omitted effort still carries a pending omo.jsonc retry's effort, so a later save from any
    // path (the row or auto-assign) cannot drop it. An explicit effort replaces the retry.
    const sent = effort === undefined ? mirrorRetries[role]?.sent : effort;
    if (model === undefined && sent === undefined) return false;
    setPending(role);
    setResult(null);
    try {
      const response = await fetch(`${apiBase}/api/codex-agent-roles/${encodeURIComponent(role)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(model !== undefined ? { model } : {}), ...(sent !== undefined ? { effort: sent } : {}) }),
      });
      const payload = await readJsonOrThrow<{ omoJsonc?: { status?: OmoWriteStatus } }>(
        response,
        t("integrations.lazycodexRoles.saveFailed", { role }),
      );
      const omoStatus = payload?.omoJsonc?.status;
      const confirmed = latestData.current;
      const confirmedRow = confirmed?.roles.find(row => row.role === role);
      const confirmedEffort = sent === undefined
        ? confirmedRow ? confirmedRow.effort ?? null : displayedEffort || null
        : sent;
      const shownEffort = confirmedEffort ?? "";
      const confirmedModel = model ?? confirmedRow?.model ?? null;
      if (confirmed) {
        const next = {
          ...confirmed,
          roles: confirmed.roles.map(row => row.role === role ? {
            ...row,
            model: model ?? row.model,
            effort: confirmedEffort,
            omoJsoncModel: model !== undefined && (omoStatus === "written" || omoStatus === "unchanged") ? model : row.omoJsoncModel,
          } : row),
        };
        latestData.current = next;
        setClientResourceData(resourceKey, next);
      }
      const notice = omoStatus ? OMO_WRITE_NOTICE[omoStatus] : undefined;
      const shownModel = confirmedModel ?? t("integrations.lazycodexRoles.none");
      const picked = shownEffort ? `${shownModel} · ${shownEffort}` : shownModel;
      setResult(notice
        ? { tone: "warn", text: t(notice, { role, model: picked }) }
        : { tone: "ok", text: t("integrations.lazycodexRoles.saved", { role, model: picked }) });
      const mirrorFailed = omoStatus === "write_failed";
      const keepOnFailure = <T,>(current: Record<string, T>, value: T): Record<string, T> => {
        const { [role]: _previous, ...rest } = current;
        return mirrorFailed ? { ...rest, [role]: value } : rest;
      };
      setDrafts(current => keepOnFailure(current, model ?? ""));
      setEffortDrafts(current => keepOnFailure(current, shownEffort));
      setMirrorRetries(current => keepOnFailure(current, { sent }));
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
                <th>{t("integrations.lazycodexRoles.model")} · {t("integrations.lazycodexRoles.effort")}</th>
              </tr>
            </thead>
            <tbody>
              {data.roles.map(row => {
                const draft = drafts[row.role] ?? row.model ?? "";
                const effortDraft = effortDrafts[row.role] ?? row.effort ?? "";
                const effortChanged = effortDraft !== (row.effort ?? "");
                // A role that inherits its model has an empty model draft; its effort still saves alone.
                const changed = (draft !== "" && draft !== row.model) || effortChanged;
                const pendingMirror = mirrorRetries[row.role];
                // Without a model draft, a retry needs the effort it resends, including a null clear.
                const retryMirror = pendingMirror !== undefined && (draft !== "" || pendingMirror.sent !== undefined);
                return (
                  <tr key={row.role}>
                    <td><code>{row.role}</code></td>
                    <td>
                      {row.model
                        ? <code>{row.effort ? `${row.model} · ${row.effort}` : row.model}</code>
                        : <>
                          <span className="integration-meta">{t("integrations.lazycodexRoles.none")}</span>
                          {row.effort && <> · <code>{row.effort}</code></>}
                        </>}
                    </td>
                    <td>
                      <div className="lazycodex-role-models-edit">
                        <Select
                          value={draft}
                          options={optionsFor(row, draft)}
                          label={t("integrations.lazycodexRoles.modelFor", { role: row.role })}
                          disabled={pending !== null}
                          onChange={value => setDrafts(current => ({ ...current, [row.role]: value }))}
                        />
                        <Select
                          value={effortDraft}
                          options={[
                            { value: "", label: t("integrations.lazycodexRoles.effortDefault") },
                            ...[...new Set([...(row.effort ? [row.effort] : []), ...data.efforts])].map(value => ({ value, label: value })),
                          ]}
                          label={t("integrations.lazycodexRoles.effortFor", { role: row.role })}
                          disabled={pending !== null}
                          onChange={value => setEffortDrafts(current => ({ ...current, [row.role]: value }))}
                        />
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={!(changed || retryMirror) || pending !== null}
                          onClick={() => void save(row.role, draft || undefined, effortChanged ? effortDraft || null : undefined, row.effort ?? "")}
                        >
                          {pending === row.role
                            ? t("common.saving")
                            : retryMirror && !changed ? t("integrations.lazycodexRoles.retryMirror") : t("common.save")}
                        </button>
                      </div>
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
