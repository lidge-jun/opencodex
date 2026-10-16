import { IconMinus, IconPlus } from "../icons";
import { useT } from "../i18n/shared";
import type { ZoomAction } from "../lib/desktop-zoom";

interface DesktopZoomControlProps {
  percent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onStep: (action: ZoomAction) => void;
}

/**
 * Icon-only page-zoom stepper for the desktop window; the same steps as Ctrl/Cmd + plus, minus
 * and zero. It shares the theme row in the sidebar foot, so it carries no visible label of its own:
 * the group name and each button's tooltip say what it does.
 */
export function DesktopZoomControl({ percent, canZoomIn, canZoomOut, onStep }: DesktopZoomControlProps) {
  const t = useT();
  return (
    <div className="zoom-control" role="group" aria-label={t("zoom.label")} title={t("zoom.label")}>
      <button type="button" className="zoom-control__btn" disabled={!canZoomOut}
        onClick={() => onStep("out")} aria-label={t("zoom.out")} title={t("zoom.out")}>
        <IconMinus aria-hidden />
      </button>
      <button type="button" className="zoom-control__value" onClick={() => onStep("reset")}
        aria-label={t("zoom.reset")} title={t("zoom.reset")}>
        {percent}%
      </button>
      <button type="button" className="zoom-control__btn" disabled={!canZoomIn}
        onClick={() => onStep("in")} aria-label={t("zoom.in")} title={t("zoom.in")}>
        <IconPlus aria-hidden />
      </button>
    </div>
  );
}
