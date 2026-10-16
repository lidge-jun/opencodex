import { useMemo, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonOrThrow } from "../fetch-json";
import { IconLink, IconMonitor, IconPlus, IconRefresh, IconTerminal, IconTrash } from "../icons";
import { useT } from "../i18n/shared";
import { Notice, Select } from "../ui";
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

  if (!state && !resource.error) return <div className="alert">{t("remote.loading")}</div>;
  if (resource.error && !state) {
    return <><Notice tone="err">{t("remote.loadFailed")}</Notice><button type="button" className="btn btn-ghost" onClick={() => void resource.refresh()}>{t("common.retry")}</button></>;
  }
  if (state?.available === false) return <Notice tone="err">{t("remote.hubRequired")}</Notice>;

  return (
    <section className="remote-workspace-page">
      <div className="page-head">
        <div>
          <h2>{t("remote.title")}</h2>
          <p className="page-sub">{t("remote.subtitle")}</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void resource.refresh()} disabled={resource.refreshing}>
          <IconRefresh /> {t("remote.refresh")}
        </button>
      </div>

      {stale ? <Notice tone="err">{t("remote.loadFailed")}</Notice> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      <div className="remote-workspace-grid">
        <div className="remote-workspace-column">
          <article className="panel panel-accent remote-pair-card">
            <div className="remote-panel-head">
              <div className="remote-icon"><IconLink /></div>
              <div><h3>{t("remote.addComputer")}</h3><p>{t("remote.addComputerHint")}</p></div>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => void createPairing()} disabled={busy !== null}>
              <IconPlus /> {t("remote.createPairing")}
            </button>
            {pairing ? (
              <div className="remote-pairing-result">
                <span className="field-label">{t("remote.pairingCode")}</span>
                <div className="remote-pairing-code">{pairing.code}</div>
                <div className="remote-expiry">{t("remote.pairingExpires", { time: new Date(pairing.expiresAt).toLocaleTimeString() })}</div>
                <span className="field-label">{t("remote.pairingCommandPosix")}</span>
                <pre><code>{pairingCommands.posix}</code></pre>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyPairingCommand("posix", pairingCommands.posix)}>
                  {copiedCommand === "posix" ? t("remote.copied") : t("remote.copyCommand")}
                </button>
                <span className="field-label">{t("remote.pairingCommandWindows")}</span>
                <pre><code>{pairingCommands.powershell}</code></pre>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyPairingCommand("powershell", pairingCommands.powershell)}>
                  {copiedCommand === "powershell" ? t("remote.copied") : t("remote.copyCommand")}
                </button>
              </div>
            ) : null}
          </article>

          <section className="panel remote-device-panel">
            <div className="remote-section-title"><h3>{t("remote.devices")}</h3><span>{devices.length}</span></div>
            {devices.length === 0 ? <p className="remote-empty">{t("remote.noDevices")}</p> : (
              <div className="remote-device-list">
                {devices.map(device => (
                  <div
                    key={device.id}
                    className={`remote-device${effectiveDevice?.id === device.id ? " selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="remote-device-main"
                      onClick={() => { setSelectedDeviceId(device.id); setSelectedRootId(device.roots[0]?.id ?? ""); }}
                      aria-pressed={effectiveDevice?.id === device.id}
                    >
                      <span className={`remote-online-dot${device.online ? " online" : ""}`} />
                      <span className="remote-device-copy"><strong>{device.name}</strong><small>{device.platform} · {device.online ? t("remote.online") : t("remote.offline")} · {device.capabilities.includes("workspace.exec") ? t("remote.capability.full") : t("remote.capability.files")}</small></span>
                    </button>
                    <button
                      type="button"
                      className="remote-revoke"
                      aria-label={t("remote.revoke")}
                      disabled={busy !== null}
                      onClick={() => void revokeDevice(device)}
                    ><IconTrash /></button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="remote-workspace-column remote-session-column">
          <section className="panel remote-launch-panel">
            <div className="remote-section-title"><h3>{t("remote.newSession")}</h3><IconMonitor /></div>
            <div className="remote-launch-fields">
              <label><span className="field-label">{t("remote.device")}</span><Select value={effectiveDevice?.id ?? ""} options={devices.map(device => ({ value: device.id, label: device.name }))} onChange={value => { setSelectedDeviceId(value); setSelectedRootId(devices.find(device => device.id === value)?.roots[0]?.id ?? ""); }} label={t("remote.device")} disabled={devices.length === 0} /></label>
              <label><span className="field-label">{t("remote.folder")}</span><Select value={effectiveRoot?.id ?? ""} options={(effectiveDevice?.roots ?? []).map(root => ({ value: root.id, label: root.label }))} onChange={setSelectedRootId} label={t("remote.folder")} disabled={!effectiveDevice} /></label>
              <label><span className="field-label">{t("remote.runtime")}</span><Select value={effectiveProfile} options={PROFILES.map(profile => ({ value: profile, label: state?.runtimes?.[profile]?.available ? PROFILE_LABEL[profile] : `${PROFILE_LABEL[profile]} · ${t("remote.unavailable")}` }))} onChange={value => { if (isRuntimeProfile(value)) setSelectedProfile(value); }} label={t("remote.runtime")} /></label>
              <label><span className="field-label">{t("remote.access")}</span><Select value={selectedAccessMode} options={[{ value: "read-only", label: t("remote.access.readOnly") }, { value: "workspace", label: workspaceAccessLabel }]} onChange={value => { if (isRemoteAccessMode(value)) setSelectedAccessMode(value); }} label={t("remote.access")} /></label>
            </div>
            {effectiveDevice ? (
              <div className="remote-execution-map">
                <span><strong>{PROFILE_LABEL[effectiveProfile]}</strong>{t("remote.runsOnHub")}</span>
                <span><strong>{effectiveDevice.name}</strong>{selectedAccessMode === "read-only" ? t("remote.runsReadOnly") : selectedCanExecute ? t("remote.runsFilesCommands") : t("remote.runsFilesOnly")}</span>
              </div>
            ) : null}
            {selectedAccessMode === "workspace" && !selectedCanExecute && effectiveDevice ? <Notice tone="err">{t("remote.execUnavailable")}</Notice> : null}
            {!state?.runtimes?.[effectiveProfile]?.available && state?.runtimes?.[effectiveProfile]?.reason
              ? <p className="remote-runtime-reason">{state.runtimes[effectiveProfile].reason}</p>
              : null}
            <button type="button" className="btn btn-primary remote-start" onClick={() => void createSession()} disabled={!effectiveDevice?.online || !effectiveRoot || !state?.runtimes?.[effectiveProfile]?.available || busy !== null}>
              <IconTerminal /> {t("remote.startSession")}
            </button>
          </section>

        </div>
      </div>
      <RemoteWorkspaceChats key={apiBase} apiBase={apiBase} sessions={sessions} devices={devices} selectedSessionId={selectedSessionId} stale={stale} refresh={resource.refresh} />
    </section>
  );
}
