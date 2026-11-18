import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { TFn } from "../i18n/shared";
import { computeSelectMenuStyle } from "../select-position";
import { VISION_TIMEOUT_MS_MAX, VISION_TIMEOUT_MS_MIN } from "./dashboard-shared";

/** The Vision sidecar's advanced numbers (descriptions per turn, timeout) as a floating popover. */
export function VisionAdvancedPopover({ t, open, triggerRef, onClose, maxValue, maxInvalid, timeoutValue, timeoutInvalid, disabled, setMaxDraft, setMaxInvalid, setTimeoutDraft, setTimeoutInvalid, commitMaxDescriptions, commitTimeout }: {
  t: TFn;
  open: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  maxValue: string;
  maxInvalid: boolean;
  timeoutValue: string;
  timeoutInvalid: boolean;
  disabled: boolean;
  setMaxDraft: (v: string | null) => void;
  setMaxInvalid: (v: boolean) => void;
  setTimeoutDraft: (v: string | null) => void;
  setTimeoutInvalid: (v: boolean) => void;
  commitMaxDescriptions: (raw?: string) => void;
  commitTimeout: (raw?: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [style, setStyle] = useState<CSSProperties | undefined>();

  const reposition = useCallback(() => {
    if (!triggerRef.current) return;

    setStyle(computeSelectMenuStyle(
      triggerRef.current.getBoundingClientRect(),
      {
        align: "right",
        placement: "below",
        menuHeight: panelRef.current?.offsetHeight ?? 180,
      },
    ));
  }, [triggerRef]);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onViewportChange = () => reposition();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open, reposition, maxInvalid, timeoutInvalid]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;

      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && panelRef.current?.contains(activeElement)) {
        activeElement.blur();
      }

      onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, onClose, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose, triggerRef]);
  useEffect(() => {
    if (!open) return;
    firstInputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div ref={panelRef} id="dash-vision-advanced-popover" className="dash-vision-advanced-popover" role="dialog" aria-modal="false"
      aria-label={t("dash.visionAdvancedPopover") as string}
      style={{ ...style, zIndex: 60 }}>
      <div className="dash-vision-advanced-popover-title">{t("dash.visionAdvancedPopover")}</div>
      <label className="dash-vision-number">
        <span className="muted setting-hint" id="dash-vision-max-label">{t("dash.visionMaxDescriptions")}</span>
        <span className="codex-auto-switch-input-wrap">
          <input
            ref={firstInputRef}
            className="input mono codex-auto-switch-input"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={maxValue}
            disabled={disabled}
            aria-invalid={maxInvalid || undefined}
            aria-label={t("dash.visionMaxDescriptions")}
            aria-describedby={maxInvalid ? "dash-vision-max-error dash-vision-max-label" : "dash-vision-max-label"}
            onChange={event => {
              setMaxInvalid(false);
              setMaxDraft(event.target.value);
            }}
            onBlur={event => commitMaxDescriptions(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || disabled) return;
              if (event.key === "Enter") {
                event.preventDefault();
                commitMaxDescriptions(event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setMaxDraft(null);
                setMaxInvalid(false);
              }
            }}
          />
        </span>
        {maxInvalid && (
          <span id="dash-vision-max-error" className="muted setting-hint" role="alert">
            {t("dash.visionMaxDescriptionsInvalid")}
          </span>
        )}
      </label>
      <label className="dash-vision-number">
        <span className="muted setting-hint" id="dash-vision-timeout-label">{t("dash.visionTimeout")}</span>
        <span className="codex-auto-switch-input-wrap">
          <input
            className="input mono codex-auto-switch-input"
            type="number"
            min={VISION_TIMEOUT_MS_MIN}
            max={VISION_TIMEOUT_MS_MAX}
            step={1000}
            inputMode="numeric"
            value={timeoutValue}
            disabled={disabled}
            aria-invalid={timeoutInvalid || undefined}
            aria-label={t("dash.visionTimeout")}
            aria-describedby={timeoutInvalid ? "dash-vision-timeout-error dash-vision-timeout-label" : "dash-vision-timeout-label"}
            onChange={event => {
              setTimeoutInvalid(false);
              setTimeoutDraft(event.target.value);
            }}
            onBlur={event => commitTimeout(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || disabled) return;
              if (event.key === "Enter") {
                event.preventDefault();
                commitTimeout(event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setTimeoutDraft(null);
                setTimeoutInvalid(false);
              }
            }}
          />
          <span className="codex-auto-switch-unit" aria-hidden="true">ms</span>
        </span>
        {timeoutInvalid && (
          <span id="dash-vision-timeout-error" className="muted setting-hint" role="alert">
            {t("dash.visionTimeoutInvalid", { min: VISION_TIMEOUT_MS_MIN, max: VISION_TIMEOUT_MS_MAX })}
          </span>
        )}
      </label>
    </div>
  );
}
