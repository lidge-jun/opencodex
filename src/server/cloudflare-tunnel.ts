import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { commandInvocation } from "../lib/win-exec";

export const CLOUDFLARE_TUNNEL_ORIGIN_HOST = "opencodex-tunnel.invalid";

export type CloudflareTunnelPhase = "stopped" | "starting" | "running" | "stopping" | "error";
export type CloudflareTunnelMode = "quick" | "named";

export interface CloudflareTunnelStatus {
  status: CloudflareTunnelPhase;
  mode: CloudflareTunnelMode;
  publicUrl: string | null;
  supportsSse: boolean;
  error?: string;
  startedAt?: string;
}

export interface CloudflareTunnelStartOptions {
  originUrl: string;
  actualPort: number;
  configuredPort: number;
  mode?: CloudflareTunnelMode;
  namedTunnel?: { publicUrl: string; tokenFile: string };
}

export interface CloudflareTunnelController {
  getStatus(): CloudflareTunnelStatus;
  start(options: CloudflareTunnelStartOptions): Promise<CloudflareTunnelStatus>;
  stop(): Promise<CloudflareTunnelStatus>;
}

export interface CloudflareTunnelDeps {
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  now?: () => Date;
  startupTimeoutMs?: number;
  namedReadyDelayMs?: number;
  stopTimeoutMs?: number;
}

interface LaunchSpec {
  mode: CloudflareTunnelMode;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  publicUrl: string | null;
  supportsSse: boolean;
}

const HTTPS_URL_TOKEN_PATTERN = /https:\/\/[^\s"'<>|│]+/ig;
const LOOPBACK_METRICS_PATTERN = /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d{1,5})\/metrics\b/ig;
const MAX_OUTPUT_BUFFER = 64 * 1024;

function modeSupportsSse(mode: CloudflareTunnelMode): boolean {
  return mode === "named";
}

function isValidDnsHostname(hostname: string, requireMultipleLabels = false): boolean {
  if (!hostname || hostname.length > 253 || isIP(hostname) !== 0) return false;
  const labels = hostname.toLowerCase().split(".");
  if (requireMultipleLabels && labels.length < 2) return false;
  return labels.every(label => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ));
}

function selectedMode(env: NodeJS.ProcessEnv): CloudflareTunnelMode {
  return env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN?.trim()
    || env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE?.trim()
    || env.OPENCODEX_CLOUDFLARE_PUBLIC_URL?.trim()
    ? "named"
    : "quick";
}

function stoppedStatus(env: NodeJS.ProcessEnv): CloudflareTunnelStatus {
  const mode = selectedMode(env);
  return { status: "stopped", mode, publicUrl: null, supportsSse: modeSupportsSse(mode) };
}

function sanitizedError(message: string, mode: CloudflareTunnelMode, publicUrl: string | null = null): CloudflareTunnelStatus {
  return {
    status: "error",
    mode,
    publicUrl,
    supportsSse: modeSupportsSse(mode),
    error: message,
  };
}

export function parseQuickTunnelUrl(output: string): string | null {
  HTTPS_URL_TOKEN_PATTERN.lastIndex = 0;
  for (const match of output.matchAll(HTTPS_URL_TOKEN_PATTERN)) {
    try {
      const parsed = new URL(match[0].replace(/[\])},;.!]+$/, ""));
      const hostname = parsed.hostname.toLowerCase();
      const suffix = ".trycloudflare.com";
      const subdomain = hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : "";
      const validLabels = isValidDnsHostname(subdomain);
      if (
        parsed.protocol === "https:"
        && parsed.username === ""
        && parsed.password === ""
        && parsed.port === ""
        && parsed.pathname === "/"
        && parsed.search === ""
        && parsed.hash === ""
        && !!subdomain
        && validLabels
      ) return parsed.origin;
    } catch {
      // Ignore unrelated or malformed URLs in cloudflared diagnostics.
    }
  }
  return null;
}

