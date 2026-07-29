/**
 * Speed-badge text for one request log row.
 *
 * The badge reports what THIS request asked for, never what the dashboard is
 * currently configured to ask for (#689).
 *
 * Codex represents Standard as the `default` sentinel and omits it from the
 * outbound request, so an absent `requestedSpeedLabel` means "this request did
 * not ask for Fast" — not "we don't know". Filling that gap with the global
 * configured label painted a Fast badge on Standard requests whenever Fast had
 * been selected in some other task, which is a guess wearing an observation's
 * clothes.
 */
export function speedLabel(log: {
  requestedSpeedLabel?: string;
}): string | undefined {
  return log.requestedSpeedLabel || undefined;
}
