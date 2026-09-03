import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { navigateHash, normalizeHashPath } from "../hash-routing";
import { useT } from "../i18n/shared";
import { useDataSurface } from "../data-surface";
import ClientMark from "../components/ClientMark";
import { INTEGRATION_MARKS } from "../components/integration-marks";
import ApiKeys from "./ApiKeys";
import Claude from "./Claude";
import Grok from "./Grok";
import CursorIntegrationPage from "./integrations/CursorIntegrationPage";
import IntegrationsOverview from "./integrations/IntegrationsOverview";
import FileIntegrationPage, {
  type FileIntegrationClientId,
} from "./integrations/FileIntegrationPage";
import { FILE_CLIENTS, TABS, type IntegrationTab } from "./integrations/integration-tabs";
import { loadIntegrationStates, type IntegrationStatus } from "./integrations/integration-api";

function readIntegrationTab(hash = window.location.hash): IntegrationTab {
  const raw = normalizeHashPath(hash);
  if (raw === "integrations/claude/desktop") return "claude";
  const match = TABS.find(tab => tab.hash === raw);
  return match?.id ?? "overview";
}

function tabDomId(tab: IntegrationTab): string {
  return `integrations-tab-${tab}`;
}

function panelDomId(tab: IntegrationTab): string {
  return `integrations-panel-${tab}`;
}

/*
 * The strip carries 18 tabs on one row, which is precisely where a mark earns
 * its place: the eye finds a logo faster than it reads the tenth label. Two
 * tabs have no client behind them -- `overview` is the page itself and `keys`
 * is a credential surface, not an integration -- so they stay text-only rather
 * than borrowing a mark that would imply a client.
 */
function tabMark(tab: IntegrationTab): string | null {
  if (tab === "overview" || tab === "keys") return null;
  return INTEGRATION_MARKS[tab] ?? null;
}