export function normalizeNamedPublicUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || parsed.port
      || (parsed.pathname !== "/" && parsed.pathname !== "")
      || parsed.search
      || parsed.hash
      || !parsed.hostname
      || parsed.hostname.endsWith(".")
      || !isValidDnsHostname(parsed.hostname, true)
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Parse only the explicitly loopback-bound metrics listener emitted by cloudflared. */
export function parseCloudflaredReadyUrl(output: string): string | null {
  LOOPBACK_METRICS_PATTERN.lastIndex = 0;
  let readyUrl: string | null = null;
  for (const match of output.matchAll(LOOPBACK_METRICS_PATTERN)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) {
      readyUrl = `http://127.0.0.1:${port}/ready`;
    }
  }
  return readyUrl;
}

export function buildCloudflaredLaunch(
  options: CloudflareTunnelStartOptions,
  deps: Pick<CloudflareTunnelDeps, "env" | "homeDir" | "exists" | "readFile"> = {},
): LaunchSpec | CloudflareTunnelStatus {
  const env = deps.env ?? process.env;
  const mode = options.mode ?? selectedMode(env);
  const binary = env.OPENCODEX_CLOUDFLARED_PATH?.trim() || "cloudflared";
  const childEnv: NodeJS.ProcessEnv = { ...env };
  let token = options.namedTunnel ? undefined : env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN?.trim();
  const tokenFile = options.namedTunnel ? undefined : env.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE?.trim();
  const publicUrlValue = options.namedTunnel?.publicUrl ?? env.OPENCODEX_CLOUDFLARE_PUBLIC_URL?.trim();
  delete childEnv.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN;
  delete childEnv.OPENCODEX_CLOUDFLARE_TUNNEL_TOKEN_FILE;
  // Ambient official cloudflared credentials must never select or conflict with the explicit
  // opencodex mode. Re-add only the one credential source chosen below.
  delete childEnv.TUNNEL_TOKEN;
  delete childEnv.TUNNEL_TOKEN_FILE;

  if (options.namedTunnel) {
    try {
      token = (deps.readFile ?? (path => readFileSync(path, "utf8")))(options.namedTunnel.tokenFile).trim();
    } catch {
      return sanitizedError("Stored Cloudflare Tunnel credentials could not be read.", "named");
    }
    if (!/^eyJ[A-Za-z0-9._~+/=-]{30,16381}$/.test(token)) {
      return sanitizedError("Stored Cloudflare Tunnel credentials are invalid.", "named");
    }
  }

  if (mode === "named") {
    if ((!token && !tokenFile) || (token && tokenFile) || !publicUrlValue) {
      return sanitizedError(
        "Named Tunnel requires one tunnel token source and OPENCODEX_CLOUDFLARE_PUBLIC_URL.",
        mode,
      );
    }
    const publicUrl = normalizeNamedPublicUrl(publicUrlValue);
    if (!publicUrl) {
      return sanitizedError("OPENCODEX_CLOUDFLARE_PUBLIC_URL must be an HTTPS origin without a path.", mode);
    }
    if (options.actualPort !== options.configuredPort) {
      return sanitizedError(
        "Named Tunnel origin uses the configured opencodex port, but the proxy started on a fallback port.",
        mode,
        publicUrl,
      );
    }
    const args = [
      "tunnel", "--no-autoupdate", "--loglevel", "info", "--protocol", "auto",
      "--metrics", "127.0.0.1:0", "run",
    ];
    if (tokenFile) {
      args.push("--token-file", tokenFile);
    } else {
      childEnv.TUNNEL_TOKEN = token;
    }
    return { mode, binary, args, env: childEnv, publicUrl, supportsSse: true };
  }

  const home = deps.homeDir ?? homedir();
  const pathExists = deps.exists ?? existsSync;
  const configDir = join(home, ".cloudflared");
  if (pathExists(join(configDir, "config.yml")) || pathExists(join(configDir, "config.yaml"))) {
    return sanitizedError(
      "Quick Tunnel cannot start while ~/.cloudflared/config.yml or config.yaml exists. Use a Named Tunnel or move that Cloudflare config.",
      mode,
    );
  }
  return {
    mode,
    binary,
    args: [
      "tunnel",
      "--no-autoupdate",
      "--loglevel",
      "info",
      "--metrics",
      "127.0.0.1:0",
      "--http-host-header",
      CLOUDFLARE_TUNNEL_ORIGIN_HOST,
      "--url",
      options.originUrl,
    ],
    env: childEnv,
    publicUrl: null,
    supportsSse: false,
  };
}

