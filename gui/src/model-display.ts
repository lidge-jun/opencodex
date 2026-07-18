/**
 * Global model display-name mapping: renders an inline SVG icon for recognized
 * model slugs. Used across all GUI surfaces (dropdowns, tables, badges) so the
 * 5.6 trio is instantly distinguishable. No emoji — Lucide-style SVG only.
 */
import { createElement, type ReactNode } from "react";
import { IconSun, IconGlobe, IconMoon } from "./icons";

type IconComponent = typeof IconSun;

const MODEL_ICON_MAP: Record<string, IconComponent> = {
  "gpt-5.6-sol": IconSun,
  "gpt-5.6-terra": IconGlobe,
  "gpt-5.6-luna": IconMoon,
};

const ICON_STYLE = { width: 14, height: 14, flexShrink: 0, verticalAlign: "text-bottom" as const, marginRight: 4 };

/** Resolve the bare slug from a potentially provider-prefixed id. */
function bareSlug(slug: string): string {
  return slug.slice(slug.lastIndexOf("/") + 1);
}

/** Return the icon component for a model slug, or null. */
function resolveIcon(slug: string): IconComponent | null {
  return MODEL_ICON_MAP[slug] ?? MODEL_ICON_MAP[bareSlug(slug)] ?? null;
}

/** Render a model name with an inline SVG icon prefix (ReactNode). Falls back to plain text. */
export function modelLabel(slug: string): ReactNode {
  const Icon = resolveIcon(slug);
  if (!Icon) return slug;
  return createElement("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
    createElement(Icon, { style: ICON_STYLE }),
    slug,
  );
}
