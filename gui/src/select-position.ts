import type { CSSProperties } from "react";

export interface SelectMenuTriggerRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export interface SelectMenuStyleOptions {
  align?: "left" | "right";
  placement?: "below" | "right";
  menuHeight?: number;
}

const MENU_GAP_PX = 4;
const FLIP_GAP_PX = 8;
const VIEWPORT_PAD_PX = 8;
const MAX_MENU_HEIGHT_PX = 280;
const MIN_MENU_HEIGHT_PX = 120;
const BESIDE_MIN_WIDTH_PX = 160;

function viewportHeight() {
  return typeof window !== "undefined" ? window.innerHeight : 800;
}

function viewportWidth() {
  return typeof window !== "undefined" ? window.innerWidth : 1024;
}

export function computeSelectMenuStyle(
  trigger: SelectMenuTriggerRect,
  { align = "left", placement = "below", menuHeight = MAX_MENU_HEIGHT_PX }: SelectMenuStyleOptions = {},
): CSSProperties {
  const measuredHeight = Math.min(Math.max(menuHeight, MIN_MENU_HEIGHT_PX), MAX_MENU_HEIGHT_PX);
  const vh = viewportHeight();
  const vw = viewportWidth();

  if (placement === "right") {
    const spaceBelow = vh - trigger.top - VIEWPORT_PAD_PX;
    const spaceAbove = trigger.top - VIEWPORT_PAD_PX;
    const openAbove = measuredHeight + FLIP_GAP_PX > spaceBelow && spaceAbove > spaceBelow;
    const left = Math.max(VIEWPORT_PAD_PX, Math.min(trigger.right + 6, vw - BESIDE_MIN_WIDTH_PX - VIEWPORT_PAD_PX));

    if (openAbove) {
      return {
        position: "fixed",
        left,
        bottom: vh - trigger.top + FLIP_GAP_PX,
        minWidth: BESIDE_MIN_WIDTH_PX,
        maxHeight: Math.max(MIN_MENU_HEIGHT_PX, Math.min(MAX_MENU_HEIGHT_PX, trigger.top - VIEWPORT_PAD_PX - MENU_GAP_PX)),
      };
    }

    return {
      position: "fixed",
      top: trigger.top,
      left,
      minWidth: BESIDE_MIN_WIDTH_PX,
      maxHeight: Math.max(MIN_MENU_HEIGHT_PX, Math.min(MAX_MENU_HEIGHT_PX, vh - trigger.top - VIEWPORT_PAD_PX)),
    };
  }

  const width = Math.max(trigger.width, 0);
  const spaceBelow = vh - trigger.bottom - VIEWPORT_PAD_PX;
  const spaceAbove = trigger.top - VIEWPORT_PAD_PX;
  const flipUp = measuredHeight + MENU_GAP_PX > spaceBelow && spaceAbove > spaceBelow;

  if (flipUp) {
    const style: CSSProperties = {
      position: "fixed",
      bottom: vh - trigger.top + FLIP_GAP_PX,
      minWidth: width,
      maxHeight: Math.max(MIN_MENU_HEIGHT_PX, spaceAbove - MENU_GAP_PX),
    };
    if (align === "right") {
      style.right = vw - trigger.right;
    } else {
      style.left = Math.max(VIEWPORT_PAD_PX, Math.min(trigger.left, vw - VIEWPORT_PAD_PX - width));
    }
    return style;
  }

  const style: CSSProperties = {
    position: "fixed",
    top: trigger.bottom + MENU_GAP_PX,
    minWidth: width,
    maxHeight: Math.max(MIN_MENU_HEIGHT_PX, Math.min(MAX_MENU_HEIGHT_PX, spaceBelow - MENU_GAP_PX)),
  };
  if (align === "right") {
    style.right = vw - trigger.right;
  } else {
    style.left = Math.max(VIEWPORT_PAD_PX, Math.min(trigger.left, vw - VIEWPORT_PAD_PX - width));
  }
  return style;
}
