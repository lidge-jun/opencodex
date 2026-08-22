import type { CodexAppServerStateResponse } from "../../src/lib/codex-restart-contract";
import { isCodexAppServerStateResponse } from "../../src/lib/codex-restart-contract";

export interface AppServerStateOutcome {
  /** Null means "render nothing" — never a guess about what Codex is showing. */
  state: CodexAppServerStateResponse["state"] | null;
  runningCount: number;
}

const UNKNOWN: AppServerStateOutcome = { state: null, runningCount: 0 };

/**
 * GET /api/system/codex-app-server.
 *
 * Fetched once on mount and on explicit refresh, never on a timer: enumeration
 * shells out to ps, procfs, or PowerShell CIM, and a polling banner would be the
 * kind of hidden work the models workspace already avoids for its own catalog.
 */
export async function fetchCodexAppServerState(
  apiBase: string,
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
): Promise<AppServerStateOutcome> {
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(`${apiBase}/api/system/codex-app-server`, {
      signal: options.signal,
    });
    if (!response.ok) return UNKNOWN;
    const body = await response.json().catch(() => null) as unknown;
    // Reuse the contract's guard rather than re-deriving a weaker one here.
    if (!isCodexAppServerStateResponse(body)) return UNKNOWN;
    return { state: body.state, runningCount: body.runningCount };
  } catch {
    // Includes AbortError on unmount. A failed reading renders nothing rather
    // than asserting a state the proxy never reported.
    return UNKNOWN;
  }
}

