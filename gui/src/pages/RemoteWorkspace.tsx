import { useMemo, useRef, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonOrThrow } from "../fetch-json";
import { IconLink, IconMonitor, IconPlus, IconRefresh, IconTerminal, IconTrash } from "../icons";
import { type TKey, useT } from "../i18n/shared";
import { Notice, Select } from "../ui";
import { remoteWorkspacePairingCommands } from "../remote-workspace-command";

type RuntimeProfile = "codex" | "claude" | "pi";
type RemoteCapability = "workspace.read" | "workspace.write" | "workspace.exec";
type RemoteAccessMode = "read-only" | "workspace";
type SessionStatus = "starting" | "ready" | "running" | "waiting_for_executor" | "failed" | "stopped";

interface RemoteRoot { id: string; label: string }
interface RemoteDevice {
  id: string;
  name: string;
  platform: string;
  capabilities: RemoteCapability[];
  roots: RemoteRoot[];
  online: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}
interface RuntimeAvailability { available: boolean; version?: string; reason?: string }
interface SessionEvent { sequence: number; at: string; type: "status" | "assistant" | "tool" | "error"; text: string }
interface RemoteSession {
  id: string;
  profile: RuntimeProfile;
  accessMode: RemoteAccessMode;
  deviceId: string;
  deviceName: string;
  rootId: string;
  rootLabel: string;
  capabilities: RemoteCapability[];
  tools: string[];
  threadId: string | null;
  resumable: boolean;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  events: SessionEvent[];
}
interface RemoteWorkspaceState {
  available: boolean;
  reason?: string;
  devices: RemoteDevice[];
  runtimes: Record<RuntimeProfile, RuntimeAvailability>;
  sessions: RemoteSession[];
}
interface PairingGrant { code: string; expiresAt: string }

const PROFILES: RuntimeProfile[] = ["codex", "claude", "pi"];
const PROFILE_LABEL: Record<RuntimeProfile, string> = { codex: "Codex", claude: "Claude Code", pi: "Pi" };
const STATUS_TKEY: Record<SessionStatus, TKey> = {
  starting: "remote.status.starting",
  ready: "remote.status.ready",
  running: "remote.status.running",
  waiting_for_executor: "remote.status.waiting",
  failed: "remote.status.failed",
  stopped: "remote.status.stopped",
};
const EVENT_TKEY: Record<Exclude<SessionEvent["type"], "assistant">, TKey> = {
  status: "remote.event.status",
  tool: "remote.event.tool",
  error: "remote.event.error",
};

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

