import { bootstrapApiSession, configureApiTargets, hasApiSession } from '../api';
import { apiBaseForPlane, discoverApiTargets, type ApiTargets } from '../api-targets';

/**
 * The tray popup is its own entry point (gui/src/main.tsx mounts it without App), so it has to run
 * App's target sequence itself before its first management request: discover the runtime's targets,
 * install them for the shared auth fetch, and on a connected client bootstrap the hub session. Every
 * tray request then goes to the shared plane, as App routes Usage and Providers. Without this the
 * popup stayed on the standalone targets and asked the local client runtime for hub data (#6920).
 */
export interface TrayTargetDeps {
  discover(initialBase: string, signal: AbortSignal): Promise<ApiTargets>;
  configure(targets: ApiTargets): void;
  hasSharedSession(): boolean;
  bootstrapShared(signal: AbortSignal): Promise<boolean>;
}

const DEFAULT_DEPS: TrayTargetDeps = {
  discover: discoverApiTargets,
  configure: configureApiTargets,
  hasSharedSession: () => hasApiSession('shared'),
  bootstrapShared: signal => bootstrapApiSession('shared', signal),
};

const cancelled = () => new DOMException('Tray target resolution cancelled', 'AbortError');

/** Resolves the base URL every tray request is sent to; rejects when discovery fails or is cancelled. */
export async function resolveTrayApiBase(
  signal: AbortSignal,
  initialBase: string = import.meta.env?.VITE_API_BASE || '',
  deps: TrayTargetDeps = DEFAULT_DEPS,
): Promise<string> {
  if (signal.aborted) throw cancelled();
  const targets = await deps.discover(initialBase, signal);
  if (signal.aborted) throw cancelled();
  deps.configure(targets);
  // A failed bootstrap is not fatal, exactly as in App: requests then meet the auth fetch's 401
  // recovery, and the popup reports what it cannot load.
  if (targets.connected && !deps.hasSharedSession()) await deps.bootstrapShared(signal);
  if (signal.aborted) throw cancelled();
  return apiBaseForPlane('shared', targets);
}
