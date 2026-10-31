import { IconMonitor, IconMoon, IconSun } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import { SegmentedControl } from "./ui-v2/segmented-control";

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
 * is selected, so the user picks a mode in one click instead of cycling through a single button
 * whose next state is hidden. Each option carries its mode name as tooltip and accessible name.
 * Design system v2: rendered as a segmented control whose thumb slides to the chosen mode.
 */
export function ThemeSwitch({ theme, onChange }: ThemeSwitchProps) {
  const t = useT();
  return (
    <SegmentedControl
      size="sm"
      aria-label={t("theme.label")}
      value={theme}
      onChange={onChange}
      items={MODES.map(({ mode, tkey, Icon }) => ({ value: mode, title: t(tkey), label: <Icon aria-hidden /> }))}
    />
  );
}
