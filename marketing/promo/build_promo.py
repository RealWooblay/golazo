#!/usr/bin/env python3
"""
GOLAZO animated promo — frame renderer (Pillow).

Renders a ~8 second, 1080x1080, 30fps flat-brand promo to frames/ and then
prints the exact ffmpeg command to assemble golazo_promo.mp4.

Brand (STRICT, flat + dark):
  canvas    #0B0C0F
  surface   #14181E / #1B1F27
  hairline  #23262D
  accent    #27E08A   (exactly one accent, used surgically)
  text      #E8EDF2   muted #8A93A0
  No gradients, no glow, no shadows, no grain, no 3D. Sentence case.

Self-contained: standard library + Pillow only. Degrades gracefully if a
preferred font path is missing (falls back through a list, then PIL default).
"""

import os
import sys
import math

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.stderr.write(
        "ERROR: Pillow (PIL) is not installed. Install with: python3 -m pip install Pillow\n"
    )
    sys.exit(1)

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
W = H = 1080
FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES_DIR = os.path.join(HERE, "frames")
OUT_MP4 = os.path.join(HERE, "golazo_promo.mp4")

# Brand palette
BG       = (11, 12, 15)      # #0B0C0F
SURFACE  = (20, 24, 30)      # #14181E
SURFACE2 = (27, 31, 39)      # #1B1F27
HAIRLINE = (35, 38, 45)      # #23262D
ACCENT   = (39, 224, 138)    # #27E08A
TEXT     = (232, 237, 242)   # #E8EDF2
MUTED    = (138, 147, 160)   # #8A93A0

# ----------------------------------------------------------------------------
# Fonts (graceful fallback)
# ----------------------------------------------------------------------------
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Volumes/Data/Library/Frameworks/Python.framework/Versions/3.11/lib/python3.11/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans-Bold.ttf",
    "/System/Volumes/Data/Library/Frameworks/Python.framework/Versions/3.11/lib/python3.11/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf",
]
FONT_BOLD_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Volumes/Data/Library/Frameworks/Python.framework/Versions/3.11/lib/python3.11/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans-Bold.ttf",
]
FONT_REG_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Volumes/Data/Library/Frameworks/Python.framework/Versions/3.11/lib/python3.11/site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf",
]


def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


_BOLD_PATH = _first_existing(FONT_BOLD_CANDIDATES) or _first_existing(FONT_CANDIDATES)
_REG_PATH = _first_existing(FONT_REG_CANDIDATES) or _BOLD_PATH

if _BOLD_PATH is None:
    print("WARNING: no TrueType font found; falling back to PIL bitmap font "
          "(sizes will be ignored).", file=sys.stderr)

_font_cache = {}


def font(size, bold=True):
    key = (size, bold)
    if key in _font_cache:
        return _font_cache[key]
    path = _BOLD_PATH if bold else _REG_PATH
    try:
        f = ImageFont.truetype(path, size) if path else ImageFont.load_default()
    except Exception:
        f = ImageFont.load_default()
    _font_cache[key] = f
    return f


# ----------------------------------------------------------------------------
# Easing + helpers
# ----------------------------------------------------------------------------
def ease_out(t):
    """Cubic ease-out, t in [0,1]."""
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = clamp01(t)
    return 3 * t * t - 2 * t * t * t


def clamp01(t):
    return max(0.0, min(1.0, t))


def lerp(a, b, t):
    return a + (b - a) * t


def fade_color(color, alpha):
    """Blend a color toward BG by alpha (0 = invisible, 1 = full)."""
    a = clamp01(alpha)
    return tuple(int(round(lerp(BG[i], color[i], a))) for i in range(3))


def measure(draw, text, fnt):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox


def draw_text_center(draw, cx, cy, text, fnt, fill, tracking=0):
    """Draw text centered at (cx, cy). Optional letter tracking (px)."""
    if tracking == 0:
        w, h, bbox = measure(draw, text, fnt)
        x = cx - w / 2 - bbox[0]
        y = cy - h / 2 - bbox[1]
        draw.text((x, y), text, font=fnt, fill=fill)
        return w
    # tracked: render glyph by glyph
    widths = []
    total = 0
    for ch in text:
        bb = draw.textbbox((0, 0), ch, font=fnt)
        cw = bb[2] - bb[0]
        widths.append(cw)
        total += cw
    total += tracking * (len(text) - 1)
    # vertical metrics from full string
    _, fh, fbb = measure(draw, text, fnt)
    x = cx - total / 2
    y = cy - fh / 2 - fbb[1]
    for ch, cw in zip(text, widths):
        bb = draw.textbbox((0, 0), ch, font=fnt)
        draw.text((x - bb[0], y), ch, font=fnt, fill=fill)
        x += cw + tracking
    return total


