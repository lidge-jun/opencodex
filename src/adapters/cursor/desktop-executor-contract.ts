/**
 * Opt-in external executor for computer-use / record-screen. opencodex is a headless proxy and
 * cannot drive a screen itself; set these commands only when running on a host that can. Each
 * command receives the request as JSON on stdin and must print a JSON result on stdout.
 */
export interface DesktopExecutorConfig {
  /** Command (run via the platform shell) handling computer-use. Receives `{toolCallId, actions}` on stdin. */
  computerUseCommand?: string;
  /** Command handling record-screen. Receives `{mode, toolCallId, saveAsFilename?}` on stdin. */
  recordScreenCommand?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Max time to wait for the external process. Default 30s. */
  timeoutMs?: number;
}
