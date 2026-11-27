import { useT, type TKey } from "../../i18n/shared";
import { cn } from "../../lib/utils";

export type AdvisorMcpClientId =
  | "workbuddy"
  | "workbuddy-ai"
  | "qoder"
  | "qoder-cn"
  | "commandcode"
  | "cline"
  | "opencode"
  | "claude";

export interface AdvisorMcpClientStatusDto {
  clientId: AdvisorMcpClientId;
  label: string;
  detected: boolean;
  routed: boolean;
  mounted: boolean;
  selected: boolean;
  defaultAutoMount: boolean;
  supportsHooks: boolean;
  supportsSkills: boolean;
  hooksMounted: boolean;
  skillMounted: boolean;
  trustStatus: "trusted" | "action_required" | "needs_confirmation" | "auto_enabled" | "not_mounted";
  configPath: string;
  hookConfigPath?: string;
  skillPath?: string;
  trustNoteZh: string;
  trustNoteEn: string;
}

interface AdvisorClientMcpPanelProps {
  clients: readonly AdvisorMcpClientStatusDto[];
  autoMountMcp: boolean;
  explicitClients: readonly AdvisorMcpClientId[] | null | undefined;
  disabled: boolean;
  onChangeAutoMount: (enabled: boolean) => void;
  onChangeClients: (clients: AdvisorMcpClientId[] | null) => void;
}

function trustBadgeClass(status: AdvisorMcpClientStatusDto["trustStatus"]): string {
  switch (status) {
    case "trusted":
    case "auto_enabled":
      return "bg-success-soft text-success";
    case "action_required":
      return "bg-warning-soft text-warning";
    default:
      return "bg-raised text-fg-muted";
  }
}

export function AdvisorClientMcpPanel({
  clients,
  autoMountMcp,
  explicitClients,
  disabled,
  onChangeAutoMount,
  onChangeClients,
}: AdvisorClientMcpPanelProps) {
  const t = useT();
  const isManual = Array.isArray(explicitClients);

  const selectedSet = new Set<AdvisorMcpClientId>(
    isManual
      ? explicitClients
      : clients
          .filter(item => autoMountMcp && item.defaultAutoMount && item.routed)
          .map(item => item.clientId),
  );

  const toggleClient = (clientId: AdvisorMcpClientId, checked: boolean) => {
    const base = isManual
      ? [...explicitClients]
      : [...selectedSet];
    const next = new Set<AdvisorMcpClientId>(base);
    if (checked) next.add(clientId);
    else next.delete(clientId);
    onChangeClients([...next]);
  };

  const selectAllRouted = () => {
    const routedIds = clients
      .filter(item => item.routed && item.defaultAutoMount)
      .map(item => item.clientId);
    onChangeClients(routedIds);
  };

  return (
    <section
      id="advisor-client-mcp"
      aria-labelledby="advisor-mcp-title"
      className="flex flex-col gap-3 rounded-card bg-surface p-4 ring-1 ring-inset ring-line"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="advisor-mcp-title" className="m-0 text-[15px] leading-5 font-semibold text-fg">
          {t("advisor.mcp.title")}
        </h3>
        <span className="ml-auto rounded-full bg-raised px-2 py-0.5 text-[11px] font-semibold text-fg-muted">
          {isManual ? t("advisor.mcp.selectionModeManual") : autoMountMcp ? t("advisor.mcp.selectionModeAuto") : t("advisor.mcp.selectionModeOff")}
        </span>
      </div>
      <p className="m-0 text-[13px] leading-[19px] text-fg-muted">{t("advisor.mcp.subtitle")}</p>

      <div className="rounded-control bg-raised p-3 text-[12px] leading-[18px] text-fg-muted ring-1 ring-line">
        <strong className="text-fg">{t("advisor.mcp.proxyNativeTitle")}:</strong> {t("advisor.mcp.proxyNativeDesc")}
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-control bg-raised p-3 ring-1 ring-line">
        <input
          id="advisor-auto-mount-mcp"
          type="checkbox"
          className="advisor-consent-check mt-0.5 size-4 shrink-0 cursor-pointer"
          checked={autoMountMcp}
          disabled={disabled}
          aria-label={t("advisor.mcp.autoMountLabel")}
          onChange={event => onChangeAutoMount(event.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium leading-[19px] text-fg">{t("advisor.mcp.autoMountLabel")}</span>
          <span className="text-[12px] leading-[17px] text-fg-muted">{t("advisor.mcp.autoMountHint")}</span>
        </span>
      </label>

      {clients.length === 0 ? (
        <p className="m-0 text-[12px] text-fg-muted">{t("advisor.mcp.emptyHint")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {isManual && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={disabled}
                onClick={() => onChangeClients(null)}
              >
                {t("advisor.mcp.useAutoMode")}
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled || !clients.some(item => item.routed && item.defaultAutoMount)}
              onClick={selectAllRouted}
            >
              {t("advisor.mcp.selectRouted")}
            </button>
          </div>

          <div className="flex flex-col gap-2">
            {clients.map(client => {
              const checked = selectedSet.has(client.clientId);
              const trustLabelKey =
                client.trustStatus === "trusted"
                  ? "advisor.mcp.trust.trusted"
                  : client.trustStatus === "action_required"
                    ? "advisor.mcp.trust.actionRequired"
                    : client.trustStatus === "needs_confirmation"
                      ? "advisor.mcp.trust.needsConfirmation"
                      : client.trustStatus === "auto_enabled"
                        ? "advisor.mcp.trust.autoEnabled"
                        : "advisor.mcp.trust.notMounted";
              const note = t(`advisor.mcp.note.${client.clientId}` as TKey);

              return (
                <label
                  key={client.clientId}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1.5 rounded-control bg-raised p-3 ring-1 transition-colors",
                    checked ? "ring-accent/45" : "ring-line",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="checkbox"
                      className="advisor-consent-check size-4 shrink-0 cursor-pointer"
                      checked={checked}
                      disabled={disabled}
                      onChange={event => toggleClient(client.clientId, event.target.checked)}
                    />
                    <span className="text-[13px] font-semibold text-fg">{client.label}</span>
                    {client.routed && (
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-line">
                        {t("advisor.mcp.badgeRouted")}
                      </span>
                    )}
                    {client.detected && (
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-line">
                        {t("advisor.mcp.badgeDetected")}
                      </span>
                    )}
                    {client.mounted && (
                      <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
                        {t("advisor.mcp.badgeMounted")}
                      </span>
                    )}
                    {(client.hooksMounted || client.skillMounted) && (
                      <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-line">
                        {t("advisor.mcp.badgeHookSkill")}
                      </span>
                    )}
                    <span className={cn("ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold", trustBadgeClass(client.trustStatus))}>
                      {t(trustLabelKey)}
                    </span>
                  </div>
                  {client.configPath && (
                    <code className="mono break-all pl-6 text-[11px] text-fg-muted">{client.configPath}</code>
                  )}
                  <span
                    className={cn(
                      "pl-6 text-[12px] leading-[17px]",
                      client.trustStatus === "action_required" ? "font-medium text-warning" : "text-fg-muted",
                    )}
                  >
                    {note}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
