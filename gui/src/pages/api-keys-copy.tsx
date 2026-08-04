/**
 * Click-to-copy primitives shared by the endpoint list and the curl examples.
 * Extracted so neither of the panels that use them has to carry the tooltip
 * portal machinery.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/shared";

export function EndpointUrl({ url }: { url: string }) {
  return (
    <CopyOnClickTip
      text={url}
      hintKey="api.copyUrlHint"
      copiedKey="api.urlCopied"
      className="api-endpoint-url-btn"
    >
      <code className="api-code api-code-inline api-endpoint-url">{url}</code>
    </CopyOnClickTip>
  );
}

function CopyOnClickTip({
  text,
  hintKey,
  copiedKey,
  className,
  children,
}: {
  text: string;
  hintKey: "api.copyUrlHint" | "api.copyExampleHint";
  copiedKey: "api.urlCopied" | "api.exampleCopied";
  className: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const tipId = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const showTip = hover || copied;

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  useLayoutEffect(() => {
    // No reset on close: the portal and aria-describedby are already gated on showTip,
    // and reopening remeasures in this same layout effect before paint. Clearing here
    // only forced a second render.
    if (!showTip) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setCoords({
        top: Math.max(8, rect.top - 8),
        left: rect.left + rect.width / 2,
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [showTip]);

  const openTip = () => setHover(true);
  const closeTip = () => setHover(false);

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const tip = showTip && coords
    ? createPortal(
      <span
        id={tipId}
        className="ocx-tooltip-bubble api-copy-tip-fixed"
        role="tooltip"
        style={{ top: coords.top, left: coords.left }}
      >
        {copied ? t(copiedKey) : t(hintKey)}
      </span>,
      document.body,
    )
    : null;

  const shared = {
    ref: anchorRef as never,
    className: `ocx-tooltip ${className}`,
    onMouseEnter: openTip,
    onMouseLeave: closeTip,
    onFocus: openTip,
    onBlur: closeTip,
    onClick: (event: { currentTarget: EventTarget & Element; target: EventTarget | null; clientX: number; clientY: number }) => {
      if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
      const target = event.target;
      if (target instanceof HTMLElement && target !== event.currentTarget) {
        const rect = target.getBoundingClientRect();
        if (target.scrollHeight > target.clientHeight + 1 && event.clientX >= rect.right - 16) return;
        if (target.scrollWidth > target.clientWidth + 1 && event.clientY >= rect.bottom - 16) return;
      }
      void copyText();
    },
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key === "Escape") closeTip();
    },
    "aria-label": t(hintKey),
    "aria-describedby": showTip ? tipId : undefined,
  };

  return (
    <>
      <button type="button" {...shared}>
        {children}
      </button>
      {tip}
    </>
  );
}

export function CopyableExample({ text }: { text: string }) {
  return (
    <CopyOnClickTip
      text={text}
      hintKey="api.copyExampleHint"
      copiedKey="api.exampleCopied"
      className="api-example-copy-btn"
    >
      <code className="api-code api-example-pre">{text}</code>
    </CopyOnClickTip>
  );
}