export default function Integrations({ apiBase, machineApiBase = apiBase, connected = false }: { apiBase: string; machineApiBase?: string; connected?: boolean }) {
  const t = useT();
  const [tab, setTab] = useState<IntegrationTab>(readIntegrationTab);
  /*
   * Panels mount lazily and then STAY mounted, hidden, so a half-typed key or
   * an unsaved Grok selection survives a tab hop. Each mounted panel is gated
   * by `active`, which is what stops a hidden one from polling.
   */
  const [mounted, setMounted] = useState<ReadonlySet<IntegrationTab>>(
    () => new Set([readIntegrationTab()]),
  );
  const tabRefs = useRef<Map<IntegrationTab, HTMLButtonElement> | null>(null);
  const [machineClients, setMachineClients] = useState<string[]>([]);
  const [machineSyncing, setMachineSyncing] = useState(false);
  if (tabRefs.current === null) tabRefs.current = new Map();

  /*
   * Eighteen tabs, most of them clients that are not installed on this machine, is the
   * page's largest noise source. Tabs for uninstalled file clients hide behind one
   * "more" button; everything the operator can actually act on stays in the strip.
   * The state comes from the same keyed resource the overview reads, so this is not a
   * second fetch. Until it settles every tab is primary — a strip must never flash-hide.
   */
  const fetchStates = useCallback(
    async (signal: AbortSignal) => (await loadIntegrationStates(apiBase, signal)).clients,
    [apiBase],
  );
  const statesResource = useDataSurface<IntegrationStatus[]>(
    `integration-states:${apiBase}`,
    [apiBase],
    fetchStates,
    { isEmpty: rows => rows.length === 0, sessionCacheKey: `ocx.integrations.states.v1:${apiBase}` },
  );
  const statesSettled = statesResource.state.kind !== "cold" && statesResource.state.kind !== "retrying-cold";
  const installedFileClients = new Set((statesResource.state.data ?? []).filter(c => c.installed).map(c => c.clientId));
  const isSecondary = (id: IntegrationTab) =>
    statesSettled && FILE_CLIENTS.has(id as FileIntegrationClientId) && !installedFileClients.has(id as FileIntegrationClientId);
  const secondaryCount = TABS.filter(d => isSecondary(d.id)).length;
  const [moreOpen, setMoreOpen] = useState(false);
  const tablistId = useId();
  // The selected tab can never be hidden: a deep link to an uninstalled client opens the
  // overflow, and the button is disabled while such a tab is selected.
  const selectedIsSecondary = isSecondary(tab);
  const showSecondary = moreOpen || selectedIsSecondary;

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    void fetch(`${machineApiBase}/api/machine/clients`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then((value: { selectedClients?: unknown } | null) => {
        if (!controller.signal.aborted && Array.isArray(value?.selectedClients)) {
          setMachineClients(value.selectedClients.filter((item): item is string => typeof item === "string"));
        }
      }).catch(() => {});
    return () => controller.abort();
  }, [connected, machineApiBase]);

  const syncMachine = async () => {
    setMachineSyncing(true);
    try {
      await fetch(`${machineApiBase}/api/machine/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } finally { setMachineSyncing(false); }
  };

  /*
   * Every tab change goes through here, whether it came from a click or from
   * the browser's own history. Accumulating the mounted set in an effect
   * instead would run a second render pass after every switch for a value
   * both callers already know.
   */
  const activateTab = (next: IntegrationTab) => {
    setTab(next);
    setMounted(current => (current.has(next) ? current : new Set([...current, next])));
  };

  useEffect(() => {
    const syncFromHash = () => activateTab(readIntegrationTab());
    window.addEventListener("hashchange", syncFromHash);
    window.addEventListener("popstate", syncFromHash);
    return () => {
      window.removeEventListener("hashchange", syncFromHash);
      window.removeEventListener("popstate", syncFromHash);
    };
  }, []);

  const selectTab = (next: IntegrationTab, moveFocus: boolean) => {
    const definition = TABS.find(candidate => candidate.id === next);
    if (!definition) return;
    navigateHash(definition.hash);
    activateTab(next);
    if (moveFocus) {
      window.requestAnimationFrame(() => {
        tabRefs.current!.get(next)?.focus({ preventScroll: true });
      });
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex(candidate => candidate.id === tab);
    // Arrows walk the VISIBLE tabs only; a hidden tab is not a stop.
    const visible = TABS.map((d, i) => ({ d, i })).filter(({ d }) => showSecondary || !isSecondary(d.id));
    const pos = visible.findIndex(({ i }) => i === index);
    let nextPos: number | null = null;
    if (event.key === "ArrowLeft") nextPos = (pos - 1 + visible.length) % visible.length;
    else if (event.key === "ArrowRight") nextPos = (pos + 1) % visible.length;
    else if (event.key === "Home") nextPos = 0;
    else if (event.key === "End") nextPos = visible.length - 1;
    if (nextPos === null) return;
    const nextIndex = visible[nextPos]!.i;
    event.preventDefault();
    selectTab(TABS[nextIndex].id, true);
  };

  return (
    <section className="integrations-page">
      <div className="page-head">
        <h2>{t("nav.integrations")}</h2>
      </div>
      {connected && (
        <section className="notice" aria-label={t("connection.clients.title")}>
          <strong>{t("connection.clients.title")}</strong>
          <span>{machineClients.length > 0 ? machineClients.join(", ") : t("connection.clients.none")}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={machineSyncing} onClick={() => void syncMachine()}>{t(machineSyncing ? "connection.clients.syncing" : "connection.clients.sync")}</button>
        </section>
      )}

      <div className="page-tabs" role="tablist" aria-label={t("integrations.tabsLabel")} id={tablistId}>
        {TABS.map(definition => (
          <button
            key={definition.id}
            ref={node => {
              if (node) tabRefs.current!.set(definition.id, node);
              else tabRefs.current!.delete(definition.id);
            }}
            type="button"
            role="tab"
            id={tabDomId(definition.id)}
            aria-selected={tab === definition.id}
            aria-controls={panelDomId(definition.id)}
            tabIndex={tab === definition.id ? 0 : -1}
            className={`page-tab${tab === definition.id ? " page-tab--active" : ""}`}
            hidden={!showSecondary && isSecondary(definition.id)}
            onClick={() => selectTab(definition.id, true)}
            onKeyDown={handleTabKeyDown}
          >
            {tabMark(definition.id) && (
              <ClientMark src={tabMark(definition.id)} label={t(definition.labelKey)} size={14} />
            )}
            {t(definition.labelKey)}
          </button>
        ))}
      </div>
      {secondaryCount > 0 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm page-tabs-more"
          aria-expanded={showSecondary}
          aria-controls={tablistId}
          disabled={selectedIsSecondary}
          onClick={() => setMoreOpen(open => !open)}
        >
          {t(showSecondary ? "integrations.fewerClients" : "integrations.moreClients", { count: secondaryCount })}
        </button>
      )}

      {TABS.map(definition => {
        if (!mounted.has(definition.id)) return null;
        const active = tab === definition.id;
        return (
          <div
            key={definition.id}
            role="tabpanel"
            id={panelDomId(definition.id)}
            aria-labelledby={tabDomId(definition.id)}
            hidden={!active}
          >
            {definition.id === "overview" && (
              <IntegrationsOverview apiBase={apiBase} active={active} statesResource={statesResource} />
            )}
            {definition.id === "keys" && <ApiKeys apiBase={apiBase} active={active} />}
            {definition.id === "codex" && (
              <section className="integration-native-page" aria-labelledby="codex-integration-title">
                <h3 id="codex-integration-title">{t("integrations.codex.title")}</h3>
                <p>{t("integrations.codex.body")}</p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => navigateHash("startup")}
                >
                  {t("integrations.codex.openService")}
                </button>
              </section>
            )}
            {definition.id === "claude" && <Claude apiBase={apiBase} active={active} />}
            {definition.id === "grok" && <Grok apiBase={apiBase} active={active} />}
            {definition.id === "cursor" && <CursorIntegrationPage apiBase={apiBase} active={active} />}
            {FILE_CLIENTS.has(definition.id as FileIntegrationClientId) && (
              <FileIntegrationPage
                apiBase={apiBase}
                client={definition.id as FileIntegrationClientId}
                active={active}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}