function hostFromValue(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
}

export class ManagedCloudflareTunnelController implements CloudflareTunnelController {
  private readonly deps: Required<Pick<CloudflareTunnelDeps,
    "spawnFn" | "fetchFn" | "env" | "platform" | "homeDir" | "exists" | "readFile" | "now" | "startupTimeoutMs" | "namedReadyDelayMs" | "stopTimeoutMs">>;
  private state: CloudflareTunnelStatus;
  private child: ChildProcess | null = null;
  private startPromise: Promise<CloudflareTunnelStatus> | null = null;
  private stopPromise: Promise<CloudflareTunnelStatus> | null = null;
  private cancelStartWaiter: (() => void) | null = null;
  private output = "";
  private generation = 0;
  private intentEpoch = 0;
  private desiredRunning = false;

  constructor(deps: CloudflareTunnelDeps = {}) {
    this.deps = {
      spawnFn: deps.spawnFn ?? spawn,
      fetchFn: deps.fetchFn ?? fetch,
      env: deps.env ?? process.env,
      platform: deps.platform ?? process.platform,
      homeDir: deps.homeDir ?? homedir(),
      exists: deps.exists ?? existsSync,
      readFile: deps.readFile ?? (path => readFileSync(path, "utf8")),
      now: deps.now ?? (() => new Date()),
      startupTimeoutMs: deps.startupTimeoutMs ?? 20_000,
      namedReadyDelayMs: deps.namedReadyDelayMs ?? 750,
      stopTimeoutMs: deps.stopTimeoutMs ?? 3_000,
    };
    this.state = stoppedStatus(this.deps.env);
  }

  getStatus(): CloudflareTunnelStatus {
    if (this.state.status === "stopped") this.state = stoppedStatus(this.deps.env);
    return { ...this.state };
  }

  start(options: CloudflareTunnelStartOptions): Promise<CloudflareTunnelStatus> {
    this.desiredRunning = true;
    if (this.state.status === "running") return Promise.resolve(this.getStatus());
    if (this.startPromise) return this.startPromise;
    const intent = ++this.intentEpoch;
    const pending = this.startOnce(options, intent).finally(() => {
      if (this.startPromise === pending) this.startPromise = null;
    });
    this.startPromise = pending;
    return pending;
  }

  private shouldStart(intent: number): boolean {
    return this.desiredRunning && intent === this.intentEpoch;
  }

