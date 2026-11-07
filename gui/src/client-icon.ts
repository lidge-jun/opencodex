const MONOCHROME_CLIENT_ICONS = new Set(["grok.svg", "opencode.svg", "aside.svg"]);

/** Invert only dark monochrome marks in dark themes; preserve colored brand marks. */
export function clientIconClass(icon: string): string {
  return `usage-source-mark${MONOCHROME_CLIENT_ICONS.has(icon) ? " usage-source-mark--mono" : ""}`;
}
