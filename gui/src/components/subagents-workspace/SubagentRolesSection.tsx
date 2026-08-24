/**
 * Named specialist catalog for the Subagents tab.
 *
 * Roles are user-authored (id + when-to-use + model + child prompt). The parent still
 * decides whether to spawn; this catalog is what it reads when it does.
 */
import { useEffect, useRef, useState } from "react";
import { IconPlus, IconX } from "../../icons";
import { useT } from "../../i18n/shared";
import { formatNamespacedModelId } from "../../provider-icons";
import { readJsonOrThrow } from "../../fetch-json";
import { Select, Switch } from "../../ui";
import type { DelegationModelOption } from "../../pages/use-subagent-delegation";

const ROLE_MAX = 8;

export type RoleDraft = {
  key: string;
  id: string;
  description: string;
  model: string;
  effort: string;
  developerInstructions: string;
  enabled: boolean;
};

let roleDraftKey = 0;
function newRoleDraftKey(): string {
  roleDraftKey += 1;
  return `role-${roleDraftKey}`;
}

export interface SubagentRolesSectionProps {
  apiBase: string;
  available: DelegationModelOption[];
  efforts: string[];
  multiAgentMode: "v1" | "default" | "v2";
  keepNativeChatGptOnV1: boolean;
  onStatus: (ok: boolean, message: string) => void;
}

function emptyRole(model: string): RoleDraft {
  return {
    key: newRoleDraftKey(),
    id: "",
    description: "",
    model,
    effort: "",
    developerInstructions: "",
    enabled: true,
  };
}

/** Slash models whose catalog row is not a native OpenAI id (account selectors stay provider openai). */
function isRoutedRoleModel(model: string, available: readonly DelegationModelOption[]): boolean {
  const slash = model.indexOf("/");
  if (slash <= 0) return false;
  const row = available.find(option => option.namespaced === model);
  if (row) return row.provider !== "openai";
  // Unknown slash id: fail closed so a missing catalog row still warns on v2.
  return true;
}

function toPayload(role: RoleDraft) {
  return {
    id: role.id.trim(),
    description: role.description,
    model: role.model,
    ...(role.effort ? { effort: role.effort } : {}),
    developerInstructions: role.developerInstructions,
    enabled: role.enabled,
  };
}

function fromServer(row: Record<string, unknown>, fallbackModel: string): RoleDraft {
  return {
    key: newRoleDraftKey(),
    id: typeof row.id === "string" ? row.id : "",
    description: typeof row.description === "string" ? row.description : "",
    model: typeof row.model === "string" ? row.model : fallbackModel,
    effort: typeof row.effort === "string" ? row.effort : "",
    developerInstructions: typeof row.developerInstructions === "string" ? row.developerInstructions : "",
    enabled: row.enabled !== false,
  };
}

