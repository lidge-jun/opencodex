import { useEffect, useMemo, useRef, useState } from "react";
import { IconDeviceDesktop, IconLoader2, IconLock, IconShield, IconTerminal2 } from "@tabler/icons-react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createTerminalSession, getWorkspace, type Workspace, type WorkspaceDevice } from "./api";
import {
  BrowserTerminalCipher,
  base64UrlDecode,
  base64UrlEncode,
  type CommandProfile,
  type RemoteVault,
} from "./e2ee";

const encoder = new TextEncoder();
const VAULT_HANDOFF_PREFIX = "#ocxr-vault=";
const VAULT_SESSION_KEY = "ocxr.remote.vault.v1";

function validVault(value: unknown): value is RemoteVault {
  if (!value || typeof value !== "object") return false;
  const vault = value as Partial<RemoteVault>;
  try {
    return vault.version === 1
      && typeof vault.vaultKey === "string"
      && base64UrlDecode(vault.vaultKey).length === 32
      && typeof vault.rootPrivateKeyPem === "string"
      && vault.rootPrivateKeyPem.includes("BEGIN PRIVATE KEY")
      && vault.rootPrivateKeyPem.length <= 2048;
  } catch {
    return false;
  }
}

export function vaultHandoff(vault: RemoteVault): string {
  return `${VAULT_HANDOFF_PREFIX}${base64UrlEncode(encoder.encode(JSON.stringify(vault)))}`;
}

function loadVault(): RemoteVault | null {
  try {
    if (window.location.hash.startsWith(VAULT_HANDOFF_PREFIX)) {
      const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(
        window.location.hash.slice(VAULT_HANDOFF_PREFIX.length),
      ))) as unknown;
      if (!validVault(parsed)) throw new Error("invalid vault handoff");
      window.sessionStorage.setItem(VAULT_SESSION_KEY, JSON.stringify(parsed));
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      return parsed;
    }
    const stored = window.sessionStorage.getItem(VAULT_SESSION_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as unknown;
    return validVault(parsed) ? parsed : null;
  } catch {
    window.sessionStorage.removeItem(VAULT_SESSION_KEY);
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return null;
  }
}

function appFrame(kind: number, body = new Uint8Array()): Uint8Array {
  const frame = new Uint8Array(1 + body.length);
  frame[0] = kind;
  frame.set(body, 1);
  return frame;
}

