import { useMemo, useState, type ReactNode } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonOrThrow } from "../fetch-json";
import { IconCheck, IconLink, IconMonitor, IconPlus, IconRefresh, IconTerminal, IconTrash } from "../icons";
import { useT } from "../i18n/shared";
import { Select } from "../ui";
import { Button } from "@/components/ui-v2/button";
import { cn } from "@/lib/utils";
import { Banner, IconButton, PageHeader, Panel } from "../components/v2-startup/primitives";
import { confirmAction } from "../action-dialogs";
import { remoteWorkspacePairingCommands } from "../remote-workspace-command";
import { RemoteWorkspaceChats } from "../components/remote-workspace/RemoteWorkspaceChats";
import { PROFILES, PROFILE_LABEL, type RuntimeProfile, type RemoteAccessMode, type RemoteSession, type RemoteWorkspaceState, type RemoteDevice, type PairingGrant } from "../components/remote-workspace/types";

function isRuntimeProfile(value: string): value is RuntimeProfile {
  return value === "codex" || value === "claude" || value === "pi";
}

function isRemoteAccessMode(value: string): value is RemoteAccessMode {
  return value === "read-only" || value === "workspace";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A labelled field of the new-session form. */
function field(label: string, control: ReactNode) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5"><span className="text-[12px] leading-4 font-medium text-fg-muted">{label}</span>{control}</label>
  );
}

