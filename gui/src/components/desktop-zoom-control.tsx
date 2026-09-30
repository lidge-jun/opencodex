import { IconMinus, IconPlus } from "../icons";
import { useT } from "../i18n/shared";
import type { ZoomAction } from "../lib/desktop-zoom";

interface DesktopZoomControlProps {
  percent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onStep: (action: ZoomAction) => void;
}

/** Sidebar row for the desktop window's page zoom; the same steps as Ctrl/Cmd + plus, minus and zero. */
export function DesktopZoomControl({ percent, canZoomIn, canZoomOut, onStep }: DesktopZoomControlProps) {
  const t = useT();
  return (
    <div className="zoom-control" role="group" aria-label={t("zoom.label")}>
      <span className="zoom-control__label">{t("zoom.label")}</span>
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
