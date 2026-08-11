// overlay.rs — QL-778: the Windows taskbar overlay badge.
//
// Window::set_badge_count is documented as unsupported on Windows ("use
// set_overlay_icon instead", tauri/src/window/mod.rs), so the attention count
// Notifications.tsx used to push at it never reached the taskbar at all. This
// module renders that count as a small icon and hands it to the shell through
// Window::set_overlay_icon, which is the API Windows actually implements
// (ITaskbarList3::SetOverlayIcon).
//
// The badge is DRAWN HERE in code rather than shipped as PNG assets. Same
// pixels either way, but this needs no image-decoder feature on `tauri`, no
// binary blobs in the repo, and — the part that matters — it is unit-testable,
// which a GUI-only feature otherwise wouldn't be at all.
//
// Rendering is a 4x supersampled 32x32 RGBA buffer: the disc rim and the glyph
// edges stay smooth after Windows scales the icon down into the 16x16 (or
// DPI-scaled) overlay slot. 32x32x16 samples is ~16k iterations, and it only
// runs when the count actually changes, so cost is irrelevant.

use tauri::image::Image;

/// Badge edge in pixels. Windows renders overlay icons at the small-icon size
/// (16x16 at 100% DPI, more at higher scaling), so this is drawn at 2x and let
/// the shell downscale rather than shipping a blurry 16x16.
pub(crate) const BADGE_PX: u32 = 32;

/// Supersampling factor for the coverage pass.
const SS: u32 = 4;

/// Google-red disc, white glyph — brief-specified, and it reads as "stop" at
/// 16 pixels against both light and dark taskbars.
const DISC_RGB: [f32; 3] = [0xD9 as f32, 0x30 as f32, 0x25 as f32];
const INK_RGB: [f32; 3] = [255.0, 255.0, 255.0];

/// Above this the badge shows "9+" — two glyphs is the most that stays legible
/// in a 16px slot, and past nine the exact number stopped being the point.
const MAX_SHOWN: u32 = 9;

const GLYPH_W: usize = 5;
const GLYPH_H: usize = 7;
/// Index of the "+" glyph in FONT, after the ten digits.
const PLUS: usize = 10;

