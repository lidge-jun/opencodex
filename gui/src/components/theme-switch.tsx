import { IconMonitor, IconMoon, IconSun } from "../icons";
import { useT, type TKey } from "../i18n/shared";

export type ThemeMode = "light" | "dark" | "system";

const MODES: ReadonlyArray<{ mode: ThemeMode; tkey: TKey; Icon: typeof IconSun }> = [
  { mode: "light", tkey: "theme.light", Icon: IconSun },
  { mode: "dark", tkey: "theme.dark", Icon: IconMoon },
  { mode: "system", tkey: "theme.system", Icon: IconMonitor },
];

interface ThemeSwitchProps {
  theme: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

/**
 * One-button theme switch for the sidebar foot, sized like the GitHub row's orbs it sits with.
 * A click steps light → dark → system. The icon shows the current mode, and because a single
 * button hides what comes next, its accessible name and tooltip spell out both the current mode
 * and the one a click switches to.
 */
export function ThemeSwitch({ theme, onChange }: ThemeSwitchProps) {
  const t = useT();
  const index = Math.max(0, MODES.findIndex(entry => entry.mode === theme));
  const current = MODES[index]!;
  const next = MODES[(index + 1) % MODES.length]!;
  const label = t("shellV2.themeCycle", { mode: t(current.tkey), next: t(next.tkey) });
  return (
    <button
      type="button"
      className="sidebar-orb sidebar-theme-toggle"
      data-mode={theme}
      onClick={() => onChange(next.mode)}
      aria-label={label}
      title={label}
    >
      <current.Icon aria-hidden="true" />
    </button>
  );
}
