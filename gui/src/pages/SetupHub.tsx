import { useKeyedClientResource } from "../client-resource";
import { useT } from "../i18n/shared";
import type { Page } from "../app-routing";
import { IconCodex, IconKey, IconLink, IconMonitor, IconPower, IconServer } from "../icons";
import { HubCard, type HubBadge } from "@/components/ui-v2/hub-card";

/*
 * The "Set up" tier: everything people do once, in the order they do it. Each card opens
 * the existing page that owns the job, so no setup flow is duplicated here — this page is
 * the map and the progress, the pages stay the source of truth.
 */

interface SetupHubProps {
  apiBase: string;
  navigate: (page: Page, subPath?: string) => void;
}

interface ConfigBody { providers?: Record<string, unknown> }
interface UsageBody { summary?: { requests?: number } }
interface StartupBody { protection?: string; serviceInstalled?: boolean; shimInstalled?: boolean }

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const res = await fetch(url, { signal });
  return res.ok ? ((await res.json()) as T) : null;
}

export default function SetupHub({ apiBase, navigate }: SetupHubProps) {
  const t = useT();
  const config = useKeyedClientResource(`home-config:${apiBase}`, [apiBase],
    signal => getJson<ConfigBody>(`${apiBase}/api/config`, signal));
  const usage = useKeyedClientResource(`setup-usage:${apiBase}`, [apiBase],
    signal => getJson<UsageBody>(`${apiBase}/api/usage?range=all`, signal));
  const startup = useKeyedClientResource(`home-startup:${apiBase}`, [apiBase],
    signal => getJson<StartupBody>(`${apiBase}/api/startup-health`, signal));

  const done = { label: t("shellV2.badgeDone"), tone: "done" } satisfies HubBadge;
  const todo = { label: t("shellV2.badgeTodo"), tone: "todo" } satisfies HubBadge;
  const optional = { label: t("shellV2.badgeOptional"), tone: "optional" } satisfies HubBadge;
  const state = (value: boolean | undefined) => (value === undefined ? undefined : value ? done : todo);

  const providers = config.data ? Object.keys(config.data.providers ?? {}).length > 0 : undefined;
  const requested = usage.data ? (usage.data.summary?.requests ?? 0) > 0 : undefined;
  const protectedStart = startup.data
    ? startup.data.protection !== "none" || Boolean(startup.data.serviceInstalled || startup.data.shimInstalled)
    : undefined;

  const open = t("shellV2.stepOpen");
  return (
    <div className="ui-v2 flex flex-col gap-6 font-sans text-fg">
      <header className="flex max-w-[640px] flex-col gap-2">
        <h1 className="m-0 text-[26px] leading-tight font-semibold tracking-[-0.025em]">{t("shellV2.setupTitle")}</h1>
        <p className="m-0 text-[15px] text-fg-muted">{t("shellV2.setupIntro")}</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <HubCard icon={<IconServer />} title={t("shellV2.stepProvider")} body={t("shellV2.stepProviderHint")}
          badge={state(providers)} onOpen={() => navigate("providers")} openLabel={open} />
        <HubCard icon={<IconLink />} title={t("shellV2.setupApps")} body={t("shellV2.setupAppsHint")}
          badge={state(requested)} onOpen={() => navigate("integrations")} openLabel={open} />
        <HubCard icon={<IconCodex />} title={t("shellV2.stepFirstRequest")} body={t("shellV2.stepFirstRequestHint")}
          badge={state(requested)} onOpen={() => navigate("providers")} openLabel={open} />
        <HubCard icon={<IconPower />} title={t("shellV2.stepAutostart")} body={t("shellV2.stepAutostartHint")}
          badge={state(protectedStart)} onOpen={() => navigate("startup")} openLabel={open} />
        <HubCard icon={<IconKey />} title={t("shellV2.setupApiKeys")} body={t("shellV2.setupApiKeysHint")}
          badge={optional} onOpen={() => navigate("integrations", "keys")} openLabel={open} />
        <HubCard icon={<IconMonitor />} title={t("shellV2.setupRemote")} body={t("shellV2.setupRemoteHint")}
          badge={optional} onOpen={() => navigate("remote")} openLabel={open} />
      </div>
    </div>
  );
}
