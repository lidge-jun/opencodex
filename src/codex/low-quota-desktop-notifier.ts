import { existsSync } from "node:fs";
import { isTestHomeGuardArmed } from "../lib/test-home-guard";

/** What a low-quota notice may tell the operating system. Never an email, raw id or credential. */
export type LowQuotaNotice = {
  /** Pseudonymous `p<hex6>` log label of the pool account. */
  accountLabel: string;
  window: "short" | "weekly";
  percentUsed: number;
  threshold: number;
  /** Epoch milliseconds of the window reset, when known. */
  resetAt: number | null;
};

/** Resolves when the OS notifier accepted the notice; rejects on failure, timeout or abort. */
export type LowQuotaNoticeSink = (notice: LowQuotaNotice, signal: AbortSignal) => Promise<void>;

type SpawnedNotifier = { exited: Promise<number | null>; kill(): void };
export type LowQuotaNotifierIo = {
  platform?: NodeJS.Platform;
  /** Returns true when the absolute path is an existing executable candidate. */
  exists?: (path: string) => boolean;
  spawn?: (argv: string[]) => SpawnedNotifier;
  timeoutMs?: number;
  /** Formats the reset time for display; defaults to the host locale. */
  formatTime?: (epochMs: number) => string;
};

const OSASCRIPT = "/usr/bin/osascript";
/** Literal system locations only: a PATH lookup would let any earlier PATH entry run as the proxy. */
const NOTIFY_SEND_CANDIDATES = ["/usr/bin/notify-send", "/usr/local/bin/notify-send", "/bin/notify-send"];
const DEFAULT_TIMEOUT_MS = 5_000;
const TITLE = "OpenCodex quota";

export function formatLowQuotaNotice(notice: LowQuotaNotice, formatTime: (epochMs: number) => string = defaultFormatTime): { title: string; body: string } {
  const window = notice.window === "short" ? "5-hour" : "weekly";
  const reset = notice.resetAt === null ? "reset time unknown" : `resets ${formatTime(notice.resetAt)}`;
  return {
    title: TITLE,
    body: `Account ${notice.accountLabel}: ${window} quota at ${Math.round(notice.percentUsed)}% (threshold ${notice.threshold}%), ${reset}.`,
  };
}

function defaultFormatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

/** notify-send bodies may be parsed as markup by the notification server. */
function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Builds the fixed argv for the host notifier. The notice text is always a separate argv item:
 * the AppleScript source is constant and reads its arguments, and notify-send stops option
 * parsing at `--`, so no account or quota text is ever interpreted as script or flags.
 */
export function lowQuotaNotifierArgv(
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
  title: string,
  body: string,
): string[] | undefined {
  if (platform === "darwin") {
    if (!exists(OSASCRIPT)) return undefined;
    return [OSASCRIPT, "-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body];
  }
  if (platform === "linux") {
    const notifySend = NOTIFY_SEND_CANDIDATES.find(exists);
    if (!notifySend) return undefined;
    return [notifySend, "--app-name=OpenCodex", "--", title, escapeMarkup(body)];
  }
  return undefined;
}

function defaultSpawn(argv: string[]): SpawnedNotifier {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  return { exited: proc.exited, kill: () => { try { proc.kill(); } catch { /* already gone */ } } };
}

/**
 * Returns a sink that hands notices to this host's notification service, or undefined when the
 * platform has none we support (Windows and others stay log-only). An armed test process never
 * reaches a real notifier unless a spawn is injected.
 */
export function resolveLowQuotaDesktopSink(io: LowQuotaNotifierIo = {}): LowQuotaNoticeSink | undefined {
  if (!io.spawn && isTestHomeGuardArmed()) return undefined;
  const platform = io.platform ?? process.platform;
  const exists = io.exists ?? existsSync;
  const spawn = io.spawn ?? defaultSpawn;
  const timeoutMs = io.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probe = lowQuotaNotifierArgv(platform, exists, TITLE, "");
  if (!probe) return undefined;
  return (notice, signal) => {
    if (signal.aborted) return Promise.reject(new Error("low-quota notice cancelled"));
    const { title, body } = formatLowQuotaNotice(notice, io.formatTime);
    const argv = lowQuotaNotifierArgv(platform, exists, title, body);
    if (!argv) return Promise.reject(new Error("low-quota notifier unavailable"));
    let child: SpawnedNotifier;
    try {
      child = spawn(argv);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => { child.kill(); finish(new Error("low-quota notice cancelled")); };
      const timer = setTimeout(() => { child.kill(); finish(new Error("low-quota notifier timed out")); }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      child.exited.then(
        code => finish(code === 0 ? undefined : new Error(`low-quota notifier exited ${code}`)),
        error => finish(error instanceof Error ? error : new Error("low-quota notifier failed")),
      );
    });
  };
}
