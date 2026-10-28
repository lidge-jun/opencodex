import { useState } from "react";
import { useI18n } from "../../i18n/shared";
import { Notice } from "../../ui";

export interface RoleSetting {
  model: string | null;
  effort: string | null;
}

export interface RoleChange {
  at: string;
  batch: string;
  role: string;
  before: RoleSetting;
  after: RoleSetting;
}

/** A saved role write: the batch the server recorded it in, absent when it recorded nothing. */
export interface SavedRole {
  batch?: string;
}

/**
 * `batch` joins the batch the first write of this Restore started (the server hands out batch ids);
 * `restores` names the batch being put back, and the server checks the write against its own history.
 */
type Restore = (role: string, model: string | undefined, effort: string | null, batch: string | undefined, restores: string) => Promise<SavedRole | null>;

/** Newest first, as the server lists them; one entry per batch, so Apply all reads as one action. */
function groupByBatch(history: RoleChange[]): RoleChange[][] {
  const groups = new Map<string, RoleChange[]>();
  for (const change of history) groups.set(change.batch, [...(groups.get(change.batch) ?? []), change]);
  return [...groups.values()];
}

/** A role changed twice in one batch goes back to what it held before the first change. */
function earliestBefore(group: RoleChange[]): Map<string, RoleSetting> {
  const before = new Map<string, RoleSetting>();
  for (const change of group) before.set(change.role, change.before);
  return before;
}

export default function LazyCodexRoleHistory({ history, unavailable, busy, restore }: { history: RoleChange[]; unavailable: boolean; busy: boolean; restore: Restore }) {
  const { locale, t } = useI18n();
  const [restoring, setRestoring] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  if (unavailable) return <Notice tone="warn">{t("integrations.lazycodexRoles.history.unavailable")}</Notice>;
  if (history.length === 0) return null;

  const describe = (setting: RoleSetting) => {
    const model = setting.model ?? t("integrations.lazycodexRoles.none");
    return setting.effort ? `${model} · ${setting.effort}` : model;
  };

  const restoreGroup = async (group: RoleChange[]) => {
    setRestoring(group[0]!.batch);
    setSummary(null);
    try {
      let batch: string | undefined;
      const roles = [...earliestBefore(group)];
      let count = 0;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose: every PUT rewrites the shared omo.jsonc mirror
      for (const [role, setting] of roles) {
        // A role that had no model pin keeps its current one: a save can set a pin, not remove it.
        const saved = await restore(role, setting.model ?? undefined, setting.effort, batch, group[0]!.batch);
        if (!saved) break;
        batch ??= saved.batch;
        count += 1;
      }
      const time = new Date(group[0]!.at).toLocaleString(locale);
      setSummary(count === roles.length
        ? { tone: "ok", text: t("integrations.lazycodexRoles.history.restored", { count: String(count), time }) }
        : { tone: "warn", text: t("integrations.lazycodexRoles.history.partial", { count: String(count), total: String(roles.length), role: roles[count]![0] }) });
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="lazycodex-role-history">
      <h5>{t("integrations.lazycodexRoles.history.title")}</h5>
      <p className="page-sub">{t("integrations.lazycodexRoles.history.hint")}</p>
      {summary && <Notice tone={summary.tone}>{summary.text}</Notice>}
      <ul>
        {groupByBatch(history).map(group => (
          <li key={group[0]!.batch}>
            <span className="integration-meta">{new Date(group[0]!.at).toLocaleString(locale)}</span>
            <ul>
              {group.map(change => (
                <li key={`${change.at}-${change.role}`}>
                  <code>{change.role}</code>: <code>{describe(change.before)}</code> → <code>{describe(change.after)}</code>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-sm" disabled={busy || restoring !== null} onClick={() => void restoreGroup(group)}>
              {restoring === group[0]!.batch ? t("common.saving") : t("integrations.lazycodexRoles.history.restore")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