# ----------------------------------------------------------------------------
# Logo strike-mark (the brand icon), scalable + drawable progress
# ----------------------------------------------------------------------------
# Reference coordinate system is 100x100 (matches the brand SVG):
#   three speed lines on the left, a filled accent disc on the right with a
#   small dark pentagon punched out (the "strike").
def draw_logo(draw, cx, cy, scale, draw_progress=1.0, alpha=1.0):
    """
    Draw the strike-mark centered at (cx, cy).
    scale: pixels per reference-unit-ish; the 100x100 art is mapped to ~scale.
    draw_progress: 0..1 reveals lines then disc (used for the intro draw-in).
    alpha: overall opacity (blend toward BG).
    """
    s = scale / 100.0  # one ref unit -> s px

    def P(x, y):
        return (cx + (x - 50) * s, cy + (y - 50) * s)

    acc = fade_color(ACCENT, alpha)
    dark = fade_color(BG, alpha)

    lw = max(2, int(round(7 * s)))

    # Phase split: lines draw 0..0.55, disc+strike 0.45..1.0
    line_p = clamp01(draw_progress / 0.58)
    disc_p = clamp01((draw_progress - 0.42) / 0.58)

    # three speed lines (animate length from left anchor)
    lines = [
        ((18, 38), (40, 38)),
        ((13, 50), (38, 50)),
        ((18, 62), (40, 62)),
    ]
    for i, ((x0, y0), (x1, y1)) in enumerate(lines):
        # stagger each line slightly
        lp = clamp01((line_p - i * 0.10) / 0.70)
        lp = ease_out(lp)
        if lp <= 0:
            continue
        xe = lerp(x0, x1, lp)
        a, b = P(x0, y0), P(xe, y1)
        draw.line([a, b], fill=acc, width=lw)
        # round caps
        r = lw / 2
        for pt in (a, b):
            draw.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=acc)

    # accent disc (grows in), then punch the strike pentagon
    if disc_p > 0:
        dp = ease_out(disc_p)
        R = 19 * s * dp
        dc = P(64, 50)
        draw.ellipse([dc[0] - R, dc[1] - R, dc[0] + R, dc[1] + R], fill=acc)
        # strike pentagon (only once disc is mostly grown, so it reads as a punch)
        if disc_p > 0.65:
            poly = [P(64, 41), P(71, 47), P(68, 55), P(60, 55), P(57, 47)]
            draw.polygon(poly, fill=dark)


# ----------------------------------------------------------------------------
# Reusable card-ish row (a betting line) — flat surface, hairline, accent dot
# ----------------------------------------------------------------------------
def draw_bet_row(draw, cx, cy, w, h, label, reveal=1.0, accent_dot=True,
                 mult_text=None):
    """A flat rounded surface with a label, an optional accent dot, and an
    optional multiplier chip on the right. reveal in [0,1] slides+fades in."""
    if reveal <= 0:
        return
    e = ease_out(reveal)
    # slide up slightly while fading in
    oy = (1 - e) * 26
    cy = cy + oy
    a = e

    x0, y0 = cx - w / 2, cy - h / 2
    x1, y1 = cx + w / 2, cy + h / 2
    rad = int(h * 0.28)

    surf = fade_color(SURFACE2, a)
    hair = fade_color(HAIRLINE, a)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=rad, fill=surf,
                           outline=hair, width=2)

    # accent dot (small, surgical)
    pad = h * 0.5
    if accent_dot:
        dot_r = h * 0.085
        dcx = x0 + pad
        dcy = cy
        draw.ellipse([dcx - dot_r, dcy - dot_r, dcx + dot_r, dcy + dot_r],
                     fill=fade_color(ACCENT, a))
        tx0 = dcx + dot_r + h * 0.34
    else:
        tx0 = x0 + pad

    # label (left-aligned, vertically centered)
    fnt = font(int(h * 0.42), bold=True)
    _, th, tbb = measure(draw, label, fnt)
    draw.text((tx0 - tbb[0], cy - th / 2 - tbb[1]), label, font=fnt,
              fill=fade_color(TEXT, a))

    # multiplier chip on the right
    if mult_text:
        cf = font(int(h * 0.40), bold=True)
        cw, ch, cbb = measure(draw, mult_text, cf)
        chip_pad_x = h * 0.32
        chip_w = cw + chip_pad_x * 2
        chip_h = h * 0.64
        ccx1 = x1 - pad
        ccx0 = ccx1 - chip_w
        ccy0 = cy - chip_h / 2
        ccy1 = cy + chip_h / 2
        draw.rounded_rectangle([ccx0, ccy0, ccx1, ccy1],
                               radius=int(chip_h * 0.32),
                               fill=fade_color(SURFACE, a),
                               outline=fade_color(ACCENT, a), width=2)
        draw.text((ccx0 + chip_pad_x - cbb[0],
                   cy - ch / 2 - cbb[1]),
                  mult_text, font=cf, fill=fade_color(ACCENT, a))


