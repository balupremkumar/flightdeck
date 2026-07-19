// ============================================================
// Flightdeck — Deep Cove icon set
// One grid: viewBox 0 0 20 20, strokeWidth 1.6, round caps/joins,
// optically tuned for the 16px render most call sites use.
// Bell keeps ibell-arc-1 / ibell-arc-2 for the radar-ping keyframes.
// Drag is a 6-dot grip. Settings knobs fill with var(--surface).
// ============================================================
import type { SVGProps } from "react";

// Call sites pass `size` (default 16, matching the previous set). Everything
// else is a normal SVG prop (className, style, onClick, ...).
type IconProps = Omit<SVGProps<SVGSVGElement>, "width" | "height"> & { size?: number };

const Svg = ({ size = 16, ...p }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...p}
  />
);

export const IconBrand = (p: IconProps) => (
  <Svg {...p}><path d="M10 3 L16.5 16 L10 12.5 L3.5 16 Z" /></Svg>
);
export const IconPanel = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4.5" width="14" height="11" rx="2" /><path d="M8 4.5 V15.5" /></Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M10 4.5 V15.5" /><path d="M4.5 10 H15.5" /></Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M5.5 5.5 L14.5 14.5" /><path d="M14.5 5.5 L5.5 14.5" /></Svg>
);
export const IconChevron = (p: IconProps) => (
  <Svg {...p}><path d="M8 5 L13 10 L8 15" /></Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M15.7 6.6 A6 6 0 1 0 16.3 11" /><path d="M15.8 3.6 L15.8 6.9 L12.5 6.9" /></Svg>
);
export const IconBranch = (p: IconProps) => (
  <Svg {...p}><circle cx="6" cy="6" r="1.8" /><circle cx="6" cy="14" r="1.8" /><circle cx="14" cy="7" r="1.8" /><path d="M6 7.8 V12.2" /><path d="M6 10.5 A5 5 0 0 0 12.1 8.4" /></Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}><path d="M3 6.6 a1.6 1.6 0 0 1 1.6 -1.6 h3 l2 2 h5.4 a1.6 1.6 0 0 1 1.6 1.6 v5.8 a1.6 1.6 0 0 1 -1.6 1.6 h-11 a1.6 1.6 0 0 1 -1.6 -1.6 Z" /></Svg>
);
export const IconFile = (p: IconProps) => (
  <Svg {...p}><path d="M6 3.5 h5 l4 4 v9 a1 1 0 0 1 -1 1 h-8 a1 1 0 0 1 -1 -1 v-12 a1 1 0 0 1 1 -1 Z" /><path d="M11 3.5 V7.5 H15" /></Svg>
);
export const IconBoard = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="3.6" height="11" rx="1" /><rect x="8.2" y="4.5" width="3.6" height="7.5" rx="1" /><rect x="12.9" y="4.5" width="3.6" height="9" rx="1" /></Svg>
);
export const IconWorkspace = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="4.5" width="13" height="11" rx="2" /><path d="M3.5 8 H16.5" /><circle cx="6" cy="6.2" r="0.5" fill="currentColor" /></Svg>
);
export const IconDrag = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="5" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="5" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="8" cy="15" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="15" r="1" fill="currentColor" stroke="none" /></Svg>
);
export const IconAgent = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4.5" width="14" height="11" rx="2" /><path d="M6.5 8.5 L9 10.5 L6.5 12.5" /><path d="M10.5 12.5 H13.5" /></Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}><path d="M4 6.5 H16" /><path d="M4 10 H16" /><path d="M4 13.5 H16" /><circle cx="8" cy="6.5" r="1.7" fill="var(--surface)" /><circle cx="13" cy="10" r="1.7" fill="var(--surface)" /><circle cx="7" cy="13.5" r="1.7" fill="var(--surface)" /></Svg>
);
export const IconBell = ({ className, ...p }: IconProps) => (
  <Svg {...p} className={["icon-bell", className].filter(Boolean).join(" ")}>
    <path d="M10 3.2 a4.6 4.6 0 0 1 4.6 4.6 v2.8 l1.4 2 h-12 l1.4 -2 v-2.8 a4.6 4.6 0 0 1 4.6 -4.6 Z" />
    <path d="M8.3 16 a1.7 1.7 0 0 0 3.4 0" />
    <path className="ibell-arc-1" d="M15.8 5 a3 3 0 0 1 0.9 2.1" />
    <path className="ibell-arc-2" d="M17 3.5 a5 5 0 0 1 1.3 3.6" />
  </Svg>
);