function TerminalPane({
  sessionId,
  websocketPath,
  profile,
  device,
  vault,
  close,
}: {
  sessionId: string;
  websocketPath: string;
  profile: CommandProfile;
  device: WorkspaceDevice;
  vault: RemoteVault;
  close: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 14,
      theme: { background: "#0c0d0f", foreground: "#ececef", cursor: "#79d49d" },
      scrollback: 5_000,
      cols: 80,
      rows: 24,
    });
    terminal.open(container.current);
    terminal.writeln(`\x1b[2mConnecting securely to ${device.name}…\x1b[0m`);
    const socketUrl = new URL(websocketPath, window.location.href);
    socketUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl);
    socket.binaryType = "arraybuffer";
    let cipher: BrowserTerminalCipher | null = null;
    let disposed = false;
    let sendQueue = Promise.resolve();
    let receiveQueue = Promise.resolve();

    function encryptedSend(plaintext: Uint8Array) {
      sendQueue = sendQueue.then(async () => {
        if (!cipher || socket.readyState !== WebSocket.OPEN) return;
        socket.send(await cipher.encrypt(plaintext));
      }).catch(error => terminal.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : "Secure send failed"}\x1b[0m`));
    }

    const input = terminal.onData(data => encryptedSend(appFrame(1, encoder.encode(data))));
    const resize = terminal.onResize(size => {
      const dimensions = new Uint8Array(4);
      const view = new DataView(dimensions.buffer);
      view.setUint16(0, size.cols, false);
      view.setUint16(2, size.rows, false);
      encryptedSend(appFrame(2, dimensions));
    });
    const observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      terminal.resize(
        Math.max(20, Math.min(240, Math.floor((box.width - 20) / 8.5))),
        Math.max(5, Math.min(100, Math.floor((box.height - 16) / 18))),
      );
    });
    observer.observe(container.current);

    socket.addEventListener("open", () => {
      void BrowserTerminalCipher.handshake(socket, sessionId, profile, device, vault).then(ready => {
        if (disposed) return;
        cipher = ready;
        terminal.clear();
        terminal.focus();
        encryptedSend(appFrame(2, Uint8Array.of(
          terminal.cols >> 8, terminal.cols & 255,
          terminal.rows >> 8, terminal.rows & 255,
        )));
      }).catch(error => {
        terminal.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : "Secure handshake failed"}\x1b[0m`);
        socket.close(1008, "handshake failed");
      });
    });
    socket.addEventListener("message", event => {
      if (!cipher || !(event.data instanceof ArrayBuffer)) return;
      receiveQueue = receiveQueue.then(async () => {
        const plaintext = await cipher!.decrypt(event.data);
        const kind = plaintext[0];
        if (kind === 3) terminal.write(plaintext.subarray(1));
        else if (kind === 4 && plaintext.length === 5) {
          const code = new DataView(plaintext.buffer, plaintext.byteOffset + 1, 4).getUint32(0, false);
          terminal.writeln(`\r\n\x1b[2mProcess exited with code ${code}.\x1b[0m`);
        } else throw new Error("Remote computer sent an invalid application frame");
      }).catch(error => {
        terminal.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : "Secure receive failed"}\x1b[0m`);
        socket.close(1008, "encrypted frame rejected");
      });
    });
    socket.addEventListener("close", () => {
      if (!disposed) terminal.writeln("\r\n\x1b[2mRemote computer disconnected.\x1b[0m");
    });
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      socket.close(1000, "terminal closed");
      terminal.dispose();
    };
  }, [sessionId, websocketPath, profile, device, vault]);

  return <section className="workspace-terminal-card">
    <header><div><span className="workspace-online-dot" /><strong>{device.name}</strong><span>{profile}</span></div><button onClick={close}>Close terminal</button></header>
    <div className="workspace-terminal" ref={container} />
  </section>;
}

export function WorkspaceApp({ slug, centralOrigin }: { slug: string; centralOrigin: string }) {
  const [vault] = useState(loadVault);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [active, setActive] = useState<{
    sessionId: string; websocketPath: string; profile: CommandProfile; device: WorkspaceDevice;
  } | null>(null);

  useEffect(() => {
    if (!vault) return;
    void getWorkspace().then(setWorkspace).catch(reason => setError(
      reason instanceof Error ? reason.message : "Could not load Remote workspace",
    ));
  }, [vault]);

  const online = useMemo(() => workspace?.devices.filter(device => device.relayOnline) ?? [], [workspace]);

  async function open(device: WorkspaceDevice, profile: CommandProfile) {
    setBusy(`${device.id}:${profile}`);
    setError(null);
    try {
      const created = await createTerminalSession(device.id, profile);
      setActive({ sessionId: created.session.id, websocketPath: created.websocketPath, profile, device });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open terminal");
    } finally {
      setBusy(null);
    }
  }

  function lock() {
    window.sessionStorage.removeItem(VAULT_SESSION_KEY);
    window.location.replace(`${centralOrigin}/access/${encodeURIComponent(slug)}`);
  }

  if (!vault) return <div className="connect-shell"><section className="connect-card access-instance-card">
    <IconLock className="landing-icon" /><h1>Remote is locked</h1>
    <p>The encryption key is kept only in this browser tab. Unlock again with GitHub and your Remote password.</p>
    <a className="primary connect-action" href={`${centralOrigin}/access/${encodeURIComponent(slug)}`}>Unlock Remote</a>
  </section></div>;
  return <div className="workspace-shell">
    <header className="workspace-header"><div className="connect-brand"><img src="/logo.png" alt="" /><div><strong>opencodex</strong><span>{slug} Remote</span></div></div><button onClick={lock}><IconLock />Lock</button></header>
    <main className="workspace-main">
      <section className="workspace-intro"><div><span>End-to-end encrypted workspace</span><h1>Your computers</h1><p>Terminal plaintext stays between this browser and your computer. The relay sees only bounded ciphertext frames.</p></div><div className="workspace-security"><IconShield /><span><strong>{online.length}</strong> of {workspace?.devices.length ?? 0} online</span></div></section>
      {error && <div className="workspace-error">{error}</div>}
      {!workspace ? <div className="workspace-loading"><IconLoader2 className="spin" />Loading encrypted workspace</div>
        : <section className="workspace-devices">
          {workspace.devices.map(device => <article className="workspace-device" key={device.id}>
            <div className="workspace-device-heading"><span className={device.relayOnline ? "online" : "offline"}><IconDeviceDesktop /></span><div><strong>{device.name}</strong><span>{device.platform}</span></div><em>{device.relayOnline ? "Online" : "Offline"}</em></div>
            <div className="workspace-device-actions">
              {(["shell", "codex", "claude"] as const).map(profile => <button key={profile} disabled={!device.relayOnline || busy !== null} onClick={() => void open(device, profile)}><IconTerminal2 />{busy === `${device.id}:${profile}` ? "Opening…" : profile === "shell" ? "Shell" : profile === "codex" ? "Codex CLI" : "Claude Code"}</button>)}
            </div>
          </article>)}
          {!workspace.devices.length && <div className="workspace-empty"><IconDeviceDesktop /><strong>No paired computers</strong><span>Pair this OCX from the local Remote tab first.</span></div>}
        </section>}
      {active && <TerminalPane {...active} vault={vault} close={() => setActive(null)} />}
    </main>
  </div>;
}