export default function RemoteWorkspace({ apiBase, hubOrigin }: { apiBase: string; hubOrigin: string }) {
  const t = useT();
  const resource = useKeyedClientResource(
    `remote-workspace:${apiBase}`,
    [apiBase],
    async signal => {
      const response = await fetch(`${apiBase}/api/remote-workspace`, { signal, cache: "no-store" });
      return await readJsonOrThrow<RemoteWorkspaceState>(response, t("remote.loadFailed"));
    },
    { pollMs: 3_000, deadlineMs: 10_000 },
  );
  const state = resource.data;
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [selectedRootId, setSelectedRootId] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<RuntimeProfile>("codex");
  const [selectedAccessMode, setSelectedAccessMode] = useState<RemoteAccessMode>("read-only");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [localSession, setLocalSession] = useState<RemoteSession | null>(null);
  const [pairing, setPairing] = useState<PairingGrant | null>(null);
  const [busy, setBusy] = useState<"pair" | "session" | "revoke" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<"posix" | "powershell" | null>(null);

  const devices = state?.devices ?? [];
  const effectiveDevice = devices.find(device => device.id === selectedDeviceId)
    ?? devices.find(device => device.online)
    ?? devices[0]
    ?? null;
  const effectiveRoot = effectiveDevice?.roots.find(root => root.id === selectedRootId)
    ?? effectiveDevice?.roots[0]
    ?? null;
  const selectedCanExecute = selectedAccessMode === "workspace"
    && (effectiveDevice?.capabilities.includes("workspace.exec") ?? false);
  const workspaceAccessLabel = effectiveDevice && !effectiveDevice.capabilities.includes("workspace.exec")
    ? t("remote.access.workspaceFilesOnly")
    : t("remote.access.workspace");
  const availableProfiles = PROFILES.filter(profile => state?.runtimes?.[profile]?.available);
  const effectiveProfile = availableProfiles.includes(selectedProfile)
    ? selectedProfile
    : availableProfiles[0] ?? selectedProfile;
  const remoteSessions = state?.sessions ?? [];
  const sessions = localSession && !remoteSessions.some(session => session.id === localSession.id)
    ? [...remoteSessions, localSession] : remoteSessions;
  if (localSession && state?.sessions.some(session => session.id === localSession.id)) setLocalSession(null);
  const stale = Boolean(state && !resource.lastAttemptOk);

  const pairingCommands = useMemo(() => {
    if (!pairing) return { posix: "", powershell: "" };
    return remoteWorkspacePairingCommands(pairing.code, hubOrigin);
  }, [pairing, hubOrigin]);

  const mutate = async <T,>(path: string, init: RequestInit, fallback: string): Promise<T> => {
    const response = await fetch(`${apiBase}${path}`, init);
    const body = await readJsonOrThrow<T>(response, fallback);
    if (body === undefined) throw new Error(fallback);
    return body;
  };

  const createPairing = async () => {
    setBusy("pair");
    setNotice(null);
    try {
      const grant = await mutate<PairingGrant>("/api/remote-workspace/pairing", { method: "POST" }, t("remote.requestFailed"));
      setPairing(grant);
      setCopiedCommand(null);
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : t("remote.requestFailed") });
    } finally { setBusy(null); }
  };

  const createSession = async () => {
    if (!effectiveDevice || !effectiveRoot) return;
    setBusy("session");
    setNotice(null);
    try {
      const session = await mutate<RemoteSession>("/api/remote-workspace/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: effectiveProfile,
          deviceId: effectiveDevice.id,
          rootId: effectiveRoot.id,
          accessMode: selectedAccessMode,
        }),
      }, t("remote.requestFailed"));
      setLocalSession(session);
      setSelectedSessionId(session.id);
      setNotice({ tone: "ok", text: t("remote.sessionStarted") });
      void resource.refresh();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : t("remote.requestFailed") });
    } finally { setBusy(null); }
  };

  const revokeDevice = async (device: RemoteDevice) => {
    if (!(await confirmAction({ message: t("remote.revokeConfirm", { name: device.name }), confirmLabel: t("common.remove"), tone: "danger" }))) return;
    setBusy("revoke");
    try {
      await mutate(`/api/remote-workspace/devices/${device.id}`, { method: "DELETE" }, t("remote.requestFailed"));
      if (selectedDeviceId === device.id) setSelectedDeviceId("");
      void resource.refresh();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : t("remote.requestFailed") });
    } finally { setBusy(null); }
  };

  const copyPairingCommand = async (kind: "posix" | "powershell", command: string) => {
    setCopiedCommand(await copyText(command) ? kind : null);
  };

  if (!state && !resource.error) return <Banner tone="info">{t("remote.loading")}</Banner>;
  if (resource.error && !state) {
    return <Banner tone="err" action={<Button variant="outline" size="sm" onClick={() => void resource.refresh()}>{t("common.retry")}</Button>}>{t("remote.loadFailed")}</Banner>;
  }
  if (state?.available === false) return <Banner tone="err">{t("remote.hubRequired")}</Banner>;

  return (
    <section className="remote-workspace-page flex min-w-0 flex-col gap-5 font-sans text-fg">
      <PageHeader title={t("remote.title")} subtitle={t("remote.subtitle")} actions={(
        <Button variant="ghost" size="sm" onClick={() => void resource.refresh()} disabled={resource.refreshing}><IconRefresh /> {t("remote.refresh")}</Button>
      )} />

      {stale ? <Banner tone="err">{t("remote.loadFailed")}</Banner> : null}
      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.3fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel icon={<IconLink />} title={t("remote.addComputer")} description={t("remote.addComputerHint")}>
            <div className="flex flex-col gap-4 p-4">
            <Button variant="outline" className="self-start" onClick={() => void createPairing()} disabled={busy !== null}><IconPlus /> {t("remote.createPairing")}</Button>
            {pairing ? (
              <div className="remote-pairing-result flex flex-col gap-3 border-t border-line pt-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-fg-muted">{t("remote.pairingCode")}</span>
                  <span className="font-mono text-[24px] leading-8 font-semibold tracking-[0.1em] text-fg">{pairing.code}</span>
                  <span className="text-[12px] text-fg-subtle">{t("remote.pairingExpires", { time: new Date(pairing.expiresAt).toLocaleTimeString() })}</span>
                </div>
                {([["posix", t("remote.pairingCommandPosix"), pairingCommands.posix], ["powershell", t("remote.pairingCommandWindows"), pairingCommands.powershell]] as const).map(([kind, label, command]) => (
                  <div key={kind} className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-[12px] font-medium text-fg-muted">{label}</span>
                    <div className="flex min-w-0 items-start gap-1 rounded-[8px] bg-surface py-1 pr-1 pl-3 ring-1 ring-line">
                      <pre className="m-0 min-w-0 flex-1 py-1.5 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"><code>{command}</code></pre>
                      <Button variant="ghost" size="sm" onClick={() => void copyPairingCommand(kind, command)}>
                        {copiedCommand === kind ? t("remote.copied") : t("remote.copyCommand")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            </div>
          </Panel>

          <Panel title={t("remote.devices")} meta={devices.length}>
            {devices.length === 0 ? <p className="m-0 px-4 py-6 text-center text-[13px] text-fg-muted">{t("remote.noDevices")}</p> : (
              <ul className="m-0 flex list-none flex-col gap-1 p-1">
                {devices.map(device => {
                  const selected = effectiveDevice?.id === device.id;
                  return (
                    <li key={device.id} className={cn("remote-device flex min-w-0 items-center gap-1 rounded-[8px] pr-1 transition-colors hover:bg-surface", selected && "bg-surface ring-1 ring-line-strong")}>
                      <button type="button" aria-pressed={selected}
                        onClick={() => { setSelectedDeviceId(device.id); setSelectedRootId(device.roots[0]?.id ?? ""); }}
                        className="ui-v2 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-highlight">
                        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", device.online ? "bg-success" : "bg-fg-subtle")} />
                        <span className="flex min-w-0 flex-col">
                          <strong className="truncate text-[14px] font-semibold">{device.name}</strong>
                          <small className="truncate text-[12px] text-fg-muted">{device.platform} · {device.online ? t("remote.online") : t("remote.offline")} · {device.capabilities.includes("workspace.exec") ? t("remote.capability.full") : t("remote.capability.files")}</small>
                        </span>
                        {selected && <span aria-hidden="true" className="ml-auto text-fg [&_svg]:size-4"><IconCheck /></span>}
                      </button>
                      <IconButton label={t("remote.revoke")} tone="danger" disabled={busy !== null} onClick={() => void revokeDevice(device)}><IconTrash /></IconButton>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <Panel icon={<IconMonitor />} title={t("remote.newSession")}>
          <div className="flex flex-col gap-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {field(t("remote.device"), <Select fullWidth value={effectiveDevice?.id ?? ""} options={devices.map(device => ({ value: device.id, label: device.name }))} onChange={value => { setSelectedDeviceId(value); setSelectedRootId(devices.find(device => device.id === value)?.roots[0]?.id ?? ""); }} label={t("remote.device")} disabled={devices.length === 0} />)}
              {field(t("remote.folder"), <Select fullWidth value={effectiveRoot?.id ?? ""} options={(effectiveDevice?.roots ?? []).map(root => ({ value: root.id, label: root.label }))} onChange={setSelectedRootId} label={t("remote.folder")} disabled={!effectiveDevice} />)}
              {field(t("remote.runtime"), <Select fullWidth value={effectiveProfile} options={PROFILES.map(profile => ({ value: profile, label: state?.runtimes?.[profile]?.available ? PROFILE_LABEL[profile] : `${PROFILE_LABEL[profile]} · ${t("remote.unavailable")}` }))} onChange={value => { if (isRuntimeProfile(value)) setSelectedProfile(value); }} label={t("remote.runtime")} />)}
              {field(t("remote.access"), <Select fullWidth value={selectedAccessMode} options={[{ value: "read-only", label: t("remote.access.readOnly") }, { value: "workspace", label: workspaceAccessLabel }]} onChange={value => { if (isRemoteAccessMode(value)) setSelectedAccessMode(value); }} label={t("remote.access")} />)}
            </div>
            {effectiveDevice ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {([[PROFILE_LABEL[effectiveProfile], t("remote.runsOnHub")], [effectiveDevice.name, selectedAccessMode === "read-only" ? t("remote.runsReadOnly") : selectedCanExecute ? t("remote.runsFilesCommands") : t("remote.runsFilesOnly")]] as const).map(([name, where]) => (
                  <span key={where} className="flex min-w-0 flex-col gap-0.5 rounded-[8px] bg-surface px-3 py-2.5 text-[12px] text-fg-muted ring-1 ring-line">
                    <strong className="truncate text-[13px] font-semibold text-fg">{name}</strong>{where}
                  </span>
                ))}
              </div>
            ) : null}
            {selectedAccessMode === "workspace" && !selectedCanExecute && effectiveDevice ? <Banner tone="err">{t("remote.execUnavailable")}</Banner> : null}
            {!state?.runtimes?.[effectiveProfile]?.available && state?.runtimes?.[effectiveProfile]?.reason
              ? <p className="m-0 text-[12px] leading-[18px] text-danger">{state.runtimes[effectiveProfile].reason}</p>
              : null}
            <Button variant="primary" className="w-full" onClick={() => void createSession()} disabled={!effectiveDevice?.online || !effectiveRoot || !state?.runtimes?.[effectiveProfile]?.available || busy !== null}>
              <IconTerminal /> {t("remote.startSession")}
            </Button>
          </div>
        </Panel>
      </div>
      <RemoteWorkspaceChats key={apiBase} apiBase={apiBase} sessions={sessions} devices={devices} selectedSessionId={selectedSessionId} stale={stale} refresh={resource.refresh} />
    </section>
  );
}
