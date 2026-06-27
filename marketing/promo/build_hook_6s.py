#!/usr/bin/env python3
"""
GOLAZO hook_6s — a 6-second, 1080x1080, 30fps scroll-stopper (Pillow).

This is the PUNCHY hook, not the full promo. It renders only the three hero
beats the product owner cares about, plus a single logo flash:

  Beat 2  TENSION / PAUSE  — live pitch + score + clock, commentary builds,
                             action leans Brazil, then a centered "NEXT MARKET"
                             pill pulses with 3..2..1 (the get-ready hush).
  Beat 3  MARKET POPS UP   — the betting card slides + scales in
                             ("Next shot: Brazil or Argentina?") with a split
                             price board + a segmented fuse counting down; a tap
                             lights the Brazil 1.85x half green ("Bet in").
  Beat 5  THE SHOT         — "Brazil shoots!" the moment resolves, then a quick
                             win flash: 1.85x / "You won +$46.25".
  END     LOGO FLASH       — the strike-mark tile + GOLAZO, one beat.

Brand (STRICT, flat + dark — no gradients, glow, shadow, grain, 3D):
  canvas    #0B0C0F      surface   #14181E / #1B1F27
  hairline  #23262D      accent    #27E08A  (exactly one accent, surgical)
  text      #E8EDF2      muted     #8A93A0  loss-red #FF5C5C (loss only; unused)
  pitch     dark flat green band with thin white markings

Self-contained: standard library + Pillow only. Graceful font fallback
(Arial -> DejaVuSans -> PIL default). Renders to frames_hook_6s/ (its OWN dir)
then prints the exact ffmpeg assemble command.
"""

import os
import sys
import math

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.stderr.write(
        "ERROR: Pillow (PIL) is not installed. Install with: "
        "python3 -m pip install Pillow\n"
    )
    sys.exit(1)

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
W = H = 1080
FPS = 30
HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES_DIR = os.path.join(HERE, "frames_hook_6s")  # OWN dir, do not share
OUT_MP4 = os.path.join(HERE, "golazo_hook_6s.mp4")

# Brand palette
BG       = (11, 12, 15)      # #0B0C0F
SURFACE  = (20, 24, 30)      # #14181E
SURFACE2 = (27, 31, 39)      # #1B1F27
HAIRLINE = (35, 38, 45)      # #23262D
ACCENT   = (39, 224, 138)    # #27E08A
TEXT     = (232, 237, 242)   # #E8EDF2
MUTED    = (138, 147, 160)   # #8A93A0
LOSS     = (255, 92, 92)     # #FF5C5C (loss only)

# Pitch + crests (flat)
PITCH    = (19, 53, 31)      # dark flat green band
PITCH_HI = (24, 64, 38)      # very subtle flat variation for far half (no gradient)
PITCH_LINE = (210, 224, 214) # thin white-ish markings
BRA_Y    = (244, 206, 42)    # Brazil disc (yellow)
BRA_G    = (39, 174, 96)     # Brazil inner ring (green)
ARG_B    = (124, 185, 232)   # Argentina disc (light blue)
WHITE    = (240, 244, 248)
LIVE_RED = (255, 76, 76)

# ----------------------------------------------------------------------------
# Fonts (graceful fallback)
# ----------------------------------------------------------------------------
FONT_BOLD_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/Library/Frameworks/Python.framework/Versions/3.11/lib/python3.11/"
    "site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans-Bold.ttf",
]
FONT_REG_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/Library/Frameworks/Python.framework/Versions/3.11/lib/python3.11/"
    "site-packages/matplotlib/mpl-data/fonts/ttf/DejaVuSans.ttf",
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


def ease_back(t):
    """Slight overshoot at the end — for a 'pop' in."""
    t = clamp01(t)
    c1 = 1.70158
    c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2


def lerp(a, b, t):
    return a + (b - a) * t


def fade_color(color, alpha):
    """Blend a color toward BG by alpha (0 = invisible, 1 = full)."""
    a = clamp01(alpha)
    return tuple(int(round(lerp(BG[i], color[i], a))) for i in range(3))


def blend(c0, c1, t):
    """Blend two arbitrary colors, t in [0,1]."""
    t = clamp01(t)
    return tuple(int(round(lerp(c0[i], c1[i], t))) for i in range(3))


