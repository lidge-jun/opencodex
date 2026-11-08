import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

/**
 * Keep the process-group leader alive until shutdown. Only group members signal group 0;
 * the parent never sends a negative PID that could have been reused after the CLI exited.
 * A private pipe requests shutdown and also closes when the proxy dies.
 */
export const TRAE_POSIX_SUPERVISOR = String.raw`
grace=$1
shift
stop_group() {
  trap '' TERM INT HUP
  kill -TERM 0 2>/dev/null || :
  ( /bin/sleep "$grace"; kill -KILL 0 ) &
  wait "$cli" 2>/dev/null || :
  kill -KILL 0
}
trap stop_group TERM INT HUP
exec 4<&0
(
  trap - TERM INT HUP
  exec 0<&- 1>&- 2>&- 4<&-
  IFS= read -r stop <&3 || :
  kill -TERM 0
) &
guard=$!
"$@" <&4 3<&- 4<&- &
cli=$!
exec 4<&-
wait "$cli"
status=$?
case "$status" in 126|127) printf 'OCX_TRAE_LAUNCH:%s\n' "$status" >&3 ;; esac
exec 3<&-
exec 0<&- 1>&- 2>&-
wait "$guard"
stop_group
`;

/** Preserve argv boundaries; the CLI path and arguments are never interpolated into shell code. */
export function traePosixInvocation(file: string, args: readonly string[], graceMs: number): { file: string; args: string[] } {
  const seconds = Math.max(0, Number.isFinite(graceMs) ? graceMs : 2000) / 1000;
  return { file: "/bin/sh", args: ["-c", TRAE_POSIX_SUPERVISOR, "ocx-trae-cn-supervisor", String(seconds), file, ...args] };
}

/** The private descriptor identifies the owned supervisor without consulting a numeric PID. */
export function traeStopPipe(child: ChildProcess): Writable | undefined {
  const pipe = child.stdio?.[3];
  return pipe && "write" in pipe ? pipe as Writable : undefined;
}
