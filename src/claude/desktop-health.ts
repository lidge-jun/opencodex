/** In-memory Desktop health tracker (resets on server restart). */

interface DesktopHealthState {
  lastRequestAt: number | null;
  requestCount: number;
  errorCount: number;
}

const state: DesktopHealthState = { lastRequestAt: null, requestCount: 0, errorCount: 0 };

export function recordDesktopRequest(): void {
  state.lastRequestAt = Date.now();
  state.requestCount++;
}

export function recordDesktopError(): void {
  state.errorCount++;
}

export function getDesktopHealth(): { lastRequestAt: string | null; requestCount: number; errorCount: number } {
  return {
    lastRequestAt: state.lastRequestAt !== null ? new Date(state.lastRequestAt).toISOString() : null,
    requestCount: state.requestCount,
    errorCount: state.errorCount,
  };
}