def measure(draw, text, fnt):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    return bbox[2] - bbox[0], bbox[3] - bbox[1], bbox


def draw_text_center(draw, cx, cy, text, fnt, fill, tracking=0):
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


def draw_text_left(draw, x, cy, text, fnt, fill):
    _, th, tbb = measure(draw, text, fnt)
    draw.text((x - tbb[0], cy - th / 2 - tbb[1]), text, font=fnt, fill=fill)


def draw_text_right(draw, x, cy, text, fnt, fill):
    tw, th, tbb = measure(draw, text, fnt)
    draw.text((x - tw - tbb[0], cy - th / 2 - tbb[1]), text, font=fnt, fill=fill)


# ----------------------------------------------------------------------------
# Logo strike-mark (brand icon), reference coordinate system 100x100
#   three speed lines on the left + a filled accent disc with a dark pentagon.
# ----------------------------------------------------------------------------
def draw_logo(draw, cx, cy, scale, alpha=1.0):
    s = scale / 100.0

    def P(x, y):
        return (cx + (x - 50) * s, cy + (y - 50) * s)

    acc = fade_color(ACCENT, alpha)
    dark = fade_color(BG, alpha)
    lw = max(2, int(round(7 * s)))

    lines = [((18, 38), (40, 38)), ((13, 50), (38, 50)), ((18, 62), (40, 62))]
    for (x0, y0), (x1, y1) in lines:
        a, b = P(x0, y0), P(x1, y1)
        draw.line([a, b], fill=acc, width=lw)
        r = lw / 2
        for pt in (a, b):
            draw.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=acc)

    R = 19 * s
    dc = P(64, 50)
    draw.ellipse([dc[0] - R, dc[1] - R, dc[0] + R, dc[1] + R], fill=acc)
    poly = [P(64, 41), P(71, 47), P(68, 55), P(60, 55), P(57, 47)]
    draw.polygon(poly, fill=dark)


def draw_logo_tile(draw, cx, cy, tile, alpha=1.0):
    """The strike-mark on a dark rounded tile (the brand lockup)."""
    half = tile / 2
    rad = int(tile * 0.22)
    draw.rounded_rectangle(
        [cx - half, cy - half, cx + half, cy + half],
        radius=rad, fill=fade_color(SURFACE, alpha),
        outline=fade_color(HAIRLINE, alpha), width=2,
    )
    draw_logo(draw, cx, cy, scale=tile * 0.62, alpha=alpha)


# ----------------------------------------------------------------------------
# Team crest discs (flat colored discs)
# ----------------------------------------------------------------------------
def crest_bra(draw, cx, cy, r, alpha=1.0):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fade_color(BRA_Y, alpha))
    ir = r * 0.58
    draw.ellipse([cx - ir, cy - ir, cx + ir, cy + ir], fill=fade_color(BRA_G, alpha))


def crest_arg(draw, cx, cy, r, alpha=1.0):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fade_color(ARG_B, alpha))
    # thin white vertical stripe hint, flat
    sw = max(1, int(r * 0.22))
    draw.rectangle([cx - sw, cy - r * 0.82, cx + sw, cy + r * 0.82],
                   fill=fade_color(WHITE, alpha * 0.9))


