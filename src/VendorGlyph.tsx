// VendorGlyph — UI-236 / UI-219.
//
// Vendors were distinguished by colour alone, which fails twice: colour-blind
// users can't separate them, and a monogram is faster to scan than a hue even
// for those who can. This renders a small tinted badge carrying the vendor's
// initial(s), so identity survives in greyscale, in High Contrast, and at a
// glance.
import { vendorColor, vendorMeta } from "./vendors";

/** One or two characters that read as "which agent". Derived from the short
 *  name so a manifest vendor gets a sensible badge for free. */
export function vendorInitials(id: string): string {
  const short = vendorMeta(id).short || id;
  // "Git Bash" -> "GB", "OpenCode" -> "OC", "claude" -> "CL"
  const words = short.split(/[\s\-_]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? id;
  const caps = w.replace(/[^A-Z]/g, "");
  if (caps.length >= 2) return caps.slice(0, 2);
  // A vendor with no usable name still needs a visible badge — an empty one
  // reads as a rendering bug rather than an unnamed agent.
  return w.slice(0, 2).toUpperCase() || "?";
}

export function VendorGlyph({ id, size = 16, title }: { id: string; size?: number; title?: string }) {
  const colour = vendorColor(id);
  return (
    <span
      className="vglyph"
      title={title ?? vendorMeta(id).label}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        color: colour,
        borderColor: colour,
        fontSize: Math.max(7, Math.round(size * 0.44)),
      }}
    >
      {vendorInitials(id)}
    </span>
  );
}