# ----------------------------------------------------------------------------
# Timeline (seconds). Total ~8.0s.
# ----------------------------------------------------------------------------
# a) logo draw-in + wordmark .............. 0.0 - 2.0
# b) "Bet the next moment." ................ 2.0 - 3.4
# c) three beats (shot/corner/goal) ........ 3.4 - 5.2
# d) multiplier ticks + "Paid in seconds." . 5.2 - 6.7
# e) end card .............................. 6.7 - 8.0
SECTIONS = {
    "intro":  (0.00, 2.00),
    "tag":    (2.00, 3.40),
    "beats":  (3.40, 5.20),
    "mult":   (5.20, 6.70),
    "end":    (6.70, 8.00),
}
DURATION = 8.00
TOTAL_FRAMES = int(round(DURATION * FPS))


def seg_t(t, key):
    """Local progress 0..1 within a named section, else clamped."""
    a, b = SECTIONS[key]
    return clamp01((t - a) / (b - a))


def in_seg(t, key):
    a, b = SECTIONS[key]
    return a <= t < b


# small reusable wordmark with tracking
def draw_wordmark(draw, cx, cy, size, alpha=1.0, tracking=None):
    if tracking is None:
        tracking = max(2, int(size * 0.07))
    fnt = font(size, bold=True)
    draw_text_center(draw, cx, cy, "GOLAZO", fnt, fade_color(TEXT, alpha),
                     tracking=tracking)