# ----------------------------------------------------------------------------
# PITCH HERO — flat dark-green band, thin markings, LIVE pill, clock, scoreline
# ----------------------------------------------------------------------------
def draw_pitch_hero(draw, top, height, alpha, clock_text, lean=0.0,
                    shoot_flash=0.0):
    """
    Flat pitch band across the full width.
      lean: -1..+1 crowd/action lean (>0 = toward Brazil/left attack glow line).
      shoot_flash: 0..1 brief accent emphasis when the shot is taken.
    """
    x0, y0, x1, y1 = 0, top, W, top + height
    # base pitch (flat fill, two flat halves — NOT a gradient)
    draw.rectangle([x0, y0, x1, y1], fill=fade_color(PITCH, alpha))
    draw.rectangle([x0, y0, x1, top + height * 0.5],
                   fill=fade_color(PITCH_HI, alpha))

    line = fade_color(PITCH_LINE, alpha * 0.55)
    lw = 3
    # halfway line (horizontal across the band)
    midy = top + height * 0.52
    draw.line([x0 + 24, midy, x1 - 24, midy], fill=line, width=lw)
    # center circle
    ccx, ccy = W / 2, midy
    cr = height * 0.20
    draw.ellipse([ccx - cr, ccy - cr, ccx + cr, ccy + cr], outline=line, width=lw)
    draw.ellipse([ccx - 5, ccy - 5, ccx + 5, ccy + 5], fill=line)
    # outer touch frame
    draw.rectangle([x0 + 18, y0 + 14, x1 - 18, y1 - 14], outline=line, width=lw)

    # action-lean marker: a subtle accent arc on the attacking side (Brazil=left)
    if lean > 0.01:
        la = clamp01(lean) * alpha * 0.9
        ax = x0 + 18 + height * 0.10
        draw.line([ax, top + height * 0.30, ax, top + height * 0.74],
                  fill=fade_color(ACCENT, la * 0.5), width=4)

    # shot flash: brief accent rim on the band
    if shoot_flash > 0.01:
        sf = clamp01(shoot_flash)
        draw.rectangle([x0 + 18, y0 + 14, x1 - 18, y1 - 14],
                       outline=fade_color(ACCENT, sf * alpha), width=5)

    # ---- LIVE pill (top-left) ----
    px, py = x0 + 40, y0 + 38
    dot_r = 9
    blink = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(py))  # static-ish; pulse via caller not needed
    draw.ellipse([px, py - dot_r, px + dot_r * 2, py + dot_r], fill=fade_color(LIVE_RED, alpha))
    lf = font(30, bold=True)
    draw_text_left(draw, px + dot_r * 2 + 12, py, "LIVE", lf, fade_color(TEXT, alpha))

    # ---- match clock (top-right) ----
    cf = font(34, bold=True)
    draw_text_right(draw, x1 - 40, py, clock_text, cf, fade_color(TEXT, alpha))

    # ---- scoreline row: BRA  1 - 1  ARG with crest discs ----
    srow_y = y1 - 64
    cr_r = 22
    sf_team = font(40, bold=True)
    sf_score = font(54, bold=True)
    # measure to center the whole group
    score_txt = "1  -  1"
    sw_score, _, _ = measure(draw, score_txt, sf_score)
    bra_w, _, _ = measure(draw, "BRA", sf_team)
    arg_w, _, _ = measure(draw, "ARG", sf_team)
    gap = 22
    group_w = cr_r * 2 + 14 + bra_w + gap + sw_score + gap + arg_w + 14 + cr_r * 2
    gx = W / 2 - group_w / 2

    # Brazil crest + abbrev
    crest_bra(draw, gx + cr_r, srow_y, cr_r, alpha)
    gx += cr_r * 2 + 14
    draw_text_left(draw, gx, srow_y, "BRA", sf_team, fade_color(TEXT, alpha))
    gx += bra_w + gap
    # score
    draw_text_left(draw, gx, srow_y, score_txt, sf_score, fade_color(TEXT, alpha))
    gx += sw_score + gap
    # Argentina abbrev + crest
    draw_text_left(draw, gx, srow_y, "ARG", sf_team, fade_color(TEXT, alpha))
    gx += arg_w + 14
    crest_arg(draw, gx + cr_r, srow_y, cr_r, alpha)


# ----------------------------------------------------------------------------
# NEXT MARKET telegraph pill (the get-ready pause) with 3/2/1 countdown
# ----------------------------------------------------------------------------
def draw_next_market_pill(draw, cx, cy, alpha, pulse, count_label):
    if alpha <= 0:
        return
    pw, ph = 470, 132
    rad = ph // 2
    # soft pulse = the pill breathes via a faint accent outer ring
    if pulse > 0:
        ring = pw / 2 + 16 * pulse
        ra = alpha * (0.30 * (1 - pulse))
        draw.rounded_rectangle(
            [cx - ring, cy - ph / 2 - 16 * pulse, cx + ring, cy + ph / 2 + 16 * pulse],
            radius=int(rad + 16 * pulse),
            outline=fade_color(ACCENT, ra), width=4,
        )
    draw.rounded_rectangle(
        [cx - pw / 2, cy - ph / 2, cx + pw / 2, cy + ph / 2],
        radius=rad, fill=fade_color(SURFACE2, alpha),
        outline=fade_color(ACCENT, alpha * 0.9), width=3,
    )
    eb = font(34, bold=True)
    draw_text_center(draw, cx, cy - 22, "NEXT MARKET", eb,
                     fade_color(ACCENT, alpha), tracking=8)
    big = font(60, bold=True)
    draw_text_center(draw, cx, cy + 30, count_label, big, fade_color(TEXT, alpha))