export default function SubagentRolesSection({
  apiBase,
  available,
  efforts,
  multiAgentMode,
  keepNativeChatGptOnV1,
  onStatus,
}: SubagentRolesSectionProps) {
  const t = useT();
  const [roles, setRoles] = useState<RoleDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<DelegationModelOption[]>(available);
  const [effortOptions, setEffortOptions] = useState<string[]>(efforts);
  const [syncExplicit, setSyncExplicit] = useState<boolean | undefined>(undefined);
  const [syncDraft, setSyncDraft] = useState(false);
  const initialEffective = useRef(false);
  const fallbackModel = catalog[0]?.namespaced ?? available[0]?.namespaced ?? "";
  const modelOptions = catalog.length > 0 ? catalog : available;
  const effortList = effortOptions.length > 0 ? effortOptions : efforts;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/subagent-roles`);
        const data = await readJsonOrThrow<{
          roles?: Array<Record<string, unknown>>;
          available?: DelegationModelOption[];
          efforts?: string[];
          syncCodexAgentRoles?: boolean;
          syncCodexAgentRolesEffective?: boolean;
        }>(res, t("sub.roles.loadFail"));
        if (cancelled || !data) return;
        setRoles(Array.isArray(data.roles) ? data.roles.map(row => fromServer(row, "")) : []);
        if (Array.isArray(data.available)) setCatalog(data.available);
        if (Array.isArray(data.efforts)) setEffortOptions(data.efforts);
        const explicit = typeof data.syncCodexAgentRoles === "boolean" ? data.syncCodexAgentRoles : undefined;
        const effective = data.syncCodexAgentRolesEffective === true;
        setSyncExplicit(explicit);
        setSyncDraft(effective);
        initialEffective.current = effective;
      } catch {
        if (!cancelled) onStatus(false, t("sub.roles.loadFail"));
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, t, onStatus]);

  const update = (index: number, patch: Partial<RoleDraft>) => {
    setRoles(prev => prev.map((role, i) => i === index ? { ...role, ...patch } : role));
  };

  const add = () => {
    setRoles(prev => prev.length >= ROLE_MAX ? prev : [...prev, emptyRole(fallbackModel)]);
  };

  const remove = (index: number) => {
    setRoles(prev => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const payload: { roles: ReturnType<typeof toPayload>[]; syncCodexAgentRoles?: boolean } = {
        roles: roles.map(toPayload),
      };
      if (syncExplicit !== undefined || syncDraft !== initialEffective.current) {
        payload.syncCodexAgentRoles = syncDraft;
      }
      const res = await fetch(`${apiBase}/api/subagent-roles`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await readJsonOrThrow<{
        roles?: Array<Record<string, unknown>>;
        warnings?: string[];
        syncCodexAgentRoles?: boolean;
        syncCodexAgentRolesEffective?: boolean;
      }>(res, t("sub.roles.saveFailed"));
      if (Array.isArray(data?.roles)) {
        setRoles(data.roles.map(row => fromServer(row, fallbackModel)));
      }
      if (data && typeof data.syncCodexAgentRoles === "boolean") setSyncExplicit(data.syncCodexAgentRoles);
      else if (data && !("syncCodexAgentRoles" in data)) setSyncExplicit(undefined);
      if (data) {
        const effective = data.syncCodexAgentRolesEffective === true;
        setSyncDraft(effective);
        initialEffective.current = effective;
      }
      const warnings = (data?.warnings ?? []).filter(row => typeof row === "string" && row.trim());
      onStatus(true, warnings.length > 0
        ? [t("sub.roles.saved"), ...warnings].join(" ")
        : t("sub.roles.saved"));
    } catch (error) {
      onStatus(false, error instanceof Error && error.message ? error.message : t("sub.roles.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const full = roles.length >= ROLE_MAX;
  const warnRoutedOnV2 = multiAgentMode === "v2" && !keepNativeChatGptOnV1;

  return (
    <div className="swi-roles">
      <p className="swi-featured-hint">
        <span>{t("sub.roles.hint")}</span>
      </p>

      {roles.length === 0 ? (
        <div className="swi-featured-empty">{t("sub.roles.empty")}</div>
      ) : (
        <div className="swi-roles-list">
          {roles.map((role, index) => {
            const showRoutedWarning = warnRoutedOnV2 && role.enabled && isRoutedRoleModel(role.model, modelOptions);
            return (
              <div key={role.key} className="swi-role-card">
                <div className="swi-role-grid">
                  <div className="swi-role-field">
                    <span className="swi-role-label">{t("sub.roles.id")}</span>
                    <input
                      className="input"
                      type="text"
                      value={role.id}
                      onChange={event => update(index, { id: event.currentTarget.value })}
                      aria-label={t("sub.roles.id")}
                      disabled={saving}
                    />
                  </div>
                  <div className="swi-role-field">
                    <span className="swi-role-label">{t("sub.roles.model")}</span>
                    <Select
                      value={role.model}
                      options={modelOptions.map(m => ({
                        value: m.namespaced,
                        label: formatNamespacedModelId(`${m.provider}/${m.model}`, t),
                      }))}
                      onChange={v => update(index, { model: v })}
                      disabled={saving || modelOptions.length === 0}
                      label={t("sub.roles.model")}
                      align="right"
                    />
                  </div>
                  <div className="swi-role-field">
                    <span className="swi-role-label">{t("sub.roles.effort")}</span>
                    <Select
                      value={role.effort}
                      options={[
                        { value: "", label: t("sub.roles.effortNone") },
                        ...effortList.map(e => ({ value: e, label: e })),
                      ]}
                      onChange={v => update(index, { effort: v })}
                      disabled={saving}
                      label={t("sub.roles.effort")}
                      align="right"
                    />
                  </div>
                </div>
                <div className="swi-role-field">
                  <span className="swi-role-label">{t("sub.roles.description")}</span>
                  <input
                    className="input"
                    type="text"
                    value={role.description}
                    onChange={event => update(index, { description: event.currentTarget.value })}
                    aria-label={t("sub.roles.description")}
                    disabled={saving}
                  />
                  <span className="muted setting-hint">{t("sub.roles.descriptionHint")}</span>
                </div>
                <div className="swi-role-field">
                  <span className="swi-role-label">{t("sub.roles.instructions")}</span>
                  <textarea
                    className="input swi-role-instructions"
                    value={role.developerInstructions}
                    onChange={event => update(index, { developerInstructions: event.currentTarget.value })}
                    aria-label={t("sub.roles.instructions")}
                    rows={4}
                    disabled={saving}
                  />
                  <span className="muted setting-hint">{t("sub.roles.instructionsHint")}</span>
                </div>
                {showRoutedWarning && (
                  <div className="muted setting-hint" role="status">{t("sub.roles.routedV2Warning")}</div>
                )}
                <div className="swi-role-footer">
                  <div className="swi-role-enable">
                    <span className="swi-role-label">{t("sub.roles.enabled")}</span>
                    <Switch
                      on={role.enabled}
                      onClick={() => update(index, { enabled: !role.enabled })}
                      disabled={saving}
                      label={t("sub.roles.enabled")}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={() => remove(index)}
                    disabled={saving}
                    aria-label={t("sub.roles.delete", { id: role.id || String(index + 1) })}
                    style={{ color: "var(--red)" }}
                  >
                    <IconX />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="swi-delegation-row">
        <div className="setting-copy">
          <div className="font-semibold">{t("sub.roles.sync")}</div>
          <div className="muted setting-hint">{t("sub.roles.syncHint")}</div>
        </div>
        <Switch
          on={syncDraft}
          onClick={() => setSyncDraft(value => !value)}
          disabled={saving}
          label={t("sub.roles.sync")}
        />
      </div>

      <div className="swi-save-row">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={add}
          disabled={saving || full}
          aria-label={t("sub.roles.add")}
          title={full ? t("sub.roles.full") : t("sub.roles.add")}
        >
          <IconPlus style={{ width: 14, height: 14 }} />
          {t("sub.roles.add")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { void save(); }}
          disabled={saving}
          aria-label={t("sub.roles.save")}
        >
          {t("sub.roles.save")}
        </button>
      </div>
    </div>
  );
}
