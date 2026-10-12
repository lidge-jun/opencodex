import { readConfigDiagnostics } from "../config/diagnostics";
import { readRuntimePort } from "../config/process-state";
import { packageVersion } from "./help";
import { proxyIdentityAt } from "../server/proxy-liveness";
import { computeVersionSkew } from "./version-skew";

const LIFECYCLE = new Set(["start", "stop", "restart", "update", "service"]);
const NOTICE_DEADLINE_MS = 200;
let printed = false;

export function shouldNoticeVersionSkew(command: string | undefined, args: string[]): boolean {
  const boundary = args.indexOf("--");
  const prefix = boundary < 0 ? args : args.slice(0, boundary);
  return LIFECYCLE.has(command ?? "")
    && !prefix.some(arg => arg === "--json" || arg === "--help" || arg === "-h")
    && prefix[1] !== "help";
}

export interface VersionSkewNoticeIo {
  readRuntime?: typeof readRuntimePort;
  readConfig?: typeof readConfigDiagnostics;
  probe?: typeof proxyIdentityAt;
  cliVersion?: () => string;
  now?: () => number;
  warn?: (message: string) => void;
}

/**
 * One proxyIdentityAt (src/server/proxy-liveness.ts) call validates /healthz identity,
 * expected PID and terminal-safe version within the total diagnostic budget.
 */
export async function maybeNoticeVersionSkew(
  command: string | undefined, args: string[], io: VersionSkewNoticeIo = {},
): Promise<void> {
  if (printed || !shouldNoticeVersionSkew(command, args)) return;
  const now = io.now ?? Date.now;
  const deadlineAt = now() + NOTICE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const runtime = (io.readRuntime ?? readRuntimePort)();
    let port: number;
    let hostname: string | undefined;
    let expectedPid: number | undefined;
    if (runtime) {
      ({ port, hostname } = runtime);
      expectedPid = runtime.pid;
    } else {
      const diagnostics = (io.readConfig ?? readConfigDiagnostics)();
      if (diagnostics.error) return;
      port = diagnostics.config.port ?? 10100;
      hostname = diagnostics.config.hostname;
    }
    const remaining = Math.floor(deadlineAt - now());
    if (remaining <= 0) return;
    const cliVersion = (io.cliVersion ?? packageVersion)();
    if (now() >= deadlineAt) return;
    const identity = await Promise.race([
      (io.probe ?? proxyIdentityAt)(port, { hostname, expectedPid }, {
        timeoutMs: Math.max(1, Math.floor(deadlineAt - now())),
        attempts: 1, deadlineAt, nowFn: now,
      }),
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), Math.max(1, deadlineAt - now()));
      }),
    ]);
    if (printed || !identity || now() >= deadlineAt) return;
    const skew = computeVersionSkew(cliVersion, identity.version);
    if (!skew.skewed) return;
    printed = true;
    (io.warn ?? console.error)(`ocx ${cliVersion} does not match the running proxy ${identity.version}. `
      + "Check which opencodex installation you meant to use (`ocx status` shows both).");
  } catch {
    // Best-effort diagnostics must not fail a lifecycle command or change its exit code.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
