// Termination signals a Node launcher relays to the child it starts. Windows has no real POSIX
// signals (no SIGHUP), so forwarding there is best-effort.
export function launcherForwardedSignals(platform = process.platform) {
  return platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
}

// Install the forwarders BEFORE spawning the child, then attach() the child once it exists.
// A listener registered only after spawn() returns leaves a window in which the child has already
// started (and may have written output a supervisor treats as ready) while a signal to the
// launcher still takes the default action: the launcher dies, its exit cleanup never runs, and
// the child is orphaned without ever seeing the signal. A signal observed before attach() is held
// and delivered to the child as soon as it is attached.
export function forwardLauncherSignals(deps = {}) {
  const parent = deps.parent ?? process;
  let child = null;
  let cleared = false;
  const pending = [];
  const send = signal => { try { child.kill(signal); } catch { /* child already exited */ } };
  const handlers = launcherForwardedSignals(deps.platform ?? process.platform).map(signal => {
    const handler = () => { if (child) send(signal); else pending.push(signal); };
    parent.on(signal, handler);
    return [signal, handler];
  });
  return {
    attach(spawned) {
      if (cleared || child) return;
      child = spawned;
      for (const signal of pending.splice(0)) send(signal);
    },
    clear() {
      if (cleared) return;
      cleared = true;
      for (const [signal, handler] of handlers) parent.removeListener(signal, handler);
    },
  };
}