/// 5x7 bitmaps: the ten digits plus "+". A pixel font on purpose — the badge
/// is rendered into 16 physical pixels, where anything fancier is mud.
const FONT: [[&str; GLYPH_H]; 11] = [
    [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."], // 0
    ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."], // 1
    [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"], // 2
    ["####.", "....#", "....#", ".###.", "....#", "....#", "####."], // 3
    ["#...#", "#...#", "#...#", "#####", "....#", "....#", "....#"], // 4
    ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."], // 5
    [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."], // 6
    ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."], // 7
    [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."], // 8
    [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."], // 9
    [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."], // +
];

/// Which glyphs a given count draws. Never called with 0 — a zero count clears
/// the overlay instead of drawing an empty badge.
fn label_glyphs(count: u32) -> Vec<usize> {
    if count > MAX_SHOWN {
        vec![9, PLUS]
    } else {
        vec![count as usize]
    }
}

/// Is this point inside the label's ink? `gx`/`gy` are canvas coordinates
/// relative to the label's top-left corner, `u` the size of one font pixel.
fn glyph_ink(glyphs: &[usize], gx: f32, gy: f32, u: f32) -> bool {
    if gx < 0.0 || gy < 0.0 {
        return false;
    }
    let col = (gx / u) as usize;
    let row = (gy / u) as usize;
    if row >= GLYPH_H {
        return false;
    }
    // Glyphs are laid out with a one-font-pixel gap between them.
    let within = col % (GLYPH_W + 1);
    if within >= GLYPH_W {
        return false;
    }
    let Some(&g) = glyphs.get(col / (GLYPH_W + 1)) else {
        return false;
    };
    FONT[g][row].as_bytes()[within] == b'#'
}

/// Straight RGBA (not premultiplied), row-major top to bottom — what
/// `Image::new_owned` wants.
pub(crate) fn badge_rgba(count: u32) -> Vec<u8> {
    let glyphs = label_glyphs(count);
    let centre = BADGE_PX as f32 / 2.0;
    // Half a pixel of margin so the rim isn't clipped by the canvas edge.
    let radius = centre - 0.5;

    // Font-pixel columns the whole label occupies, gaps included.
    let cols = glyphs.len() * GLYPH_W + glyphs.len().saturating_sub(1);
    // One font pixel in canvas units: as large as fits inside the disc, capped
    // on both axes so "9" and "9+" both clear the rim with room to spare.
    let u = (0.80 * 2.0 * radius / cols as f32).min(0.66 * 2.0 * radius / GLYPH_H as f32);
    let x0 = centre - (cols as f32 * u) / 2.0;
    let y0 = centre - (GLYPH_H as f32 * u) / 2.0;

    let mut out = vec![0u8; (BADGE_PX * BADGE_PX * 4) as usize];
    let step = 1.0 / SS as f32;
    let samples = (SS * SS) as f32;
    for py in 0..BADGE_PX {
        for px in 0..BADGE_PX {
            let (mut disc, mut ink) = (0u32, 0u32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = px as f32 + (sx as f32 + 0.5) * step;
                    let y = py as f32 + (sy as f32 + 0.5) * step;
                    if (x - centre).powi(2) + (y - centre).powi(2) > radius * radius {
                        continue;
                    }
                    disc += 1;
                    if glyph_ink(&glyphs, x - x0, y - y0, u) {
                        ink += 1;
                    }
                }
            }
            if disc == 0 {
                continue; // outside the disc: leave it fully transparent
            }
            let alpha = disc as f32 / samples;
            // The glyph sits ON the disc, so the two coverages collapse into
            // one colour carried at the disc's own alpha.
            let t = (ink as f32 / disc as f32).clamp(0.0, 1.0);
            let i = ((py * BADGE_PX + px) * 4) as usize;
            for ch in 0..3 {
                out[i + ch] = (DISC_RGB[ch] + (INK_RGB[ch] - DISC_RGB[ch]) * t).round() as u8;
            }
            out[i + 3] = (alpha * 255.0).round() as u8;
        }
    }
    out
}

/// The overlay icon for a count, or None for "clear the overlay".
pub(crate) fn badge_image(count: u32) -> Option<Image<'static>> {
    if count == 0 {
        return None;
    }
    Some(Image::new_owned(badge_rgba(count), BADGE_PX, BADGE_PX))
}

/// Show `count` on the taskbar icon; 0 removes the overlay. Replaces the
/// `setBadgeCount` call in Notifications.tsx, which was a documented no-op on
/// this platform. Non-Windows builds accept the call and do nothing, so the
/// frontend needs no platform branch.
#[tauri::command]
pub fn set_attention_overlay(window: tauri::Window, count: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        window
            .set_overlay_icon(badge_image(count))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&window, count);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(rgba: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * BADGE_PX + x) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn buffer_is_exactly_one_rgba_image() {
        assert_eq!(badge_rgba(1).len(), (BADGE_PX * BADGE_PX * 4) as usize);
    }

    #[test]
    fn corners_are_fully_transparent() {
        let b = badge_rgba(3);
        for (x, y) in [(0, 0), (BADGE_PX - 1, 0), (0, BADGE_PX - 1), (BADGE_PX - 1, BADGE_PX - 1)] {
            assert_eq!(px(&b, x, y)[3], 0, "corner {x},{y} must be transparent, not a red square");
        }
    }

    /// The disc has to be opaque where it matters, or the count reads as a
    /// smear over whatever the taskbar icon already shows.
    #[test]
    fn the_disc_is_opaque() {
        let b = badge_rgba(1);
        // Left of centre, clear of the "1" glyph and well inside the rim.
        assert_eq!(px(&b, 3, BADGE_PX / 2)[3], 255);
    }

    #[test]
    fn the_glyph_is_white_ink_on_a_red_disc() {
        let b = badge_rgba(8);
        let mut white = 0;
        let mut red = 0;
        for i in (0..b.len()).step_by(4) {
            if b[i + 3] < 255 {
                continue;
            }
            if b[i] > 240 && b[i + 1] > 240 && b[i + 2] > 240 {
                white += 1;
            }
            if b[i] == 0xD9 && b[i + 1] == 0x30 && b[i + 2] == 0x25 {
                red += 1;
            }
        }
        assert!(white > 20, "expected a legible white glyph, got {white} white pixels");
        assert!(red > white, "the disc must still dominate the glyph ({red} red vs {white} white)");
    }

    #[test]
    fn every_count_draws_a_distinct_glyph() {
        for a in 1..=9u32 {
            for b in 1..=9u32 {
                if a == b {
                    continue;
                }
                assert_ne!(badge_rgba(a), badge_rgba(b), "{a} and {b} render identically");
            }
        }
    }

    /// Ten and a thousand are the same badge: "9+".
    #[test]
    fn counts_past_nine_all_collapse_to_the_same_overflow_badge() {
        let ten = badge_rgba(10);
        assert_eq!(ten, badge_rgba(99));
        assert_eq!(ten, badge_rgba(u32::MAX));
        assert_ne!(ten, badge_rgba(9), "9+ must not look like a plain 9");
    }

    /// Whatever the count, no ink may spill outside the disc.
    #[test]
    fn nothing_is_drawn_outside_the_disc() {
        let centre = BADGE_PX as f32 / 2.0;
        for count in [1, 7, 10] {
            let b = badge_rgba(count);
            for y in 0..BADGE_PX {
                for x in 0..BADGE_PX {
                    let d = ((x as f32 + 0.5 - centre).powi(2) + (y as f32 + 0.5 - centre).powi(2)).sqrt();
                    if d > centre {
                        assert_eq!(px(&b, x, y)[3], 0, "count {count} painted outside the disc at {x},{y}");
                    }
                }
            }
        }
    }

    #[test]
    fn zero_clears_the_overlay_instead_of_drawing_one() {
        assert!(badge_image(0).is_none());
        let img = badge_image(4).expect("a real count draws a badge");
        assert_eq!((img.width(), img.height()), (BADGE_PX, BADGE_PX));
        assert_eq!(img.rgba().len(), (BADGE_PX * BADGE_PX * 4) as usize);
    }
}