# ----------------------------------------------------------------------------
# BETTING CARD — split price board + segmented fuse
# ----------------------------------------------------------------------------
def draw_betting_card(draw, cx, top, alpha, scale, fuse_frac, tap=0.0,
                      left_lit=0.0):
    """
    Flat rounded card. scale animates the 'pop' (slide+scale in). fuse_frac in
    [0,1] = remaining time (pips deplete). tap 0..1 = finger highlight on the
    Brazil half. left_lit 0..1 = Brazil half lights green ('Bet in').
    """
    if alpha <= 0:
        return
    cw = 760 * scale
    ch = 430 * scale
    x0 = cx - cw / 2
    x1 = cx + cw / 2
    y0 = top
    y1 = top + ch
    rad = int(34 * scale)

    draw.rounded_rectangle([x0, y0, x1, y1], radius=rad,
                           fill=fade_color(SURFACE, alpha),
                           outline=fade_color(HAIRLINE, alpha), width=2)

    pad = 34 * scale
    # ---- NEXT lane chip (green) ----
    chip_w, chip_h = 116 * scale, 50 * scale
    cxx0 = x0 + pad
    cyy0 = y0 + pad
    draw.rounded_rectangle(
        [cxx0, cyy0, cxx0 + chip_w, cyy0 + chip_h],
        radius=int(chip_h * 0.32), fill=fade_color(blend(BG, ACCENT, 0.16), alpha),
        outline=fade_color(ACCENT, alpha), width=2,
    )
    cf = font(int(28 * scale), bold=True)
    draw_text_center(draw, cxx0 + chip_w / 2, cyy0 + chip_h / 2, "NEXT", cf,
                     fade_color(ACCENT, alpha), tracking=3)

    # ---- question ----
    qf = font(int(42 * scale), bold=True)
    draw_text_left(draw, x0 + pad, y0 + 134 * scale,
                   "Next shot: Brazil or Argentina?", qf, fade_color(TEXT, alpha))

    # ---- split PRICE BOARD: two rounded halves ----
    bw = (cw - pad * 2 - 18 * scale) / 2
    bh = 150 * scale
    by0 = y0 + 178 * scale
    by1 = by0 + bh
    lbx0 = x0 + pad
    lbx1 = lbx0 + bw
    rbx0 = lbx1 + 18 * scale
    rbx1 = rbx0 + bw
    hrad = int(22 * scale)

    # left half — Brazil (green tint), lights up when bet is "in"
    left_fill = blend(SURFACE2, blend(BG, ACCENT, 0.22), left_lit)
    left_out = blend(HAIRLINE, ACCENT, max(left_lit, tap * 0.8))
    left_ow = int(2 + 3 * max(left_lit, tap))
    draw.rounded_rectangle([lbx0, by0, lbx1, by1], radius=hrad,
                           fill=fade_color(left_fill, alpha),
                           outline=fade_color(left_out, alpha), width=left_ow)
    lcx = (lbx0 + lbx1) / 2
    crest_bra(draw, lbx0 + 38 * scale, by0 + 42 * scale, 18 * scale, alpha)
    tf = font(int(34 * scale), bold=True)
    draw_text_left(draw, lbx0 + 66 * scale, by0 + 42 * scale, "Brazil", tf,
                   fade_color(TEXT, alpha))
    mf = font(int(58 * scale), bold=True)
    lmcol = blend(ACCENT, WHITE, 0)  # accent multiplier
    draw_text_center(draw, lcx, by0 + bh * 0.66, "1.85x", mf,
                     fade_color(ACCENT, alpha))

    # right half — Argentina (neutral)
    draw.rounded_rectangle([rbx0, by0, rbx1, by1], radius=hrad,
                           fill=fade_color(SURFACE2, alpha),
                           outline=fade_color(HAIRLINE, alpha), width=2)
    rcx = (rbx0 + rbx1) / 2
    crest_arg(draw, rbx0 + 38 * scale, by0 + 42 * scale, 18 * scale, alpha)
    draw_text_left(draw, rbx0 + 66 * scale, by0 + 42 * scale, "Argentina", tf,
                   fade_color(TEXT, alpha))
    draw_text_center(draw, rcx, by0 + bh * 0.66, "2.10x", mf,
                     fade_color(TEXT, alpha))

    # divider + crowd-lean marker (between halves)
    dvx = (lbx1 + rbx0) / 2
    draw.line([dvx, by0 + 12 * scale, dvx, by1 - 12 * scale],
              fill=fade_color(HAIRLINE, alpha), width=2)
    # lean marker: a small accent tick nudged toward Brazil
    lean_x = dvx - 26 * scale
    draw.ellipse([lean_x - 6 * scale, (by0 + by1) / 2 - 6 * scale,
                  lean_x + 6 * scale, (by0 + by1) / 2 + 6 * scale],
                 fill=fade_color(ACCENT, alpha))

    # ---- segmented FUSE timer (pips deplete) + RESOLVES IN ----
    fy = y1 - 58 * scale
    n_pips = 12
    pip_gap = 10 * scale
    fuse_w = cw - pad * 2 - 200 * scale
    pip_w = (fuse_w - pip_gap * (n_pips - 1)) / n_pips
    pip_h = 16 * scale
    fx = x0 + pad
    lit = int(round(clamp01(fuse_frac) * n_pips))
    for k in range(n_pips):
        px0 = fx + k * (pip_w + pip_gap)
        on = k < lit
        col = ACCENT if on else HAIRLINE
        a = alpha if on else alpha * 0.8
        draw.rounded_rectangle([px0, fy - pip_h / 2, px0 + pip_w, fy + pip_h / 2],
                               radius=int(pip_h * 0.4), fill=fade_color(col, a))
    # resolves-in label (right)
    secs = max(0, int(round(clamp01(fuse_frac) * 8)))
    rlabel = "RESOLVES IN 0:%02d" % secs
    rf = font(int(26 * scale), bold=True)
    draw_text_right(draw, x1 - pad, fy, rlabel, rf, fade_color(MUTED, alpha))

    # ---- finger / tap highlight on the Brazil half ----
    if tap > 0.001:
        # a ring that contracts as the tap lands
        tap_e = ease_out(tap)
        ring_r = lerp(64 * scale, 30 * scale, tap_e)
        tcx, tcy = lcx, by0 + bh * 0.5
        ta = alpha * (0.85 if tap < 0.92 else (1 - (tap - 0.92) / 0.08))
        draw.ellipse([tcx - ring_r, tcy - ring_r, tcx + ring_r, tcy + ring_r],
                     outline=fade_color(ACCENT, clamp01(ta)), width=int(4 * scale))
        # solid contact dot
        dr = 16 * scale
        draw.ellipse([tcx - dr, tcy - dr, tcx + dr, tcy + dr],
                     fill=fade_color(ACCENT, clamp01(ta * 0.5)))