  private async startOnce(options: CloudflareTunnelStartOptions, intent: number): Promise<CloudflareTunnelStatus> {
    if (this.stopPromise) await this.stopPromise;
    if (!this.shouldStart(intent)) return this.getStatus();
    if (this.child) {
      await this.beginStop();
      if (!this.shouldStart(intent)) return this.getStatus();
      if (this.child) return this.getStatus();
    }
    const launch = buildCloudflaredLaunch(options, this.deps);
    if ("status" in launch) {
      this.state = launch;
      return this.getStatus();
    }

    const generation = ++this.generation;
    this.output = "";
    this.state = {
      status: "starting",
      mode: launch.mode,
      publicUrl: launch.publicUrl,
      supportsSse: launch.supportsSse,
    };

    const invocation = commandInvocation(launch.binary, launch.args, this.deps.platform, { env: launch.env });
    let child: ChildProcess;
    try {
      child = this.deps.spawnFn(invocation.file, invocation.args, {
        ...invocation.options,
        env: launch.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: false,
        shell: false,
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      this.state = sanitizedError(
        missing
          ? "cloudflared is not installed. Install it or set OPENCODEX_CLOUDFLARED_PATH."
          : "cloudflared could not be started.",
        launch.mode,
        launch.publicUrl,
      );
      return this.getStatus();
    }
    this.child = child;

    return new Promise<CloudflareTunnelStatus>(resolve => {
      let settled = false;
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      let readyUrl: string | null = null;
      let discoveredPublicUrl = launch.publicUrl;
      let readyProbeInFlight = false;
      const startupTimer = setTimeout(() => {
        fail("Cloudflare Tunnel did not become ready before the startup timeout.");
      }, this.deps.startupTimeoutMs);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        if (readyTimer) clearTimeout(readyTimer);
        if (this.cancelStartWaiter === finish) this.cancelStartWaiter = null;
        resolve(this.getStatus());
      };
      this.cancelStartWaiter = finish;

      const markRunning = (publicUrl: string | null) => {
        if (
          this.child !== child
          || this.generation !== generation
          || this.state.status !== "starting"
          || !this.shouldStart(intent)
        ) return;
        this.state = {
          status: "running",
          mode: launch.mode,
          publicUrl,
          supportsSse: launch.supportsSse,
          startedAt: this.deps.now().toISOString(),
        };
        finish();
      };

      const fail = (message: string, missing = false) => {
        if (this.child !== child || this.generation !== generation) return finish();
        if (!this.shouldStart(intent)) return finish();
        this.state = sanitizedError(
          missing
            ? "cloudflared is not installed. Install it or set OPENCODEX_CLOUDFLARED_PATH."
            : message,
          launch.mode,
          launch.publicUrl,
        );
        try { child.kill("SIGTERM"); } catch { /* best-effort */ }
        // Keep ownership until close so a slow graceful shutdown cannot become an orphan. Escalate
        // independently because the start request has already received its sanitized error state.
        setTimeout(() => {
          if (this.child !== child || this.generation !== generation) return;
          try { child.kill("SIGKILL"); } catch { /* direct child may already be gone */ }
        }, this.deps.stopTimeoutMs);
        finish();
      };

      const scheduleReadyProbe = () => {
        if (
          settled
          || !readyUrl
          || !discoveredPublicUrl
          || readyTimer
          || readyProbeInFlight
          || !this.shouldStart(intent)
        ) return;
        readyTimer = setTimeout(() => {
          readyTimer = undefined;
          void probeReady();
        }, this.deps.namedReadyDelayMs);
      };

      const probeReady = async () => {
        if (settled || !readyUrl || !discoveredPublicUrl || !this.shouldStart(intent)) return;
        readyProbeInFlight = true;
        try {
          const response = await this.deps.fetchFn(readyUrl, {
            signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, this.deps.startupTimeoutMs))),
          });
          try { await response.body?.cancel(); } catch { /* local probe body is best-effort */ }
          if (response.status === 200) {
            markRunning(discoveredPublicUrl);
            return;
          }
        } catch {
          // Metrics can begin listening before the first edge connection becomes active.
        } finally {
          readyProbeInFlight = false;
        }
        scheduleReadyProbe();
      };

      const inspectOutput = (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        this.output = (this.output + text).slice(-MAX_OUTPUT_BUFFER);
        readyUrl = parseCloudflaredReadyUrl(this.output) ?? readyUrl;
        if (launch.mode === "quick") {
          discoveredPublicUrl = parseQuickTunnelUrl(this.output) ?? discoveredPublicUrl;
        }
        scheduleReadyProbe();
      };

      child.stdout?.on("data", inspectOutput);
      child.stderr?.on("data", inspectOutput);
      child.once("error", error => {
        fail("cloudflared could not be started.", (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT");
      });
      child.once("close", () => {
        if (this.child !== child || this.generation !== generation) return;
        this.child = null;
        if (this.state.status === "stopping") {
          this.state = stoppedStatus(this.deps.env);
        } else if (this.state.status === "starting") {
          this.state = sanitizedError("cloudflared exited before the tunnel became ready.", launch.mode, launch.publicUrl);
        } else if (this.state.status === "running") {
          this.state = sanitizedError("Cloudflare Tunnel stopped unexpectedly.", launch.mode, this.state.publicUrl);
        }
        finish();
      });
    });
  }

  stop(): Promise<CloudflareTunnelStatus> {
    this.desiredRunning = false;
    ++this.intentEpoch;
    // A pending start keeps running only long enough to observe the changed intent. Clearing the
    // slot lets a later start express a new intent without waiting on the canceled promise wrapper.
    this.startPromise = null;
    const pending = this.beginStop();
    // beginStop synchronously moves a live child to "stopping" before the canceled start resolves,
    // so callers never observe a stale "starting" result and its startup timer cannot overwrite a
    // later forced-stop diagnostic.
    this.cancelStartWaiter?.();
    return pending;
  }

