use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Duration,
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use p256::{
    PublicKey,
    ecdh::EphemeralSecret,
    elliptic_curve::rand_core::OsRng,
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePublicKey},
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc as tokio_mpsc;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
        protocol::WebSocketConfig,
    },
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

const PROTOCOL_VERSION: u8 = 1;
const FRAME_OPEN: u8 = 1;
const FRAME_DATA: u8 = 2;
const FRAME_CLOSE: u8 = 3;
const FRAME_HEADER_SIZE: usize = 18;
const MAX_PAYLOAD: usize = 64 * 1024;
const MAX_SESSIONS: usize = 4;

const APP_INPUT: u8 = 1;
const APP_RESIZE: u8 = 2;
const APP_OUTPUT: u8 = 3;
const APP_EXIT: u8 = 4;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteState {
    version: u8,
    state: String,
    relay_url: String,
    relay_token: Zeroizing<String>,
    device_id: Uuid,
    private_key_pem: Zeroizing<String>,
    e2ee: E2eeEnvelope,
    instance: Option<RemoteInstance>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct E2eeEnvelope {
    root_public_key: String,
}

#[derive(Debug, Deserialize)]
struct RemoteInstance {
    id: Uuid,
}

impl RemoteState {
    fn load(path: &Path) -> Result<Self> {
        let metadata = std::fs::metadata(path)
            .with_context(|| format!("read metadata for {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                bail!("{} must not be readable by other users", path.display());
            }
        }
        if metadata.len() > 256 * 1024 {
            bail!("remote state is too large");
        }
        let state: Self = serde_json::from_slice(
            &std::fs::read(path).with_context(|| format!("read {}", path.display()))?,
        )
        .context("parse OpenCodex remote state")?;
        if state.version != 2 || state.state != "connected" || state.instance.is_none() {
            bail!("Remote must be connected, encrypted, and activated before the Agent starts");
        }
        let relay = Url::parse(&state.relay_url).context("parse relay URL")?;
        let local_development =
            relay.scheme() == "ws" && matches!(relay.host_str(), Some("127.0.0.1" | "localhost"));
        if relay.scheme() != "wss" && !local_development {
            bail!("relay URL must use WSS");
        }
        Ok(state)
    }

    fn signing_key(&self) -> Result<SigningKey> {
        SigningKey::from_pkcs8_pem(&self.private_key_pem).context("parse device signing key")
    }

    fn root_verifying_key(&self) -> Result<VerifyingKey> {
        let der = URL_SAFE_NO_PAD
            .decode(&self.e2ee.root_public_key)
            .context("decode account root public key")?;
        VerifyingKey::from_public_key_der(&der).context("parse account root public key")
    }
}

pub fn default_remote_state_path() -> PathBuf {
    if let Some(home) = env::var_os("OPENCODEX_HOME") {
        return PathBuf::from(home).join("remote.json");
    }
    PathBuf::from(env::var_os("HOME").unwrap_or_else(|| ".".into()))
        .join(".opencodex")
        .join("remote.json")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameKind {
    Open,
    Data,
    Close,
}

impl FrameKind {
    fn from_byte(value: u8) -> Result<Self> {
        match value {
            FRAME_OPEN => Ok(Self::Open),
            FRAME_DATA => Ok(Self::Data),
            FRAME_CLOSE => Ok(Self::Close),
            _ => bail!("unknown relay frame kind"),
        }
    }

    fn byte(self) -> u8 {
        match self {
            Self::Open => FRAME_OPEN,
            Self::Data => FRAME_DATA,
            Self::Close => FRAME_CLOSE,
        }
    }
}

#[derive(Debug)]
struct RelayFrame {
    kind: FrameKind,
    session_id: Uuid,
    payload: Vec<u8>,
}

impl RelayFrame {
    fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < FRAME_HEADER_SIZE || bytes.len() > FRAME_HEADER_SIZE + MAX_PAYLOAD {
            bail!("invalid relay frame length");
        }
        if bytes[0] != PROTOCOL_VERSION {
            bail!("unsupported relay protocol version");
        }
        Ok(Self {
            kind: FrameKind::from_byte(bytes[1])?,
            session_id: Uuid::from_slice(&bytes[2..FRAME_HEADER_SIZE])
                .context("parse relay session ID")?,
            payload: bytes[FRAME_HEADER_SIZE..].to_vec(),
        })
    }

    fn encode(&self) -> Result<Vec<u8>> {
        if self.payload.len() > MAX_PAYLOAD {
            bail!("relay payload is too large");
        }
        let mut bytes = Vec::with_capacity(FRAME_HEADER_SIZE + self.payload.len());
        bytes.extend_from_slice(&[PROTOCOL_VERSION, self.kind.byte()]);
        bytes.extend_from_slice(self.session_id.as_bytes());
        bytes.extend_from_slice(&self.payload);
        Ok(bytes)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenRequest {
    command_profile: CommandProfile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientHello {
    command_profile: CommandProfile,
    ephemeral_public_key: String,
    client_nonce: String,
    signature: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentHello {
    ephemeral_public_key: String,
    server_nonce: String,
    signature: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CommandProfile {
    Shell,
    Codex,
    Claude,
}

impl CommandProfile {
    fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    fn executable(self) -> &'static str {
        match self {
            Self::Shell => {
                #[cfg(windows)]
                {
                    "powershell.exe"
                }
                #[cfg(not(windows))]
                {
                    "/bin/sh"
                }
            }
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

struct SessionCrypto {
    session_id: Uuid,
    receive: Aes256Gcm,
    send: Aes256Gcm,
    receive_nonce_prefix: [u8; 4],
    send_nonce_prefix: [u8; 4],
    receive_counter: u64,
    send_counter: u64,
}

impl SessionCrypto {
    fn derive(
        session_id: Uuid,
        shared: &[u8],
        client_nonce: &[u8],
        server_nonce: &[u8],
    ) -> Result<Self> {
        let mut salt_source = Vec::with_capacity(client_nonce.len() + server_nonce.len());
        salt_source.extend_from_slice(client_nonce);
        salt_source.extend_from_slice(server_nonce);
        let salt = Sha256::digest(&salt_source);
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared);
        let mut receive_key = [0_u8; 32];
        let mut send_key = [0_u8; 32];
        let mut receive_nonce_prefix = [0_u8; 4];
        let mut send_nonce_prefix = [0_u8; 4];
        hkdf.expand(b"ocx terminal browser to agent key v1", &mut receive_key)
            .map_err(|_| anyhow::anyhow!("derive browser-to-agent key"))?;
        hkdf.expand(b"ocx terminal agent to browser key v1", &mut send_key)
            .map_err(|_| anyhow::anyhow!("derive agent-to-browser key"))?;
        hkdf.expand(
            b"ocx terminal browser to agent nonce v1",
            &mut receive_nonce_prefix,
        )
        .map_err(|_| anyhow::anyhow!("derive browser-to-agent nonce"))?;
        hkdf.expand(
            b"ocx terminal agent to browser nonce v1",
            &mut send_nonce_prefix,
        )
        .map_err(|_| anyhow::anyhow!("derive agent-to-browser nonce"))?;
        Ok(Self {
            session_id,
            receive: Aes256Gcm::new_from_slice(&receive_key).expect("AES-256 key length"),
            send: Aes256Gcm::new_from_slice(&send_key).expect("AES-256 key length"),
            receive_nonce_prefix,
            send_nonce_prefix,
            receive_counter: 0,
            send_counter: 0,
        })
    }

    fn aad(&self, direction: u8, counter: u64) -> Vec<u8> {
        let mut aad = b"ocx-terminal-frame-v1\0".to_vec();
        aad.extend_from_slice(self.session_id.as_bytes());
        aad.push(direction);
        aad.extend_from_slice(&counter.to_be_bytes());
        aad
    }

    fn nonce(prefix: [u8; 4], counter: u64) -> [u8; 12] {
        let mut nonce = [0_u8; 12];
        nonce[..4].copy_from_slice(&prefix);
        nonce[4..].copy_from_slice(&counter.to_be_bytes());
        nonce
    }

    fn decrypt(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        if bytes.len() < 8 + 16 {
            bail!("encrypted terminal frame is too short");
        }
        let counter = u64::from_be_bytes(bytes[..8].try_into().expect("counter length"));
        if counter != self.receive_counter {
            bail!("replayed or out-of-order terminal frame");
        }
        let nonce = Self::nonce(self.receive_nonce_prefix, counter);
        let plaintext = self
            .receive
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &bytes[8..],
                    aad: &self.aad(0, counter),
                },
            )
            .map_err(|_| anyhow::anyhow!("terminal frame authentication failed"))?;
        self.receive_counter = self
            .receive_counter
            .checked_add(1)
            .context("terminal receive counter exhausted")?;
        Ok(plaintext)
    }

    fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let counter = self.send_counter;
        let nonce = Self::nonce(self.send_nonce_prefix, counter);
        let encrypted = self
            .send
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &self.aad(1, counter),
                },
            )
            .map_err(|_| anyhow::anyhow!("encrypt terminal frame"))?;
        self.send_counter = self
            .send_counter
            .checked_add(1)
            .context("terminal send counter exhausted")?;
        let mut bytes = Vec::with_capacity(8 + encrypted.len());
        bytes.extend_from_slice(&counter.to_be_bytes());
        bytes.extend_from_slice(&encrypted);
        Ok(bytes)
    }
}

enum PtyCommand {
    Input(Vec<u8>),
    Resize { rows: u16, cols: u16 },
    Close,
}

enum PtyEvent {
    Output { session_id: Uuid, bytes: Vec<u8> },
    Exit { session_id: Uuid, code: u32 },
}

struct PtySession {
    commands: mpsc::Sender<PtyCommand>,
}

impl PtySession {
    fn input(&self, bytes: Vec<u8>) -> Result<()> {
        self.commands
            .send(PtyCommand::Input(bytes))
            .map_err(|_| anyhow::anyhow!("terminal has exited"))
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        if !(2..=1000).contains(&rows) || !(2..=1000).contains(&cols) {
            bail!("invalid terminal dimensions");
        }
        self.commands
            .send(PtyCommand::Resize { rows, cols })
            .map_err(|_| anyhow::anyhow!("terminal has exited"))
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.commands.send(PtyCommand::Close);
    }
}

fn spawn_pty(
    session_id: Uuid,
    profile: CommandProfile,
    events: tokio_mpsc::Sender<PtyEvent>,
) -> Result<PtySession> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("open local PTY")?;
    let mut command = CommandBuilder::new(profile.executable());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    if let Some(home) = env::var_os("HOME") {
        command.cwd(home);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .with_context(|| format!("start {} terminal", profile.as_str()))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().context("clone PTY reader")?;
    let mut writer = pair.master.take_writer().context("take PTY writer")?;
    let mut killer = child.clone_killer();
    let master = pair.master;
    let (commands, command_rx) = mpsc::channel();

    let output_events = events.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if output_events
                        .blocking_send(PtyEvent::Output {
                            session_id,
                            bytes: buffer[..read].to_vec(),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });
    thread::spawn(move || {
        while let Ok(command) = command_rx.recv() {
            let result = match command {
                PtyCommand::Input(bytes) => writer.write_all(&bytes).and_then(|_| writer.flush()),
                PtyCommand::Resize { rows, cols } => master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(std::io::Error::other),
                PtyCommand::Close => {
                    let _ = killer.kill();
                    break;
                }
            };
            if result.is_err() {
                break;
            }
        }
    });
    thread::spawn(move || {
        let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
        let _ = events.blocking_send(PtyEvent::Exit { session_id, code });
    });
    Ok(PtySession { commands })
}

enum SessionState {
    Pending {
        profile: CommandProfile,
    },
    Handshaken {
        profile: CommandProfile,
        crypto: SessionCrypto,
    },
    Active {
        crypto: SessionCrypto,
        pty: PtySession,
    },
}

fn client_transcript(
    session_id: Uuid,
    device_id: Uuid,
    profile: CommandProfile,
    public_key: &[u8],
    nonce: &[u8],
) -> Vec<u8> {
    let mut transcript = b"ocx-terminal-client-v1\0".to_vec();
    transcript.extend_from_slice(session_id.as_bytes());
    transcript.extend_from_slice(device_id.as_bytes());
    transcript.extend_from_slice(profile.as_str().as_bytes());
    transcript.push(0);
    transcript.extend_from_slice(public_key);
    transcript.extend_from_slice(nonce);
    transcript
}

fn agent_transcript(
    client_transcript: &[u8],
    agent_public_key: &[u8],
    server_nonce: &[u8],
) -> Vec<u8> {
    let mut transcript = b"ocx-terminal-agent-v1\0".to_vec();
    transcript.extend_from_slice(client_transcript);
    transcript.extend_from_slice(agent_public_key);
    transcript.extend_from_slice(server_nonce);
    transcript
}

fn accept_client_hello(
    state: &RemoteState,
    session_id: Uuid,
    expected_profile: CommandProfile,
    payload: &[u8],
) -> Result<(AgentHello, SessionCrypto)> {
    let hello: ClientHello =
        serde_json::from_slice(payload).context("parse client terminal hello")?;
    if hello.command_profile != expected_profile {
        bail!("terminal command profile was changed in transit");
    }
    let client_public_der = URL_SAFE_NO_PAD
        .decode(&hello.ephemeral_public_key)
        .context("decode browser ephemeral key")?;
    let client_public = PublicKey::from_public_key_der(&client_public_der)
        .context("parse browser ephemeral key")?;
    let client_nonce = URL_SAFE_NO_PAD
        .decode(&hello.client_nonce)
        .context("decode browser nonce")?;
    if client_nonce.len() != 32 {
        bail!("browser nonce must be 32 bytes");
    }
    let signature = URL_SAFE_NO_PAD
        .decode(&hello.signature)
        .context("decode browser signature")?;
    let signature = Signature::from_slice(&signature).context("parse browser signature")?;
    let client_transcript = client_transcript(
        session_id,
        state.device_id,
        expected_profile,
        &client_public_der,
        &client_nonce,
    );
    state
        .root_verifying_key()?
        .verify(&client_transcript, &signature)
        .context("verify account root signature")?;

    let ephemeral = EphemeralSecret::random(&mut OsRng);
    let agent_public = PublicKey::from(&ephemeral);
    let agent_public_der = agent_public
        .to_public_key_der()
        .context("encode Agent ephemeral key")?;
    let shared = ephemeral.diffie_hellman(&client_public);
    let server_nonce = rand::random::<[u8; 32]>();
    let signature = state.signing_key()?.sign(&agent_transcript(
        &client_transcript,
        agent_public_der.as_bytes(),
        &server_nonce,
    ));
    let crypto = SessionCrypto::derive(
        session_id,
        shared.raw_secret_bytes(),
        &client_nonce,
        &server_nonce,
    )?;
    Ok((
        AgentHello {
            ephemeral_public_key: URL_SAFE_NO_PAD.encode(agent_public_der.as_bytes()),
            server_nonce: URL_SAFE_NO_PAD.encode(server_nonce),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        },
        crypto,
    ))
}

fn apply_terminal_input(pty: &PtySession, plaintext: &[u8]) -> Result<()> {
    let Some((&kind, body)) = plaintext.split_first() else {
        bail!("empty terminal application frame");
    };
    match kind {
        APP_INPUT => pty.input(body.to_vec()),
        APP_RESIZE if body.len() == 4 => {
            let cols = u16::from_be_bytes([body[0], body[1]]);
            let rows = u16::from_be_bytes([body[2], body[3]]);
            pty.resize(rows, cols)
        }
        _ => bail!("invalid terminal application frame"),
    }
}

pub async fn run(state_path: PathBuf, shutdown: CancellationToken) -> Result<()> {
    let mut retry = Duration::from_secs(1);
    loop {
        if shutdown.is_cancelled() {
            return Ok(());
        }
        match run_connection(&state_path, shutdown.clone()).await {
            Ok(()) if shutdown.is_cancelled() => return Ok(()),
            Ok(()) => warn!("relay disconnected"),
            Err(error) => warn!(error = %error, "relay connection failed"),
        }
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = tokio::time::sleep(retry) => {}
        }
        retry = (retry * 2).min(Duration::from_secs(30));
    }
}

async fn run_connection(state_path: &Path, shutdown: CancellationToken) -> Result<()> {
    let state = RemoteState::load(state_path)?;
    let instance_id = state.instance.as_ref().expect("validated instance").id;
    let mut request = state
        .relay_url
        .as_str()
        .into_client_request()
        .context("build relay request")?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", state.relay_token.as_str()))
            .context("build relay authorization")?,
    );
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(FRAME_HEADER_SIZE + MAX_PAYLOAD))
        .max_frame_size(Some(FRAME_HEADER_SIZE + MAX_PAYLOAD));
    let (socket, _) = connect_async_with_config(request, Some(websocket_config), false)
        .await
        .context("connect outbound relay")?;
    info!(%instance_id, device_id = %state.device_id, "outbound relay connected");
    let (mut sink, mut stream) = socket.split();
    let (pty_events_tx, mut pty_events_rx) = tokio_mpsc::channel::<PtyEvent>(64);
    let mut sessions = HashMap::<Uuid, SessionState>::new();

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                let _ = sink.send(Message::Close(None)).await;
                return Ok(());
            }
            event = pty_events_rx.recv() => {
                let Some(event) = event else { continue };
                match event {
                    PtyEvent::Output { session_id, bytes } => {
                        let Some(SessionState::Active { crypto, .. }) = sessions.get_mut(&session_id) else { continue };
                        let mut plaintext = Vec::with_capacity(1 + bytes.len());
                        plaintext.push(APP_OUTPUT);
                        plaintext.extend_from_slice(&bytes);
                        let encrypted = crypto.encrypt(&plaintext)?;
                        sink.send(Message::Binary(RelayFrame { kind: FrameKind::Data, session_id, payload: encrypted }.encode()?.into())).await?;
                    }
                    PtyEvent::Exit { session_id, code } => {
                        if let Some(SessionState::Active { crypto, .. }) = sessions.get_mut(&session_id) {
                            let mut plaintext = vec![APP_EXIT];
                            plaintext.extend_from_slice(&code.to_be_bytes());
                            let encrypted = crypto.encrypt(&plaintext)?;
                            sink.send(Message::Binary(RelayFrame { kind: FrameKind::Data, session_id, payload: encrypted }.encode()?.into())).await?;
                        }
                        sessions.remove(&session_id);
                        sink.send(Message::Binary(RelayFrame { kind: FrameKind::Close, session_id, payload: vec![] }.encode()?.into())).await?;
                    }
                }
            }
            message = stream.next() => {
                let Some(message) = message else { return Ok(()) };
                match message.context("read relay message")? {
                    Message::Binary(bytes) => {
                        let frame = RelayFrame::decode(&bytes)?;
                        match frame.kind {
                            FrameKind::Open => {
                                if sessions.contains_key(&frame.session_id) || sessions.len() >= MAX_SESSIONS {
                                    sink.send(Message::Binary(RelayFrame { kind: FrameKind::Close, session_id: frame.session_id, payload: vec![] }.encode()?.into())).await?;
                                    continue;
                                }
                                match serde_json::from_slice::<OpenRequest>(&frame.payload) {
                                    Ok(request) => {
                                        sessions.insert(frame.session_id, SessionState::Pending { profile: request.command_profile });
                                    }
                                    Err(error) => {
                                        warn!(session_id = %frame.session_id, error = %error, "terminal open request rejected");
                                        sink.send(Message::Binary(RelayFrame { kind: FrameKind::Close, session_id: frame.session_id, payload: vec![] }.encode()?.into())).await?;
                                    }
                                }
                            }
                            FrameKind::Data => {
                                let Some(session) = sessions.remove(&frame.session_id) else { continue };
                                match session {
                                    SessionState::Pending { profile } => {
                                        match accept_client_hello(&state, frame.session_id, profile, &frame.payload) {
                                            Ok((hello, crypto)) => {
                                                // The browser cannot decrypt application output until it has
                                                // verified this hello and installed its receive handler. Starting
                                                // the PTY here can lose an early shell prompt (counter 0), making
                                                // the next frame look replayed. The first authenticated browser
                                                // frame is therefore also the explicit PTY-start signal.
                                                sessions.insert(frame.session_id, SessionState::Handshaken { profile, crypto });
                                                sink.send(Message::Binary(RelayFrame {
                                                    kind: FrameKind::Open,
                                                    session_id: frame.session_id,
                                                    payload: serde_json::to_vec(&hello)?,
                                                }.encode()?.into())).await?;
                                            }
                                            Err(error) => {
                                                warn!(session_id = %frame.session_id, error = %error, "terminal handshake rejected");
                                                sink.send(Message::Binary(RelayFrame { kind: FrameKind::Close, session_id: frame.session_id, payload: vec![] }.encode()?.into())).await?;
                                            }
                                        }
                                    }
                                    SessionState::Handshaken { profile, mut crypto } => {
                                        let started = crypto.decrypt(&frame.payload).and_then(|plaintext| {
                                            let pty = spawn_pty(frame.session_id, profile, pty_events_tx.clone())?;
                                            apply_terminal_input(&pty, &plaintext)?;
                                            Ok(pty)
                                        });
                                        match started {
                                            Ok(pty) => {
                                                sessions.insert(frame.session_id, SessionState::Active { crypto, pty });
                                            }
                                            Err(error) => {
                                                warn!(session_id = %frame.session_id, error = %error, "terminal process failed to start");
                                                sink.send(Message::Binary(RelayFrame { kind: FrameKind::Close, session_id: frame.session_id, payload: vec![] }.encode()?.into())).await?;
                                            }
                                        }
                                    }
                                    SessionState::Active { mut crypto, pty } => {
                                        match crypto.decrypt(&frame.payload).and_then(|plaintext| apply_terminal_input(&pty, &plaintext)) {
                                            Ok(()) => {
                                                sessions.insert(frame.session_id, SessionState::Active { crypto, pty });
                                            }
                                            Err(error) => {
                                                warn!(session_id = %frame.session_id, error = %error, "encrypted terminal input rejected");
                                                sink.send(Message::Binary(RelayFrame { kind: FrameKind::Close, session_id: frame.session_id, payload: vec![] }.encode()?.into())).await?;
                                            }
                                        }
                                    }
                                }
                            }
                            FrameKind::Close => {
                                sessions.remove(&frame.session_id);
                            }
                        }
                    }
                    Message::Ping(payload) => sink.send(Message::Pong(payload)).await?,
                    Message::Close(_) => return Ok(()),
                    Message::Text(_) => bail!("relay sent a text frame"),
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_frame_round_trip_and_bounds() {
        let session_id = Uuid::new_v4();
        let encoded = RelayFrame {
            kind: FrameKind::Data,
            session_id,
            payload: b"opaque".to_vec(),
        }
        .encode()
        .unwrap();
        let decoded = RelayFrame::decode(&encoded).unwrap();
        assert_eq!(decoded.kind, FrameKind::Data);
        assert_eq!(decoded.session_id, session_id);
        assert_eq!(decoded.payload, b"opaque");
        assert!(RelayFrame::decode(&[0; FRAME_HEADER_SIZE - 1]).is_err());
        assert!(
            RelayFrame {
                kind: FrameKind::Data,
                session_id,
                payload: vec![0; MAX_PAYLOAD + 1],
            }
            .encode()
            .is_err()
        );
    }

    #[test]
    fn command_profiles_never_accept_arbitrary_commands() {
        assert_eq!(CommandProfile::Shell.as_str(), "shell");
        assert_eq!(CommandProfile::Codex.executable(), "codex");
        assert_eq!(CommandProfile::Claude.executable(), "claude");
        assert!(serde_json::from_str::<CommandProfile>("\"rm -rf /\"").is_err());
    }

    #[test]
    fn receive_counter_rejects_replay() {
        let session_id = Uuid::new_v4();
        let mut agent = SessionCrypto::derive(session_id, &[7; 32], &[8; 32], &[9; 32]).unwrap();
        let nonce = SessionCrypto::nonce(agent.receive_nonce_prefix, 0);
        let ciphertext = agent
            .receive
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: b"hello",
                    aad: &agent.aad(0, 0),
                },
            )
            .unwrap();
        let mut encrypted = 0_u64.to_be_bytes().to_vec();
        encrypted.extend_from_slice(&ciphertext);
        assert_eq!(agent.decrypt(&encrypted).unwrap(), b"hello");
        assert!(agent.decrypt(&encrypted).is_err());
    }
}
