export interface ForegroundShellResult {
  stdout: string;
  stderr: string;
  code: number;
  aborted: boolean;
  signal: string;
}

/** Keep the transport's shutdown fence even while foreground execution is unavailable. */
export class CursorForegroundShellOwner {
  private closed = false;

  get activeCount(): number { return 0; }
  get isClosed(): boolean { return this.closed; }

  async close(): Promise<void> { this.closed = true; }
}

export function foregroundShellUnavailableMessage(redirectHint?: string): string {
  return "Cursor foreground native shell is unavailable without kernel-backed descendant ownership. "
    + (redirectHint ?? "Use the client shell tool instead.");
}

export function runForegroundShell(
  _command: string,
  _cwd: string,
  _hardTimeout: number,
  owner = new CursorForegroundShellOwner(),
  signal?: AbortSignal,
  redirectHint?: string,
): Promise<ForegroundShellResult> {
  // A POSIX process group is not a descendant owner: a child can leave it with
  // setsid(), including after closing its inherited pipes. Windows needs a job
  // object for the same lifetime guarantee. Neither backend exists here, so reject
  // BEFORE spawn rather than reporting group disappearance as complete cleanup.
  const cancelled = owner.isClosed || signal?.aborted;
  return Promise.resolve({
    stdout: "",
    stderr: cancelled ? "Cursor shell cancelled." : foregroundShellUnavailableMessage(redirectHint),
    code: 1,
    aborted: true,
    signal: "",
  });
}