# ----------------------------------------------------------------------------
# WIN flash card (after the shot resolves)
# ----------------------------------------------------------------------------
def draw_win_flash(draw, cx, cy, alpha, scale):
    if alpha <= 0:
        return
    # big green multiple
    mf = font(int(210 * scale), bold=True)
    draw_text_center(draw, cx, cy - 110 * scale, "1.85x", mf,
                     fade_color(ACCENT, alpha))
    # "You won"
    yf = font(int(56 * scale), bold=True)
    draw_text_center(draw, cx, cy + 26 * scale, "You won", yf,
                     fade_color(TEXT, alpha))
    # +$46.25
    pf = font(int(92 * scale), bold=True)
    draw_text_center(draw, cx, cy + 116 * scale, "+$46.25", pf,
                     fade_color(ACCENT, alpha))
    # stake -> return line
    sf = font(int(38 * scale), bold=True)
    draw_text_center(draw, cx, cy + 196 * scale, "$25  ->  $71.25", sf,
                     fade_color(MUTED, alpha))


# ----------------------------------------------------------------------------
# Timeline (seconds). Total ~6.0s. Punchy hook = beats 2, 3, 5 + logo flash.
# ----------------------------------------------------------------------------
#  PAUSE   live pitch + NEXT MARKET pill 3..2..1 ........ 0.00 - 1.70
#  POP     betting card slides+scales in, fuse runs ..... 1.70 - 3.20
#  TAP     Brazil half lights green ("Bet in") .......... 3.20 - 3.85  (overlaps)
#  SHOT    "Brazil shoots!" the moment resolves ......... 3.85 - 4.45
#  WIN     1.85x / You won +$46.25 ...................... 4.45 - 5.40
#  LOGO    single strike-mark flash + GOLAZO ............ 5.40 - 6.00
SECTIONS = {
    "pause": (0.00, 1.70),
    "pop":   (1.70, 3.85),   # card present from pop through tap
    "shot":  (3.85, 4.45),
    "win":   (4.45, 5.40),
    "logo":  (5.40, 6.00),
}
DURATION = 6.00
TOTAL_FRAMES = int(round(DURATION * FPS))