  private beginStop(): Promise<CloudflareTunnelStatus> {
    if (this.stopPromise) return this.stopPromise;
    const pending = this.stopOnce().finally(() => {
      if (this.stopPromise === pending) this.stopPromise = null;
    });
    this.stopPromise = pending;
    return pending;
  }

  private async stopOnce(): Promise<CloudflareTunnelStatus> {
    const child = this.child;
    if (!child) {
      ++this.generation;
      this.state = stoppedStatus(this.deps.env);
      return this.getStatus();
    }
    this.state = { ...this.state, status: "stopping", error: undefined };
    const generation = this.generation;

    return new Promise<CloudflareTunnelStatus>(resolve => {
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let finalTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (closed: boolean) => {
        if (closed && this.generation === generation) {
          if (this.child === child) this.child = null;
          ++this.generation;
          this.state = stoppedStatus(this.deps.env);
        }
        // A late close after the bounded stop response still clears ownership and state above.
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (finalTimer) clearTimeout(finalTimer);
        if (!closed) {
          this.state = sanitizedError(
            "cloudflared did not stop after forced termination.",
            this.state.mode,
            this.state.publicUrl,
          );
        }
        resolve(this.getStatus());
      };

      child.once("close", () => finish(true));
      try { child.kill("SIGTERM"); } catch { /* escalate below */ }
      forceTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* direct child may already be gone */ }
        finalTimer = setTimeout(() => finish(false), 250);
      }, this.deps.stopTimeoutMs);
    });
  }

  /** Synchronous best-effort cleanup for process.on("exit"), where promises cannot be awaited. */
  killOwnedChild(): void {
    const child = this.child;
    this.child = null;
    ++this.generation;
    if (child) {
      // Async graceful cleanup cannot run from an exit handler; terminate the owned connector so
      // it cannot survive the origin process as an orphan.
      try { child.kill("SIGKILL"); } catch { /* process is already exiting */ }
    }
  }
}

export const cloudflareTunnelController = new ManagedCloudflareTunnelController();

function activePublicOrigin(): string | null {
  const status = cloudflareTunnelController.getStatus();
  // Keep recognizing a known Named-Tunnel host even in an error state. A failed graceful kill can
  // leave cloudflared accepting requests briefly; dropping the host gate first would expose the
  // loopback-only management surface during that interval. stopped always clears publicUrl.
  // The configured Named host is also reserved while stopped. This fails closed if a hard crash
  // leaves an old connector alive after the persisted toggle was cleared.
  return status.publicUrl ?? normalizeNamedPublicUrl(process.env.OPENCODEX_CLOUDFLARE_PUBLIC_URL);
}

export function isCloudflareTunnelRequest(req: Request): boolean {
  // The edge-to-origin headers are a fail-closed fallback for Named Tunnel configurations that
  // override the origin Host header. Cloudflare documents CF-Connecting-IP as edge-to-origin only;
  // CF-Ray remains useful when visitor-IP headers are removed by a Managed Transform. A forged
  // marker on a local request only makes the request more restricted, never less restricted.
  if (req.headers.has("cf-connecting-ip") || req.headers.has("cf-ray")) return true;
  const headerHost = hostFromValue(req.headers.get("Host"));
  let requestHost = headerHost;
  if (!requestHost) {
    try { requestHost = new URL(req.url).hostname.toLowerCase(); } catch { return false; }
  }
  if (requestHost === CLOUDFLARE_TUNNEL_ORIGIN_HOST) return true;
  const publicOrigin = activePublicOrigin();
  if (!publicOrigin) return false;
  try {
    const publicHost = new URL(publicOrigin).hostname.toLowerCase().replace(/\.+$/, "");
    return requestHost === publicHost;
  } catch { return false; }
}

export function isCloudflareTunnelRequestOrigin(origin: string): boolean {
  const publicOrigin = activePublicOrigin();
  if (!publicOrigin) return false;
  try { return new URL(origin).origin === new URL(publicOrigin).origin; } catch { return false; }
}

process.once("exit", () => cloudflareTunnelController.killOwnedChild());
