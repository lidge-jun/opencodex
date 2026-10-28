// Best-effort known-pattern regression lint, not a security boundary or
// completeness proof. Runtime mutation guards enforce update authority.
// Exact existing terminal/probe lifecycle sites. No arbitrary process API is admitted.
export const updateProcessAllowlist: readonly (readonly [string, string, number])[] = [
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.exit(1)","terminal failure only; cannot publish successful update",29],
  ["bin/ocx.mjs:runPackageManagerSelfUpdate:process.exit(0)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:fail:process.exit(1)","terminal failure only; cannot publish successful update",1],
  ["bin/ocx.mjs:<module>:process.exit(0)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",3],
  ["bin/ocx.mjs:<module>:process.exit(2)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:<module>:process.exit(1)","terminal failure only; cannot publish successful update",5],
  ["bin/ocx.mjs:<module>:process.exit(127)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:<module>:process.exit(result.code)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["bin/ocx.mjs:<module>:process.on(sig, handler)","ordinary launcher signal relay registration/cleanup",1],
  ["bin/ocx.mjs:<module>:process.removeListener(sig, handler)","ordinary launcher signal relay registration/cleanup",1],
  ["bin/ocx.mjs:<module>:process.exit(code ?? 1)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["src/update/index.ts:runUpdate:process.exit(1)","terminal failure only; cannot publish successful update",4],
  ["src/update/index.ts:runUpdate:process.exit(updateExitCode)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["src/update/job.ts:defaultProbeProxyIdentity:fetch(`http://${probeHostname(hostname)}:${port}/healthz`, { signal: AbortSignal.timeout(750), })","bounded loopback health observation, no update control",1],
  ["src/update/notify.ts:maybeShowUpdatePrompt:process.exit(0)","ordinary launcher/help/probe or terminal prompt outcome; update success remains guarded",1],
  ["src/update/service-home-probe-entry.ts:<module>:process.exit(1)","terminal failure only; cannot publish successful update",1],
];