def render_frame(i):
    t = i / FPS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    cx = W / 2

    # ---- (a) INTRO: logo draws in, wordmark fades up -----------------------
    if t < SECTIONS["tag"][0] + 0.3:  # keep logo around briefly into tag
        p = seg_t(t, "intro")
        # logo draw progress over first ~1.15s of intro
        draw_p = clamp01(p / 0.62)
        # logo overall fade
        logo_alpha = ease_out(clamp01(p / 0.18))
        # as we approach tag, drift logo up a touch and fade if needed
        logo_cy = H * 0.40
        # wordmark appears after the mark is mostly drawn
        word_alpha = ease_out(clamp01((p - 0.55) / 0.35))
        word_oy = (1 - word_alpha) * 20

        # If we're past intro (in the small overlap), hold full
        if t >= SECTIONS["intro"][1]:
            draw_p = 1.0
            logo_alpha = 1.0
            word_alpha = 1.0
            word_oy = 0
            # fade everything out as tag takes over
            out = clamp01((t - SECTIONS["intro"][1]) / 0.3)
            logo_alpha *= (1 - out)
            word_alpha *= (1 - out)

        draw_logo(d, cx, logo_cy, scale=300, draw_progress=draw_p,
                  alpha=logo_alpha)
        if word_alpha > 0:
            draw_wordmark(d, cx, H * 0.595 + word_oy, size=120,
                          alpha=word_alpha)

    # ---- (b) TAG: "Bet the next moment." -----------------------------------
    if in_seg(t, "tag") or (t >= SECTIONS["tag"][1] and t < SECTIONS["beats"][0]):
        p = seg_t(t, "tag")
        a_in = ease_out(clamp01(p / 0.30))
        a_out = 1 - ease_in_out(clamp01((p - 0.78) / 0.22))
        alpha = min(a_in, a_out)
        oy = (1 - a_in) * 22
        # tiny eyebrow label (ALL CAPS allowed for tiny eyebrow only)
        eb = font(34, bold=True)
        draw_text_center(d, cx, H * 0.40 + oy, "LIVE FOOTBALL", eb,
                         fade_color(MUTED, alpha), tracking=8)
        big = font(96, bold=True)
        draw_text_center(d, cx, H * 0.50 + oy, "Bet the next moment.",
                         big, fade_color(TEXT, alpha))
        # one surgical accent: short underline rule under the line
        if alpha > 0.05:
            rw = 150 * a_in
            ry = H * 0.50 + oy + 70
            d.line([cx - rw / 2, ry, cx + rw / 2, ry],
                   fill=fade_color(ACCENT, alpha), width=5)

    # ---- (c) BEATS: three betting-card lines appear ------------------------
    if in_seg(t, "beats") or (t >= SECTIONS["beats"][1] and t < SECTIONS["mult"][0]):
        p = seg_t(t, "beats")
        rows = [
            ("Next shot?",   0.00),
            ("Next corner?", 0.22),
            ("Next goal?",   0.44),
        ]
        row_w = W * 0.62
        row_h = 132
        gap = 36
        total_h = row_h * 3 + gap * 2
        top = H / 2 - total_h / 2 + row_h / 2
        # global out-fade as section ends
        sect_out = 1 - clamp01((t - (SECTIONS["beats"][1] - 0.25)) / 0.25) \
            if t >= SECTIONS["beats"][1] - 0.25 else 1.0
        for idx, (label, delay) in enumerate(rows):
            rp = clamp01((p - delay) / 0.34)
            reveal = rp * sect_out
            cyy = top + idx * (row_h + gap)
            # last row ("Next goal?") gets the accent dot emphasis already on
            draw_bet_row(d, cx, cyy, row_w, row_h, label, reveal=reveal,
                         accent_dot=True)

    # ---- (d) MULT: green multiplier ticks up + "Paid in seconds." ----------
    if in_seg(t, "mult") or (t >= SECTIONS["mult"][1] and t < SECTIONS["end"][0]):
        p = seg_t(t, "mult")
        a_in = ease_out(clamp01(p / 0.22))
        a_out = 1 - ease_in_out(clamp01((p - 0.80) / 0.20))
        alpha = min(a_in, a_out)

        # multiplier ticks 1.00x -> 3.75x over the section, ease-out
        tick_p = ease_out(clamp01(p / 0.72))
        val = lerp(1.00, 3.75, tick_p)
        mult_str = "%.2fx" % val
        big = font(220, bold=True)
        draw_text_center(d, cx, H * 0.43, mult_str, big,
                         fade_color(ACCENT, alpha))
        # caption
        cap = font(80, bold=True)
        cap_a = min(alpha, ease_out(clamp01((p - 0.30) / 0.30)))
        draw_text_center(d, cx, H * 0.62, "Paid in seconds.", cap,
                         fade_color(TEXT, cap_a))
        # eyebrow under
        eb = font(30, bold=True)
        draw_text_center(d, cx, H * 0.70, "PARIMUTUEL  /  WINNERS SPLIT THE POT",
                         eb, fade_color(MUTED, cap_a), tracking=6)

    # ---- (e) END CARD: mark + wordmark + url -------------------------------
    if t >= SECTIONS["end"][0]:
        p = seg_t(t, "end")
        a = ease_out(clamp01(p / 0.30))
        draw_logo(d, cx, H * 0.40, scale=240, draw_progress=1.0, alpha=a)
        draw_wordmark(d, cx, H * 0.565, size=110, alpha=a)
        url = font(46, bold=False)
        url_a = ease_out(clamp01((p - 0.25) / 0.30))
        draw_text_center(d, cx, H * 0.66, "golazo.wooblay.com", url,
                         fade_color(ACCENT, url_a), tracking=3)

    return img


def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    print("Rendering %d frames (%.1fs @ %dfps, %dx%d) -> %s"
          % (TOTAL_FRAMES, DURATION, FPS, W, H, FRAMES_DIR))
    for i in range(TOTAL_FRAMES):
        img = render_frame(i)
        img.save(os.path.join(FRAMES_DIR, "frame_%04d.png" % i))
        if i % 30 == 0 or i == TOTAL_FRAMES - 1:
            print("  frame %4d / %d" % (i, TOTAL_FRAMES - 1))
    print("Done rendering %d frames." % TOTAL_FRAMES)

    # ffmpeg assembly command (libx264, yuv420p, social-friendly)
    cmd = (
        'ffmpeg -y -framerate {fps} -i "{frames}/frame_%04d.png" '
        '-c:v libx264 -profile:v high -pix_fmt yuv420p -crf 18 '
        '-movflags +faststart "{out}"'
    ).format(fps=FPS, frames=FRAMES_DIR, out=OUT_MP4)

    print("\n=== FFMPEG ASSEMBLE COMMAND ===")
    print(cmd)
    print("===============================")


if __name__ == "__main__":
    main()
