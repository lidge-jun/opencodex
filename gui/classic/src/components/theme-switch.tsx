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
 * Icon-only theme switch for the sidebar foot. All three modes stay visible and the current one
 * is filled, so the user picks a mode in one click instead of cycling through a single button
 * whose next state is hidden. Each button carries its mode name as tooltip and accessible name.
 */
export function ThemeSwitch({ theme, onChange }: ThemeSwitchProps) {
  const t = useT();
  return (
    <div className="theme-switch" role="group" aria-label={t("theme.label")}>
      {MODES.map(({ mode, tkey, Icon }) => (
        <button key={mode} type="button" className="theme-switch__btn" aria-pressed={theme === mode}
          aria-label={t(tkey)} title={t(tkey)} onClick={() => onChange(mode)}>
          <Icon aria-hidden />
        </button>
      ))}
    </div>
  );
}
