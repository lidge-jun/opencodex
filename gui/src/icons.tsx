/* Inline SVG icons (Lucide-style, stroke=currentColor). No icon-library dependency. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const S = (props: P) => ({
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props,
});

export const IconGrid = (p: P) => (<svg {...S(p)}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>);
export const IconServer = (p: P) => (<svg {...S(p)}><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>);
export const IconBoxes = (p: P) => (<svg {...S(p)}><path d="M12 2 4 6v6l8 4 8-4V6l-8-4Z"/><path d="m4 6 8 4 8-4M12 10v8"/></svg>);
export const IconBot = (p: P) => (<svg {...S(p)}><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M8 2h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>);
export const IconList = (p: P) => (<svg {...S(p)}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>);
export const IconMenu = (p: P) => (<svg {...S(p)}><path d="M4 6h16M4 12h16M4 18h16"/></svg>);
export const IconTerminal = (p: P) => (<svg {...S(p)}><path d="m4 17 6-5-6-5"/><path d="M12 19h8"/></svg>);
export const IconActivity = (p: P) => (<svg {...S(p)}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>);
/** Scatter / frontier chart — guide page nav. */
export const IconChart = (p: P) => (
  <svg {...S(p)}>
    <path d="M3 3v18h18" />
    <circle cx="8" cy="14" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="13" cy="9" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCheck = (p: P) => (<svg {...S(p)}><path d="m20 6-11 11-5-5"/></svg>);
export const IconX = (p: P) => (<svg {...S(p)}><path d="M18 6 6 18M6 6l12 12"/></svg>);
export const IconPlus = (p: P) => (<svg {...S(p)}><path d="M12 5v14M5 12h14"/></svg>);
export const IconRefresh = (p: P) => (<svg {...S(p)}><path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16M3 21v-5h5M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8M21 3v5h-5"/></svg>);
export const IconTrash = (p: P) => (<svg {...S(p)}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>);
export const IconAlert = (p: P) => (<svg {...S(p)}><path d="M10.3 3.7 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>);
export const IconInfo = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>);
export const IconSearch = (p: P) => (<svg {...S(p)}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>);
export const IconArrowUp = (p: P) => (<svg {...S(p)}><path d="M12 19V5M5 12l7-7 7 7"/></svg>);
export const IconArrowDown = (p: P) => (<svg {...S(p)}><path d="M12 5v14M19 12l-7 7-7-7"/></svg>);
export const IconChevron = (p: P) => (<svg {...S(p)}><path d="m9 18 6-6-6-6"/></svg>);
export const IconGithub = (p: P) => (<svg {...S(p)}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 20 4.8 4.9 4.9 0 0 0 19.9 1S18.7.6 16 2.5a13.4 13.4 0 0 0-7 0C6.3.6 5.1 1 5.1 1A4.9 4.9 0 0 0 5 4.8a5.2 5.2 0 0 0-1.4 3.7c0 5.1 3.1 6.4 6.1 6.7a3.4 3.4 0 0 0-.9 2.5V22"/></svg>);
export const IconPower = (p: P) => (<svg {...S(p)}><path d="M18.4 5.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/></svg>);
export const IconExternal = (p: P) => (<svg {...S(p)}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>);
export const IconKey = (p: P) => (<svg {...S(p)}><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.6-9.6M16 7l3 3M14 9l2 2"/></svg>);

export const IconLock = (p: P) => (<svg {...S(p)}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>);
export const IconTicket = (p: P) => (<svg {...S(p)}><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>);
export const IconLink = (p: P) => (<svg {...S(p)}><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>);
export const IconSun = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>);
export const IconMoon = (p: P) => (<svg {...S(p)}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>);
export const IconMonitor = (p: P) => (<svg {...S(p)}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>);
export const IconGlobe = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>);
export const IconSparkle = (p: P) => (<svg {...S(p)}><path d="M12 3v18M5.6 5.6l12.8 12.8M3 12h18M5.6 18.4 18.4 5.6"/></svg>);
/** Crossed arrows — Combos workspace nav / rail marker (load-balance / hop). */
export const IconShuffle = (p: P) => (
  <svg {...S(p)}>
    <path d="m18 14 4 4-4 4" />
    <path d="m18 2 4 4-4 4" />
    <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
    <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
    <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
  </svg>
);
export const IconGrip = (p: P) => (
  <svg {...S(p)}>
    <circle cx="9" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1" fill="currentColor" stroke="none" />
  </svg>
);
export const IconStar = (p: P) => (<svg {...S(p)}><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>);
export const IconFilter = (p: P) => (<svg {...S(p)}><path d="M4 5h16l-6 7v5l-4 2v-7L4 5z"/></svg>);