// New icons introduced by the redesign (custom title bar / pane controls) ---
export const IconMinimize = (p: IconProps) => (
  <Svg {...p}><path d="M5 10 H15" /></Svg>
);
export const IconMaximize = (p: IconProps) => (
  <Svg {...p}><rect x="5" y="5" width="10" height="10" rx="1.5" /></Svg>
);
export const IconMaximizePane = (p: IconProps) => (
  <Svg {...p}><path d="M4.5 8 V4.5 H8" /><path d="M15.5 8 V4.5 H12" /><path d="M4.5 12 V15.5 H8" /><path d="M15.5 12 V15.5 H12" /></Svg>
);
export const IconOverflow = (p: IconProps) => (
  <Svg {...p}><circle cx="5" cy="10" r="1.2" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.2" fill="currentColor" stroke="none" /><circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none" /></Svg>
);
export const IconWindowClose = IconClose;

// Light/dark toggle — a half-filled contrast disc.
export const IconTheme = (p: IconProps) => (
  <Svg {...p}><circle cx="10" cy="10" r="6.3" /><path d="M10 3.7 A6.3 6.3 0 0 0 10 16.3 Z" fill="currentColor" stroke="none" /></Svg>
);

// Broadcast — radio-waves fanning off a beacon dot, matching IconAgent's
// footprint so it can drop into the same topbar slot.
export const IconBroadcast = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="1.7" fill="currentColor" stroke="none" />
    <path d="M6.8 7.2 a4.2 4.2 0 0 0 0 5.6" />
    <path d="M13.2 7.2 a4.2 4.2 0 0 1 0 5.6" />
    <path d="M4.3 4.6 a7.8 7.8 0 0 0 0 10.8" />
    <path d="M15.7 4.6 a7.8 7.8 0 0 1 0 10.8" />
  </Svg>
);

// Terminal chevron (prompt) with a small plus badge — "new terminal".
export const IconTerminalPlus = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="4.5" width="11" height="9.5" rx="1.6" />
    <path d="M5 8 L7.3 9.9 L5 11.8" />
    <path d="M8.2 11.8 H10.6" />
    <path d="M15 12.5 V17.5" />
    <path d="M12.5 15 H17.5" />
  </Svg>
);

// Diff / compare — two columns with change ticks; the review-surface glyph.
export const IconDiff = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3.5" width="6" height="13" rx="1.3" />
    <rect x="11" y="3.5" width="6" height="13" rx="1.3" />
    <path d="M6 6.6 V9.4" />
    <path d="M4.6 8 H7.4" />
    <path d="M12.6 12 H15.4" />
  </Svg>
);

// Merge — two branch dots joining into one line (merge-back action).
export const IconMerge = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.5" cy="5.5" r="1.8" />
    <circle cx="5.5" cy="14.5" r="1.8" />
    <circle cx="14.5" cy="10" r="1.8" />
    <path d="M5.5 7.3 a6.5 6.5 0 0 0 7.2 2.7" />
    <path d="M5.5 12.7 a6.5 6.5 0 0 1 7.2 -2.7" />
  </Svg>
);

// Commit — a dot on a line (git commit).
export const IconCommit = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="2.6" />
    <path d="M2.8 10 H7.4" />
    <path d="M12.6 10 H17.2" />
  </Svg>
);

// Wipe — a destructive full-reset glyph (trash-adjacent), distinct from the
// circular refresh arrow used for the harmless per-pane restart.
export const IconWipe = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 6.2 H15" />
    <path d="M7.3 6.2 V4.6 a1 1 0 0 1 1 -1 h3.4 a1 1 0 0 1 1 1 v1.6" />
    <path d="M6.1 6.2 L6.8 15 a1.2 1.2 0 0 0 1.2 1.1 h4 a1.2 1.2 0 0 0 1.2 -1.1 l0.7 -8.8" />
    <path d="M8.7 9 V13.2" />
    <path d="M11.3 9 V13.2" />
  </Svg>
);