export default function RemoteWorkspace({ apiBase }: { apiBase: string }) {
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
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"pair" | "session" | "revoke" | null>(null);
  const [promptPending, setPromptPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const stoppedSessionId = useRef<string | null>(null);
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
  const effectiveSession = remoteSessions.find(session => session.id === selectedSessionId)
    ?? (localSession && localSession.id === selectedSessionId ? localSession : null)
    ?? [...remoteSessions].reverse().find(session => session.status !== "stopped")
    ?? localSession;

  const pairingCommands = useMemo(() => {
    if (!pairing) return { posix: "", powershell: "" };
    const hub = typeof window === "undefined" ? "https://hub.example" : window.location.origin;
    return remoteWorkspacePairingCommands(pairing.code, hub);
  }, [pairing]);

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

  const sendPrompt = async () => {
    if (!effectiveSession || !prompt.trim() || promptPending || stopPending || busy !== null) return;
    const target = effectiveSession;
    const submitted = prompt;
    setPrompt("");
    setPromptPending(true);
    setNotice(null);
    try {
      const session = await mutate<RemoteSession>(`/api/remote-workspace/sessions/${target.id}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: submitted }),
      }, t("remote.requestFailed"));
      if (stoppedSessionId.current !== target.id) setLocalSession(session);
      void resource.refresh();
    } catch (error) {
      if (stoppedSessionId.current !== target.id) {
        setPrompt(submitted);
        setNotice({ tone: "err", text: error instanceof Error ? error.message : t("remote.requestFailed") });
      }
    } finally { setPromptPending(false); }
  };

  const stopSession = async () => {
    if (!effectiveSession || stopPending || busy !== null) return;
    const target = effectiveSession;
    setStopPending(true);
    try {
      await mutate(`/api/remote-workspace/sessions/${target.id}`, { method: "DELETE" }, t("remote.requestFailed"));
      stoppedSessionId.current = target.id;
      setLocalSession({ ...target, status: "stopped" });
      void resource.refresh();
    } catch (error) {
      setNotice({ tone: "err", text: error instanceof Error ? error.message : t("remote.requestFailed") });
    } finally { setStopPending(false); }
  };

  const revokeDevice = async (device: RemoteDevice) => {
    if (!confirm(t("remote.revokeConfirm", { name: device.name }))) return;
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

  if (resource.loading && !state) return <div className="alert">{t("remote.loading")}</div>;
  if (resource.error && !state) {
    return <><Notice tone="err">{t("remote.loadFailed")}</Notice><button type="button" className="btn btn-ghost" onClick={() => void resource.refresh()}>{t("common.retry")}</button></>;
  }
  if (state?.available === false) return <Notice tone="err">{state.reason ?? t("remote.hubRequired")}</Notice>;

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
                      disabled={busy !== null || promptPending || stopPending}
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
            <button type="button" className="btn btn-primary remote-start" onClick={() => void createSession()} disabled={!effectiveDevice?.online || !effectiveRoot || !state?.runtimes?.[effectiveProfile]?.available || busy !== null || promptPending || stopPending}>
              <IconTerminal /> {t("remote.startSession")}
            </button>
          </section>

          <section className="panel remote-console-panel">
            <div className="remote-section-title">
              <div><h3>{t("remote.sessions")}</h3>{effectiveSession ? <small>{PROFILE_LABEL[effectiveSession.profile]} · {effectiveSession.deviceName}/{effectiveSession.rootLabel} · {effectiveSession.accessMode === "read-only" ? t("remote.access.readOnly") : t("remote.access.workspace")}</small> : null}</div>
              {effectiveSession ? <span className={`remote-status remote-status--${effectiveSession.status}`}>{t(STATUS_TKEY[effectiveSession.status])}</span> : null}
            </div>
            {remoteSessions.length > 1 ? (
              <Select value={effectiveSession?.id ?? ""} options={remoteSessions.map(session => ({ value: session.id, label: `${PROFILE_LABEL[session.profile]} · ${session.deviceName}/${session.rootLabel}` }))} onChange={setSelectedSessionId} label={t("remote.sessions")} />
            ) : null}
            {!effectiveSession ? <p className="remote-empty remote-empty--console">{t("remote.noSessions")}</p> : (
              <>
                <div className="remote-events" aria-live="polite" aria-label={t("remote.events")}>
                  {effectiveSession.events.length === 0 ? <p className="remote-empty">{t("remote.noEvents")}</p> : effectiveSession.events.map(event => (
                    <div key={event.sequence} className={`remote-event remote-event--${event.type}`}>
                      <span>{event.type === "assistant" ? PROFILE_LABEL[effectiveSession.profile] : t(EVENT_TKEY[event.type])}</span>
                      <p>{event.text}</p>
                    </div>
                  ))}
                </div>
                {effectiveSession.status === "failed" && effectiveSession.resumable === false
                  ? <Notice tone="err">{t("remote.notResumable")}</Notice>
                  : null}
                <label className="remote-composer">
                  <span className="field-label">{t("remote.prompt")}</span>
                  <textarea className="input" rows={4} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t("remote.promptPlaceholder")} disabled={effectiveSession.status === "stopped" || (effectiveSession.status === "failed" && effectiveSession.resumable === false)} onKeyDown={event => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void sendPrompt(); }
                  }} />
                </label>
                <div className="remote-console-actions">
                  <button type="button" className="btn btn-primary" onClick={() => void sendPrompt()} disabled={!prompt.trim() || busy !== null || promptPending || stopPending || effectiveSession.status === "running" || effectiveSession.status === "stopped" || (effectiveSession.status === "failed" && effectiveSession.resumable === false) || (effectiveSession.status === "waiting_for_executor" && !devices.find(device => device.id === effectiveSession.deviceId)?.online)}>{t("remote.send")}</button>
                  <button type="button" className="btn btn-danger" onClick={() => void stopSession()} disabled={busy !== null || stopPending || effectiveSession.status === "stopped"}>{t("remote.stop")}</button>
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