# Pitch hero geometry (shared)
PITCH_TOP = 96
PITCH_H = 300


def seg_t(t, key):
    a, b = SECTIONS[key]
    return clamp01((t - a) / (b - a))


def render_frame(i):
    t = i / FPS
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    cx = W / 2

    # ===================================================================
    # The pitch hero + commentary are present through PAUSE -> SHOT, then
    # hand off to the WIN flash, then the LOGO flash.
    # ===================================================================
    show_match = t < SECTIONS["win"][0]

    if show_match:
        # hero fades in fast at the very start, holds, fades as win takes over
        hero_in = ease_out(clamp01(t / 0.25))
        hero_out = 1 - ease_in_out(clamp01((t - (SECTIONS["shot"][1])) / 0.0001)) \
            if False else 1.0
        # fade hero out across the last 0.18s before win
        fade_start = SECTIONS["win"][0] - 0.22
        if t >= fade_start:
            hero_out = 1 - ease_in_out(clamp01((t - fade_start) / 0.22))
        hero_alpha = min(hero_in, hero_out)

        # clock ticks forward subtly 67' -> 68'
        clock = "67'" if t < 3.0 else "68'"

        # action lean toward Brazil ramps during the pause, peaks at the shot
        if t < SECTIONS["shot"][0]:
            lean = ease_in_out(clamp01(t / SECTIONS["shot"][0])) * 0.9
        else:
            lean = 0.9
        # shot flash on the pitch rim during the shot beat
        sflash = 0.0
        if SECTIONS["shot"][0] <= t < SECTIONS["shot"][1]:
            sp = seg_t(t, "shot")
            sflash = math.sin(min(1.0, sp / 0.4) * math.pi)  # quick in/out

        draw_pitch_hero(d, PITCH_TOP, PITCH_H, hero_alpha, clock,
                        lean=lean, shoot_flash=sflash)

        # ---- commentary line under the hero (muted) ----
        com_y = PITCH_TOP + PITCH_H + 52
        if t < SECTIONS["shot"][0]:
            commentary = "Brazil surging down the right."
            com_col = MUTED
        else:
            commentary = "Brazil shoots!"
            com_col = ACCENT  # the moment
        cf = font(40, bold=True)
        # commentary swaps with a quick fade at the shot
        if SECTIONS["shot"][0] <= t < SECTIONS["shot"][0] + 0.12:
            ca = ease_out((t - SECTIONS["shot"][0]) / 0.12)
        else:
            ca = 1.0
        draw_text_center(d, cx, com_y, commentary, cf,
                         fade_color(com_col, hero_alpha * ca))

    # ===================================================================
    # BEAT 2 — TENSION / PAUSE: NEXT MARKET pill pulses with 3..2..1
    # ===================================================================
    if t < SECTIONS["pause"][1] + 0.05:
        p = seg_t(t, "pause")
        # pill fades in fast, then fades just as the card pops
        pill_in = ease_out(clamp01(p / 0.18))
        pill_out = 1 - ease_in_out(clamp01((p - 0.86) / 0.14))
        pill_alpha = min(pill_in, pill_out)
        # 3 / 2 / 1 countdown across the pause
        if p < 0.34:
            count = "3"
        elif p < 0.62:
            count = "2"
        else:
            count = "1"
        # soft pulse, retriggered each number (a get-ready breath)
        seg = (p % 0.34) / 0.34 if p < 0.62 else ((p - 0.62) / 0.38)
        pulse = max(0.0, 1 - seg) ** 1.5
        pill_cy = PITCH_TOP + PITCH_H + 250
        draw_next_market_pill(d, cx, pill_cy, pill_alpha, pulse, count)

    # ===================================================================
    # BEAT 3 — MARKET POPS UP: betting card slides+scales in, fuse runs,
    #          then a tap lights the Brazil half green ("Bet in").
    # ===================================================================
    if SECTIONS["pop"][0] <= t < SECTIONS["shot"][0] + 0.10:
        p = seg_t(t, "pop")
        # POP: scale + slide in with a slight overshoot
        pop_p = clamp01(p / 0.16)
        scale = lerp(0.86, 1.0, ease_back(pop_p))
        card_alpha = ease_out(clamp01(p / 0.12))
        slide = (1 - ease_out(clamp01(p / 0.18))) * 60
        card_top = PITCH_TOP + PITCH_H + 110 + slide

        # fuse depletes across the card's life (full -> low by the shot)
        fuse_frac = lerp(1.0, 0.10, ease_in_out(clamp01(p / 0.95)))

        # tap lands late in the pop window: ring contracts ~3.20-3.55,
        # left half stays lit ('Bet in') 3.55 -> shot
        tap = 0.0
        left_lit = 0.0
        tap_start = (SECTIONS["pop"][0] + 1.50)   # ~3.20s
        tap_land = tap_start + 0.35               # ~3.55s
        if tap_start <= t < tap_land:
            tap = clamp01((t - tap_start) / 0.35)
        elif t >= tap_land:
            tap = 1.0
            left_lit = ease_out(clamp01((t - tap_land) / 0.22))

        # card fades out right as the shot fires
        if t >= SECTIONS["shot"][0]:
            card_alpha *= (1 - ease_in_out(clamp01((t - SECTIONS["shot"][0]) / 0.10)))

        draw_betting_card(d, cx, card_top, card_alpha, scale, fuse_frac,
                          tap=tap, left_lit=left_lit)

        # "Bet in" confirmation tag once the half is lit
        if left_lit > 0.05:
            bf = font(34, bold=True)
            ba = left_lit
            tag_y = card_top + 430 * scale + 46
            draw_text_center(d, cx, tag_y, "Bet in", bf,
                             fade_color(ACCENT, ba), tracking=4)

    # ===================================================================
    # BEAT 5 — WIN flash: 1.85x / You won +$46.25 / $25 -> $71.25
    # ===================================================================
    if SECTIONS["win"][0] <= t < SECTIONS["logo"][0] + 0.05:
        p = seg_t(t, "win")
        win_in = ease_out(clamp01(p / 0.16))
        # quick scale punch on entry
        scale = lerp(0.88, 1.0, ease_back(clamp01(p / 0.22)))
        win_out = 1 - ease_in_out(clamp01((p - 0.86) / 0.14))
        win_alpha = min(win_in, win_out)
        draw_win_flash(d, cx, H * 0.46, win_alpha, scale)

    # ===================================================================
    # END — single LOGO flash: strike-mark tile + GOLAZO + tagline + url
    # ===================================================================
    if t >= SECTIONS["logo"][0]:
        p = seg_t(t, "logo")
        a = ease_out(clamp01(p / 0.22))
        scale = lerp(0.90, 1.0, ease_back(clamp01(p / 0.30)))
        tile = 240 * scale
        draw_logo_tile(d, cx, H * 0.38, tile, alpha=a)
        wf = font(int(118 * scale), bold=True)
        draw_text_center(d, cx, H * 0.55, "GOLAZO", wf, fade_color(TEXT, a),
                         tracking=int(8 * scale))
        # tagline + url come a beat later
        ta = ease_out(clamp01((p - 0.22) / 0.30))
        tf = font(46, bold=True)
        draw_text_center(d, cx, H * 0.635, "Bet the next moment.", tf,
                         fade_color(MUTED, ta))
        uf = font(42, bold=False)
        draw_text_center(d, cx, H * 0.70, "golazo.wooblay.com", uf,
                         fade_color(ACCENT, ta), tracking=3)

    return img


def main():
    os.makedirs(FRAMES_DIR, exist_ok=True)
    # clear any stale frames in our OWN dir only
    for fn in os.listdir(FRAMES_DIR):
        if fn.startswith("frame_") and fn.endswith(".png"):
            try:
                os.remove(os.path.join(FRAMES_DIR, fn))
            except OSError:
                pass

    print("Font (bold): %s" % _BOLD_PATH)
    print("Font (reg):  %s" % _REG_PATH)
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
