#!/usr/bin/env python3
"""
GOLAZO hero vertical — full product-loop promo (Pillow, 1080x1920, 30fps, ~13s).

Renders the REAL app UI per frame as a flat mock so it reads as GOLAZO, then
prints the exact ffmpeg command to assemble golazo_hero_vertical.mp4.

The loop (7 beats, generous on the PAUSE before the shot + the MARKET POPPING UP):
  1. Live pitch + score + clock; commentary builds.
  2. TENSION / PAUSE: action leans to Brazil, a hush, a centered "NEXT MARKET"
     pill pulses with 3..2..1 (the get-ready pause).
  3. MARKET POPS UP: the betting card slides + scales in with a fuse countdown.
  4. A finger taps "Brazil 1.85x" -> it lights green ("Bet in").
  5. SHOT: "Brazil shoots!" the moment resolves.
  6. PAYOUT: card flips to a win -> 1.85x, "You won +$46.25".
  7. END CARD: strike logo + GOLAZO + "Bet the next moment." + url.

Brand (STRICT, flat + dark):
  canvas    #0B0C0F
  surface   #14181E / #1B1F27
  hairline  #23262D
  accent    #27E08A   (exactly one accent, surgical)
  text      #E8EDF2   muted #8A93A0   loss #FF5C5C (only on a loss)
  pitch     ~#13351F flat with thin white markings
  No gradients, no glow, no shadows, no grain, no 3D. Sentence case.

Self-contained: standard library + Pillow only. Degrades gracefully through a
font-candidate list, then PIL default.
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
W, H = 1080, 1920
FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES_DIR = os.path.join(HERE, "frames_hero_vertical")
OUT_MP4 = os.path.join(HERE, "golazo_hero_vertical.mp4")

# Brand palette
BG       = (11, 12, 15)      # #0B0C0F
SURFACE  = (20, 24, 30)      # #14181E
SURFACE2 = (27, 31, 39)      # #1B1F27
HAIRLINE = (35, 38, 45)      # #23262D
ACCENT   = (39, 224, 138)    # #27E08A
TEXT     = (232, 237, 242)   # #E8EDF2
MUTED    = (138, 147, 160)   # #8A93A0
LOSS     = (255, 92, 92)     # #FF5C5C (only on a loss)

PITCH    = (19, 53, 31)      # ~#13351F flat dark-green pitch band
PITCH_LN = (210, 224, 214)   # thin pitch markings (soft white)

# crests as small colored discs
BRA_Y    = (244, 208, 63)    # Brazil yellow
BRA_G    = (39, 174, 96)     # Brazil green (ring)
ARG_B    = (140, 190, 230)   # Argentina light blue
ARG_W    = (236, 240, 244)   # Argentina white

# ----------------------------------------------------------------------------
# Fonts (graceful fallback)
# ----------------------------------------------------------------------------
FONT_BOLD_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]
FONT_REG_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return None


_BOLD_PATH = _first_existing(FONT_BOLD_CANDIDATES)
_REG_PATH = _first_existing(FONT_REG_CANDIDATES) or _BOLD_PATH
if _BOLD_PATH is None:
    _BOLD_PATH = _REG_PATH

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
def clamp01(t):
    return max(0.0, min(1.0, t))


def ease_out(t):
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = clamp01(t)
    return 3 * t * t - 2 * t * t * t


def ease_back_out(t, s=1.70158):
    """Slight overshoot ease-out (for the market pop)."""
    t = clamp01(t) - 1
    return (t * t * ((s + 1) * t + s) + 1)


def lerp(a, b, t):
    return a + (b - a) * t


def fade_color(color, alpha):
    """Blend a color toward BG by alpha (0 = invisible, 1 = full)."""
    a = clamp01(alpha)
    return tuple(int(round(lerp(BG[i], color[i], a))) for i in range(3))


def blend(c0, c1, t):
    t = clamp01(t)
    return tuple(int(round(lerp(c0[i], c1[i], t))) for i in range(3))


def measure(draw, text, fnt):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox


def text_center(draw, cx, cy, text, fnt, fill, tracking=0):
    if tracking == 0:
        w, h, bbox = measure(draw, text, fnt)
        x = cx - w / 2 - bbox[0]
        y = cy - h / 2 - bbox[1]
        draw.text((x, y), text, font=fnt, fill=fill)
        return w
    widths = []
    total = 0
    for ch in text:
        bb = draw.textbbox((0, 0), ch, font=fnt)
        cw = bb[2] - bb[0]
        widths.append(cw)
        total += cw
    total += tracking * (len(text) - 1)
    _, fh, fbb = measure(draw, text, fnt)
    x = cx - total / 2
    y = cy - fh / 2 - fbb[1]
    for ch, cw in zip(text, widths):
        bb = draw.textbbox((0, 0), ch, font=fnt)
        draw.text((x - bb[0], y), ch, font=fnt, fill=fill)
        x += cw + tracking
    return total


def text_left(draw, x, cy, text, fnt, fill):
    _, th, tbb = measure(draw, text, fnt)
    draw.text((x - tbb[0], cy - th / 2 - tbb[1]), text, font=fnt, fill=fill)


def text_right(draw, x, cy, text, fnt, fill):
    tw, th, tbb = measure(draw, text, fnt)
    draw.text((x - tw - tbb[0], cy - th / 2 - tbb[1]), text, font=fnt, fill=fill)


# ----------------------------------------------------------------------------
# Logo strike-mark (brand icon)
# ----------------------------------------------------------------------------
def draw_logo(draw, cx, cy, scale, draw_progress=1.0, alpha=1.0):
    s = scale / 100.0

    def P(x, y):
        return (cx + (x - 50) * s, cy + (y - 50) * s)

    acc = fade_color(ACCENT, alpha)
    dark = fade_color(BG, alpha)
    lw = max(2, int(round(7 * s)))

    line_p = clamp01(draw_progress / 0.58)
    disc_p = clamp01((draw_progress - 0.42) / 0.58)

    lines = [
        ((18, 38), (40, 38)),
        ((13, 50), (38, 50)),
        ((18, 62), (40, 62)),
    ]
    for i, ((x0, y0), (x1, y1)) in enumerate(lines):
        lp = ease_out(clamp01((line_p - i * 0.10) / 0.70))
        if lp <= 0:
            continue
        xe = lerp(x0, x1, lp)
        a, b = P(x0, y0), P(xe, y1)
        draw.line([a, b], fill=acc, width=lw)
        r = lw / 2
        for pt in (a, b):
            draw.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=acc)

    if disc_p > 0:
        dp = ease_out(disc_p)
        R = 19 * s * dp
        dc = P(64, 50)
        draw.ellipse([dc[0] - R, dc[1] - R, dc[0] + R, dc[1] + R], fill=acc)
        if disc_p > 0.65:
            poly = [P(64, 41), P(71, 47), P(68, 55), P(60, 55), P(57, 47)]
            draw.polygon(poly, fill=dark)


def draw_logo_tile(draw, cx, cy, tile, alpha=1.0):
    """The strike mark on a dark rounded tile (end-card lockup)."""
    a = clamp01(alpha)
    x0, y0 = cx - tile / 2, cy - tile / 2
    x1, y1 = cx + tile / 2, cy + tile / 2
    draw.rounded_rectangle([x0, y0, x1, y1], radius=int(tile * 0.24),
                           fill=fade_color(SURFACE, a),
                           outline=fade_color(HAIRLINE, a), width=2)
    draw_logo(draw, cx, cy, scale=tile * 0.78, draw_progress=1.0, alpha=a)


# ----------------------------------------------------------------------------
# Crest disc (small colored team disc)
# ----------------------------------------------------------------------------
def crest(draw, cx, cy, r, team, alpha=1.0):
    a = alpha
    if team == "BRA":
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fade_color(BRA_Y, a),
                     outline=fade_color(BRA_G, a), width=max(2, int(r * 0.22)))
        ir = r * 0.42
        draw.ellipse([cx - ir, cy - ir, cx + ir, cy + ir],
                     fill=fade_color(BRA_G, a))
    else:  # ARG
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fade_color(ARG_B, a),
                     outline=fade_color(ARG_W, a), width=max(2, int(r * 0.22)))
        # a couple light-blue/white vertical stripes hint
        draw.rectangle([cx - r * 0.18, cy - r * 0.72, cx + r * 0.18, cy + r * 0.72],
                       fill=fade_color(ARG_W, a))


# ----------------------------------------------------------------------------
# PITCH HERO — dark-green band, halfway line + center circle, LIVE pill, clock,
# scoreline. lean drives a faint highlight toward the leaning side.
# ----------------------------------------------------------------------------
def draw_pitch_hero(d, top, height, clock_text, lean=0.0, alpha=1.0,
                    flash=0.0):
    a = alpha
    x0, y0 = 36, top
    x1, y1 = W - 36, top + height
    rad = 40
    pitch_col = fade_color(PITCH, a)
    d.rounded_rectangle([x0, y0, x1, y1], radius=rad, fill=pitch_col)

    # subtle attacking lean: a faint brighter vertical band toward leaning side
    if lean != 0.0 and a > 0.05:
        band_col = blend(PITCH, (28, 74, 44), 0.7)
        band_col = fade_color(band_col, a)
        bw = (x1 - x0) * 0.32
        if lean > 0:  # action leans toward Brazil (left side of the pitch)
            bx0 = x0
            bx1 = x0 + bw * abs(lean)
        else:  # toward Argentina (right side)
            bx0 = x1 - bw * abs(lean)
            bx1 = x1
        # clip to rounded rect interior using a simple inset rectangle
        bx0 = max(bx0, x0 + 6)
        bx1 = min(bx1, x1 - 6)
        if bx1 > bx0:
            d.rectangle([bx0, y0 + 8, bx1, y1 - 8], fill=band_col)

    # shot flash overlay (white-ish, brief) when the shot resolves
    if flash > 0.001:
        fc = blend(PITCH, (235, 245, 238), 0.85 * flash)
        d.rounded_rectangle([x0, y0, x1, y1], radius=rad, fill=fade_color(fc, a))

    pen = fade_color(PITCH_LN, a * 0.85)
    midx = (x0 + x1) / 2
    # halfway line
    d.line([midx, y0 + 14, midx, y1 - 14], fill=pen, width=3)
    # center circle
    cyy = (y0 + y1) / 2
    cr = height * 0.26
    d.ellipse([midx - cr, cyy - cr, midx + cr, cyy + cr], outline=pen, width=3)
    d.ellipse([midx - 6, cyy - 6, midx + 6, cyy + 6], fill=pen)
    # outer touch line (inset)
    d.rounded_rectangle([x0 + 12, y0 + 12, x1 - 12, y1 - 12], radius=rad - 10,
                        outline=fade_color(PITCH_LN, a * 0.45), width=2)

    # ---- LIVE pill (top-left) ----
    px0, py0 = x0 + 34, y0 + 30
    pill_h = 50
    live_txt = "LIVE"
    lf = font(28, bold=True)
    lw = measure(d, live_txt, lf)[0]
    dot_r = 9
    pill_w = dot_r * 2 + 16 + lw + 40
    d.rounded_rectangle([px0, py0, px0 + pill_w, py0 + pill_h],
                        radius=pill_h // 2, fill=fade_color((26, 17, 17), a))
    # blinking red dot
    blink = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(clock_blink_phase[0]))
    d.ellipse([px0 + 20 - dot_r, py0 + pill_h / 2 - dot_r,
               px0 + 20 + dot_r, py0 + pill_h / 2 + dot_r],
              fill=fade_color(LOSS, a * blink))
    text_left(d, px0 + 20 + dot_r + 12, py0 + pill_h / 2, live_txt, lf,
              fade_color(TEXT, a))

    # ---- match clock (top-right) ----
    cf = font(38, bold=True)
    text_right(d, x1 - 36, py0 + pill_h / 2, clock_text, cf, fade_color(TEXT, a))

    # ---- scoreline row (bottom band of pitch) ----
    srow_y = y1 - 86
    # BRA crest + abbr ... score ... ARG abbr + crest
    cr_r = 26
    af = font(46, bold=True)
    sf = font(64, bold=True)
    # center score
    score = "1 - 1"
    text_center(d, midx, srow_y, score, sf, fade_color(TEXT, a))
    # left: BRA
    bx = x0 + 40
    crest(d, bx + cr_r, srow_y, cr_r, "BRA", a)
    text_left(d, bx + cr_r * 2 + 16, srow_y, "BRA", af, fade_color(TEXT, a))
    # right: ARG
    axr = x1 - 40
    crest(d, axr - cr_r, srow_y, cr_r, "ARG", a)
    text_right(d, axr - cr_r * 2 - 16, srow_y, "ARG", af, fade_color(TEXT, a))


# shared mutable blink phase so the LIVE dot pulses across frames
clock_blink_phase = [0.0]


# ----------------------------------------------------------------------------
# Segmented fuse timer (row of pips that deplete)
# ----------------------------------------------------------------------------
def draw_fuse(d, cx, cy, total_w, frac, alpha=1.0, n=12):
    """frac in [0,1] = remaining. Pips deplete left->right as time runs out."""
    a = alpha
    gap = 10
    pip_w = (total_w - gap * (n - 1)) / n
    pip_h = 16
    x = cx - total_w / 2
    lit = frac * n
    for i in range(n):
        full = clamp01(lit - i)
        col = blend(HAIRLINE, ACCENT, full)
        # last lit pip in mid-depletion blends; spent pips are hairline
        d.rounded_rectangle([x, cy - pip_h / 2, x + pip_w, cy + pip_h / 2],
                            radius=6, fill=fade_color(col, a))
        x += pip_w + gap


# ----------------------------------------------------------------------------
# Price board (two rounded halves: Brazil / Argentina) with crowd-lean marker
# ----------------------------------------------------------------------------
def draw_price_board(d, cx, cy, w, h, lean, picked=0.0, alpha=1.0):
    """
    lean: 0..1 crowd lean toward Brazil (left). picked: 0..1 how lit the Brazil
    half is (the tap highlight). alpha: opacity.
    """
    a = alpha
    x0, y0 = cx - w / 2, cy - h / 2
    x1, y1 = cx + w / 2, cy + h / 2
    rad = 26
    gap = 14
    half_w = (w - gap) / 2

    # LEFT — Brazil (green tint, gets the pick highlight)
    lx0, lx1 = x0, x0 + half_w
    base_fill = blend(SURFACE2, (18, 46, 33), 0.55)  # green tint
    pick_fill = blend(base_fill, (24, 70, 49), picked)
    pick_outline = blend(HAIRLINE, ACCENT, max(0.25, picked))
    ow = int(lerp(2, 6, picked))
    d.rounded_rectangle([lx0, y0, lx1, y1], radius=rad,
                        fill=fade_color(pick_fill, a),
                        outline=fade_color(pick_outline, a), width=ow)
    text_center(d, (lx0 + lx1) / 2, cy - h * 0.16, "Brazil",
                font(40, bold=True), fade_color(TEXT, a))
    text_center(d, (lx0 + lx1) / 2, cy + h * 0.17, "1.85x",
                font(58, bold=True), fade_color(ACCENT, a))

    # RIGHT — Argentina (neutral)
    rx0, rx1 = x1 - half_w, x1
    d.rounded_rectangle([rx0, y0, rx1, y1], radius=rad,
                        fill=fade_color(SURFACE2, a),
                        outline=fade_color(HAIRLINE, a), width=2)
    text_center(d, (rx0 + rx1) / 2, cy - h * 0.16, "Argentina",
                font(40, bold=True), fade_color(TEXT, a))
    text_center(d, (rx0 + rx1) / 2, cy + h * 0.17, "2.10x",
                font(58, bold=True), fade_color(TEXT, a))

    # thin divider with crowd-lean marker (slides toward leaning side)
    dx = cx
    d.line([dx, y0 + 14, dx, y1 - 14], fill=fade_color(HAIRLINE, a), width=2)
    # lean marker: small accent tick offset toward Brazil (left) by lean
    mxr = (w / 2 - gap) * 0.74
    mx = cx - lerp(0, mxr, lean)
    mr = 8
    d.ellipse([mx - mr, y0 - mr - 4, mx + mr, y0 + mr - 4],
              fill=fade_color(ACCENT, a))


# ----------------------------------------------------------------------------
# Betting card surface (rounded). Contains NEXT chip, question, board, fuse.
# Returns card box for tap pointer placement.
# ----------------------------------------------------------------------------
def draw_bet_card(d, cx, cy, w, h, fuse_frac, lean, picked=0.0, alpha=1.0,
                  resolves_text="RESOLVES IN 0:08"):
    a = alpha
    x0, y0 = cx - w / 2, cy - h / 2
    x1, y1 = cx + w / 2, cy + h / 2
    d.rounded_rectangle([x0, y0, x1, y1], radius=40,
                        fill=fade_color(SURFACE, a),
                        outline=fade_color(HAIRLINE, a), width=2)

    pad = 50
    # NEXT lane chip (green)
    chip_y = y0 + pad + 4
    chip_txt = "NEXT"
    cf = font(28, bold=True)
    ctw = measure(d, chip_txt, cf)[0]
    chip_w = ctw + 44
    chip_h = 50
    d.rounded_rectangle([x0 + pad, chip_y, x0 + pad + chip_w, chip_y + chip_h],
                        radius=chip_h // 2,
                        fill=fade_color(blend(SURFACE2, (18, 46, 33), 0.6), a),
                        outline=fade_color(ACCENT, a), width=2)
    text_center(d, x0 + pad + chip_w / 2, chip_y + chip_h / 2, chip_txt, cf,
                fade_color(ACCENT, a))

    # question
    qf = font(48, bold=True)
    text_left(d, x0 + pad, chip_y + chip_h + 56,
              "Next shot: Brazil or Argentina?", qf, fade_color(TEXT, a))

    # price board
    board_w = w - pad * 2
    board_h = 170
    board_cy = cy + 6
    draw_price_board(d, cx, board_cy, board_w, board_h, lean, picked=picked,
                     alpha=a)

    # fuse + resolves-in
    fuse_y = y1 - pad - 28
    draw_fuse(d, cx, fuse_y, board_w, fuse_frac, alpha=a)
    rf = font(28, bold=True)
    text_center(d, cx, fuse_y + 46, resolves_text, rf, fade_color(MUTED, a),
                tracking=3)

    return (x0, y0, x1, y1, board_cy, board_h, board_w)


# ----------------------------------------------------------------------------
# Tap pointer (simple finger/cursor) — a rounded pill with a small dot tip
# ----------------------------------------------------------------------------
def draw_tap(d, x, y, press=0.0, alpha=1.0):
    a = alpha
    # ripple ring on press
    if press > 0.01:
        rr = lerp(18, 70, press)
        ring_a = a * (1 - press)
        d.ellipse([x - rr, y - rr, x + rr, y + rr],
                  outline=fade_color(ACCENT, ring_a), width=4)
    # fingertip dot
    r = lerp(26, 22, press)
    d.ellipse([x - r, y - r, x + r, y + r], fill=fade_color((245, 248, 250), a))
    d.ellipse([x - r, y - r, x + r, y + r], outline=fade_color(HAIRLINE, a),
              width=3)
    # little "hand" stem below-right
    d.line([x + r * 0.5, y + r * 0.7, x + r * 1.6, y + r * 1.9],
           fill=fade_color((245, 248, 250), a), width=14)


# ----------------------------------------------------------------------------
# NEXT MARKET telegraph pill with 3/2/1 countdown + soft pulse
# ----------------------------------------------------------------------------
def draw_next_market(d, cx, cy, count_num, pulse, alpha=1.0):
    a = alpha
    # soft pulse ring (no glow — just a flat expanding hairline-accent ring)
    pr = lerp(120, 200, pulse)
    ring_a = a * (1 - pulse) * 0.8
    d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr],
              outline=fade_color(ACCENT, ring_a), width=4)

    # pill
    label = "NEXT MARKET"
    lf = font(34, bold=True)
    lw = measure(d, label, lf)[0]
    pill_w = lw + 80
    pill_h = 84
    sc = lerp(0.98, 1.04, pulse)
    pw, ph = pill_w * sc, pill_h * sc
    d.rounded_rectangle([cx - pw / 2, cy - ph / 2 - 70, cx + pw / 2, cy - ph / 2 - 70 + ph],
                        radius=int(ph / 2),
                        fill=fade_color(SURFACE2, a),
                        outline=fade_color(ACCENT, a), width=3)
    text_center(d, cx, cy - 70, label, lf, fade_color(ACCENT, a), tracking=6)

    # big countdown number
    nf = font(220, bold=True)
    n_a = a
    text_center(d, cx, cy + 95, str(count_num), nf, fade_color(TEXT, n_a))


# ----------------------------------------------------------------------------
# Commentary line
# ----------------------------------------------------------------------------
def draw_commentary(d, cx, cy, text, alpha=1.0, color=None):
    if color is None:
        color = MUTED
    cf = font(40, bold=False)
    text_center(d, cx, cy, text, cf, fade_color(color, alpha))


# ----------------------------------------------------------------------------
# Top app bar (tiny brand presence at very top)
# ----------------------------------------------------------------------------
def draw_topbar(d, alpha=1.0):
    a = alpha
    cy = 70
    draw_logo(d, 70, cy, scale=70, draw_progress=1.0, alpha=a)
    text_left(d, 110, cy, "GOLAZO", font(38, bold=True), fade_color(TEXT, a))


# ----------------------------------------------------------------------------
# Timeline (seconds). Total ~13.0s.
# ----------------------------------------------------------------------------
#  intro_live   0.00 - 2.20  live pitch + score + clock + commentary builds
#  pause        2.20 - 5.20  TENSION: lean to Brazil, NEXT MARKET 3..2..1
#  market_pop   5.20 - 7.00  betting card slides + scales in, fuse runs
#  tap          7.00 - 8.50  finger taps Brazil 1.85x -> lights green
#  shot         8.50 - 9.70  "Brazil shoots!" resolves (flash)
#  payout       9.70 - 11.6  card flips to win -> 1.85x, +$46.25
#  end          11.6 - 13.0  logo + GOLAZO + tagline + url
SECTIONS = {
    "intro": (0.00, 2.20),
    "pause": (2.20, 5.20),
    "pop":   (5.20, 7.00),
    "tap":   (7.00, 8.50),
    "shot":  (8.50, 9.70),
    "pay":   (9.70, 11.60),
    "end":   (11.60, 13.00),
}
DURATION = 13.00
TOTAL_FRAMES = int(round(DURATION * FPS))

PITCH_TOP = 150
PITCH_H = 470


def seg_t(t, key):
    a, b = SECTIONS[key]
    return clamp01((t - a) / (b - a))


def in_seg(t, key):
    a, b = SECTIONS[key]
    return a <= t < b


def clock_for(t):
    """Match clock ticks 67' -> 68' across the film."""
    base = 67
    # advance one minute around the shot
    if t >= SECTIONS["shot"][0]:
        base = 68
    return "%d'" % base


# ----------------------------------------------------------------------------
# Frame render
# ----------------------------------------------------------------------------
def render_frame(i):
    t = i / FPS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    cx = W / 2

    # advance the LIVE-dot blink phase every frame
    clock_blink_phase[0] = t * 2 * math.pi * 1.1

    # ---------- Persistent pitch hero (beats 1-6) ----------
    # The pitch + score stays anchored at the top through the whole product
    # loop; only the end card replaces the screen.
    show_pitch = t < SECTIONS["end"][0]
    if show_pitch:
        # fade the whole UI out as the end card arrives
        ui_out = 1.0
        if t >= SECTIONS["pay"][1] - 0.30:
            ui_out = 1 - clamp01((t - (SECTIONS["pay"][1] - 0.30)) / 0.30)

        intro_in = ease_out(clamp01(t / 0.45))
        ui_a = min(intro_in, ui_out)

        # crowd / attacking lean toward Brazil during the pause + pop
        lean = 0.0
        if t >= SECTIONS["pause"][0]:
            lean = ease_in_out(clamp01((t - SECTIONS["pause"][0]) / 0.9))
        if t >= SECTIONS["shot"][1]:
            lean *= (1 - clamp01((t - SECTIONS["shot"][1]) / 0.5))

        # shot flash
        flash = 0.0
        if in_seg(t, "shot"):
            sp = seg_t(t, "shot")
            # quick flash near the start of the shot beat
            flash = max(0.0, 1 - abs(sp - 0.18) / 0.18) if sp < 0.36 else 0.0

        draw_topbar(d, alpha=ui_a)
        draw_pitch_hero(d, PITCH_TOP, PITCH_H, clock_for(t), lean=lean,
                        alpha=ui_a, flash=flash)

    # ---------- Commentary (changes per beat) ----------
    comm_cy = PITCH_TOP + PITCH_H + 70
    if show_pitch:
        ui_out = 1.0
        if t >= SECTIONS["pay"][1] - 0.30:
            ui_out = 1 - clamp01((t - (SECTIONS["pay"][1] - 0.30)) / 0.30)
        if in_seg(t, "intro"):
            a = ease_out(clamp01(seg_t(t, "intro") / 0.25))
            draw_commentary(d, cx, comm_cy, "Brazil surging down the right.", a)
        elif in_seg(t, "pause"):
            draw_commentary(d, cx, comm_cy, "Brazil break... they're in.",
                            min(1.0, ui_out))
        elif in_seg(t, "pop") or in_seg(t, "tap"):
            draw_commentary(d, cx, comm_cy, "Neymar lines it up...",
                            min(1.0, ui_out))
        elif in_seg(t, "shot"):
            a = ease_out(clamp01(seg_t(t, "shot") / 0.12))
            draw_commentary(d, cx, comm_cy, "Brazil shoots!", a, color=TEXT)
        elif in_seg(t, "pay"):
            draw_commentary(d, cx, comm_cy, "On target — moment resolved.",
                            min(1.0, ui_out))

    # ---------- BEAT 2: PAUSE / TENSION — NEXT MARKET 3..2..1 ----------
    if in_seg(t, "pause"):
        p = seg_t(t, "pause")
        # the telegraph appears after a short hush, counts 3..2..1
        tele_in = ease_out(clamp01((p - 0.18) / 0.18))
        tele_out = 1 - ease_in_out(clamp01((p - 0.90) / 0.10))
        tele_a = min(tele_in, tele_out)
        # countdown window mapped to numbers 3,2,1 across the visible span
        span0, span1 = 0.22, 0.92
        cp = clamp01((p - span0) / (span1 - span0))
        if cp < 1 / 3:
            num = 3
            seg_local = cp / (1 / 3)
        elif cp < 2 / 3:
            num = 2
            seg_local = (cp - 1 / 3) / (1 / 3)
        else:
            num = 1
            seg_local = (cp - 2 / 3) / (1 / 3)
        pulse = ease_out(clamp01(seg_local))  # pulse resets each number
        tele_cy = comm_cy + 360
        if tele_a > 0.02:
            draw_next_market(d, cx, tele_cy, num, pulse, alpha=tele_a)

    # ---------- BEATS 3-6: the betting / payout card ----------
    # The card lives in the lower portion of the screen.
    card_w = W - 72
    card_h = 620
    card_cy = comm_cy + 470

    # POP (slide + scale in)
    if in_seg(t, "pop"):
        p = seg_t(t, "pop")
        appear = ease_back_out(clamp01(p / 0.42))
        # slide up from below + scale
        oy = (1 - clamp01(p / 0.42)) * 120
        # fuse depletes from full across pop+tap
        fuse = 1.0 - p * 0.40
        lean = 0.62
        draw_bet_card(d, cx, card_cy + oy, card_w, card_h, fuse, lean,
                      picked=0.0, alpha=clamp01(appear))

    # TAP (finger highlights Brazil half -> lights green -> "Bet in")
    if in_seg(t, "tap"):
        p = seg_t(t, "tap")
        # fuse keeps depleting
        fuse = 0.60 - p * 0.30
        lean = 0.62 + 0.12 * p
        # pick highlight ramps as the finger presses
        press_t = clamp01((p - 0.20) / 0.30)
        picked = ease_out(clamp01((p - 0.22) / 0.40))
        box = draw_bet_card(d, cx, card_cy, card_w, card_h, max(0.06, fuse),
                            lean, picked=picked, alpha=1.0)
        # tap pointer over the Brazil (left) half of the price board
        x0, y0, x1, y1, board_cy, board_h, board_w = box
        tap_x = cx - board_w * 0.25
        tap_y = board_cy + 6
        # finger descends, presses, lifts
        descend = ease_out(clamp01(p / 0.20))
        ty = lerp(tap_y + 120, tap_y, descend)
        press = max(0.0, 1 - abs(p - 0.32) / 0.16) if 0.16 < p < 0.50 else 0.0
        tap_a = ease_out(clamp01(p / 0.12)) * (1 - clamp01((p - 0.78) / 0.22))
        draw_tap(d, tap_x, ty, press=press, alpha=tap_a)
        # "Bet in" confirmation chip near the half once picked
        if picked > 0.5:
            ba = ease_out(clamp01((p - 0.40) / 0.25))
            chip = "Bet in"
            cf = font(34, bold=True)
            cwid = measure(d, chip, cf)[0] + 44
            chy = board_cy + board_h / 2 + 50
            d.rounded_rectangle([tap_x - cwid / 2, chy - 26, tap_x + cwid / 2, chy + 26],
                                radius=26, fill=fade_color(blend(SURFACE2, (18, 46, 33), 0.7), ba),
                                outline=fade_color(ACCENT, ba), width=2)
            text_center(d, tap_x, chy, chip, cf, fade_color(ACCENT, ba))

    # SHOT (card holds, "locked" — fuse empty, board frozen on Brazil pick)
    if in_seg(t, "shot"):
        p = seg_t(t, "shot")
        # card shakes a touch on the shot impact then settles
        shake = math.sin(p * 40) * max(0.0, 6 * (1 - p / 0.4)) if p < 0.4 else 0.0
        draw_bet_card(d, cx + shake, card_cy, card_w, card_h, 0.0, 0.74,
                      picked=1.0, alpha=1.0, resolves_text="LOCKED")

    # PAYOUT (card flips to a win)
    if in_seg(t, "pay"):
        p = seg_t(t, "pay")
        ui_out = 1.0
        if t >= SECTIONS["pay"][1] - 0.30:
            ui_out = 1 - clamp01((t - (SECTIONS["pay"][1] - 0.30)) / 0.30)
        draw_payout_card(d, cx, card_cy, card_w, card_h, p, alpha=min(1.0, ui_out))

    # ---------- BEAT 7: END CARD ----------
    if t >= SECTIONS["end"][0]:
        p = seg_t(t, "end")
        a = ease_out(clamp01(p / 0.28))
        draw_logo_tile(d, cx, H * 0.38, tile=220, alpha=a)
        text_center(d, cx, H * 0.50, "GOLAZO", font(118, bold=True),
                    fade_color(TEXT, a), tracking=8)
        tag_a = ease_out(clamp01((p - 0.20) / 0.28))
        text_center(d, cx, H * 0.575, "Bet the next moment.",
                    font(56, bold=True), fade_color(TEXT, tag_a))
        url_a = ease_out(clamp01((p - 0.38) / 0.30))
        text_center(d, cx, H * 0.64, "golazo.wooblay.com",
                    font(44, bold=False), fade_color(ACCENT, url_a), tracking=3)

    return img


# ----------------------------------------------------------------------------
# Payout card (win) — big green multiple, "You won", +$46.25, stake->return
# ----------------------------------------------------------------------------
def draw_payout_card(d, cx, cy, w, h, p, alpha=1.0):
    a = alpha
    x0, y0 = cx - w / 2, cy - h / 2
    x1, y1 = cx + w / 2, cy + h / 2
    # flip-in: scale Y from a thin line to full (card "flips" to the win face)
    flip = ease_out(clamp01(p / 0.26))
    half_h = (h / 2) * flip
    fy0, fy1 = cy - half_h, cy + half_h
    win_fill = blend(SURFACE, (16, 40, 29), 0.55)
    d.rounded_rectangle([x0, fy0, x1, fy1], radius=40,
                        fill=fade_color(win_fill, a),
                        outline=fade_color(ACCENT, a), width=3)
    if flip < 0.92:
        return  # still flipping — show only the surface

    ca = ease_out(clamp01((p - 0.20) / 0.20))

    # WON lane chip
    chip = "WON"
    cf = font(30, bold=True)
    cwid = measure(d, chip, cf)[0] + 48
    chy = y0 + 70
    d.rounded_rectangle([cx - cwid / 2, chy - 30, cx + cwid / 2, chy + 30],
                        radius=30,
                        fill=fade_color(blend(SURFACE2, (18, 46, 33), 0.7), ca),
                        outline=fade_color(ACCENT, ca), width=2)
    text_center(d, cx, chy, chip, cf, fade_color(ACCENT, ca), tracking=4)

    # big green multiple (counts up to 1.85x)
    mp = ease_out(clamp01((p - 0.22) / 0.30))
    val = lerp(1.00, 1.85, mp)
    text_center(d, cx, cy - h * 0.15, "%.2fx" % val, font(190, bold=True),
                fade_color(ACCENT, ca))

    # "You won"
    text_center(d, cx, cy + h * 0.075, "You won", font(50, bold=True),
                fade_color(TEXT, ca))

    # +$46.25 (pops up)
    win_a = ease_out(clamp01((p - 0.42) / 0.22))
    pop = lerp(0.9, 1.0, win_a)
    text_center(d, cx, cy + h * 0.215, "+$46.25", font(int(86 * pop), bold=True),
                fade_color(ACCENT, win_a))

    # stake -> return line
    sr_a = ease_out(clamp01((p - 0.55) / 0.22))
    sr_y = y1 - 64
    text_center(d, cx, sr_y, "$25  ->  $71.25", font(38, bold=True),
                fade_color(MUTED, sr_a))


def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    print("Fonts: bold=%s  reg=%s" % (_BOLD_PATH, _REG_PATH))
    print("Rendering %d frames (%.1fs @ %dfps, %dx%d) -> %s"
          % (TOTAL_FRAMES, DURATION, FPS, W, H, FRAMES_DIR))
    for i in range(TOTAL_FRAMES):
        img = render_frame(i)
        img.save(os.path.join(FRAMES_DIR, "frame_%04d.png" % i))
        if i % 30 == 0 or i == TOTAL_FRAMES - 1:
            print("  frame %4d / %d" % (i, TOTAL_FRAMES - 1))
    print("Done rendering %d frames." % TOTAL_FRAMES)

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
